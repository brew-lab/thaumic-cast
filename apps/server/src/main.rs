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

/// Thaumic Cast Server: browser audio to Sonos speakers, for a machine with no screen.
#[derive(Parser, Debug)]
#[command(name = "thaumic-server")]
#[command(author, version, about, long_about = None)]
struct Args {
    /// Configuration file, in YAML. Without one the defaults are used.
    #[arg(short, long, value_name = "FILE")]
    config: Option<PathBuf>,

    /// How much to say in the log: error, warn, info, debug or trace.
    #[arg(short, long, default_value = "info", env = "THAUMIC_LOG_LEVEL")]
    log_level: log::LevelFilter,

    /// Port to listen on (overrides bind_port). Extensions and speakers both come
    /// to it. 0 takes the first free port from 49400 to 49410.
    #[arg(short = 'p', long, env = "THAUMIC_BIND_PORT")]
    port: Option<u16>,

    /// Address the speakers fetch audio from. It must be one they can reach.
    /// Overrides advertise_ip. Left unset, it is worked out from the network.
    #[arg(short = 'a', long, env = "THAUMIC_ADVERTISE_IP")]
    advertise_ip: Option<std::net::IpAddr>,

    /// Directory for what must outlast a restart (overrides data_dir): speakers
    /// added by IP address, and artwork.jpg if you keep one there. Without it,
    /// speakers cannot be added by IP address.
    #[arg(short = 'd', long, env = "THAUMIC_DATA_DIR")]
    data_dir: Option<PathBuf>,

    /// Seconds between checks on which speakers exist and how they are grouped
    /// (overrides config file). 30 by default.
    #[arg(long, value_name = "SECS", env = "THAUMIC_TOPOLOGY_REFRESH_INTERVAL")]
    topology_refresh_interval: Option<u64>,

    /// URL of the picture Sonos shows while a cast plays (overrides config file).
    /// An empty value is ignored.
    #[arg(long, value_name = "URL", env = "THAUMIC_ARTWORK_URL")]
    artwork_url: Option<String>,

    /// Refuse audio fetches from addresses the cast is not playing on (overrides
    /// config file). Off by default: strangers are logged and served, because a
    /// wrong refusal is silence and a wrong welcome is only a log line.
    #[arg(long, value_name = "BOOL", env = "THAUMIC_STRICT_STREAM_ACCESS")]
    strict_stream_access: Option<bool>,

    /// Speaker monitoring, on or off (overrides config file): ask each speaker that
    /// is playing a cast how far it has got. On by default. off asks only the casts
    /// that wanted video sync, and clock drift correction goes without.
    #[arg(
        long,
        value_name = "on|off",
        env = thaumic_core::services::SPEAKER_MONITOR_ENV,
        value_parser = parse_speaker_monitor
    )]
    speaker_monitor: Option<bool>,

    /// Speaker head start in ms, 0-2000: audio sent in advance against Wi-Fi stalls
    /// (overrides config file). 500 by default; 0 is off. PCM casts only.
    #[arg(
        long,
        value_name = "MS",
        env = thaumic_core::stream::PCM_CONNECT_BURST_ENV,
        value_parser = thaumic_core::stream::parse_pcm_connect_burst_ms
    )]
    pcm_connect_burst_ms: Option<u64>,

    /// Clock drift correction, PCM only: on, observe or off (overrides config file).
    /// On by default. observe works out the correction, logs it, and does nothing.
    /// Needs speaker monitoring.
    #[arg(
        long,
        value_name = "on|observe|off",
        env = thaumic_core::services::DRIFT_COMPENSATION_ENV,
        value_parser = parse_drift_compensation
    )]
    drift_compensation: Option<thaumic_core::DriftMode>,
}

/// Parses `--drift-compensation` / `THAUMIC_DRIFT_COMPENSATION`.
fn parse_drift_compensation(value: &str) -> Result<thaumic_core::DriftMode, String> {
    thaumic_core::DriftMode::parse(value)
        .ok_or_else(|| format!("expected on, observe or off, got {value:?}"))
}

/// Parses `--speaker-monitor` / `THAUMIC_SPEAKER_MONITOR`.
fn parse_speaker_monitor(value: &str) -> Result<bool, String> {
    thaumic_core::services::latency_monitor::parse_speaker_monitor_switch(value)
        .ok_or_else(|| format!("expected on or off, got {value:?}"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Initialize logging
    env_logger::Builder::new()
        .filter_level(args.log_level)
        .format_timestamp_millis()
        .init();

    log::info!("Thaumic Cast Server v{}", env!("CARGO_PKG_VERSION"));

    // Load configuration
    let mut config = ServerConfig::load(args.config.as_deref())
        .context("Nothing was started: the configuration could not be loaded")?;

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
    if let Some(monitor) = args.speaker_monitor {
        config.speaker_monitor = monitor;
    }
    if let Some(burst) = args.pcm_connect_burst_ms {
        config.pcm_connect_burst_ms = burst;
    }
    if let Some(mode) = args.drift_compensation {
        config.drift_compensation = mode;
    }

    // CLI/env overrides can introduce invalid values (e.g. --port 0), so
    // validate the merged configuration before anything is started.
    config
        .validate()
        .context("The configuration cannot be used, and nothing was started")?;
    log::info!(
        "Speaker monitoring: {}",
        if config.speaker_monitor {
            "on"
        } else {
            "off (casts with video sync are still asked)"
        }
    );
    if config.pcm_connect_burst_ms > 0 {
        log::info!(
            "Speaker head start: {} ms (pcm_connect_burst_ms; each speaker starts that far ahead)",
            config.pcm_connect_burst_ms
        );
    } else {
        log::info!("Speaker head start: off (pcm_connect_burst_ms is 0)");
    }
    let speaker_monitor = thaumic_core::services::speaker_monitor_enabled(config.speaker_monitor);
    match config.drift_warning(speaker_monitor) {
        Some(warning) => log::warn!("{warning}"),
        None => log::info!(
            "Clock drift correction: {} (PCM casts only)",
            config.drift_compensation
        ),
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
            "Could not work out this machine's address. Set --advertise-ip or \
             THAUMIC_ADVERTISE_IP to one the speakers can reach.",
        )?
    };

    // Bootstrap services with explicit network configuration
    let core_config = config.to_core_config();
    let handle = tokio::runtime::Handle::current();
    let services = bootstrap_services_with_network(&core_config, network, handle)
        .context("The services did not start")?;

    log::info!("Services started");

    // Set data directory BEFORE starting background tasks so initial topology
    // refresh includes manual speakers. This must happen before start_background_tasks().
    if let Some(ref data_dir) = config.data_dir {
        log::info!(
            "Data directory: {} (speakers added by IP address are kept here)",
            data_dir.display()
        );
        services.discovery_service.set_app_data_dir(data_dir);
    } else {
        log::info!(
            "No data_dir set: speakers cannot be added by IP address, there being nowhere \
             to keep them. Set --data-dir or THAUMIC_DATA_DIR."
        );
    }

    // Start background tasks (topology monitor will load manual speakers if data_dir set)
    services.start_background_tasks();

    log::info!("Asking the network for speakers");

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
    // start_server logs "Listening on port", with the address the extension is
    // given, once the bind succeeds.
    let mut server_handle = services.streaming_runtime.spawn(start_server(app_state));

    // Run until a shutdown signal arrives or the HTTP server stops. A server
    // failure (e.g. the bind port is already in use) must be fatal so that a
    // supervisor such as systemd sees the exit and can restart the unit.
    tokio::select! {
        _ = shutdown_signal() => {
            log::info!("Asked to stop. Stopping every cast first.");

            // Graceful shutdown
            services.shutdown().await;

            // Abort the server task (it will have stopped when the services shut down)
            server_handle.abort();

            log::info!("Stopped");
            Ok(())
        }
        result = &mut server_handle => {
            let err = match result {
                Ok(Ok(())) => anyhow!("The HTTP server stopped without being asked to"),
                Ok(Err(e)) => anyhow::Error::new(e).context("The HTTP server failed"),
                Err(e) => anyhow::Error::new(e).context("The HTTP server task failed"),
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

    /// Parses `args` while no other test has the environment changed: clap
    /// reads the `THAUMIC_*` variables on every parse, so a parse that runs
    /// beside [`with_env`] would see that test's value.
    fn parse(args: &[&str]) -> Result<Args, clap::Error> {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        Args::try_parse_from(args)
    }

    /// Every override is a real clap flag, so unparsable values are reported
    /// rather than silently ignored.
    #[test]
    fn unparsable_override_values_are_rejected() {
        assert!(parse(&["thaumic-server", "--port", "not-a-port"]).is_err());
        assert!(parse(&["thaumic-server", "--advertise-ip", "not-an-ip"]).is_err());
        assert!(parse(&[
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
        let args = parse(&[
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

        with_env("THAUMIC_SPEAKER_MONITOR", "sometimes", || {
            assert!(Args::try_parse_from(["thaumic-server"]).is_err());
        });
        with_env("THAUMIC_SPEAKER_MONITOR", "off", || {
            let args = Args::try_parse_from(["thaumic-server"]).expect("valid env value");
            assert_eq!(args.speaker_monitor, Some(false));
        });
        with_env("THAUMIC_SPEAKER_MONITOR", "on", || {
            let args = Args::try_parse_from(["thaumic-server"]).expect("valid env value");
            assert_eq!(args.speaker_monitor, Some(true));
        });

        with_env("THAUMIC_PCM_CONNECT_BURST_MS", "lots", || {
            assert!(Args::try_parse_from(["thaumic-server"]).is_err());
        });
        with_env("THAUMIC_PCM_CONNECT_BURST_MS", "2001", || {
            assert!(Args::try_parse_from(["thaumic-server"]).is_err());
        });
        with_env("THAUMIC_PCM_CONNECT_BURST_MS", "0", || {
            let args = Args::try_parse_from(["thaumic-server"]).expect("valid env value");
            assert_eq!(args.pcm_connect_burst_ms, Some(0));
        });
        with_env("THAUMIC_PCM_CONNECT_BURST_MS", "1000", || {
            let args = Args::try_parse_from(["thaumic-server"]).expect("valid env value");
            assert_eq!(args.pcm_connect_burst_ms, Some(1000));
        });

        with_env("THAUMIC_DRIFT_COMPENSATION", "sometimes", || {
            assert!(Args::try_parse_from(["thaumic-server"]).is_err());
        });
        with_env("THAUMIC_DRIFT_COMPENSATION", "on", || {
            let args = Args::try_parse_from(["thaumic-server"]).expect("valid env value");
            assert_eq!(args.drift_compensation, Some(thaumic_core::DriftMode::On));
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
