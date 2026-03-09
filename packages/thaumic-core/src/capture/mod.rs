//! Audio capture abstractions for platform-specific audio sources.
//!
//! This module defines the [`AudioSource`] and [`AudioSink`] traits used by
//! platform-specific capture implementations (e.g., WASAPI process loopback).
//! Sources push Float32 interleaved audio to sinks, which can bridge into
//! the streaming pipeline or collect samples for diagnostics.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::stream::AudioFormat;

/// Trait for audio capture sources that push frames into the streaming pipeline.
///
/// Each source instance is single-use: after `start()` + `stop()`,
/// create a new instance for the next capture session.
pub trait AudioSource: Send + Sync {
    /// Start capturing. Returns a handle for monitoring errors and stopping.
    ///
    /// The source spawns a dedicated capture thread and pushes audio to the sink.
    /// Returns `CaptureError::AlreadyStarted` if called while a previous capture
    /// session is still active.
    fn start(&self, sink: Arc<dyn AudioSink>) -> Result<CaptureHandle, CaptureError>;

    /// Human-readable name for logging/UI.
    fn name(&self) -> &str;

    /// Audio format this source produces (used for logging/diagnostics).
    ///
    /// Note: the source delivers Float32 samples via `AudioSink::push_audio`.
    /// The bridge layer handles conversion to the pipeline's PCM16 format.
    fn format(&self) -> AudioFormat;
}

/// Receives Float32 interleaved audio frames from a capture source.
pub trait AudioSink: Send + Sync {
    /// Called by the source on each captured audio buffer.
    ///
    /// `data` is Float32 interleaved samples (e.g., `[L, R, L, R, ...]`).
    /// `frames` is the number of audio frames (samples / channels).
    /// `channels` is the channel count (typically 2).
    /// `flags` contains platform-specific buffer status (discontinuity, silence).
    fn push_audio(&self, data: &[f32], frames: u32, channels: u16, flags: BufferFlags);
}

/// Platform-agnostic buffer status flags passed with each audio callback.
#[derive(Debug, Clone, Copy, Default)]
pub struct BufferFlags {
    /// A gap was detected in the audio stream (e.g., WASAPI `DATA_DISCONTINUITY`).
    pub discontinuity: bool,
    /// The buffer contains silence (e.g., WASAPI `AUDCLNT_BUFFERFLAGS_SILENT`).
    pub silent: bool,
}

/// Returned by `AudioSource::start()` — owns the capture lifetime.
///
/// Dropping the handle cancels the capture (via `CancellationToken`).
/// Call `stop_and_wait()` for graceful shutdown with cleanup confirmation.
pub struct CaptureHandle {
    /// Receive async errors (disconnections, device changes, process exit, etc.)
    pub errors: tokio::sync::mpsc::Receiver<CaptureError>,
    cancel: CancellationToken,
    join_handle: Option<std::thread::JoinHandle<()>>,
}

impl CaptureHandle {
    /// Create a new `CaptureHandle`.
    pub fn new(
        errors: tokio::sync::mpsc::Receiver<CaptureError>,
        cancel: CancellationToken,
        join_handle: std::thread::JoinHandle<()>,
    ) -> Self {
        Self {
            errors,
            cancel,
            join_handle: Some(join_handle),
        }
    }

    /// Signal capture to stop and wait for the thread to finish cleanup.
    pub fn stop_and_wait(mut self) {
        self.cancel.cancel();
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
    }

    /// Signal capture to stop without waiting.
    pub fn stop(self) {
        self.cancel.cancel();
        // join_handle dropped — thread finishes in background
    }

    /// Returns true if the capture has been cancelled.
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.cancel.cancel();
        // Don't join in drop — could block unexpectedly.
        // Thread will see cancellation and exit on its own.
    }
}

/// Errors that can occur during audio capture.
#[derive(Debug, Clone, thiserror::Error)]
pub enum CaptureError {
    /// Capture has already been started on this source instance.
    #[error("Capture already started")]
    AlreadyStarted,

    /// Audio device was disconnected or changed during capture.
    #[error("Audio device disconnected or changed")]
    DeviceDisconnected,

    /// The target process exited during capture.
    #[error("Target process exited")]
    ProcessExited,

    /// Platform-specific error.
    #[error("Platform error: {0}")]
    Platform(String),

    /// The audio format is not supported.
    #[error("Unsupported audio format")]
    UnsupportedFormat,

    /// Failed to spawn the capture thread.
    #[error("Thread spawn failed: {0}")]
    ThreadSpawn(String),
}
