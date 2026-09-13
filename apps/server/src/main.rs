//! Thaumic Server - Standalone headless server for Thaumic Cast.
//!
//! This binary provides the same audio streaming functionality as the desktop
//! app but without a GUI. It's designed for server deployments where the
//! Thaumic Cast service runs as a background daemon.

mod config;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use parking_lot::RwLock;
use thaumic_core::{
    bootstrap_services_with_network, start_server, AppInfo, AppState, AppType, LocalIpDetector,
    NetworkContext,
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

    /// Seconds between topology refresh checks (overrides config file).
    #[arg(long, value_name = "SECS", env = "THAUMIC_TOPOLOGY_REFRESH_INTERVAL")]
    topology_refresh_interval: Option<u64>,

    /// Custom artwork URL shown on Sonos (overrides config file; empty is ignored).
    #[arg(long, value_name = "URL", env = "THAUMIC_ARTWORK_URL")]
    artwork_url: Option<String>,

    /// Refuse audio fetches from addresses the stream is not playing on
    /// (overrides config file). Off by default: unexpected addresses are logged
    /// and still served, because a wrongly refused fetch is silent dead air.
    #[arg(long, value_name = "BOOL", env = "THAUMIC_STRICT_STREAM_ACCESS")]
    strict_stream_access: Option<bool>,
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
    if let Some(interval) = args.topology_refresh_interval {
        config.topology_refresh_interval = interval;
    }
    if let Some(url) = args.artwork_url.filter(|url| !url.trim().is_empty()) {
        config.artwork_url = Some(url);
    }
    if let Some(strict) = args.strict_stream_access {
        config.strict_stream_access = strict;
    }

    // CLI/env overrides can introduce invalid values (e.g. --port 0), so
    // validate the merged configuration before anything is started.
    config.validate().context("Invalid configuration")?;

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
        AppInfo::new(env!("CARGO_PKG_VERSION"), AppType::Server),
    );

    // Serve HTTP (audio streams, WebSocket, API) on the dedicated streaming
    // runtime, as the desktop app does. Its workers raise their scheduling
    // priority (CAP_SYS_NICE on Linux), which keeps audio cadence steady when
    // the host is under load; the main runtime keeps discovery and GENA work.
    // start_server logs "Server listening" once the bind succeeds.
    let mut server_handle = services.streaming_runtime.spawn(start_server(app_state));

    // Run until a shutdown signal arrives or the HTTP server stops. A server
    // failure (e.g. the bind port is already in use) must be fatal so that a
    // supervisor such as systemd sees the exit and can restart the unit.
    tokio::select! {
        _ = shutdown_signal() => {
            log::info!("Shutdown signal received, cleaning up...");

            // Graceful shutdown
            services.shutdown().await;

            // Abort the server task (it will have stopped when the services shut down)
            server_handle.abort();

            log::info!("Shutdown complete");
            Ok(())
        }
        result = &mut server_handle => {
            let err = match result {
                Ok(Ok(())) => anyhow!("HTTP server exited unexpectedly"),
                Ok(Err(e)) => anyhow::Error::new(e).context("HTTP server failed"),
                Err(e) => anyhow::Error::new(e).context("HTTP server task failed"),
            };
            log::error!("{err:#}");

            services.shutdown().await;

            Err(err)
        }
    }
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::Args;
    use clap::Parser;

    /// Serialises the tests that mutate the process-global environment, which
    /// clap reads while parsing.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Runs `f` with `key` set to `value`, restoring the previous value after.
    fn with_env<T>(key: &str, value: &str, f: impl FnOnce() -> T) -> T {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        let result = f();
        match previous {
            Some(previous) => std::env::set_var(key, previous),
            None => std::env::remove_var(key),
        }
        result
    }

    /// Every override is a real clap flag, so unparsable values are reported
    /// rather than silently ignored.
    #[test]
    fn unparsable_override_values_are_rejected() {
        assert!(Args::try_parse_from(["thaumic-server", "--port", "not-a-port"]).is_err());
        assert!(Args::try_parse_from(["thaumic-server", "--advertise-ip", "not-an-ip"]).is_err());
        assert!(Args::try_parse_from([
            "thaumic-server",
            "--topology-refresh-interval",
            "not-a-number",
        ])
        .is_err());
    }

    /// The overrides that used to be parsed by hand in `config.rs` are now
    /// clap flags that actually reach `Args`.
    #[test]
    fn override_flags_are_parsed() {
        let args = Args::try_parse_from([
            "thaumic-server",
            "--topology-refresh-interval",
            "5",
            "--artwork-url",
            "https://example.test/art.jpg",
            "--port",
            "49401",
        ])
        .expect("valid overrides should parse");
        assert_eq!(args.topology_refresh_interval, Some(5));
        assert_eq!(
            args.artwork_url.as_deref(),
            Some("https://example.test/art.jpg")
        );
        assert_eq!(args.port, Some(49401));
    }

    /// `THAUMIC_*` values reach `Args` through the same clap parser, so an
    /// invalid one fails the parse instead of being swallowed.
    #[test]
    fn environment_overrides_are_parsed_and_validated() {
        with_env("THAUMIC_TOPOLOGY_REFRESH_INTERVAL", "abc", || {
            assert!(Args::try_parse_from(["thaumic-server"]).is_err());
        });
        with_env("THAUMIC_TOPOLOGY_REFRESH_INTERVAL", "5", || {
            let args = Args::try_parse_from(["thaumic-server"]).expect("valid env value");
            assert_eq!(args.topology_refresh_interval, Some(5));
        });

        with_env("THAUMIC_BIND_PORT", "not-a-port", || {
            assert!(Args::try_parse_from(["thaumic-server"]).is_err());
        });
        with_env("THAUMIC_BIND_PORT", "49401", || {
            let args = Args::try_parse_from(["thaumic-server"]).expect("valid env value");
            assert_eq!(args.port, Some(49401));
        });

        with_env(
            "THAUMIC_ARTWORK_URL",
            "https://example.test/art.jpg",
            || {
                let args = Args::try_parse_from(["thaumic-server"]).expect("valid env value");
                assert_eq!(
                    args.artwork_url.as_deref(),
                    Some("https://example.test/art.jpg")
                );
            },
        );
    }
}
