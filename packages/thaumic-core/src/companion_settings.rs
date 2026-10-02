//! The three speaker settings a companion takes from more than one place,
//! resolved once at start-up.
//!
//! Speaker monitoring, the speaker head start and clock drift correction can
//! each be set in a file, by an environment variable and, on the server, by
//! a flag. [`CompanionSettings::load`] settles each of them once, when the
//! app starts, and records where the value came from. The result is written
//! into [`Config`], and the per-connection paths read only that: a variable
//! changed after start-up changes nothing until the app is restarted.
//!
//! The order is flag, environment, file, default. The desktop app has no
//! flags, so there it is environment, settings file, default.
//!
//! [`SPEAKER_DIAGNOSTICS_ENV`] is the one exception, kept as it was: set, it
//! turns speaker monitoring on whatever anything else says.

use serde::Serialize;

use crate::protocol_constants::{DEFAULT_PCM_CONNECT_BURST_MS, MAX_PCM_CONNECT_BURST_MS};
use crate::services::latency_monitor::{
    parse_speaker_monitor_switch, SPEAKER_DIAGNOSTICS_ENV, SPEAKER_MONITOR_ENV,
};
use crate::services::speaker_monitor::control::{DriftMode, DRIFT_COMPENSATION_ENV};
use crate::state::Config;
use crate::stream::cadence::{parse_pcm_connect_burst_ms, PCM_CONNECT_BURST_ENV};

/// The server flag that sets speaker monitoring.
pub const SPEAKER_MONITOR_FLAG: &str = "--speaker-monitor";
/// The server flag that sets the speaker head start.
pub const PCM_CONNECT_BURST_FLAG: &str = "--pcm-connect-burst-ms";
/// The server flag that sets clock drift correction.
pub const DRIFT_COMPENSATION_FLAG: &str = "--drift-compensation";

/// Where a resolved setting's value came from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingOrigin {
    /// Nothing set it.
    #[default]
    Default,
    /// The config file (server) or the settings file (desktop).
    File,
    /// The setting's own environment variable.
    Env,
    /// The setting's command-line flag (server only).
    Flag,
    /// [`SPEAKER_DIAGNOSTICS_ENV`], which only ever turns monitoring on.
    LegacyEnv,
}

impl SettingOrigin {
    /// Whether an environment variable decided the value, so that a saved
    /// setting cannot change it.
    pub fn is_env(self) -> bool {
        matches!(self, Self::Env | Self::LegacyEnv)
    }
}

/// Where each of the three settings in a [`Config`] came from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SettingOrigins {
    /// Origin of [`Config::speaker_monitor`].
    pub speaker_monitor: SettingOrigin,
    /// Origin of [`Config::pcm_connect_burst_ms`].
    pub pcm_connect_burst_ms: SettingOrigin,
    /// Origin of [`Config::drift_compensation`].
    pub drift_compensation: SettingOrigin,
}

/// What one source (a file, the environment, the flags) says about the three
/// settings; `None` where it says nothing.
///
/// It is never read from a file directly. Each app parses its own file, with
/// its own key names, and fills this in from the values that parse settled
/// on, so no key is honoured here that the app's file does not document.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SpeakerSettingValues {
    /// Speaker monitoring.
    pub speaker_monitor: Option<bool>,
    /// Speaker head start, in ms.
    pub pcm_connect_burst_ms: Option<u64>,
    /// Clock drift correction.
    pub drift_compensation: Option<DriftMode>,
}

/// What the environment said about the three settings when the app started.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SpeakerEnv {
    /// The settings' own variables.
    pub values: SpeakerSettingValues,
    /// Whether [`SPEAKER_DIAGNOSTICS_ENV`] is set (not empty, not `0`).
    pub legacy_diagnostics: bool,
}

impl SpeakerEnv {
    /// Reads the process environment. Call once, at start-up.
    ///
    /// A value that cannot be used is ignored with a warning, and a blank
    /// one counts as unset.
    pub fn read() -> Self {
        Self {
            legacy_diagnostics: Self::read_legacy_diagnostics(),
            ..Self::from_lookup(|name| std::env::var(name).ok())
        }
    }

    /// Whether [`SPEAKER_DIAGNOSTICS_ENV`] is set in the process environment
    /// (not empty, not `0`), and nothing else. For the server, where clap
    /// has already read the settings' own variables.
    pub fn read_legacy_diagnostics() -> bool {
        std::env::var_os(SPEAKER_DIAGNOSTICS_ENV).is_some_and(|raw| !raw.is_empty() && raw != "0")
    }

    /// [`Self::read`] over any lookup, so tests need no real environment.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let set = |name: &str| lookup(name).filter(|raw| !raw.trim().is_empty());
        let ignored = |name: &str, raw: &str, why: &str| {
            log::warn!("Ignoring {name}={raw:?}: {why}");
        };
        let speaker_monitor = set(SPEAKER_MONITOR_ENV).and_then(|raw| {
            let parsed = parse_speaker_monitor_switch(&raw);
            if parsed.is_none() {
                ignored(SPEAKER_MONITOR_ENV, &raw, "expected on or off");
            }
            parsed
        });
        let pcm_connect_burst_ms =
            set(PCM_CONNECT_BURST_ENV).and_then(|raw| match parse_pcm_connect_burst_ms(&raw) {
                Ok(ms) => Some(ms),
                Err(why) => {
                    ignored(PCM_CONNECT_BURST_ENV, &raw, &why);
                    None
                }
            });
        let drift_compensation = set(DRIFT_COMPENSATION_ENV).and_then(|raw| {
            let parsed = DriftMode::parse(&raw);
            if parsed.is_none() {
                ignored(DRIFT_COMPENSATION_ENV, &raw, "expected on, observe or off");
            }
            parsed
        });
        Self {
            values: SpeakerSettingValues {
                speaker_monitor,
                pcm_connect_burst_ms,
                drift_compensation,
            },
            legacy_diagnostics: lookup(SPEAKER_DIAGNOSTICS_ENV)
                .is_some_and(|raw| !raw.is_empty() && raw != "0"),
        }
    }
}

/// A setting's value in effect, and where it came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resolved<T> {
    /// The value in effect.
    pub value: T,
    /// Where it came from.
    pub origin: SettingOrigin,
}

/// Settles one setting: flag, then environment, then file, then default.
fn resolve<T>(flag: Option<T>, env: Option<T>, file: Option<T>, default: T) -> Resolved<T> {
    let (value, origin) = match (flag, env, file) {
        (Some(value), _, _) => (value, SettingOrigin::Flag),
        (None, Some(value), _) => (value, SettingOrigin::Env),
        (None, None, Some(value)) => (value, SettingOrigin::File),
        (None, None, None) => (default, SettingOrigin::Default),
    };
    Resolved { value, origin }
}

/// The names an app's start-up lines use for the three settings and for its
/// file.
#[derive(Debug, Clone, Copy)]
pub struct SettingNames {
    /// What to call the file a value came from.
    pub file: &'static str,
    /// The speaker-monitoring key in that file.
    pub speaker_monitor: &'static str,
    /// The head-start key in that file.
    pub pcm_connect_burst_ms: &'static str,
    /// The drift-correction key in that file.
    pub drift_compensation: &'static str,
}

impl SettingNames {
    /// The server's `config.yaml` names.
    pub const SERVER: Self = Self {
        file: "config file",
        speaker_monitor: "speaker_monitor",
        pcm_connect_burst_ms: "pcm_connect_burst_ms",
        drift_compensation: "drift_compensation",
    };
    /// The desktop app's `settings.json` names.
    pub const DESKTOP: Self = Self {
        file: "settings.json",
        speaker_monitor: "speakerMonitor",
        pcm_connect_burst_ms: "pcmConnectBurstMs",
        drift_compensation: "driftCompensation",
    };
}

/// The three speaker settings as resolved at start-up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompanionSettings {
    /// Speaker monitoring.
    pub speaker_monitor: Resolved<bool>,
    /// Speaker head start, in ms, at most [`MAX_PCM_CONNECT_BURST_MS`].
    pub pcm_connect_burst_ms: Resolved<u64>,
    /// Clock drift correction, as asked for. It still runs as off while
    /// speaker monitoring is off; that is decided per connection.
    pub drift_compensation: Resolved<DriftMode>,
}

impl CompanionSettings {
    /// Resolves the three settings from what the file, the environment and
    /// the flags each say.
    ///
    /// A flag beats the environment, which beats the file, which beats the
    /// default. [`SpeakerEnv::legacy_diagnostics`] then turns speaker
    /// monitoring on over all of them, an explicit off included. A head
    /// start above [`MAX_PCM_CONNECT_BURST_MS`] is brought down to it.
    pub fn load(file: SpeakerSettingValues, env: SpeakerEnv, flag: SpeakerSettingValues) -> Self {
        let defaults = Config::default();
        let mut speaker_monitor = resolve(
            flag.speaker_monitor,
            env.values.speaker_monitor,
            file.speaker_monitor,
            defaults.speaker_monitor,
        );
        if env.legacy_diagnostics {
            speaker_monitor = Resolved {
                value: true,
                origin: SettingOrigin::LegacyEnv,
            };
        }
        let mut pcm_connect_burst_ms = resolve(
            flag.pcm_connect_burst_ms,
            env.values.pcm_connect_burst_ms,
            file.pcm_connect_burst_ms,
            DEFAULT_PCM_CONNECT_BURST_MS,
        );
        pcm_connect_burst_ms.value = pcm_connect_burst_ms.value.min(MAX_PCM_CONNECT_BURST_MS);
        Self {
            speaker_monitor,
            pcm_connect_burst_ms,
            drift_compensation: resolve(
                flag.drift_compensation,
                env.values.drift_compensation,
                file.drift_compensation,
                defaults.drift_compensation,
            ),
        }
    }

    /// Where each value came from.
    pub fn origins(&self) -> SettingOrigins {
        SettingOrigins {
            speaker_monitor: self.speaker_monitor.origin,
            pcm_connect_burst_ms: self.pcm_connect_burst_ms.origin,
            drift_compensation: self.drift_compensation.origin,
        }
    }

    /// Writes the values and their origins into `config`, which is all the
    /// per-connection paths read.
    pub fn apply_to(&self, config: &mut Config) {
        config.speaker_monitor = self.speaker_monitor.value;
        config.pcm_connect_burst_ms = self.pcm_connect_burst_ms.value;
        config.drift_compensation = self.drift_compensation.value;
        config.setting_origins = self.origins();
    }

    /// The start-up lines, one per setting: `key = value (source)`.
    ///
    /// Speaker monitoring that is off says what is still asked, a head start
    /// of 0 says it is off, and drift correction that cannot run because
    /// monitoring is off says so on its own line.
    pub fn startup_lines(&self, names: SettingNames) -> [String; 3] {
        let source = |origin: SettingOrigin, env: &'static str, flag: &'static str| match origin {
            SettingOrigin::Default => "default",
            SettingOrigin::File => names.file,
            SettingOrigin::Env => env,
            SettingOrigin::Flag => flag,
            SettingOrigin::LegacyEnv => SPEAKER_DIAGNOSTICS_ENV,
        };
        let monitor = self.speaker_monitor.value;
        let ms = self.pcm_connect_burst_ms.value;
        let drift = self.drift_compensation.value;
        [
            format!(
                "{} = {} ({}){}",
                names.speaker_monitor,
                if monitor { "on" } else { "off" },
                source(
                    self.speaker_monitor.origin,
                    SPEAKER_MONITOR_ENV,
                    SPEAKER_MONITOR_FLAG
                ),
                if monitor {
                    ""
                } else {
                    "; casts with video sync are still asked"
                }
            ),
            format!(
                "{} = {} ms{} ({})",
                names.pcm_connect_burst_ms,
                ms,
                if ms == 0 { ", off" } else { "" },
                source(
                    self.pcm_connect_burst_ms.origin,
                    PCM_CONNECT_BURST_ENV,
                    PCM_CONNECT_BURST_FLAG
                )
            ),
            format!(
                "{} = {} ({}){}",
                names.drift_compensation,
                drift,
                source(
                    self.drift_compensation.origin,
                    DRIFT_COMPENSATION_ENV,
                    DRIFT_COMPENSATION_FLAG
                ),
                if !monitor && drift != DriftMode::Off {
                    format!("; runs as off while {} is off", names.speaker_monitor)
                } else {
                    String::new()
                }
            ),
        ]
    }

    /// The warning to log once at start-up when [`SPEAKER_DIAGNOSTICS_ENV`]
    /// decided speaker monitoring, naming what replaces it; `None` when the
    /// variable is not set. `server` adds the server's flag and config key.
    pub fn legacy_warning(&self, server: bool) -> Option<String> {
        (self.speaker_monitor.origin == SettingOrigin::LegacyEnv).then(|| {
            let replacement = if server {
                format!(
                    "{SPEAKER_MONITOR_ENV}=on replaces it, as does {SPEAKER_MONITOR_FLAG} on, \
                     or speaker_monitor: true in the config file."
                )
            } else {
                format!("{SPEAKER_MONITOR_ENV}=on replaces it.")
            };
            format!(
                "{SPEAKER_DIAGNOSTICS_ENV} is set, so speaker monitoring is on, and it stays on \
                 over an explicit off from anywhere else. The variable still works. {replacement}"
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> SpeakerEnv {
        SpeakerEnv::from_lookup(|name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        })
    }

    fn values(
        speaker_monitor: Option<bool>,
        pcm_connect_burst_ms: Option<u64>,
        drift_compensation: Option<DriftMode>,
    ) -> SpeakerSettingValues {
        SpeakerSettingValues {
            speaker_monitor,
            pcm_connect_burst_ms,
            drift_compensation,
        }
    }

    const NONE: SpeakerSettingValues = SpeakerSettingValues {
        speaker_monitor: None,
        pcm_connect_burst_ms: None,
        drift_compensation: None,
    };

    #[test]
    fn nothing_set_gives_the_defaults() {
        let settings = CompanionSettings::load(NONE, SpeakerEnv::default(), NONE);
        assert_eq!(
            (
                settings.speaker_monitor.value,
                settings.pcm_connect_burst_ms.value,
                settings.drift_compensation.value
            ),
            (true, 500, DriftMode::On)
        );
        assert_eq!(settings.origins(), SettingOrigins::default());
    }

    #[test]
    fn speaker_monitor_takes_flag_then_env_then_file() {
        use SettingOrigin::{Env, File, Flag};
        let file = values(Some(false), None, None);
        let env_on = env(&[(SPEAKER_MONITOR_ENV, "on")]);
        let flag_off = values(Some(false), None, None);

        let from_file = CompanionSettings::load(file, SpeakerEnv::default(), NONE);
        assert_eq!(
            from_file.speaker_monitor,
            Resolved {
                value: false,
                origin: File
            }
        );
        let from_env = CompanionSettings::load(file, env_on, NONE);
        assert_eq!(
            from_env.speaker_monitor,
            Resolved {
                value: true,
                origin: Env
            }
        );
        let from_flag = CompanionSettings::load(values(Some(true), None, None), env_on, flag_off);
        assert_eq!(
            from_flag.speaker_monitor,
            Resolved {
                value: false,
                origin: Flag
            }
        );
    }

    #[test]
    fn head_start_takes_flag_then_env_then_file() {
        use SettingOrigin::{Env, File, Flag};
        let file = values(None, Some(1000), None);
        let env_zero = env(&[(PCM_CONNECT_BURST_ENV, "0")]);

        let from_file = CompanionSettings::load(file, SpeakerEnv::default(), NONE);
        assert_eq!(
            from_file.pcm_connect_burst_ms,
            Resolved {
                value: 1000,
                origin: File
            }
        );
        let from_env = CompanionSettings::load(file, env_zero, NONE);
        assert_eq!(
            from_env.pcm_connect_burst_ms,
            Resolved {
                value: 0,
                origin: Env
            }
        );
        let from_flag = CompanionSettings::load(file, env_zero, values(None, Some(1500), None));
        assert_eq!(
            from_flag.pcm_connect_burst_ms,
            Resolved {
                value: 1500,
                origin: Flag
            }
        );
    }

    #[test]
    fn drift_correction_takes_flag_then_env_then_file() {
        use SettingOrigin::{Env, File, Flag};
        let file = values(None, None, Some(DriftMode::Observe));
        let env_off = env(&[(DRIFT_COMPENSATION_ENV, "off")]);

        let from_file = CompanionSettings::load(file, SpeakerEnv::default(), NONE);
        assert_eq!(
            from_file.drift_compensation,
            Resolved {
                value: DriftMode::Observe,
                origin: File
            }
        );
        let from_env = CompanionSettings::load(file, env_off, NONE);
        assert_eq!(
            from_env.drift_compensation,
            Resolved {
                value: DriftMode::Off,
                origin: Env
            }
        );
        let from_flag =
            CompanionSettings::load(file, env_off, values(None, None, Some(DriftMode::On)));
        assert_eq!(
            from_flag.drift_compensation,
            Resolved {
                value: DriftMode::On,
                origin: Flag
            }
        );
    }

    #[test]
    fn the_legacy_variable_turns_monitoring_on_over_an_explicit_off() {
        let legacy = env(&[(SPEAKER_DIAGNOSTICS_ENV, "1")]);
        assert!(legacy.legacy_diagnostics);

        let alone = CompanionSettings::load(NONE, legacy, NONE);
        assert_eq!(
            alone.speaker_monitor,
            Resolved {
                value: true,
                origin: SettingOrigin::LegacyEnv
            }
        );

        let off = values(Some(false), None, None);
        let with_env_off = env(&[(SPEAKER_DIAGNOSTICS_ENV, "1"), (SPEAKER_MONITOR_ENV, "off")]);
        for settings in [
            CompanionSettings::load(off, legacy, NONE),
            CompanionSettings::load(NONE, with_env_off, NONE),
            CompanionSettings::load(NONE, legacy, off),
        ] {
            assert!(settings.speaker_monitor.value, "the legacy variable wins");
            assert_eq!(settings.speaker_monitor.origin, SettingOrigin::LegacyEnv);
        }
    }

    #[test]
    fn the_legacy_variable_counts_only_when_set_to_something() {
        assert!(!env(&[]).legacy_diagnostics);
        assert!(!env(&[(SPEAKER_DIAGNOSTICS_ENV, "")]).legacy_diagnostics);
        assert!(!env(&[(SPEAKER_DIAGNOSTICS_ENV, "0")]).legacy_diagnostics);
        assert!(env(&[(SPEAKER_DIAGNOSTICS_ENV, "yes")]).legacy_diagnostics);
    }

    #[test]
    fn the_legacy_warning_names_the_variable_and_its_replacement() {
        let legacy = env(&[(SPEAKER_DIAGNOSTICS_ENV, "1")]);
        let settings = CompanionSettings::load(NONE, legacy, NONE);
        let server = settings.legacy_warning(true).expect("warns");
        assert!(server.contains("THAUMIC_SPEAKER_DIAGNOSTICS is set"));
        assert!(server.contains("still works"));
        assert!(server.contains("explicit off"));
        assert!(server.contains("THAUMIC_SPEAKER_MONITOR=on"));
        assert!(server.contains("--speaker-monitor on"));
        assert!(server.contains("speaker_monitor: true"));
        let desktop = settings.legacy_warning(false).expect("warns");
        assert!(desktop.contains("THAUMIC_SPEAKER_MONITOR=on"));
        assert!(!desktop.contains("--speaker-monitor"));

        let unset = CompanionSettings::load(NONE, SpeakerEnv::default(), NONE);
        assert_eq!(unset.legacy_warning(true), None);
    }

    #[test]
    fn unusable_and_blank_variables_are_ignored() {
        let read = env(&[
            (SPEAKER_MONITOR_ENV, "sometimes"),
            (PCM_CONNECT_BURST_ENV, "2001"),
            (DRIFT_COMPENSATION_ENV, "  "),
        ]);
        assert_eq!(read, SpeakerEnv::default());
        let read = env(&[
            (SPEAKER_MONITOR_ENV, " OFF "),
            (PCM_CONNECT_BURST_ENV, " 0 "),
            (DRIFT_COMPENSATION_ENV, "Observe"),
        ]);
        assert_eq!(
            read.values,
            values(Some(false), Some(0), Some(DriftMode::Observe))
        );
    }

    #[test]
    fn a_head_start_above_the_maximum_is_brought_down_to_it() {
        let settings =
            CompanionSettings::load(values(None, Some(9000), None), SpeakerEnv::default(), NONE);
        assert_eq!(
            settings.pcm_connect_burst_ms.value,
            MAX_PCM_CONNECT_BURST_MS
        );
    }

    #[test]
    fn apply_writes_values_and_origins_into_the_config() {
        let settings = CompanionSettings::load(
            values(Some(false), None, None),
            env(&[(PCM_CONNECT_BURST_ENV, "1500")]),
            values(None, None, Some(DriftMode::Observe)),
        );
        let mut config = Config::default();
        settings.apply_to(&mut config);
        assert!(!config.speaker_monitor);
        assert_eq!(config.pcm_connect_burst_ms, 1500);
        assert_eq!(config.drift_compensation, DriftMode::Observe);
        assert_eq!(
            config.setting_origins,
            SettingOrigins {
                speaker_monitor: SettingOrigin::File,
                pcm_connect_burst_ms: SettingOrigin::Env,
                drift_compensation: SettingOrigin::Flag,
            }
        );
    }

    #[test]
    fn startup_lines_say_key_value_and_source() {
        let settings = CompanionSettings::load(
            values(None, None, Some(DriftMode::Observe)),
            env(&[(PCM_CONNECT_BURST_ENV, "0")]),
            values(Some(false), None, None),
        );
        assert_eq!(
            settings.startup_lines(SettingNames::SERVER),
            [
                "speaker_monitor = off (--speaker-monitor); casts with video sync are still asked",
                "pcm_connect_burst_ms = 0 ms, off (THAUMIC_PCM_CONNECT_BURST_MS)",
                "drift_compensation = observe (config file); runs as off while speaker_monitor is off",
            ]
        );

        let legacy = CompanionSettings::load(NONE, env(&[(SPEAKER_DIAGNOSTICS_ENV, "1")]), NONE);
        assert_eq!(
            legacy.startup_lines(SettingNames::DESKTOP),
            [
                "speakerMonitor = on (THAUMIC_SPEAKER_DIAGNOSTICS)",
                "pcmConnectBurstMs = 500 ms (default)",
                "driftCompensation = on (default)",
            ]
        );
    }
}
