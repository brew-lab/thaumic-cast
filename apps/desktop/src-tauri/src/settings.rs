//! Desktop settings that the server side acts on, persisted in the app data
//! directory.
//!
//! Preferences that only the window cares about (theme, language) live in the
//! frontend's local storage. Anything the core reads lives here instead, so it
//! applies from startup, before the window has even loaded.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

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
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            speaker_monitor: thaumic_core::Config::default().speaker_monitor,
        }
    }
}

impl DesktopSettings {
    /// Loads the settings from `app_data_dir`, or the defaults if the file is
    /// missing or unreadable.
    pub fn load(app_data_dir: &Path) -> Self {
        let path = app_data_dir.join(SETTINGS_FILE);
        match std::fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|e| {
                log::warn!(
                    "[Settings] {} is not valid ({}); using defaults",
                    path.display(),
                    e
                );
                Self::default()
            }),
            Err(_) => Self::default(),
        }
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
    fn a_damaged_file_loads_as_the_defaults() {
        let dir = temp_dir("damaged");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(SETTINGS_FILE), "{ not json").unwrap();
        assert_eq!(DesktopSettings::load(&dir), DesktopSettings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
