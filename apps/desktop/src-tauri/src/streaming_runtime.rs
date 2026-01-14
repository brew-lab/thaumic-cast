//! Dedicated high-priority runtime for audio streaming.
//!
//! This module provides an isolated Tokio runtime running on dedicated OS threads
//! with elevated thread priority. This helps ensure consistent 20ms cadence for
//! WAV streaming even during system load or UI freezes.
//!
//! # Architecture
//!
//! The streaming runtime runs a multi-threaded Tokio executor on its own thread pool,
//! separate from Tauri's shared runtime. Each worker thread has elevated priority:
//!
//! - **Windows**: Uses MMCSS "Pro Audio" task for OS-level audio scheduling guarantees,
//!   with fallback to `THREAD_PRIORITY_HIGHEST` if MMCSS fails.
//!
//! - **Linux**: Sets thread nice value to -10 using `setpriority` with thread ID.
//!   Requires `CAP_SYS_NICE` capability or root privileges.
//!
//! - **macOS/BSD**: Sets thread nice value to -10. May require elevated privileges.
//!
//! # Why This Helps
//!
//! Tauri's global runtime shares threads with UI updates, Tauri commands, discovery,
//! and other tasks. When the app freezes (e.g., during heavy UI rendering), those
//! Tokio workers are starved, causing gaps in audio delivery to Sonos.
//!
//! A dedicated runtime with elevated priority:
//! - Continues running even when the main runtime is starved
//! - Gets preferential CPU scheduling via MMCSS on Windows
//! - Isolates streaming from UI/discovery contention
//!
//! # Limitations
//!
//! This won't help during full system stalls (kernel-level DPC/ISR spikes, OS-wide
//! pauses, or hardware issues). But it significantly reduces the >300ms gaps caused
//! by application-level scheduler starvation.

use std::thread::{self, JoinHandle};

use tokio::runtime::{Builder, Handle};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Number of worker threads for the streaming runtime.
///
/// Two threads provides redundancy without excessive overhead.
/// If one thread is briefly blocked, the other can continue serving.
const STREAMING_WORKER_THREADS: usize = 2;

/// A dedicated runtime for latency-sensitive streaming operations.
///
/// Runs on its own thread pool with elevated priority to reduce scheduler
/// starvation during system load.
pub struct StreamingRuntime {
    /// Handle to spawn tasks on the streaming runtime.
    handle: Handle,
    /// Cancellation token for graceful shutdown.
    cancel: CancellationToken,
    /// Thread join handle for cleanup (None after shutdown).
    thread: Option<JoinHandle<()>>,
}

impl StreamingRuntime {
    /// Creates a new streaming runtime on dedicated high-priority threads.
    ///
    /// # Errors
    ///
    /// Returns an error if the runtime thread fails to spawn or initialize.
    /// Priority elevation failures are logged but don't cause errors.
    pub fn new() -> std::io::Result<Self> {
        let (tx, rx) = oneshot::channel();
        let cancel = CancellationToken::new();
        let cancel_clone = cancel.clone();

        let thread = thread::Builder::new()
            .name("streaming-runtime".into())
            .spawn(move || {
                // Build a dedicated multi-threaded Tokio runtime
                let runtime = Builder::new_multi_thread()
                    .worker_threads(STREAMING_WORKER_THREADS)
                    .thread_name("streaming-worker")
                    .on_thread_start(|| {
                        // Elevate EACH worker thread's priority
                        raise_thread_priority();
                    })
                    .enable_all()
                    .build()
                    .expect("Failed to build streaming runtime");

                let handle = runtime.handle().clone();

                // Send handle back to caller
                if tx.send(handle).is_err() {
                    log::error!("Failed to send streaming runtime handle");
                    return;
                }

                // Block until shutdown is requested
                runtime.block_on(async {
                    cancel_clone.cancelled().await;
                    log::info!("Streaming runtime shutting down");
                });

                // Runtime drops here, stopping all workers
            })?;

        // Wait for runtime to be ready
        let handle = rx
            .blocking_recv()
            .map_err(|_| std::io::Error::other("Failed to receive streaming runtime handle"))?;

        log::info!(
            "Streaming runtime started with {} worker threads",
            STREAMING_WORKER_THREADS
        );

        Ok(Self {
            handle,
            cancel,
            thread: Some(thread),
        })
    }

    /// Returns a handle for spawning tasks on the streaming runtime.
    #[allow(dead_code)]
    pub fn handle(&self) -> &Handle {
        &self.handle
    }

    /// Spawns a future on the streaming runtime.
    ///
    /// Use this for latency-sensitive operations like HTTP streaming.
    pub fn spawn<F>(&self, future: F) -> tokio::task::JoinHandle<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        self.handle.spawn(future)
    }

    /// Initiates graceful shutdown of the streaming runtime.
    ///
    /// This signals all workers to stop and waits for the runtime thread to exit.
    pub fn shutdown(&mut self) {
        self.cancel.cancel();

        if let Some(thread) = self.thread.take() {
            if let Err(e) = thread.join() {
                log::error!("Streaming runtime thread panicked: {:?}", e);
            } else {
                log::info!("Streaming runtime shutdown complete");
            }
        }
    }
}

impl Drop for StreamingRuntime {
    fn drop(&mut self) {
        if self.thread.is_some() {
            self.shutdown();
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Thread Priority Elevation
// ─────────────────────────────────────────────────────────────────────────────

/// Elevates the current thread's priority for audio streaming.
///
/// Called by each worker thread on startup via `on_thread_start`.
fn raise_thread_priority() {
    #[cfg(target_os = "windows")]
    raise_thread_priority_windows();

    #[cfg(target_os = "linux")]
    raise_thread_priority_linux();

    #[cfg(target_os = "macos")]
    raise_thread_priority_macos();

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    raise_thread_priority_generic_unix();
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows: MMCSS with fallback to THREAD_PRIORITY_HIGHEST
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn raise_thread_priority_windows() {
    use windows_sys::Win32::System::Threading::{
        AvSetMmThreadCharacteristicsW, AvSetMmThreadPriority, GetCurrentThread, SetThreadPriority,
        AVRT_PRIORITY_HIGH, THREAD_PRIORITY_HIGHEST,
    };

    // Try MMCSS first - this is the gold standard for audio on Windows
    if try_mmcss() {
        return;
    }

    // Fallback to THREAD_PRIORITY_HIGHEST (not TIME_CRITICAL to avoid system starvation)
    // SAFETY: GetCurrentThread returns a pseudo-handle, SetThreadPriority is safe
    let result = unsafe {
        let thread = GetCurrentThread();
        SetThreadPriority(thread, THREAD_PRIORITY_HIGHEST)
    };

    if result != 0 {
        log::info!("Streaming thread priority set to HIGHEST (MMCSS unavailable)");
    } else {
        log::warn!(
            "Failed to set streaming thread priority: {}",
            std::io::Error::last_os_error()
        );
    }
}

/// Attempts to register the current thread with MMCSS for audio scheduling.
///
/// Returns true if successful, false if MMCSS is unavailable or fails.
#[cfg(target_os = "windows")]
fn try_mmcss() -> bool {
    use windows_sys::Win32::System::Threading::{
        AvSetMmThreadCharacteristicsW, AvSetMmThreadPriority, AVRT_PRIORITY_HIGH,
    };

    // "Pro Audio" task provides the highest priority scheduling for audio
    // Other options: "Audio", "Capture", "Playback"
    let task_name: Vec<u16> = "Pro Audio\0".encode_utf16().collect();
    let mut task_index: u32 = 0;

    // SAFETY: AvSetMmThreadCharacteristicsW is safe to call with valid task name
    let handle = unsafe { AvSetMmThreadCharacteristicsW(task_name.as_ptr(), &mut task_index) };

    if handle.is_null() {
        log::debug!(
            "MMCSS AvSetMmThreadCharacteristicsW failed: {}",
            std::io::Error::last_os_error()
        );
        return false;
    }

    // Set priority within the MMCSS task (HIGH, not CRITICAL)
    // SAFETY: handle is valid from successful AvSetMmThreadCharacteristicsW
    let priority_result = unsafe { AvSetMmThreadPriority(handle, AVRT_PRIORITY_HIGH) };

    if priority_result == 0 {
        log::warn!(
            "MMCSS AvSetMmThreadPriority failed: {}",
            std::io::Error::last_os_error()
        );
        // Still registered with MMCSS, just at default priority
    }

    log::info!(
        "Streaming thread registered with MMCSS 'Pro Audio' (task index: {})",
        task_index
    );

    // Note: We intentionally don't call AvRevertMmThreadCharacteristics here.
    // The registration persists for the thread's lifetime, which is what we want.
    // It will be automatically cleaned up when the thread exits.

    true
}

// ─────────────────────────────────────────────────────────────────────────────
// Linux: Per-thread nice value using gettid + setpriority
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn raise_thread_priority_linux() {
    // SAFETY: These are standard libc calls
    unsafe {
        // Get this thread's ID (not process ID)
        let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;

        // Clear errno before checking
        *libc::__errno_location() = 0;

        // Set nice value to -10 for this specific thread
        // Requires CAP_SYS_NICE capability or root
        let result = libc::setpriority(libc::PRIO_PROCESS, tid as u32, -10);

        if result == 0 {
            log::info!("Streaming thread {} priority set to nice -10", tid);
        } else {
            log::warn!(
                "Failed to set streaming thread {} priority (requires CAP_SYS_NICE): {}",
                tid,
                std::io::Error::last_os_error()
            );
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS: pthread_setschedparam for per-thread priority
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn raise_thread_priority_macos() {
    // SAFETY: These are standard pthread/libc calls
    unsafe {
        let thread = libc::pthread_self();

        // Use SCHED_RR (round-robin) with elevated priority
        // Priority range for SCHED_RR is typically 1-99 on macOS
        let mut param: libc::sched_param = std::mem::zeroed();
        param.sched_priority = 47; // Mid-high priority (not max to avoid starvation)

        let result = libc::pthread_setschedparam(thread, libc::SCHED_RR, &param);

        if result == 0 {
            log::info!(
                "Streaming thread priority set to SCHED_RR:{}",
                param.sched_priority
            );
        } else {
            // Fall back to nice value (less effective but doesn't require root)
            *libc::__error() = 0;
            let nice_result = libc::setpriority(libc::PRIO_PROCESS, 0, -10);

            if nice_result == 0 {
                log::info!(
                    "Streaming thread priority set to nice -10 (pthread_setschedparam failed)"
                );
            } else {
                log::warn!(
                    "Failed to set streaming thread priority: {}",
                    std::io::Error::last_os_error()
                );
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic Unix fallback (BSD, etc.)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn raise_thread_priority_generic_unix() {
    // SAFETY: Standard POSIX call
    unsafe {
        let result = libc::setpriority(libc::PRIO_PROCESS, 0, -10);

        if result == 0 {
            log::info!("Streaming thread priority set to nice -10");
        } else {
            log::warn!(
                "Failed to set streaming thread priority: {}",
                std::io::Error::last_os_error()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use tokio::sync::oneshot;

    #[test]
    fn runtime_starts_and_stops() {
        let mut runtime = StreamingRuntime::new().expect("Failed to create runtime");

        // Use oneshot to signal task completion
        let (tx, rx) = oneshot::channel();

        runtime.spawn(async move {
            let _ = tx.send(42);
        });

        // Wait for task with timeout
        let result = rx.blocking_recv();
        assert_eq!(result, Ok(42));

        // Shutdown should complete cleanly
        runtime.shutdown();
    }

    #[test]
    fn runtime_handles_multiple_tasks() {
        let mut runtime = StreamingRuntime::new().expect("Failed to create runtime");

        let counter = Arc::new(AtomicU32::new(0));
        let (tx, rx) = oneshot::channel::<()>();
        let mut tx_opt = Some(tx);

        // Spawn 10 tasks, the last one signals completion
        for i in 0..10 {
            let counter_clone = Arc::clone(&counter);
            let tx = if i == 9 { tx_opt.take() } else { None };
            runtime.spawn(async move {
                counter_clone.fetch_add(1, Ordering::SeqCst);
                if let Some(tx) = tx {
                    let _ = tx.send(());
                }
            });
        }

        // Wait for all tasks to complete via oneshot signal
        let _ = rx.blocking_recv();

        assert_eq!(counter.load(Ordering::SeqCst), 10);

        runtime.shutdown();
    }
}
