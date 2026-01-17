//! Application lifecycle abstraction.
//!
//! This module provides a [`Lifecycle`] trait for controlling application
//! lifecycle operations like restart and shutdown. Different implementations
//! handle these operations appropriately for their environment (Tauri app
//! vs standalone server).

/// Trait for application lifecycle operations.
///
/// Services that need to trigger application-level actions (like restarting
/// after a configuration change) use this trait rather than directly calling
/// platform-specific APIs.
///
/// # Example
///
/// ```ignore
/// struct ConfigService {
///     lifecycle: Arc<dyn Lifecycle>,
/// }
///
/// impl ConfigService {
///     fn apply_config_requiring_restart(&self, config: Config) {
///         // Save config...
///         self.lifecycle.request_restart();
///     }
/// }
/// ```
pub trait Lifecycle: Send + Sync {
    /// Requests an application restart.
    ///
    /// The implementation determines how the restart is performed:
    /// - Tauri app: Uses Tauri's restart API
    /// - Standalone server: May log and exit (requiring orchestrator restart)
    fn request_restart(&self);

    /// Requests a graceful shutdown.
    ///
    /// The application should clean up resources and exit cleanly.
    fn request_shutdown(&self);
}

/// Server lifecycle implementation for standalone deployment.
///
/// For the standalone server, restart is not directly supported (the server
/// logs and expects an external orchestrator to handle restart). Shutdown
/// triggers a clean process exit.
pub struct ServerLifecycle;

impl Lifecycle for ServerLifecycle {
    fn request_restart(&self) {
        tracing::info!("Restart requested - server requires manual restart or orchestrator");
        // In a containerized environment, exiting with a specific code
        // could signal the orchestrator to restart. For now, just log.
    }

    fn request_shutdown(&self) {
        tracing::info!("Shutdown requested");
        std::process::exit(0);
    }
}

/// No-op lifecycle for testing or embedded use.
///
/// Does nothing on restart/shutdown requests. Useful in tests or when
/// embedding the core library in an application that manages its own lifecycle.
pub struct NoopLifecycle;

impl Lifecycle for NoopLifecycle {
    fn request_restart(&self) {
        tracing::debug!("Restart requested (no-op)");
    }

    fn request_shutdown(&self) {
        tracing::debug!("Shutdown requested (no-op)");
    }
}
