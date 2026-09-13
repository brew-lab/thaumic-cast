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
    /// refused fetch is silent dead air on the speaker.
    ///
    /// It binds the audio endpoint to whatever the control API has been told to
    /// play on, and that API is unauthenticated, so it is not a defence against
    /// an attacker actively driving it. See `thaumic_core::Config`.
    /// Override: `THAUMIC_STRICT_STREAM_ACCESS`
    pub strict_stream_access: bool,
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
    /// (`tokio::time::interval` rejects a zero period). `bind_port` is not
    /// checked here: `0` is the supported auto-assign sentinel, and any other
    /// `u16` is a bindable port.
    pub fn validate(&self) -> Result<()> {
        if self.topology_refresh_interval == 0 {
            bail!("topology_refresh_interval must be at least 1 second (got 0)");
        }
        Ok(())
    }

    /// Converts to thaumic-core's Config type.
    pub fn to_core_config(&self) -> thaumic_core::Config {
        thaumic_core::Config {
            preferred_port: self.bind_port,
            topology_refresh_interval: self.topology_refresh_interval,
            strict_stream_access: self.strict_stream_access,
            ..Default::default()
        }
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

    #[test]
    fn unparsable_advertise_ip_is_rejected() {
        assert!(ServerConfig::from_yaml("advertise_ip: not-an-ip\n").is_err());
    }

    #[test]
    fn out_of_range_bind_port_is_rejected() {
        assert!(ServerConfig::from_yaml("bind_port: 70000\n").is_err());
    }
}
