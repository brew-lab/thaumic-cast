//! Tokio-based task spawning.

use std::future::Future;

/// Spawns background tasks on a Tokio runtime.
///
/// Wraps a Tokio runtime handle to spawn fire-and-forget async tasks.
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

    /// Spawns a future as a background task.
    ///
    /// The task runs independently of the caller and will continue until
    /// completion.
    pub fn spawn<F>(&self, future: F)
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
        let spawner = TokioSpawner::new(tokio::runtime::Handle::current());
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
