//! The drift correction mode: the setting, and what a connection runs under.

use serde::{Deserialize, Serialize};

/// Environment variable that sets drift correction: `on`, `observe` or
/// `off`. Read once at start-up (see [`crate::companion_settings`]).
pub const DRIFT_COMPENSATION_ENV: &str = "THAUMIC_DRIFT_COMPENSATION";

/// Clock drift correction for PCM streams.
///
/// Read once per connection, so a change never engages or releases an
/// adapter mid-connection.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DriftMode {
    /// Nothing measured for correction, nothing corrected.
    Off,
    /// The controller runs and logs what it would command; the audio is
    /// left exactly as captured.
    Observe,
    /// Every PCM connection's audio is stretched or squeezed to hold its
    /// speaker's reserve level. The default.
    #[default]
    On,
}

impl DriftMode {
    /// The mode as its config and wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Observe => "observe",
            Self::On => "on",
        }
    }

    /// Parses `on`, `observe` or `off` (any case, surrounding space
    /// ignored), or `None` if it is none of them.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "on" => Some(Self::On),
            "observe" => Some(Self::Observe),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
}

impl std::fmt::Display for DriftMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The drift correction mode a new connection runs under, given the
/// configured setting and whether speaker monitoring is on for it.
///
/// Correction steers by the speaker monitor's estimates, so with monitoring
/// off it is off whatever the setting says. The environment plays no part
/// here; it was settled at start-up (see [`crate::companion_settings`]).
pub fn drift_compensation_mode(configured: DriftMode, monitor: bool) -> DriftMode {
    if monitor {
        configured
    } else {
        DriftMode::Off
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mode_parses_and_prints_its_config_strings() {
        for mode in [DriftMode::On, DriftMode::Observe, DriftMode::Off] {
            assert_eq!(DriftMode::parse(mode.as_str()), Some(mode));
            assert_eq!(
                serde_json::to_string(&mode).unwrap(),
                format!("\"{}\"", mode.as_str())
            );
        }
        assert_eq!(DriftMode::parse(" ON "), Some(DriftMode::On));
        assert_eq!(DriftMode::parse("sometimes"), None);
        assert_eq!(DriftMode::default(), DriftMode::On);
    }

    #[test]
    fn no_monitor_means_off_whatever_the_setting() {
        use DriftMode::*;
        assert_eq!(drift_compensation_mode(Observe, true), Observe);
        assert_eq!(drift_compensation_mode(On, true), On);
        assert_eq!(drift_compensation_mode(On, false), Off);
        assert_eq!(drift_compensation_mode(Observe, false), Off);
    }
}
