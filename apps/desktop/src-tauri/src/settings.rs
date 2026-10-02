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
use thaumic_core::{CompanionSettings, DriftMode, SpeakerEnv, SpeakerSettingValues};

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
    /// Clock drift correction for PCM streams, on unless the file says
    /// otherwise. The settings view offers only on and off, and off saves
    /// `observe`: the audio is left exactly as captured, and the log keeps
    /// saying what correction would do. `off` itself can only be set by hand
    /// or through the environment.
    /// See `thaumic_core::Config::drift_compensation`.
    pub drift_compensation: DriftMode,
    /// Which of the settings above the file itself set when it was loaded,
    /// so that start-up can say where each value came from. Not saved.
    #[serde(skip)]
    in_file: KeysInFile,
}

/// Which of the three keys a settings file has. Presence only: the values
/// are the ones [`DesktopSettings`] itself parsed. Any other key, a
/// snake_case spelling of these included, is not looked at.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct KeysInFile {
    #[serde(deserialize_with = "present")]
    speaker_monitor: bool,
    #[serde(deserialize_with = "present")]
    pcm_connect_burst_ms: bool,
    #[serde(deserialize_with = "present")]
    drift_compensation: bool,
}

impl KeysInFile {
    /// Every key, as a file this app has just saved has them.
    const ALL: Self = Self {
        speaker_monitor: true,
        pcm_connect_burst_ms: true,
        drift_compensation: true,
    };
}

/// Reads any value at all and says the key was there.
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    serde::de::IgnoredAny::deserialize(deserializer).map(|_| true)
}

impl Default for DesktopSettings {
    fn default() -> Self {
        let core = thaumic_core::Config::default();
        Self {
            speaker_monitor: core.speaker_monitor,
            pcm_connect_burst_ms: core.pcm_connect_burst_ms,
            drift_compensation: core.drift_compensation,
            in_file: KeysInFile::default(),
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
            Ok(contents) => match serde_json::from_str::<Self>(&contents) {
                // The same document again, only for which keys it has.
                Ok(settings) => Self {
                    in_file: serde_json::from_str(&contents).unwrap_or_else(|e| {
                        log::warn!(
                            "[Settings] Could not tell which settings {} sets ({}); the log \
                             will give their source as default",
                            path.display(),
                            e
                        );
                        KeysInFile::default()
                    }),
                    ..settings
                },
                Err(e) => {
                    log::warn!(
                        "[Settings] {} is not valid ({}); using defaults",
                        path.display(),
                        e
                    );
                    Self::default()
                }
            },
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
        let mut settings = settings.clamped();
        // Every key is written, so from here the file sets all three.
        settings.in_file = KeysInFile::ALL;
        std::fs::create_dir_all(app_data_dir)?;
        let path = app_data_dir.join(SETTINGS_FILE);
        let temp_path = app_data_dir.join(format!("{SETTINGS_FILE}.tmp"));
        std::fs::write(&temp_path, serde_json::to_string_pretty(&settings)?)?;
        std::fs::rename(&temp_path, &path)?;
        Ok(settings)
    }

    /// What the settings file said about each setting: the value held here
    /// for every key the file had, nothing for a key it lacked.
    fn file_values(&self) -> SpeakerSettingValues {
        let keys = self.in_file;
        SpeakerSettingValues {
            speaker_monitor: keys.speaker_monitor.then_some(self.speaker_monitor),
            pcm_connect_burst_ms: keys
                .pcm_connect_burst_ms
                .then_some(self.pcm_connect_burst_ms),
            drift_compensation: keys.drift_compensation.then_some(self.drift_compensation),
        }
    }

    /// The settings in effect: an environment variable, as read when the app
    /// started, beats the settings file, which beats the default.
    pub fn resolved(&self, env: SpeakerEnv) -> CompanionSettings {
        CompanionSettings::load(self.file_values(), env, SpeakerSettingValues::default())
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
        DesktopSettings::load(&dir)
            .resolved(SpeakerEnv::default())
            .apply_to(&mut config);
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
        settings
            .resolved(SpeakerEnv::default())
            .apply_to(&mut config);
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
    fn drift_correction_is_on_by_default_and_a_saved_mode_reaches_the_core() {
        let dir = temp_dir("drift");
        assert_eq!(
            DesktopSettings::load(&dir).drift_compensation,
            DriftMode::On
        );
        DesktopSettings::update(&dir, |s| s.drift_compensation = DriftMode::Observe)
            .expect("saves");
        let settings = DesktopSettings::load(&dir);
        assert_eq!(settings.drift_compensation, DriftMode::Observe);
        assert!(settings.speaker_monitor, "the other settings are untouched");

        let mut config = thaumic_core::Config::default();
        settings
            .resolved(SpeakerEnv::default())
            .apply_to(&mut config);
        assert_eq!(config.drift_compensation, DriftMode::Observe);

        // An older file without the field gets the default.
        std::fs::write(dir.join(SETTINGS_FILE), r#"{"speakerMonitor": true}"#).unwrap();
        assert_eq!(
            DesktopSettings::load(&dir).drift_compensation,
            DriftMode::On
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_saved_drift_mode_is_kept_whatever_the_default() {
        let dir = temp_dir("drift-saved");
        std::fs::create_dir_all(&dir).unwrap();
        for (saved, mode) in [("observe", DriftMode::Observe), ("off", DriftMode::Off)] {
            std::fs::write(
                dir.join(SETTINGS_FILE),
                format!(r#"{{"driftCompensation": "{saved}"}}"#),
            )
            .unwrap();
            assert_eq!(DesktopSettings::load(&dir).drift_compensation, mode);
        }
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

    fn env(pairs: &[(&str, &str)]) -> SpeakerEnv {
        SpeakerEnv::from_lookup(|name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        })
    }

    #[test]
    fn each_setting_takes_the_variable_then_the_file_then_the_default() {
        use thaumic_core::SettingOrigin::{Default, Env, File};
        let dir = temp_dir("precedence");
        let none = SpeakerEnv::default();
        let all = env(&[
            ("THAUMIC_SPEAKER_MONITOR", "on"),
            ("THAUMIC_PCM_CONNECT_BURST_MS", "0"),
            ("THAUMIC_DRIFT_COMPENSATION", "off"),
        ]);

        // No file: the defaults, and a variable over them.
        let missing = DesktopSettings::load(&dir);
        let resolved = missing.resolved(none);
        assert_eq!(resolved.speaker_monitor.origin, Default);
        assert_eq!(resolved.pcm_connect_burst_ms.origin, Default);
        assert_eq!(resolved.drift_compensation.origin, Default);
        assert_eq!(missing.resolved(all).pcm_connect_burst_ms.origin, Env);

        // A hand-written file with one key: that key is the file's, the
        // rest stay defaults.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(SETTINGS_FILE), r#"{"pcmConnectBurstMs": 1000}"#).unwrap();
        let resolved = DesktopSettings::load(&dir).resolved(none);
        assert_eq!(resolved.pcm_connect_burst_ms.value, 1000);
        assert_eq!(resolved.pcm_connect_burst_ms.origin, File);
        assert_eq!(resolved.speaker_monitor.origin, Default);

        // A saved file sets all three; a variable still beats each.
        DesktopSettings::update(&dir, |s| {
            s.speaker_monitor = false;
            s.drift_compensation = DriftMode::Observe;
        })
        .expect("saves");
        let saved = DesktopSettings::load(&dir);
        let resolved = saved.resolved(none);
        assert!(!resolved.speaker_monitor.value);
        assert_eq!(resolved.pcm_connect_burst_ms.value, 1000);
        assert_eq!(resolved.drift_compensation.value, DriftMode::Observe);
        assert_eq!(
            resolved.origins(),
            thaumic_core::SettingOrigins {
                speaker_monitor: File,
                pcm_connect_burst_ms: File,
                drift_compensation: File,
            }
        );
        let resolved = saved.resolved(all);
        assert!(resolved.speaker_monitor.value);
        assert_eq!(resolved.pcm_connect_burst_ms.value, 0);
        assert_eq!(resolved.drift_compensation.value, DriftMode::Off);
        assert_eq!(
            resolved.origins(),
            thaumic_core::SettingOrigins {
                speaker_monitor: Env,
                pcm_connect_burst_ms: Env,
                drift_compensation: Env,
            }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The file's keys are camelCase. A snake_case spelling is not a key, so
    /// it neither sets the value nor counts as the file setting it.
    #[test]
    fn a_snake_case_key_is_not_read() {
        let dir = temp_dir("snake-case");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(SETTINGS_FILE),
            r#"{"speaker_monitor": false, "pcmConnectBurstMs": 1000}"#,
        )
        .unwrap();
        let resolved = DesktopSettings::load(&dir).resolved(SpeakerEnv::default());
        assert!(resolved.speaker_monitor.value);
        assert_eq!(
            resolved.speaker_monitor.origin,
            thaumic_core::SettingOrigin::Default
        );
        assert_eq!(
            resolved.pcm_connect_burst_ms.origin,
            thaumic_core::SettingOrigin::File
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_setting_saved_under_a_variable_waits_for_the_variable_to_go() {
        let dir = temp_dir("saved-under-env");
        let fixed = env(&[("THAUMIC_PCM_CONNECT_BURST_MS", "2000")]);
        let saved = DesktopSettings::update(&dir, |s| s.pcm_connect_burst_ms = 250).expect("saves");
        assert_eq!(saved.resolved(fixed).pcm_connect_burst_ms.value, 2000);
        assert_eq!(
            saved
                .resolved(SpeakerEnv::default())
                .pcm_connect_burst_ms
                .value,
            250
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_legacy_variable_turns_monitoring_on_over_a_saved_off() {
        let dir = temp_dir("legacy");
        let saved = DesktopSettings::update(&dir, |s| s.speaker_monitor = false).expect("saves");
        for vars in [
            &[("THAUMIC_SPEAKER_DIAGNOSTICS", "1")][..],
            &[
                ("THAUMIC_SPEAKER_DIAGNOSTICS", "1"),
                ("THAUMIC_SPEAKER_MONITOR", "off"),
            ][..],
        ] {
            let resolved = saved.resolved(env(vars));
            assert!(resolved.speaker_monitor.value);
            assert_eq!(
                resolved.speaker_monitor.origin,
                thaumic_core::SettingOrigin::LegacyEnv
            );
            assert!(resolved.legacy_warning(false).is_some());
        }
        let resolved = saved.resolved(env(&[("THAUMIC_SPEAKER_DIAGNOSTICS", "0")]));
        assert!(!resolved.speaker_monitor.value);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
