//! Thaumic Server - Standalone headless server for Thaumic Cast.
//!
//! This binary provides the same audio streaming functionality as the desktop
//! app but without a GUI. It's designed for server deployments where the
//! Thaumic Cast service runs as a background daemon.

mod config;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use parking_lot::RwLock;
use thaumic_core::{
    bootstrap_services_with_network, start_server, AppState, LocalIpDetector, NetworkContext,
};
use tokio::signal;

use crate::config::ServerConfig;

/// Thaumic Server - Headless browser-to-Sonos audio streaming server.
#[derive(Parser, Debug)]
#[command(name = "thaumic-server")]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Path to the configuration file (YAML).
    #[arg(short, long, value_name = "FILE")]
    config: Option<PathBuf>,

    /// Log level (error, warn, info, debug, trace).
    #[arg(short, long, default_value = "info", env = "THAUMIC_LOG_LEVEL")]
    log_level: log::LevelFilter,

    /// Bind port (overrides config file).
    #[arg(short = 'p', long, env = "THAUMIC_BIND_PORT")]
    port: Option<u16>,

    /// Advertise IP address (overrides config file).
    #[arg(short = 'a', long, env = "THAUMIC_ADVERTISE_IP")]
    advertise_ip: Option<std::net::IpAddr>,

    /// Data directory for persistent state (manual speakers, etc.).
    #[arg(short = 'd', long, env = "THAUMIC_DATA_DIR")]
    data_dir: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Initialize logging
    env_logger::Builder::new()
        .filter_level(args.log_level)
        .format_timestamp_millis()
        .init();

    log::info!("Thaumic Server v{}", env!("CARGO_PKG_VERSION"));

    // Load configuration
    let mut config =
        ServerConfig::load(args.config.as_deref()).context("Failed to load configuration")?;

    // Apply CLI overrides
    if let Some(port) = args.port {
        config.bind_port = port;
    }
    if let Some(ip) = args.advertise_ip {
        config.advertise_ip = Some(ip);
    }
    if let Some(data_dir) = args.data_dir {
        config.data_dir = Some(data_dir);
    }

    // Resolve advertise IP: use explicit config, or fall back to auto-detection
    let network = if let Some(ip) = config.advertise_ip {
        log::info!(
            "Configuration: bind_port={}, advertise_ip={}",
            config.bind_port,
            ip
        );
        NetworkContext::explicit(config.bind_port, ip)
    } else {
        log::info!(
            "Configuration: bind_port={}, advertise_ip=auto",
            config.bind_port
        );
        let detector = LocalIpDetector::arc();
        NetworkContext::auto_detect(config.bind_port, detector).context(
            "Failed to auto-detect local IP address. \
             Please specify --advertise-ip or set THAUMIC_ADVERTISE_IP to the IP \
             address that Sonos speakers can reach.",
        )?
    };

    // Bootstrap services with explicit network configuration
    let core_config = config.to_core_config();
    let handle = tokio::runtime::Handle::current();
    let services = bootstrap_services_with_network(&core_config, network, handle)
        .context("Failed to bootstrap services")?;

    log::info!("Services bootstrapped successfully");

    // Set data directory BEFORE starting background tasks so initial topology
    // refresh includes manual speakers. This must happen before start_background_tasks().
    if let Some(ref data_dir) = config.data_dir {
        log::info!("Using data directory: {}", data_dir.display());
        services.discovery_service.set_app_data_dir(data_dir);
    } else {
        log::info!("No data directory configured - manual speakers will not persist");
    }

    // Start background tasks (topology monitor will load manual speakers if data_dir set)
    services.start_background_tasks();

    log::info!("Background tasks started");

    // Build app state for the HTTP server
    let app_state = AppState::new(
        &services,
        Arc::new(RwLock::new(core_config)),
        config.to_artwork_config(),
    );

    // Spawn HTTP server on the main tokio runtime.
    // Unlike the desktop app (which uses a dedicated high-priority streaming runtime
    // to avoid UI thread contention), the server has no UI and the main runtime
    // is sufficient for consistent audio delivery.
    let server_handle = tokio::spawn(async move {
        if let Err(e) = start_server(app_state).await {
            log::error!("Server error: {}", e);
        }
    });

    log::info!("HTTP server started on port {}", config.bind_port);

    // Wait for shutdown signal
    shutdown_signal().await;

    log::info!("Shutdown signal received, cleaning up...");

    // Graceful shutdown
    services.shutdown().await;

    // Abort the server task (it will have stopped when the services shut down)
    server_handle.abort();

    log::info!("Shutdown complete");
    Ok(())
}

/// Waits for a shutdown signal (Ctrl+C or SIGTERM).
async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
