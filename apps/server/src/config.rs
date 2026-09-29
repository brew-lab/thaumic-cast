//! Server configuration.
//!
//! Loads from a YAML file and validates the result. Environment variable and
//! CLI overrides are applied by the clap argument parser in `main.rs` (the
//! `THAUMIC_*` variables named below), which also rejects unparsable values;
//! `main` re-validates after applying them.

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use thaumic_core::DriftMode;

/// Server configuration loaded from YAML with environment overrides.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    /// Port to bind the HTTP server to.
    /// `0` means auto-assign: the first free port in 49400-49410 is used and
    /// advertised to Sonos speakers once the server is listening.
    /// Override: `THAUMIC_BIND_PORT`
    pub bind_port: u16,

    /// IP address to advertise to Sonos speakers.
    /// This should be the IP that Sonos speakers can reach.
    /// If not specified, auto-detection will be attempted.
    /// Override: `THAUMIC_ADVERTISE_IP`
    pub advertise_ip: Option<IpAddr>,

    /// Interval in seconds between topology refresh checks.
    /// Override: `THAUMIC_TOPOLOGY_REFRESH_INTERVAL`
    pub topology_refresh_interval: u64,

    /// Directory for persistent data (manual speakers config).
    /// Override: `THAUMIC_DATA_DIR`
    pub data_dir: Option<PathBuf>,

    /// URL for custom artwork (album art) displayed on Sonos.
    /// Should be an HTTPS URL for Android Sonos app compatibility.
    /// If not set, checks for `artwork.jpg` in data_dir, then uses embedded default.
    /// Override: `THAUMIC_ARTWORK_URL`
    pub artwork_url: Option<String>,

    /// Whether `/stream/{id}/live` refuses fetches from addresses the stream is
    /// not playing on.
    ///
    /// Defaults to `false`, which logs the unexpected address at `warn` and
    /// still serves the audio. Turn it on once those logs are quiet: a wrongly
    /// refused fetch is silent dead air on the speaker. One known case: a
    /// speaker whose address changes mid-cast (DHCP renewal, reboot) is
    /// refused until playback is restarted, because its session still names
    /// the old address.
    ///
    /// It binds the audio endpoint to whatever the control API has been told to
    /// play on, and that API is unauthenticated, so it is not a defence against
    /// an attacker actively driving it. See `thaumic_core::Config`.
    /// Override: `THAUMIC_STRICT_STREAM_ACCESS`
    pub strict_stream_access: bool,

    /// Whether each speaker playing a stream is polled for its playback
    /// position every few seconds, so a speaker about to run out of audio
    /// shows up in the log before it is heard.
    ///
    /// Defaults to `true`: about 24 quiet SOAP calls a minute per speaker
    /// that fetches a stream, never more than 120 a minute in all. `false`
    /// polls only casts whose client asked for video sync, as releases before
    /// this setting did. Applies from each speaker's next connection. See
    /// `thaumic_core::Config`.
    /// Override: `THAUMIC_SPEAKER_MONITOR` (`on` or `off`)
    pub speaker_monitor: bool,

    /// Milliseconds of already-captured audio sent to a speaker at once when
    /// it starts fetching a PCM (WAV) stream, before real-time pacing takes
    /// over, so it starts with that much in hand against Wi-Fi stalls. `0`
    /// turns it off.
    ///
    /// Defaults to 500. At most 2000. Latency grows by the same amount; video
    /// sync accounts for it. Compressed codecs are unaffected. Applies from
    /// each speaker's next connection. See `thaumic_core::Config`.
    /// Override: `THAUMIC_PCM_CONNECT_BURST_MS`
    pub pcm_connect_burst_ms: u64,

    /// Clock drift correction for PCM streams: `on` stretches or squeezes
    /// each speaker's audio by at most 150 ppm to hold its head start level
    /// over long casts, `observe` measures and logs what it would do, `off`
    /// does neither.
    ///
    /// Defaults to `observe`. Needs `speaker_monitor`: with the monitor off
    /// it runs as `off`, and startup warns once. Applies from each speaker's
    /// next connection. See `thaumic_core::Config`.
    /// Override: `THAUMIC_DRIFT_COMPENSATION` (`on`, `observe` or `off`)
    pub drift_compensation: DriftMode,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind_port: 49400,
            advertise_ip: None,
            topology_refresh_interval: 30,
            data_dir: None,
            artwork_url: None,
            strict_stream_access: false,
            speaker_monitor: true,
            pcm_connect_burst_ms: thaumic_core::protocol_constants::DEFAULT_PCM_CONNECT_BURST_MS,
            drift_compensation: DriftMode::default(),
        }
    }
}

impl ServerConfig {
    /// Loads and validates configuration from a YAML file.
    ///
    /// Without a path the defaults are used. Returns an error if the file
    /// cannot be read or parsed, or if any value is out of range.
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let config = if let Some(path) = path {
            let content = std::fs::read_to_string(path)
                .with_context(|| format!("Failed to read config file: {}", path.display()))?;
            Self::from_yaml(&content)
                .with_context(|| format!("Invalid config file: {}", path.display()))?
        } else {
            Self::default()
        };

        config.validate()?;
        Ok(config)
    }

    /// Parses configuration from a YAML document.
    fn from_yaml(content: &str) -> Result<Self> {
        serde_yaml::from_str(content).context("Failed to parse YAML")
    }

    /// Checks that all values are usable at runtime.
    ///
    /// Call this again after applying CLI overrides. A zero
    /// `topology_refresh_interval` would panic inside the topology monitor
    /// (`tokio::time::interval` rejects a zero period), and a
    /// `pcm_connect_burst_ms` above the maximum would only be clamped, with a warning in the
    /// log, rather than refused at startup. `bind_port` is not
    /// checked here: `0` is the supported auto-assign sentinel, and any other
    /// `u16` is a bindable port.
    pub fn validate(&self) -> Result<()> {
        if self.topology_refresh_interval == 0 {
            bail!("topology_refresh_interval must be at least 1 second (got 0)");
        }
        let max_burst = thaumic_core::protocol_constants::MAX_PCM_CONNECT_BURST_MS;
        if self.pcm_connect_burst_ms > max_burst {
            bail!(
                "pcm_connect_burst_ms must be at most {max_burst} (got {})",
                self.pcm_connect_burst_ms
            );
        }
        Ok(())
    }

    /// Converts to thaumic-core's Config type.
    pub fn to_core_config(&self) -> thaumic_core::Config {
        thaumic_core::Config {
            preferred_port: self.bind_port,
            topology_refresh_interval: self.topology_refresh_interval,
            strict_stream_access: self.strict_stream_access,
            speaker_monitor: self.speaker_monitor,
            pcm_connect_burst_ms: self.pcm_connect_burst_ms,
            drift_compensation: self.drift_compensation,
            ..Default::default()
        }
    }

    /// The warning to log when drift correction is asked for but cannot
    /// run, because `speaker_monitor` (whether speaker monitoring is on,
    /// environment included) is off: correction steers by the monitor, so
    /// it runs as `off`. `None` when there is nothing to warn about.
    pub fn drift_warning(&self, speaker_monitor: bool) -> Option<String> {
        (!speaker_monitor && self.drift_compensation != DriftMode::Off).then(|| {
            format!(
                "drift_compensation is {} but speaker_monitor is off; clock drift correction \
                 steers by the speaker monitor, so it runs as off",
                self.drift_compensation
            )
        })
    }

    /// Converts to thaumic-core's ArtworkConfig type.
    pub fn to_artwork_config(&self) -> thaumic_core::ArtworkConfig {
        thaumic_core::ArtworkConfig {
            url: self.artwork_url.clone(),
            data_dir: self.data_dir.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_valid() {
        let config = ServerConfig::default();
        assert!(config.validate().is_ok());
        assert!(ServerConfig::load(None).is_ok());
    }

    #[test]
    fn valid_yaml_is_accepted() {
        let config = ServerConfig::from_yaml(
            "bind_port: 8080\nadvertise_ip: 192.168.1.10\ntopology_refresh_interval: 5\n",
        )
        .expect("should parse");
        config.validate().expect("should validate");
        assert_eq!(config.bind_port, 8080);
        assert_eq!(config.advertise_ip, Some("192.168.1.10".parse().unwrap()));
        assert_eq!(config.topology_refresh_interval, 5);
    }

    #[test]
    fn zero_topology_refresh_interval_is_rejected() {
        let config =
            ServerConfig::from_yaml("topology_refresh_interval: 0\n").expect("should parse");
        let err = config.validate().expect_err("interval 0 must be rejected");
        assert!(err.to_string().contains("topology_refresh_interval"));
    }

    /// `0` is the auto-assign sentinel (`start_server` scans 49400-49410 and
    /// then publishes the chosen port), so it must keep validating.
    #[test]
    fn zero_bind_port_is_accepted_as_auto_assign() {
        let config = ServerConfig::from_yaml("bind_port: 0\n").expect("should parse");
        config.validate().expect("port 0 means auto-assign");
        assert_eq!(config.to_core_config().preferred_port, 0);
    }

    /// The flag ships off, and reaches core only when a config file turns it on.
    #[test]
    fn strict_stream_access_defaults_off_and_is_forwarded_to_core() {
        assert!(
            !ServerConfig::default()
                .to_core_config()
                .strict_stream_access
        );

        let config = ServerConfig::from_yaml("strict_stream_access: true\n").expect("should parse");
        assert!(config.to_core_config().strict_stream_access);
    }

    /// Monitoring ships on, and a config file can switch it off.
    #[test]
    fn speaker_monitor_defaults_on_and_is_forwarded_to_core() {
        assert!(ServerConfig::default().to_core_config().speaker_monitor);
        assert!(
            ServerConfig::from_yaml("bind_port: 8080\n")
                .expect("should parse")
                .to_core_config()
                .speaker_monitor
        );

        let config = ServerConfig::from_yaml("speaker_monitor: false\n").expect("should parse");
        assert!(!config.to_core_config().speaker_monitor);
    }

    /// Drift correction ships observing, reaches core, and a config file can
    /// set it.
    #[test]
    fn drift_compensation_defaults_to_observe_and_is_forwarded_to_core() {
        assert_eq!(
            ServerConfig::default().to_core_config().drift_compensation,
            DriftMode::Observe
        );
        let config = ServerConfig::from_yaml("drift_compensation: on\n").expect("should parse");
        assert_eq!(config.to_core_config().drift_compensation, DriftMode::On);
        assert!(ServerConfig::from_yaml("drift_compensation: sometimes\n").is_err());
    }

    /// Correction asked for with the monitor off is warned about once at
    /// startup; with it off, or the monitor on, there is nothing to say.
    #[test]
    fn server_warns_when_monitor_off() {
        let observe = ServerConfig::default();
        let warning = observe.drift_warning(false).expect("a warning");
        assert!(
            warning.contains("drift_compensation is observe"),
            "{warning}"
        );
        assert!(warning.contains("runs as off"), "{warning}");
        assert_eq!(observe.drift_warning(true), None);

        let off = ServerConfig::from_yaml("drift_compensation: off\n").expect("should parse");
        assert_eq!(off.drift_warning(false), None);
    }

    /// The connect burst ships on at 500 ms, reaches core, can be switched
    /// off, and is bounded.
    #[test]
    fn pcm_connect_burst_defaults_on_and_is_forwarded_to_core() {
        assert_eq!(
            ServerConfig::default()
                .to_core_config()
                .pcm_connect_burst_ms,
            500
        );

        let config = ServerConfig::from_yaml("pcm_connect_burst_ms: 0\n").expect("should parse");
        config.validate().expect("0 turns the burst off");
        assert_eq!(config.to_core_config().pcm_connect_burst_ms, 0);

        let config = ServerConfig::from_yaml("pcm_connect_burst_ms: 2000\n").expect("should parse");
        config.validate().expect("the maximum is allowed");

        let config = ServerConfig::from_yaml("pcm_connect_burst_ms: 2001\n").expect("should parse");
        let err = config.validate().expect_err("above the maximum");
        assert!(err.to_string().contains("pcm_connect_burst_ms"));
    }

    /// The installer copies the example to `/etc/thaumic-server/config.yaml`
    /// as it stands, so it must parse, validate, and leave every setting it
    /// spells out at the default the code ships with.
    #[test]
    fn config_example_parses_to_the_defaults() {
        let config = ServerConfig::from_yaml(include_str!("../config.example.yaml"))
            .expect("config.example.yaml should parse");
        config
            .validate()
            .expect("config.example.yaml should validate");

        let defaults = ServerConfig::default();
        assert_eq!(config.bind_port, defaults.bind_port);
        assert_eq!(config.advertise_ip, defaults.advertise_ip);
        assert_eq!(
            config.topology_refresh_interval,
            defaults.topology_refresh_interval
        );
        assert_eq!(config.data_dir, defaults.data_dir);
        assert_eq!(config.artwork_url, defaults.artwork_url);
        assert_eq!(config.strict_stream_access, defaults.strict_stream_access);
        assert_eq!(config.speaker_monitor, defaults.speaker_monitor);
        assert_eq!(config.pcm_connect_burst_ms, defaults.pcm_connect_burst_ms);
    }

    #[test]
    fn config_example_spells_out_the_speaker_settings() {
        let lines: Vec<&str> = include_str!("../config.example.yaml").lines().collect();
        for key in [
            format!(
                "speaker_monitor: {}",
                ServerConfig::default().speaker_monitor
            ),
            format!(
                "pcm_connect_burst_ms: {}",
                ServerConfig::default().pcm_connect_burst_ms
            ),
        ] {
            assert!(
                lines.contains(&key.as_str()),
                "config.example.yaml should set `{key}` uncommented"
            );
        }
    }

    #[test]
    fn unparsable_advertise_ip_is_rejected() {
        assert!(ServerConfig::from_yaml("advertise_ip: not-an-ip\n").is_err());
    }

    #[test]
    fn out_of_range_bind_port_is_rejected() {
        assert!(ServerConfig::from_yaml("bind_port: 70000\n").is_err());
    }
}
