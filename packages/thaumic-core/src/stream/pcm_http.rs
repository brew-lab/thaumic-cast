//! How a PCM stream is served over HTTP, and the switches that change it for
//! a field experiment.
//!
//! A PCM stream is sent chunked, with no `Content-Length`, and 0xFFFFFFFF in
//! both WAV size fields. It used to declare `Content-Length: 4294967295`, and
//! a Playbar (S2 86.10) stopped every such cast after exactly 2^31 bytes, 3h06m
//! at 48 kHz stereo: it caps a declared length at 2^31. The same speaker plays
//! a chunked stream with the 0xFFFFFFFF header past that point until 2^32
//! bytes, 6h12m50s, where it obeys the header's length and stops; it obeys a
//! smaller size in the WAV header too (see [`WAV_STREAM_SIZE_MAX`]).
//!
//! The switches let a field experiment change one thing at a time without a
//! rebuild: how the body is delimited, the length it declares, the sizes in
//! the WAV header, and a clean end from our side after a set number of bytes.
//! They are read from the environment once per connection, and none of them
//! is a setting: unset, a PCM stream is served as described above.

use std::fmt;

use crate::protocol_constants::WAV_STREAM_SIZE_MAX;

/// Environment variable that picks how a PCM response body is delimited:
/// `chunked` (the default), `length` or `close`. See [`PcmHttpFraming`].
pub const PCM_HTTP_FRAMING_ENV: &str = "THAUMIC_PCM_HTTP_FRAMING";

/// Environment variable that sets the `Content-Length` a PCM response
/// declares in `length` framing, in bytes (default 4294967295). Ignored in the
/// other framings, which declare no length.
pub const PCM_CONTENT_LENGTH_ENV: &str = "THAUMIC_PCM_CONTENT_LENGTH";

/// Environment variable that sets the data size in a PCM stream's WAV header,
/// in bytes, from 0 to 4294967295 (default 4294967295). The RIFF size follows
/// it (see [`riff_size_for`]).
pub const PCM_WAV_DATA_SIZE_ENV: &str = "THAUMIC_PCM_WAV_DATA_SIZE";

/// Environment variable that ends a PCM response body cleanly from our side
/// after this many bytes, WAV header included. Honoured only in `chunked` (the
/// default) and `close` framing: with a declared length, hyper aborts a body that ends
/// short of it instead of ending it cleanly.
pub const PCM_END_AFTER_BYTES_ENV: &str = "THAUMIC_PCM_END_AFTER_BYTES";

/// The environment variables [`PcmHttpSettings::from_env`] reads, in the
/// order they are reported.
const SWITCH_VARS: [&str; 4] = [
    PCM_HTTP_FRAMING_ENV,
    PCM_CONTENT_LENGTH_ENV,
    PCM_WAV_DATA_SIZE_ENV,
    PCM_END_AFTER_BYTES_ENV,
];

/// How a PCM response body is delimited on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PcmHttpFraming {
    /// Declare no length: hyper sends the body chunked to an HTTP/1.1 client,
    /// with no end of its own. An HTTP/1.0 client cannot take chunks, so hyper
    /// answers it as HTTP/1.0 with a body that ends only when the connection
    /// closes. The default.
    #[default]
    Chunked,
    /// Declare a `Content-Length` (4294967295 unless
    /// [`PCM_CONTENT_LENGTH_ENV`] says otherwise). hyper stops the body once
    /// that many bytes are written, and a Playbar stops at 2^31 bytes whatever
    /// larger length is declared. What PCM was served with before chunked, kept
    /// for comparison.
    Length,
    /// Answer as HTTP/1.0 with `Connection: close` and no length: the body
    /// ends only when the connection is closed.
    Close,
}

impl PcmHttpFraming {
    /// Parses a framing name: `chunked`, `length` or `close`, in any case.
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "chunked" => Ok(Self::Chunked),
            "length" => Ok(Self::Length),
            "close" => Ok(Self::Close),
            _ => Err(format!("expected chunked, length or close, got {value:?}")),
        }
    }

    /// The name used for this framing in log lines and the environment.
    pub fn label(self) -> &'static str {
        match self {
            Self::Length => "length",
            Self::Chunked => "chunked",
            Self::Close => "close",
        }
    }
}

impl fmt::Display for PcmHttpFraming {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// The RIFF chunk size that goes with a WAV data size: the data plus the 36
/// bytes of the header that follow the RIFF size field, capped at
/// 0xFFFFFFFF (so the default data size keeps the default RIFF size).
pub fn riff_size_for(data_size: u32) -> u32 {
    data_size.saturating_add(36)
}

/// How one PCM connection is served, as the switches in this module set it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PcmHttpSettings {
    /// How the response body is delimited.
    pub framing: PcmHttpFraming,
    /// The `Content-Length` declared in [`PcmHttpFraming::Length`] framing,
    /// and unused in the others.
    pub content_length: u64,
    /// The data size written into the WAV header.
    pub wav_data_size: u32,
    /// Ends the body cleanly after this many bytes, when set. Only ever set
    /// with [`PcmHttpFraming::Chunked`] or [`PcmHttpFraming::Close`].
    pub end_after_bytes: Option<u64>,
}

impl Default for PcmHttpSettings {
    /// What PCM is served with when no switch is set.
    fn default() -> Self {
        Self {
            framing: PcmHttpFraming::Chunked,
            content_length: u64::from(WAV_STREAM_SIZE_MAX),
            wav_data_size: WAV_STREAM_SIZE_MAX,
            end_after_bytes: None,
        }
    }
}

/// The switches as one connection read them: the settings they amount to,
/// whether any was set at all, and what was wrong with them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PcmHttpSwitches {
    /// The settings to serve the connection with.
    pub settings: PcmHttpSettings,
    /// Whether any switch was set to something other than blank, valid or
    /// not: the connection is then part of an experiment, and says so.
    pub any_set: bool,
    /// One line per switch that was invalid or does not apply to the chosen
    /// framing, and was ignored.
    pub problems: Vec<String>,
}

impl PcmHttpSwitches {
    /// Reads the switches from the environment. Called once per connection,
    /// so a change applies from the next one.
    ///
    /// A value that is not valid UTF-8 is ignored like any other invalid one,
    /// and reported, rather than being taken for unset.
    pub fn from_env() -> Self {
        let mut unreadable = Vec::new();
        let raw = SWITCH_VARS.map(|var| read_switch(var, std::env::var_os(var), &mut unreadable));
        let [framing, content_length, wav_data_size, end_after_bytes] = raw;
        Self::resolve(RawSwitches {
            framing: framing.as_deref(),
            content_length: content_length.as_deref(),
            wav_data_size: wav_data_size.as_deref(),
            end_after_bytes: end_after_bytes.as_deref(),
        })
        .with_unreadable(unreadable)
    }

    /// Adds the problems of switches whose values could not be read at all
    /// (see [`read_switch`]), first: such a switch was still set, so the
    /// connection is part of an experiment.
    fn with_unreadable(mut self, unreadable: Vec<String>) -> Self {
        if !unreadable.is_empty() {
            self.any_set = true;
            self.problems.splice(0..0, unreadable);
        }
        self
    }

    /// [`Self::from_env`] without the environment.
    fn resolve(raw: RawSwitches<'_>) -> Self {
        let mut problems = Vec::new();
        let mut settings = PcmHttpSettings::default();
        fn set(value: Option<&str>) -> Option<&str> {
            value.filter(|v| !v.trim().is_empty())
        }
        let raw = RawSwitches {
            framing: set(raw.framing),
            content_length: set(raw.content_length),
            wav_data_size: set(raw.wav_data_size),
            end_after_bytes: set(raw.end_after_bytes),
        };
        let any_set = raw.framing.is_some()
            || raw.content_length.is_some()
            || raw.wav_data_size.is_some()
            || raw.end_after_bytes.is_some();

        let mut ignore = |var: &str, value: &str, why: String| {
            problems.push(format!("Ignoring {var}={value:?}: {why}"));
        };

        if let Some(value) = raw.framing {
            match PcmHttpFraming::parse(value) {
                Ok(framing) => settings.framing = framing,
                Err(e) => ignore(PCM_HTTP_FRAMING_ENV, value, e),
            }
        }
        if let Some(value) = raw.wav_data_size {
            match parse_wav_data_size(value) {
                Ok(size) => settings.wav_data_size = size,
                Err(e) => ignore(PCM_WAV_DATA_SIZE_ENV, value, e),
            }
        }
        if let Some(value) = raw.content_length {
            match parse_positive_bytes(value) {
                Ok(_) if settings.framing != PcmHttpFraming::Length => ignore(
                    PCM_CONTENT_LENGTH_ENV,
                    value,
                    format!(
                        "only applies with {PCM_HTTP_FRAMING_ENV}=length, and the framing is {}",
                        settings.framing
                    ),
                ),
                Ok(len) => settings.content_length = len,
                Err(e) => ignore(PCM_CONTENT_LENGTH_ENV, value, e),
            }
        }
        if let Some(value) = raw.end_after_bytes {
            match parse_positive_bytes(value) {
                Ok(_) if settings.framing == PcmHttpFraming::Length => ignore(
                    PCM_END_AFTER_BYTES_ENV,
                    value,
                    format!(
                        "only applies with {PCM_HTTP_FRAMING_ENV}=chunked or close; with a \
                         declared length, ending the body early aborts the connection instead of \
                         ending it cleanly"
                    ),
                ),
                Ok(n) => settings.end_after_bytes = Some(n),
                Err(e) => ignore(PCM_END_AFTER_BYTES_ENV, value, e),
            }
        }

        Self {
            settings,
            any_set,
            problems,
        }
    }
}

/// The value of switch `var` as the environment gave it: `None` when unset,
/// and also when it is not valid UTF-8, which adds a line to `unreadable`.
fn read_switch(
    var: &str,
    value: Option<std::ffi::OsString>,
    unreadable: &mut Vec<String>,
) -> Option<String> {
    match value?.into_string() {
        Ok(value) => Some(value),
        Err(value) => {
            unreadable.push(format!(
                "Ignoring {var}={:?}: not valid UTF-8",
                value.to_string_lossy()
            ));
            None
        }
    }
}

/// The raw values of the switches, `None` where a variable is unset.
#[derive(Debug, Default, Clone, Copy)]
struct RawSwitches<'a> {
    framing: Option<&'a str>,
    content_length: Option<&'a str>,
    wav_data_size: Option<&'a str>,
    end_after_bytes: Option<&'a str>,
}

/// Parses a byte count of at least 1.
fn parse_positive_bytes(value: &str) -> Result<u64, String> {
    match value.trim().parse::<u64>() {
        Ok(0) => Err("expected at least 1 byte, got 0".to_string()),
        Ok(n) => Ok(n),
        Err(_) => Err(format!("expected a number of bytes, got {value:?}")),
    }
}

/// Parses a WAV data size: 0 to 4294967295 bytes.
fn parse_wav_data_size(value: &str) -> Result<u32, String> {
    value
        .trim()
        .parse::<u32>()
        .map_err(|_| format!("expected bytes from 0 to {}, got {value:?}", u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve(
        framing: Option<&str>,
        content_length: Option<&str>,
        wav_data_size: Option<&str>,
        end_after_bytes: Option<&str>,
    ) -> PcmHttpSwitches {
        PcmHttpSwitches::resolve(RawSwitches {
            framing,
            content_length,
            wav_data_size,
            end_after_bytes,
        })
    }

    #[test]
    fn unset_switches_serve_pcm_chunked_with_the_largest_wav_sizes() {
        let switches = resolve(None, None, None, None);
        assert_eq!(
            switches.settings,
            PcmHttpSettings {
                framing: PcmHttpFraming::Chunked,
                content_length: 4_294_967_295,
                wav_data_size: 0xFFFF_FFFF,
                end_after_bytes: None,
            }
        );
        assert!(!switches.any_set);
        assert!(switches.problems.is_empty());
        assert_eq!(resolve(Some(" "), Some(""), None, None), switches);
    }

    #[test]
    fn framing_names_parse_in_any_case() {
        assert_eq!(PcmHttpFraming::parse("length"), Ok(PcmHttpFraming::Length));
        assert_eq!(
            PcmHttpFraming::parse(" Chunked "),
            Ok(PcmHttpFraming::Chunked)
        );
        assert_eq!(PcmHttpFraming::parse("CLOSE"), Ok(PcmHttpFraming::Close));
        assert!(PcmHttpFraming::parse("chunky").is_err());
        assert_eq!(PcmHttpFraming::Close.to_string(), "close");
    }

    #[test]
    fn an_explicit_default_still_marks_the_connection_as_an_experiment() {
        let switches = resolve(Some("chunked"), None, None, None);
        assert_eq!(switches.settings, PcmHttpSettings::default());
        assert!(switches.any_set);
    }

    /// Length framing is still there for comparison, and by default declares
    /// the length PCM was served with before chunked.
    #[test]
    fn explicit_length_framing_declares_the_largest_length() {
        let switches = resolve(Some("length"), None, None, None);
        assert_eq!(switches.settings.framing, PcmHttpFraming::Length);
        assert_eq!(switches.settings.content_length, 4_294_967_295);
        assert_eq!(switches.settings.wav_data_size, 0xFFFF_FFFF);
        assert!(switches.problems.is_empty());
    }

    #[test]
    fn a_content_length_applies_in_length_framing_only() {
        let length = resolve(Some("length"), Some("10485760"), None, None);
        assert_eq!(length.settings.content_length, 10_485_760);
        assert!(length.problems.is_empty());

        // Unset framing is chunked, which declares no length.
        let default = resolve(None, Some("10485760"), None, None);
        assert_eq!(default.settings.framing, PcmHttpFraming::Chunked);
        assert_eq!(default.settings.content_length, 4_294_967_295);
        assert_eq!(default.problems.len(), 1);
        assert!(default.problems[0].contains("the framing is chunked"));

        // Above u32::MAX too: H2 declares 2^32 + 10 MiB.
        let wide = resolve(Some("length"), Some("4305453056"), None, None);
        assert_eq!(wide.settings.content_length, 4_305_453_056);

        let chunked = resolve(Some("chunked"), Some("10485760"), None, None);
        assert_eq!(chunked.settings.content_length, 4_294_967_295);
        assert_eq!(chunked.problems.len(), 1);
        assert!(chunked.problems[0].contains(PCM_CONTENT_LENGTH_ENV));
    }

    #[test]
    fn a_wav_data_size_can_be_anything_a_u32_holds() {
        let switches = resolve(Some("chunked"), None, Some("10485760"), None);
        assert_eq!(switches.settings.wav_data_size, 10_485_760);
        assert_eq!(switches.settings.framing, PcmHttpFraming::Chunked);
        assert_eq!(
            resolve(None, None, Some("0"), None).settings.wav_data_size,
            0
        );
        let too_big = resolve(None, None, Some("4294967296"), None);
        assert_eq!(too_big.settings.wav_data_size, 0xFFFF_FFFF);
        assert_eq!(too_big.problems.len(), 1);
    }

    #[test]
    fn an_early_end_is_refused_with_a_declared_length() {
        let length = resolve(Some("length"), None, None, Some("10485760"));
        assert_eq!(length.settings.end_after_bytes, None);
        assert_eq!(length.problems.len(), 1);
        assert!(length.problems[0].contains("aborts the connection"));

        for framing in [None, Some("chunked"), Some("close")] {
            let switches = resolve(framing, None, None, Some("10485760"));
            assert_eq!(switches.settings.end_after_bytes, Some(10_485_760));
            assert!(switches.problems.is_empty(), "{framing:?}");
        }
    }

    #[test]
    fn invalid_values_are_ignored_and_reported() {
        let switches = resolve(Some("chunky"), Some("0"), Some("-1"), Some("lots"));
        assert_eq!(switches.settings, PcmHttpSettings::default());
        assert!(switches.any_set);
        assert_eq!(switches.problems.len(), 4, "{:?}", switches.problems);
        assert!(switches.problems[0].starts_with("Ignoring THAUMIC_PCM_HTTP_FRAMING=\"chunky\""));
    }

    #[cfg(unix)]
    #[test]
    fn a_value_that_is_not_utf8_is_reported_not_taken_for_unset() {
        use std::os::unix::ffi::OsStringExt;

        let mut unreadable = Vec::new();
        let bad = std::ffi::OsString::from_vec(vec![b'c', 0xFF]);
        assert_eq!(
            read_switch(PCM_HTTP_FRAMING_ENV, Some(bad), &mut unreadable),
            None
        );
        assert_eq!(
            read_switch(PCM_WAV_DATA_SIZE_ENV, Some("10".into()), &mut unreadable),
            Some("10".to_string())
        );
        assert_eq!(
            read_switch(PCM_CONTENT_LENGTH_ENV, None, &mut unreadable),
            None
        );
        assert_eq!(unreadable.len(), 1, "{unreadable:?}");
        assert!(unreadable[0].starts_with("Ignoring THAUMIC_PCM_HTTP_FRAMING="));
        assert!(unreadable[0].ends_with("not valid UTF-8"));

        let switches = resolve(None, None, None, Some("lots")).with_unreadable(unreadable);
        assert!(switches.any_set);
        assert_eq!(switches.settings, PcmHttpSettings::default());
        assert_eq!(switches.problems.len(), 2, "{:?}", switches.problems);
        assert!(switches.problems[0].ends_with("not valid UTF-8"));

        let quiet = resolve(None, None, None, None).with_unreadable(Vec::new());
        assert!(!quiet.any_set);
        assert!(quiet.problems.is_empty());
    }

    #[test]
    fn the_riff_size_follows_the_data_size() {
        assert_eq!(riff_size_for(10_485_760), 10_485_796);
        assert_eq!(riff_size_for(0), 36);
        assert_eq!(riff_size_for(u32::MAX), u32::MAX);
        assert_eq!(riff_size_for(u32::MAX - 10), u32::MAX);
    }
}
