//! Desktop settings that the server side acts on, persisted in the app data
//! directory.
//!
//! Preferences that only the window cares about (theme, language) live in the
//! frontend's local storage. Anything the core reads lives here instead, so it
//! applies from startup, before the window has even loaded.

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use thaumic_core::protocol_constants::MAX_PCM_CONNECT_BURST_MS;
use thaumic_core::{CompanionSettings, DriftMode, SpeakerEnv, SpeakerSettingValues};

/// File name inside the app data directory.
const SETTINGS_FILE: &str = "settings.json";

/// Serialises writes so two quick toggles cannot interleave their saves.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// The keys of the settings file, as the file spells them.
const SPEAKER_MONITOR_KEY: &str = "speakerMonitor";
const PCM_CONNECT_BURST_MS_KEY: &str = "pcmConnectBurstMs";
const DRIFT_COMPENSATION_KEY: &str = "driftCompensation";

/// Every key the settings file may set. Any other is warned about and
/// ignored.
const KNOWN_KEYS: [&str; 3] = [
    SPEAKER_MONITOR_KEY,
    PCM_CONNECT_BURST_MS_KEY,
    DRIFT_COMPENSATION_KEY,
];

/// Persisted desktop settings.
///
/// Every field has a default, so a missing or older file loads as the
/// defaults for whatever it lacks, and a damaged value costs only its own
/// setting.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
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

/// Which of the three settings came from the settings file. A key the file
/// lacks, or one whose value could not be used, did not.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct KeysInFile {
    speaker_monitor: bool,
    pcm_connect_burst_ms: bool,
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

/// Takes `key` out of a settings file on its own, so that one value that
/// cannot be used does not cost the others.
///
/// Returns the file's value, or `None` when the key is missing or its value
/// is not `wanted` (what a usable value is, for the warning). The warning
/// names the key and says that `default` is used instead.
fn take_key<T: serde::de::DeserializeOwned>(
    file: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    wanted: &str,
    default: impl std::fmt::Display,
    path: &Path,
    warnings: &mut Vec<String>,
) -> Option<T> {
    let value = file.remove(key)?;
    match serde_json::from_value(value.clone()) {
        Ok(parsed) => Some(parsed),
        Err(_) => {
            warnings.push(format!(
                "{key} in {} is {value}, which is not {wanted}. It was ignored, and the default, \
                 {default}, is used.",
                path.display()
            ));
            None
        }
    }
}

impl DesktopSettings {
    /// Loads the settings from `app_data_dir`, or the defaults if the file is
    /// missing or is not JSON at all. Each key is read on its own: one whose
    /// value cannot be used takes its default, with a warning, and the others
    /// keep theirs. A head start above the maximum (a hand-edited file) loads
    /// as the maximum.
    ///
    /// A key this app does not read is warned about and ignored. It is not
    /// carried over: [`Self::update`] writes the three known keys and
    /// nothing else, so the first save drops it from the file.
    pub fn load(app_data_dir: &Path) -> Self {
        let path = app_data_dir.join(SETTINGS_FILE);
        let Ok(contents) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        let (settings, warnings) = Self::from_json(&contents, &path);
        for warning in warnings {
            log::warn!("[Settings] {warning}");
        }
        settings.clamped()
    }

    /// Reads the settings out of the text of the file at `path`, with the
    /// warnings to log about what could not be used. Values are not yet
    /// clamped.
    fn from_json(contents: &str, path: &Path) -> (Self, Vec<String>) {
        let mut file: serde_json::Map<String, serde_json::Value> =
            match serde_json::from_str(contents) {
                Ok(file) => file,
                Err(e) => {
                    let warning = format!("{} is not valid ({e}); using defaults", path.display());
                    return (Self::default(), vec![warning]);
                }
            };

        let default = Self::default();
        let mut warnings = Vec::new();
        let speaker_monitor = take_key(
            &mut file,
            SPEAKER_MONITOR_KEY,
            "true or false",
            default.speaker_monitor,
            path,
            &mut warnings,
        );
        let pcm_connect_burst_ms = take_key(
            &mut file,
            PCM_CONNECT_BURST_MS_KEY,
            "a whole number of milliseconds, 0 or more",
            default.pcm_connect_burst_ms,
            path,
            &mut warnings,
        );
        let drift_compensation = take_key(
            &mut file,
            DRIFT_COMPENSATION_KEY,
            "\"on\", \"observe\" or \"off\"",
            format!("\"{}\"", default.drift_compensation),
            path,
            &mut warnings,
        );
        // Whatever is left is a key this app does not read.
        for key in file.keys() {
            debug_assert!(!KNOWN_KEYS.contains(&key.as_str()));
            warnings.push(format!(
                "{key} in {} is not a setting Thaumic Cast reads, so it was ignored. It will be \
                 gone from the file the next time a setting is saved.",
                path.display()
            ));
        }

        let settings = Self {
            in_file: KeysInFile {
                speaker_monitor: speaker_monitor.is_some(),
                pcm_connect_burst_ms: pcm_connect_burst_ms.is_some(),
                drift_compensation: drift_compensation.is_some(),
            },
            speaker_monitor: speaker_monitor.unwrap_or(default.speaker_monitor),
            pcm_connect_burst_ms: pcm_connect_burst_ms.unwrap_or(default.pcm_connect_burst_ms),
            drift_compensation: drift_compensation.unwrap_or(default.drift_compensation),
        };
        (settings, warnings)
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

    /// Loads `contents` as the settings file, with the warnings it gives.
    fn parse(contents: &str) -> (DesktopSettings, Vec<String>) {
        let (settings, warnings) =
            DesktopSettings::from_json(contents, Path::new("/data/settings.json"));
        (settings.clamped(), warnings)
    }

    /// The list of known keys is written by hand. A setting added to the
    /// struct and not to the list would be saved and then never read back.
    #[test]
    fn the_known_keys_are_the_keys_a_save_writes() {
        let saved = serde_json::to_value(DesktopSettings::default()).unwrap();
        let written: Vec<&str> = saved
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mut known = KNOWN_KEYS.to_vec();
        known.sort_unstable();
        let mut sorted = written.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, known);

        // And what a save writes loads back without a word.
        let (loaded, warnings) = parse(&saved.to_string());
        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(loaded.in_file, KeysInFile::ALL);
    }

    #[test]
    fn one_bad_value_keeps_the_other_two() {
        let (settings, warnings) = parse(
            r#"{"speakerMonitor": false, "pcmConnectBurstMs": "lots", "driftCompensation": "observe"}"#,
        );
        assert!(!settings.speaker_monitor);
        assert_eq!(settings.pcm_connect_burst_ms, 500);
        assert_eq!(settings.drift_compensation, DriftMode::Observe);
        assert_eq!(
            warnings,
            [
                "pcmConnectBurstMs in /data/settings.json is \"lots\", which is not a whole \
                 number of milliseconds, 0 or more. It was ignored, and the default, 500, is used."
            ]
        );

        // The bad value is not the file's, so its source reads as default.
        use thaumic_core::SettingOrigin::{Default, File};
        let resolved = settings.resolved(SpeakerEnv::default());
        assert_eq!(resolved.speaker_monitor.origin, File);
        assert_eq!(resolved.pcm_connect_burst_ms.origin, Default);
        assert_eq!(resolved.drift_compensation.origin, File);
    }

    #[test]
    fn a_value_of_the_wrong_type_takes_its_default_and_is_named() {
        let (settings, warnings) = parse(
            r#"{"speakerMonitor": "yes", "pcmConnectBurstMs": -250, "driftCompensation": true}"#,
        );
        assert_eq!(
            DesktopSettings {
                in_file: KeysInFile::ALL,
                ..settings
            },
            DesktopSettings {
                in_file: KeysInFile::ALL,
                ..DesktopSettings::default()
            }
        );
        assert_eq!(settings.in_file, KeysInFile::default());
        assert_eq!(
            warnings,
            [
                "speakerMonitor in /data/settings.json is \"yes\", which is not true or false. \
                 It was ignored, and the default, true, is used.",
                "pcmConnectBurstMs in /data/settings.json is -250, which is not a whole number \
                 of milliseconds, 0 or more. It was ignored, and the default, 500, is used.",
                "driftCompensation in /data/settings.json is true, which is not \"on\", \
                 \"observe\" or \"off\". It was ignored, and the default, \"on\", is used.",
            ]
        );

        // A mode the app does not have, beside two good values.
        let (settings, warnings) = parse(
            r#"{"speakerMonitor": false, "pcmConnectBurstMs": 750, "driftCompensation": "sometimes"}"#,
        );
        assert!(!settings.speaker_monitor);
        assert_eq!(settings.pcm_connect_burst_ms, 750);
        assert_eq!(settings.drift_compensation, DriftMode::On);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn a_head_start_out_of_range_is_clamped_beside_a_bad_value() {
        let (settings, warnings) = parse(
            r#"{"speakerMonitor": 1, "pcmConnectBurstMs": 9000, "driftCompensation": "off"}"#,
        );
        assert_eq!(settings.pcm_connect_burst_ms, MAX_PCM_CONNECT_BURST_MS);
        assert!(settings.in_file.pcm_connect_burst_ms);
        assert!(settings.speaker_monitor);
        assert_eq!(settings.drift_compensation, DriftMode::Off);
        assert_eq!(warnings.len(), 1);
    }

    /// `off` is not offered by the settings view, only set by hand. It must
    /// outlast a bad neighbour and a save of another setting.
    #[test]
    fn a_drift_mode_of_off_set_by_hand_survives() {
        let dir = temp_dir("drift-off-by-hand");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(SETTINGS_FILE),
            r#"{"speakerMonitor": "no", "driftCompensation": "off"}"#,
        )
        .unwrap();
        assert_eq!(
            DesktopSettings::load(&dir).drift_compensation,
            DriftMode::Off
        );

        DesktopSettings::update(&dir, |s| s.pcm_connect_burst_ms = 750).expect("saves");
        let saved = DesktopSettings::load(&dir);
        assert_eq!(saved.drift_compensation, DriftMode::Off);
        assert_eq!(saved.pcm_connect_burst_ms, 750);
        assert!(saved.speaker_monitor);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_key_is_warned_about_and_gone_after_a_save() {
        let (settings, warnings) =
            parse(r#"{"speaker_monitor": false, "pcmConnectBurstMs": 1000}"#);
        assert!(settings.speaker_monitor);
        assert_eq!(settings.pcm_connect_burst_ms, 1000);
        assert_eq!(
            warnings,
            [
                "speaker_monitor in /data/settings.json is not a setting Thaumic Cast reads, so \
                 it was ignored. It will be gone from the file the next time a setting is saved."
            ]
        );

        let dir = temp_dir("unknown-key");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SETTINGS_FILE);
        std::fs::write(&path, r#"{"theme": "dark", "pcmConnectBurstMs": 1000}"#).unwrap();
        DesktopSettings::update(&dir, |s| s.speaker_monitor = false).expect("saves");
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("theme"), "{saved}");
        let (reloaded, warnings) = DesktopSettings::from_json(&saved, &path);
        assert_eq!(warnings, Vec::<String>::new());
        assert_eq!(reloaded.pcm_connect_burst_ms, 1000);
        assert!(!reloaded.speaker_monitor);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_is_not_a_json_object_loads_as_the_defaults() {
        for contents in ["{ not json", "[1, 2]", "true", ""] {
            let (settings, warnings) = parse(contents);
            assert_eq!(settings, DesktopSettings::default(), "{contents}");
            assert_eq!(warnings.len(), 1, "{contents}");
            assert!(
                warnings[0].starts_with("/data/settings.json is not valid ("),
                "{}",
                warnings[0]
            );
        }
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
