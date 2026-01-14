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
    bootstrap_services_with_network, start_server, AppStateBuilder, NetworkContext,
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
        config.advertise_ip = ip;
    }

    log::info!(
        "Configuration: bind_port={}, advertise_ip={}",
        config.bind_port,
        config.advertise_ip
    );

    // Create explicit network context for server mode
    let network = NetworkContext::explicit(config.bind_port, config.advertise_ip);

    // Bootstrap services with explicit network configuration
    let core_config = config.to_core_config();
    let handle = tokio::runtime::Handle::current();
    let services = bootstrap_services_with_network(&core_config, network, handle)
        .context("Failed to bootstrap services")?;

    log::info!("Services bootstrapped successfully");

    // Start background tasks
    services.discovery_service.start_renewal_task();
    Arc::clone(&services.discovery_service).start_topology_monitor();
    services.latency_monitor.start();

    log::info!("Background tasks started");

    // Build app state for the HTTP server
    let app_state = AppStateBuilder::new()
        .sonos(Arc::clone(&services.sonos))
        .stream_coordinator(Arc::clone(&services.stream_coordinator))
        .discovery_service(Arc::clone(&services.discovery_service))
        .sonos_state(Arc::clone(&services.sonos_state))
        .broadcast_tx(services.broadcast_tx.clone())
        .event_bridge(Arc::clone(&services.event_bridge))
        .network(services.network.clone())
        .ws_manager(Arc::clone(&services.ws_manager))
        .latency_monitor(Arc::clone(&services.latency_monitor))
        .config(Arc::new(RwLock::new(core_config)))
        .build();

    // Spawn HTTP server
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
