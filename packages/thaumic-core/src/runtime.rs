//! Task spawning abstraction for runtime independence.
//!
//! This module provides a [`TaskSpawner`] trait that allows the core library
//! to spawn background tasks without being tied to a specific async runtime.
//! This enables the desktop app to use Tauri's runtime while the standalone
//! server uses Tokio directly.

use std::future::Future;

/// Abstraction for spawning background tasks.
///
/// Allows core services to spawn asynchronous work without knowing the
/// underlying runtime. Implementations should ensure tasks are properly
/// tracked and can complete even if the spawner is dropped.
///
/// # Example
///
/// ```ignore
/// struct MyService {
///     spawner: Arc<dyn TaskSpawner>,
/// }
///
/// impl MyService {
///     fn start_background_work(&self) {
///         self.spawner.spawn(async {
///             // Background work here
///         });
///     }
/// }
/// ```
pub trait TaskSpawner: Send + Sync {
    /// Spawns a future as a background task.
    ///
    /// The task runs independently of the caller and will continue until
    /// completion. The spawner does not provide a way to cancel or join
    /// the spawned task.
    fn spawn<F>(&self, future: F)
    where
        F: Future<Output = ()> + Send + 'static;
}

/// Tokio-based spawner for standalone server and general use.
///
/// Uses a Tokio runtime handle to spawn tasks. This is the default
/// implementation for non-Tauri environments.
#[derive(Clone)]
pub struct TokioSpawner {
    handle: tokio::runtime::Handle,
}

impl TokioSpawner {
    /// Creates a new `TokioSpawner` with the given runtime handle.
    #[must_use]
    pub fn new(handle: tokio::runtime::Handle) -> Self {
        Self { handle }
    }

    /// Creates a new `TokioSpawner` using the current runtime's handle.
    ///
    /// # Panics
    ///
    /// Panics if called outside of a Tokio runtime context.
    #[must_use]
    pub fn current() -> Self {
        Self {
            handle: tokio::runtime::Handle::current(),
        }
    }
}

impl TaskSpawner for TokioSpawner {
    fn spawn<F>(&self, future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.handle.spawn(future);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn tokio_spawner_executes_task() {
        let spawner = TokioSpawner::current();
        let executed = Arc::new(AtomicBool::new(false));
        let executed_clone = executed.clone();

        spawner.spawn(async move {
            executed_clone.store(true, Ordering::SeqCst);
        });

        // Give the task time to execute
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        assert!(executed.load(Ordering::SeqCst));
    }
}
