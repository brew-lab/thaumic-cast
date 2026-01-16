//! Server configuration.
//!
//! Supports loading from YAML files with environment variable overrides.

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;

/// Server configuration loaded from YAML with environment overrides.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    /// Port to bind the HTTP server to.
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

    /// Enable SSDP multicast discovery.
    pub discovery_ssdp_multicast: bool,

    /// Enable SSDP broadcast discovery.
    pub discovery_ssdp_broadcast: bool,

    /// Enable mDNS/Bonjour discovery.
    pub discovery_mdns: bool,

    /// Directory for persistent data (manual speakers config).
    /// Override: `THAUMIC_DATA_DIR`
    pub data_dir: Option<PathBuf>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind_port: 49400,
            advertise_ip: None,
            topology_refresh_interval: 30,
            discovery_ssdp_multicast: true,
            discovery_ssdp_broadcast: true,
            discovery_mdns: true,
            data_dir: None,
        }
    }
}

impl ServerConfig {
    /// Loads configuration from a YAML file, then applies environment overrides.
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let mut config = if let Some(path) = path {
            let content = std::fs::read_to_string(path)
                .with_context(|| format!("Failed to read config file: {}", path.display()))?;
            serde_yaml::from_str(&content)
                .with_context(|| format!("Failed to parse config file: {}", path.display()))?
        } else {
            Self::default()
        };

        config.apply_env_overrides();
        Ok(config)
    }

    /// Applies environment variable overrides to the configuration.
    fn apply_env_overrides(&mut self) {
        if let Ok(val) = std::env::var("THAUMIC_BIND_PORT") {
            if let Ok(port) = val.parse() {
                self.bind_port = port;
            }
        }

        if let Ok(val) = std::env::var("THAUMIC_ADVERTISE_IP") {
            if let Ok(ip) = val.parse() {
                self.advertise_ip = Some(ip);
            }
        }

        if let Ok(val) = std::env::var("THAUMIC_TOPOLOGY_REFRESH_INTERVAL") {
            if let Ok(interval) = val.parse() {
                self.topology_refresh_interval = interval;
            }
        }

        // Note: THAUMIC_DATA_DIR is handled by clap via #[arg(env = ...)] in main.rs
    }

    /// Converts to thaumic-core's Config type.
    pub fn to_core_config(&self) -> thaumic_core::Config {
        thaumic_core::Config {
            preferred_port: self.bind_port,
            topology_refresh_interval: self.topology_refresh_interval,
            discovery_ssdp_multicast: self.discovery_ssdp_multicast,
            discovery_ssdp_broadcast: self.discovery_ssdp_broadcast,
            discovery_mdns: self.discovery_mdns,
            ..Default::default()
        }
    }
}
