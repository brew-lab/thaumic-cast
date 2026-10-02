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
use thaumic_core::{DriftMode, SpeakerSettingValues};

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
    /// Defaults to `on`. Needs `speaker_monitor`: with the monitor off
    /// it runs as `off`, and startup warns once. Applies from each speaker's
    /// next connection. See `thaumic_core::Config`.
    /// Override: `THAUMIC_DRIFT_COMPENSATION` (`on`, `observe` or `off`)
    pub drift_compensation: DriftMode,

    /// Which of the three speaker settings above the file itself set, so
    /// that start-up can say where each value came from. Not a key.
    #[serde(skip)]
    speaker_keys: SpeakerKeys,
}

/// Every key a config file may set: the fields of [`ServerConfig`], as they
/// are spelt in YAML. A key outside this list is warned about and ignored.
const KNOWN_KEYS: [&str; 9] = [
    "bind_port",
    "advertise_ip",
    "topology_refresh_interval",
    "data_dir",
    "artwork_url",
    "strict_stream_access",
    "speaker_monitor",
    "pcm_connect_burst_ms",
    "drift_compensation",
];

/// Which of the three speaker keys a config file has. Presence only: the
/// values are the ones [`ServerConfig`] itself parsed and validated. Any
/// other key, a camelCase spelling of these included, is not looked at.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
struct SpeakerKeys {
    #[serde(deserialize_with = "present")]
    speaker_monitor: bool,
    #[serde(deserialize_with = "present")]
    pcm_connect_burst_ms: bool,
    #[serde(deserialize_with = "present")]
    drift_compensation: bool,
}

/// The top-level keys of a YAML document, in the order the file has them.
/// A document that is not a mapping has none.
///
/// Fails where the document cannot be read as plain YAML values although
/// [`ServerConfig`] read it: a key the server does not read, written twice,
/// is skipped by the struct and refused here.
fn file_keys(content: &str) -> Result<Vec<String>, serde_yaml::Error> {
    let serde_yaml::Value::Mapping(mapping) = serde_yaml::from_str(content)? else {
        return Ok(Vec::new());
    };
    Ok(mapping
        .keys()
        .map(|key| match key {
            serde_yaml::Value::String(name) => name.clone(),
            other => serde_yaml::to_string(other)
                .map(|text| text.trim().to_string())
                .unwrap_or_else(|_| format!("{other:?}")),
        })
        .collect())
}

/// The warnings to log about the keys of the config file at `path`: one for
/// each key the server does not read, or one line saying the keys could not
/// be checked. `content` is a document [`ServerConfig`] has already read.
fn key_warnings(content: &str, path: &Path) -> Vec<String> {
    match file_keys(content) {
        Ok(keys) => keys
            .iter()
            .filter(|key| !KNOWN_KEYS.contains(&key.as_str()))
            .map(|key| unknown_key_warning(key, &keys, path))
            .collect(),
        Err(e) => vec![format!(
            "{} was read, but could not be checked for keys the server does not read: {e}.",
            path.display()
        )],
    }
}

/// A known key with at least this many letters, separators aside, may be two
/// slips away from a misspelling of it. A shorter one may be one: at two,
/// `bind_host` would pass for `bind_port`.
const LONG_KEY_LETTERS: usize = 12;

/// The known key an unknown one was most likely meant to be: the same
/// letters in another spelling (`bindPort`, `bind-port`), or within a slip
/// of the keyboard (`bind_prot`): one for a short key, two for a key of
/// [`LONG_KEY_LETTERS`] letters or more, where two slips still leave it
/// recognisable. `None` when nothing is that close.
fn nearest_known_key(unknown: &str) -> Option<&'static str> {
    let letters = |key: &str| -> Vec<char> {
        key.chars()
            .filter(|c| !matches!(c, '_' | '-'))
            .flat_map(char::to_lowercase)
            .collect()
    };
    let unknown = letters(unknown);
    KNOWN_KEYS
        .iter()
        .filter_map(|known| {
            let known_letters = letters(known);
            let allowed = if known_letters.len() >= LONG_KEY_LETTERS {
                2
            } else {
                1
            };
            let distance = edit_distance(&unknown, &known_letters);
            (distance <= allowed).then_some((distance, *known))
        })
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, known)| known)
}

/// How many letters must be added, dropped, changed or swapped with a
/// neighbour to turn `a` into `b`.
fn edit_distance(a: &[char], b: &[char]) -> usize {
    let mut rows = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in rows.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in rows[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let change = usize::from(a[i - 1] != b[j - 1]);
            let mut best = (rows[i - 1][j] + 1)
                .min(rows[i][j - 1] + 1)
                .min(rows[i - 1][j - 1] + change);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                best = best.min(rows[i - 2][j - 2] + 1);
            }
            rows[i][j] = best;
        }
    }
    rows[a.len()][b.len()]
}

/// The warning for one key the config file at `path` has and the server
/// does not read. `file_keys` is every key of that file.
///
/// A key spelt nearly as a real one gets a second sentence naming the real
/// one, unless the file has the real one as well. The sentence speaks only
/// of this line: the setting may still be set by a flag or a variable.
fn unknown_key_warning(key: &str, file_keys: &[String], path: &Path) -> String {
    let mut warning = format!(
        "{key} in {} is not a key the server reads, so it was ignored.",
        path.display()
    );
    if let Some(known) = nearest_known_key(key) {
        if !file_keys.iter().any(|file_key| file_key == known) {
            warning.push_str(&format!(" If {known} was meant, this line did not set it."));
        }
    }
    warning
}

/// Reads any value at all and says the key was there.
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    serde::de::IgnoredAny::deserialize(deserializer).map(|_| true)
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
            speaker_keys: SpeakerKeys::default(),
        }
    }
}

impl ServerConfig {
    /// Loads and validates configuration from a YAML file.
    ///
    /// Without a path the defaults are used. Returns an error if the file
    /// cannot be read or parsed, or if any value is out of range. A key the
    /// server does not read is no error: each one is warned about in the log
    /// and ignored, so a misspelt key cannot keep the server from starting.
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let config = if let Some(path) = path {
            let content = std::fs::read_to_string(path)
                .with_context(|| format!("Could not read the config file {}", path.display()))?;
            let config = Self::from_yaml(&content)
                .with_context(|| format!("The config file {} cannot be used", path.display()))?;
            for warning in key_warnings(&content, path) {
                log::warn!("{warning}");
            }
            config
        } else {
            Self::default()
        };

        config.validate()?;
        Ok(config)
    }

    /// Parses configuration from a YAML document.
    fn from_yaml(content: &str) -> Result<Self> {
        let mut config: Self = serde_yaml::from_str(content)
            .context("It was read, and this is where it went wrong")?;
        // The same document again, only for which of the speaker keys it has.
        config.speaker_keys = serde_yaml::from_str(content)
            .context("It was read, and this is where it went wrong")?;
        Ok(config)
    }

    /// What the config file said about the three speaker settings: the value
    /// held here for every key the file had, nothing for a key it lacked.
    ///
    /// Call it before a flag or a variable is written over these fields.
    pub fn speaker_file_values(&self) -> SpeakerSettingValues {
        SpeakerSettingValues {
            speaker_monitor: self
                .speaker_keys
                .speaker_monitor
                .then_some(self.speaker_monitor),
            pcm_connect_burst_ms: self
                .speaker_keys
                .pcm_connect_burst_ms
                .then_some(self.pcm_connect_burst_ms),
            drift_compensation: self
                .speaker_keys
                .drift_compensation
                .then_some(self.drift_compensation),
        }
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
            bail!("topology_refresh_interval is 0, and the least it can be is 1 second");
        }
        let max_burst = thaumic_core::protocol_constants::MAX_PCM_CONNECT_BURST_MS;
        if self.pcm_connect_burst_ms > max_burst {
            bail!(
                "pcm_connect_burst_ms is {}, and the longest speaker head start is {max_burst} ms",
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
                "drift_compensation is {} but speaker monitoring is off. Clock drift correction \
                 steers by what the monitoring reports, so it runs as off. Turn speaker \
                 monitoring on (speaker_monitor, --speaker-monitor or \
                 THAUMIC_SPEAKER_MONITOR), or set drift_compensation to off.",
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

    /// Drift correction ships on, reaches core, a config file that leaves
    /// the key out gets the default, and one that sets it keeps its value.
    #[test]
    fn drift_compensation_defaults_to_on_and_is_forwarded_to_core() {
        assert_eq!(
            ServerConfig::default().to_core_config().drift_compensation,
            DriftMode::On
        );
        let config = ServerConfig::from_yaml("bind_port: 49400\n").expect("should parse");
        assert_eq!(config.to_core_config().drift_compensation, DriftMode::On);
        for (saved, mode) in [("observe", DriftMode::Observe), ("off", DriftMode::Off)] {
            let config = ServerConfig::from_yaml(&format!("drift_compensation: {saved}\n"))
                .expect("should parse");
            assert_eq!(config.to_core_config().drift_compensation, mode);
        }
        assert!(ServerConfig::from_yaml("drift_compensation: sometimes\n").is_err());
    }

    /// Correction asked for with the monitor off is warned about once at
    /// startup; with it off, or the monitor on, there is nothing to say.
    #[test]
    fn server_warns_when_monitor_off() {
        let default = ServerConfig::default();
        let warning = default.drift_warning(false).expect("a warning");
        assert!(warning.contains("drift_compensation is on"), "{warning}");
        assert!(warning.contains("runs as off"), "{warning}");
        assert_eq!(default.drift_warning(true), None);

        let off = ServerConfig::from_yaml("drift_compensation: off\n").expect("should parse");
        assert_eq!(off.drift_warning(false), None);
    }

    /// A file records which of the three speaker settings it sets, and only
    /// those.
    #[test]
    fn the_file_says_which_speaker_settings_it_sets() {
        assert_eq!(
            ServerConfig::default().speaker_file_values(),
            SpeakerSettingValues::default()
        );
        let config = ServerConfig::from_yaml("bind_port: 49400\n").expect("should parse");
        assert_eq!(
            config.speaker_file_values(),
            SpeakerSettingValues::default()
        );

        let config = ServerConfig::from_yaml(
            "speaker_monitor: true\npcm_connect_burst_ms: 750\ndrift_compensation: observe\n",
        )
        .expect("should parse");
        assert_eq!(
            config.speaker_file_values(),
            SpeakerSettingValues {
                speaker_monitor: Some(true),
                pcm_connect_burst_ms: Some(750),
                drift_compensation: Some(DriftMode::Observe),
            }
        );
    }

    /// The file's keys are snake_case. A camelCase spelling is not a key: it
    /// is ignored as any unknown key is, alone or beside the real one.
    #[test]
    fn a_camel_case_speaker_key_is_not_read() {
        let config = ServerConfig::from_yaml(
            "speakerMonitor: false\npcmConnectBurstMs: 1000\ndriftCompensation: off\n",
        )
        .expect("should parse");
        assert!(config.speaker_monitor);
        assert_eq!(config.pcm_connect_burst_ms, 500);
        assert_eq!(config.drift_compensation, DriftMode::On);
        assert_eq!(
            config.speaker_file_values(),
            SpeakerSettingValues::default()
        );

        let both = ServerConfig::from_yaml(
            "speakerMonitor: true\nspeaker_monitor: false\npcm_connect_burst_ms: 750\n",
        )
        .expect("should parse");
        assert_eq!(
            both.speaker_file_values(),
            SpeakerSettingValues {
                speaker_monitor: Some(false),
                pcm_connect_burst_ms: Some(750),
                drift_compensation: None,
            }
        );
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

    /// Hands back the field names serde was given for a struct, and nothing
    /// else: enough to see which keys `ServerConfig` reads.
    struct FieldNames;

    impl<'de> serde::Deserializer<'de> for FieldNames {
        type Error = serde::de::value::Error;

        fn deserialize_any<V: serde::de::Visitor<'de>>(
            self,
            _: V,
        ) -> Result<V::Value, Self::Error> {
            Err(serde::de::Error::custom("not a struct"))
        }

        fn deserialize_struct<V: serde::de::Visitor<'de>>(
            self,
            _name: &'static str,
            fields: &'static [&'static str],
            _: V,
        ) -> Result<V::Value, Self::Error> {
            Err(serde::de::Error::custom(fields.join(",")))
        }

        serde::forward_to_deserialize_any! {
            bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
            bytes byte_buf option unit unit_struct newtype_struct seq tuple
            tuple_struct map enum identifier ignored_any
        }
    }

    /// The list of known keys is written by hand beside the struct. A field
    /// added to one and not the other would be warned about as unknown, or
    /// never warned about at all.
    #[test]
    fn the_known_keys_are_the_fields_the_config_reads() {
        let fields = ServerConfig::deserialize(FieldNames)
            .expect_err("FieldNames only reports the fields")
            .to_string();
        assert_eq!(fields, KNOWN_KEYS.join(","));
    }

    #[test]
    fn an_unknown_key_is_reported_and_the_file_still_loads() {
        let content = "bind_port: 8080\ncolour: blue\nspeaker_monitor: false\n";

        let config = ServerConfig::from_yaml(content).expect("should parse");
        config.validate().expect("should validate");
        assert_eq!(config.bind_port, 8080);
        assert!(!config.speaker_monitor);

        assert_eq!(
            key_warnings(content, Path::new("/etc/thaumic-server/config.yaml")),
            [
                "colour in /etc/thaumic-server/config.yaml is not a key the server reads, so it \
                 was ignored."
            ]
        );
    }

    #[test]
    fn a_file_of_known_keys_reports_nothing() {
        let path = Path::new("config.yaml");
        assert!(key_warnings(include_str!("../config.example.yaml"), path).is_empty());
        assert!(key_warnings("", path).is_empty());
        assert!(key_warnings("- a list\n- not a mapping\n", path).is_empty());
        let every_key: String = KNOWN_KEYS.iter().map(|key| format!("{key}: 1\n")).collect();
        assert!(key_warnings(&every_key, path).is_empty());
    }

    /// The dangerous unknown key is the misspelt real one: the setting it
    /// was meant for quietly keeps its old value.
    #[test]
    fn a_misspelt_key_is_reported_with_the_key_it_resembles() {
        let content = "bind_prot: 8080\n";
        let config = ServerConfig::from_yaml(content).expect("should parse");
        assert_eq!(config.bind_port, ServerConfig::default().bind_port);

        assert_eq!(
            key_warnings(content, Path::new("config.yaml")),
            [
                "bind_prot in config.yaml is not a key the server reads, so it was ignored. If \
                 bind_port was meant, this line did not set it."
            ]
        );

        assert_eq!(
            nearest_known_key("pcmConnectBurstMs"),
            Some("pcm_connect_burst_ms")
        );
        assert_eq!(
            nearest_known_key("speaker-monitor"),
            Some("speaker_monitor")
        );
        assert_eq!(nearest_known_key("artwork_uri"), Some("artwork_url"));
        assert_eq!(
            nearest_known_key("drift_compansatoin"),
            Some("drift_compensation")
        );
        assert_eq!(nearest_known_key("colour"), None);
        assert_eq!(nearest_known_key("port"), None);
    }

    /// A short key two letters from a real one is another word, not a slip.
    #[test]
    fn a_short_key_two_letters_from_a_real_one_is_not_taken_for_it() {
        assert_eq!(nearest_known_key("bind_host"), None);
        assert_eq!(nearest_known_key("data_dirs"), Some("data_dir"));
        assert_eq!(nearest_known_key("data_file"), None);
    }

    /// The file has the misspelt key and the real one: the real one is set,
    /// so the warning must not say otherwise.
    #[test]
    fn a_misspelt_key_beside_the_real_one_does_not_say_the_real_one_is_unset() {
        let content = "colour: blue\nbind_prot: 1\nbind_port: 8080\n";
        let config = ServerConfig::from_yaml(content).expect("should parse");
        assert_eq!(config.bind_port, 8080);
        assert_eq!(
            key_warnings(content, Path::new("config.yaml")),
            [
                "colour in config.yaml is not a key the server reads, so it was ignored.",
                "bind_prot in config.yaml is not a key the server reads, so it was ignored.",
            ]
        );
    }

    /// An unread key written twice is skipped by the struct and refused by
    /// the plain parse the key check uses. The file still loads, and one
    /// line says the check did not happen.
    #[test]
    fn a_file_whose_keys_cannot_be_checked_says_so_once() {
        let content = "colour: blue\ncolour: red\nbind_prot: 1\nbind_port: 8080\n";
        let config = ServerConfig::from_yaml(content).expect("should parse");
        assert_eq!(config.bind_port, 8080);

        let warnings = key_warnings(content, Path::new("config.yaml"));
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].starts_with(
                "config.yaml was read, but could not be checked for keys the server does not \
                 read: "
            ),
            "{}",
            warnings[0]
        );
        assert!(warnings[0].contains("colour"), "{}", warnings[0]);
    }

    /// An unknown key is tolerated; a bad value for a known key is not, with
    /// or without an unknown key beside it.
    #[test]
    fn a_bad_value_for_a_known_key_still_fails_beside_an_unknown_key() {
        assert!(ServerConfig::from_yaml("colour: blue\nbind_port: 70000\n").is_err());
        assert!(ServerConfig::from_yaml("colour: blue\ndrift_compensation: sometimes\n").is_err());

        let dir = std::env::temp_dir().join(format!("thaumic-config-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.yaml");

        std::fs::write(&path, "colour: blue\nbind_prot: 1\nbind_port: 8080\n").unwrap();
        let config = ServerConfig::load(Some(&path)).expect("unknown keys do not stop a start");
        assert_eq!(config.bind_port, 8080);

        std::fs::write(&path, "colour: blue\npcm_connect_burst_ms: 2001\n").unwrap();
        let err = ServerConfig::load(Some(&path)).expect_err("above the maximum");
        assert!(err.to_string().contains("pcm_connect_burst_ms"));

        std::fs::write(&path, "colour: blue\ntopology_refresh_interval: 0\n").unwrap();
        assert!(ServerConfig::load(Some(&path)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
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
