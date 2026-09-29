//! Desktop settings that the server side acts on, persisted in the app data
//! directory.
//!
//! Preferences that only the window cares about (theme, language) live in the
//! frontend's local storage. Anything the core reads lives here instead, so it
//! applies from startup, before the window has even loaded.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use thaumic_core::protocol_constants::MAX_PCM_CONNECT_BURST_MS;
use thaumic_core::DriftMode;

/// File name inside the app data directory.
const SETTINGS_FILE: &str = "settings.json";

/// Serialises writes so two quick toggles cannot interleave their saves.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// Persisted desktop settings.
///
/// Every field has a default, so a missing, older or damaged file loads as
/// the defaults for whatever it lacks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopSettings {
    /// Whether speakers playing a stream are polled for their playback
    /// position. See `thaumic_core::Config::speaker_monitor`.
    pub speaker_monitor: bool,
    /// Speaker head start for PCM streams, in ms (`0` is off), at most
    /// [`MAX_PCM_CONNECT_BURST_MS`]. See
    /// `thaumic_core::Config::pcm_connect_burst_ms`.
    pub pcm_connect_burst_ms: u64,
    /// Clock drift correction for PCM streams. The settings view offers only
    /// on and off, and off saves `observe`: the audio is left exactly as
    /// captured either way, and the log keeps saying what correction would
    /// do. `off` itself can only be set by hand or through the environment.
    /// See `thaumic_core::Config::drift_compensation`.
    pub drift_compensation: DriftMode,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        let core = thaumic_core::Config::default();
        Self {
            speaker_monitor: core.speaker_monitor,
            pcm_connect_burst_ms: core.pcm_connect_burst_ms,
            drift_compensation: core.drift_compensation,
        }
    }
}

impl DesktopSettings {
    /// Loads the settings from `app_data_dir`, or the defaults if the file is
    /// missing or unreadable. A head start above the maximum (a hand-edited
    /// file) loads as the maximum.
    pub fn load(app_data_dir: &Path) -> Self {
        let path = app_data_dir.join(SETTINGS_FILE);
        let settings: Self = match std::fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|e| {
                log::warn!(
                    "[Settings] {} is not valid ({}); using defaults",
                    path.display(),
                    e
                );
                Self::default()
            }),
            Err(_) => Self::default(),
        };
        settings.clamped()
    }

    /// The settings with every value inside its range.
    fn clamped(mut self) -> Self {
        if self.pcm_connect_burst_ms > MAX_PCM_CONNECT_BURST_MS {
            log::warn!(
                "[Settings] Speaker head start of {} ms is above the {} ms maximum; using {} ms",
                self.pcm_connect_burst_ms,
                MAX_PCM_CONNECT_BURST_MS,
                MAX_PCM_CONNECT_BURST_MS
            );
            self.pcm_connect_burst_ms = MAX_PCM_CONNECT_BURST_MS;
        }
        self
    }

    /// Loads the settings, applies `change`, and saves the result.
    ///
    /// Writes a temporary file and renames it over the old one, so a crash
    /// mid-write cannot leave a half-written file.
    pub fn update(app_data_dir: &Path, change: impl FnOnce(&mut Self)) -> std::io::Result<Self> {
        let _guard = SETTINGS_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut settings = Self::load(app_data_dir);
        change(&mut settings);
        let settings = settings.clamped();
        std::fs::create_dir_all(app_data_dir)?;
        let path = app_data_dir.join(SETTINGS_FILE);
        let temp_path = app_data_dir.join(format!("{SETTINGS_FILE}.tmp"));
        std::fs::write(&temp_path, serde_json::to_string_pretty(&settings)?)?;
        std::fs::rename(&temp_path, &path)?;
        Ok(settings)
    }

    /// Applies the settings to the core configuration.
    pub fn apply_to(&self, config: &mut thaumic_core::Config) {
        config.speaker_monitor = self.speaker_monitor;
        config.pcm_connect_burst_ms = self.pcm_connect_burst_ms.min(MAX_PCM_CONNECT_BURST_MS);
        config.drift_compensation = self.drift_compensation;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("thaumic-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn speaker_monitoring_is_on_without_a_settings_file() {
        let dir = temp_dir("missing");
        assert!(DesktopSettings::load(&dir).speaker_monitor);
    }

    #[test]
    fn a_saved_setting_survives_a_reload() {
        let dir = temp_dir("roundtrip");
        DesktopSettings::update(&dir, |s| s.speaker_monitor = false).expect("saves");
        assert!(!DesktopSettings::load(&dir).speaker_monitor);

        let mut config = thaumic_core::Config::default();
        DesktopSettings::load(&dir).apply_to(&mut config);
        assert!(!config.speaker_monitor);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_head_start_defaults_to_the_core_default() {
        let dir = temp_dir("head-start-default");
        assert_eq!(
            DesktopSettings::load(&dir).pcm_connect_burst_ms,
            thaumic_core::protocol_constants::DEFAULT_PCM_CONNECT_BURST_MS
        );
    }

    #[test]
    fn a_saved_head_start_survives_a_reload_and_reaches_the_core() {
        let dir = temp_dir("head-start-roundtrip");
        DesktopSettings::update(&dir, |s| s.pcm_connect_burst_ms = 1500).expect("saves");
        let settings = DesktopSettings::load(&dir);
        assert_eq!(settings.pcm_connect_burst_ms, 1500);
        // The monitor setting is untouched by a head start change.
        assert!(settings.speaker_monitor);

        let mut config = thaumic_core::Config::default();
        settings.apply_to(&mut config);
        assert_eq!(config.pcm_connect_burst_ms, 1500);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_head_start_above_the_maximum_is_clamped() {
        let dir = temp_dir("head-start-clamp");
        let saved =
            DesktopSettings::update(&dir, |s| s.pcm_connect_burst_ms = 5000).expect("saves");
        assert_eq!(saved.pcm_connect_burst_ms, MAX_PCM_CONNECT_BURST_MS);

        // A hand-edited file is clamped on load too.
        std::fs::write(dir.join(SETTINGS_FILE), r#"{"pcmConnectBurstMs": 9000}"#).unwrap();
        let loaded = DesktopSettings::load(&dir);
        assert_eq!(loaded.pcm_connect_burst_ms, MAX_PCM_CONNECT_BURST_MS);
        assert!(loaded.speaker_monitor);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_head_start_of_zero_is_kept_as_off() {
        let dir = temp_dir("head-start-off");
        DesktopSettings::update(&dir, |s| s.pcm_connect_burst_ms = 0).expect("saves");
        assert_eq!(DesktopSettings::load(&dir).pcm_connect_burst_ms, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drift_correction_observes_by_default_and_a_saved_mode_reaches_the_core() {
        let dir = temp_dir("drift");
        assert_eq!(
            DesktopSettings::load(&dir).drift_compensation,
            DriftMode::Observe
        );
        DesktopSettings::update(&dir, |s| s.drift_compensation = DriftMode::On).expect("saves");
        let settings = DesktopSettings::load(&dir);
        assert_eq!(settings.drift_compensation, DriftMode::On);
        assert!(settings.speaker_monitor, "the other settings are untouched");

        let mut config = thaumic_core::Config::default();
        settings.apply_to(&mut config);
        assert_eq!(config.drift_compensation, DriftMode::On);

        // An older file without the field keeps observing.
        std::fs::write(dir.join(SETTINGS_FILE), r#"{"speakerMonitor": true}"#).unwrap();
        assert_eq!(
            DesktopSettings::load(&dir).drift_compensation,
            DriftMode::Observe
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_file_loads_as_the_defaults() {
        let dir = temp_dir("damaged");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(SETTINGS_FILE), "{ not json").unwrap();
        assert_eq!(DesktopSettings::load(&dir), DesktopSettings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
