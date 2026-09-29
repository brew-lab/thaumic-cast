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
//! That 4 GiB length is a real end, so a PCM cast is served as consecutive
//! segments, each a connection whose WAV header declares a little under
//! 4 GiB and whose body ends there, carried on by one playout per speaker
//! (see [`crate::stream::playout`]).
//!
//! The switches let a field experiment change one thing at a time without a
//! rebuild: how the body is delimited, the length it declares, the sizes in
//! the WAV header, a clean end from our side after a set number of bytes, the
//! size of a segment, and how a speaker is moved on to the next one. They are read from the environment once per
//! connection, and none of them is a setting: unset, a PCM stream is served
//! as described above.
//!
//! The older switches that set the WAV header's size, end the body after a
//! set number of bytes or declare a length each fix one connection's end
//! themselves, so while any of them is set a PCM stream is served as it was
//! before segments: on one connection, with no playout carried beyond it.

use std::fmt;

use super::tap::WAV_HEADER_BYTES;
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

/// Environment variable that sets the data size of each PCM segment, in
/// bytes, from 1048576 (1 MiB) to 4294901760 (`0xFFFF0000`, the default),
/// rounded down to whole 10 ms frames. `10485760` gives 54.61 s segments at
/// 48 kHz stereo, for testing the switch from one to the next. Ignored while
/// a switch that fixes a connection's end is set (see the module docs).
pub const PCM_SEGMENT_BYTES_ENV: &str = "THAUMIC_PCM_SEGMENT_BYTES";

/// Environment variable that picks how a speaker is moved on from one PCM
/// segment to the next: `restart` (the default) or `off`. See
/// [`PcmContinuation`]. Ignored while segments are off.
pub const PCM_CONTINUATION_ENV: &str = "THAUMIC_PCM_CONTINUATION";

/// The environment variables [`PcmHttpSettings::from_env`] reads, in the
/// order they are reported.
const SWITCH_VARS: [&str; 6] = [
    PCM_HTTP_FRAMING_ENV,
    PCM_CONTENT_LENGTH_ENV,
    PCM_WAV_DATA_SIZE_ENV,
    PCM_END_AFTER_BYTES_ENV,
    PCM_SEGMENT_BYTES_ENV,
    PCM_CONTINUATION_ENV,
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

/// How a speaker is moved on from one PCM segment to the next once it has
/// played the first to its end.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PcmContinuation {
    /// Once the speaker has played a segment to its end and reported
    /// STOPPED, the server itself tells it to play the next one
    /// (`SetAVTransportURI` and `Play`): a pause of about a second and a half
    /// every segment, and nothing the user has to do. The default.
    #[default]
    Restart,
    /// Nothing moves the speaker on: the cast ends after its first segment,
    /// as it did before continuation existed. For comparison.
    Off,
}

impl PcmContinuation {
    /// Parses a continuation name: `restart` or `off`, in any case.
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "restart" => Ok(Self::Restart),
            "off" => Ok(Self::Off),
            _ => Err(format!("expected restart or off, got {value:?}")),
        }
    }

    /// The name used for this mode in log lines and the environment.
    pub fn label(self) -> &'static str {
        match self {
            Self::Restart => "restart",
            Self::Off => "off",
        }
    }
}

impl fmt::Display for PcmContinuation {
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
    /// Whether the stream is served in segments carried by a playout (see
    /// [`crate::stream::playout`]): unless a switch that fixes one
    /// connection's end is set.
    pub segments: bool,
    /// The data size asked for each segment, before it is rounded to the
    /// stream's frames (see [`crate::stream::SegmentLayout::new`]).
    pub segment_bytes: u64,
    /// How a speaker is moved on from one segment to the next.
    pub continuation: PcmContinuation,
}

impl Default for PcmHttpSettings {
    /// What PCM is served with when no switch is set.
    fn default() -> Self {
        Self {
            framing: PcmHttpFraming::Chunked,
            content_length: u64::from(WAV_STREAM_SIZE_MAX),
            wav_data_size: WAV_STREAM_SIZE_MAX,
            end_after_bytes: None,
            segments: true,
            segment_bytes: super::playout::PCM_SEGMENT_BYTES_MAX,
            continuation: PcmContinuation::Restart,
        }
    }
}

impl PcmHttpSettings {
    /// Body bytes a connection served with these settings carries up to its
    /// declared end (see [`crate::stream::DeclaredEnd`]): the WAV header and
    /// the data size it declares, or less where a declared `Content-Length`
    /// or a test cap ends the body sooner. By default 44 + 4294967295, where a
    /// Playbar stops after 6h12m50s at 48 kHz stereo.
    pub fn declared_end_bytes(&self) -> u64 {
        let mut end = u64::from(WAV_HEADER_BYTES) + u64::from(self.wav_data_size);
        if self.framing == PcmHttpFraming::Length {
            end = end.min(self.content_length);
        }
        if let Some(cap) = self.end_after_bytes {
            end = end.min(cap);
        }
        end
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
        let [framing, content_length, wav_data_size, end_after_bytes, segment_bytes, continuation] =
            raw;
        Self::resolve(RawSwitches {
            framing: framing.as_deref(),
            content_length: content_length.as_deref(),
            wav_data_size: wav_data_size.as_deref(),
            end_after_bytes: end_after_bytes.as_deref(),
            segment_bytes: segment_bytes.as_deref(),
            continuation: continuation.as_deref(),
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
            segment_bytes: set(raw.segment_bytes),
            continuation: set(raw.continuation),
        };
        let any_set = raw.framing.is_some()
            || raw.content_length.is_some()
            || raw.wav_data_size.is_some()
            || raw.end_after_bytes.is_some()
            || raw.segment_bytes.is_some()
            || raw.continuation.is_some();

        let mut ignore = |var: &str, value: &str, why: String| {
            problems.push(format!("Ignoring {var}={value:?}: {why}"));
        };

        if let Some(value) = raw.framing {
            match PcmHttpFraming::parse(value) {
                Ok(framing) => settings.framing = framing,
                Err(e) => ignore(PCM_HTTP_FRAMING_ENV, value, e),
            }
        }
        // The first switch in force that fixes a connection's end, which
        // turns segments off.
        let mut fixed_end: Option<&str> =
            (settings.framing == PcmHttpFraming::Length).then_some(PCM_HTTP_FRAMING_ENV);
        if let Some(value) = raw.wav_data_size {
            match parse_wav_data_size(value) {
                Ok(size) => {
                    settings.wav_data_size = size;
                    fixed_end = fixed_end.or(Some(PCM_WAV_DATA_SIZE_ENV));
                }
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
                Ok(n) => {
                    settings.end_after_bytes = Some(n);
                    fixed_end = fixed_end.or(Some(PCM_END_AFTER_BYTES_ENV));
                }
                Err(e) => ignore(PCM_END_AFTER_BYTES_ENV, value, e),
            }
        }
        settings.segments = fixed_end.is_none();
        if let Some(value) = raw.segment_bytes {
            match (parse_segment_bytes(value), fixed_end) {
                (Ok(_), Some(var)) => ignore(
                    PCM_SEGMENT_BYTES_ENV,
                    value,
                    format!("segments are off while {var} is set"),
                ),
                (Ok(n), None) => settings.segment_bytes = n,
                (Err(e), _) => ignore(PCM_SEGMENT_BYTES_ENV, value, e),
            }
        }
        if let Some(value) = raw.continuation {
            match (PcmContinuation::parse(value), fixed_end) {
                (Ok(_), Some(var)) => ignore(
                    PCM_CONTINUATION_ENV,
                    value,
                    format!("segments are off while {var} is set"),
                ),
                (Ok(mode), None) => settings.continuation = mode,
                (Err(e), _) => ignore(PCM_CONTINUATION_ENV, value, e),
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
    segment_bytes: Option<&'a str>,
    continuation: Option<&'a str>,
}

/// Parses a byte count of at least 1.
fn parse_positive_bytes(value: &str) -> Result<u64, String> {
    match value.trim().parse::<u64>() {
        Ok(0) => Err("expected at least 1 byte, got 0".to_string()),
        Ok(n) => Ok(n),
        Err(_) => Err(format!("expected a number of bytes, got {value:?}")),
    }
}

/// Parses a segment's data size: [`PCM_SEGMENT_BYTES_MIN`] to
/// [`PCM_SEGMENT_BYTES_MAX`] bytes.
///
/// [`PCM_SEGMENT_BYTES_MIN`]: super::playout::PCM_SEGMENT_BYTES_MIN
/// [`PCM_SEGMENT_BYTES_MAX`]: super::playout::PCM_SEGMENT_BYTES_MAX
fn parse_segment_bytes(value: &str) -> Result<u64, String> {
    use super::playout::{PCM_SEGMENT_BYTES_MAX, PCM_SEGMENT_BYTES_MIN};
    match value.trim().parse::<u64>() {
        Ok(n) if (PCM_SEGMENT_BYTES_MIN..=PCM_SEGMENT_BYTES_MAX).contains(&n) => Ok(n),
        _ => Err(format!(
            "expected bytes from {PCM_SEGMENT_BYTES_MIN} to {PCM_SEGMENT_BYTES_MAX}, got {value:?}"
        )),
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
            segment_bytes: None,
            continuation: None,
        })
    }

    /// The switches with only [`PCM_SEGMENT_BYTES_ENV`] and `framing` set.
    fn resolve_segments(framing: Option<&str>, segment_bytes: Option<&str>) -> PcmHttpSwitches {
        PcmHttpSwitches::resolve(RawSwitches {
            framing,
            segment_bytes,
            ..RawSwitches::default()
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
                segments: true,
                segment_bytes: 0xFFFF_0000,
                continuation: PcmContinuation::Restart,
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
    fn the_declared_end_is_the_soonest_length_the_body_carries() {
        let default = PcmHttpSettings::default();
        assert_eq!(default.declared_end_bytes(), 44 + u64::from(u32::MAX));
        let small_header = PcmHttpSettings {
            wav_data_size: 10_000,
            ..default
        };
        assert_eq!(small_header.declared_end_bytes(), 10_044);
        let length = PcmHttpSettings {
            framing: PcmHttpFraming::Length,
            content_length: 5_000,
            ..small_header
        };
        assert_eq!(length.declared_end_bytes(), 5_000);
        let chunked_ignores_the_length = PcmHttpSettings {
            framing: PcmHttpFraming::Chunked,
            ..length
        };
        assert_eq!(chunked_ignores_the_length.declared_end_bytes(), 10_044);
        let capped = PcmHttpSettings {
            end_after_bytes: Some(2_000),
            ..small_header
        };
        assert_eq!(capped.declared_end_bytes(), 2_000);
    }

    /// Segments are on unless a switch fixes a connection's end; their size
    /// can be set for testing within 1 MiB and just under 4 GiB.
    #[test]
    fn segments_follow_their_size_switch_unless_an_end_is_fixed() {
        let small = resolve_segments(None, Some("10485760"));
        assert!(small.settings.segments);
        assert_eq!(small.settings.segment_bytes, 10_485_760);
        assert!(small.problems.is_empty());
        assert!(small.any_set);

        for bad in ["1048575", "4294901761", "lots", "0"] {
            let switches = resolve_segments(None, Some(bad));
            assert_eq!(switches.settings.segment_bytes, 0xFFFF_0000, "{bad}");
            assert_eq!(switches.problems.len(), 1, "{bad}");
        }

        let length = resolve_segments(Some("length"), Some("10485760"));
        assert!(!length.settings.segments);
        assert_eq!(length.settings.segment_bytes, 0xFFFF_0000);
        assert!(length.problems[0].contains("segments are off while THAUMIC_PCM_HTTP_FRAMING"));
        assert!(
            !resolve(None, None, Some("10485760"), None)
                .settings
                .segments
        );
        assert!(
            !resolve(None, None, None, Some("10485760"))
                .settings
                .segments
        );
        assert!(resolve(Some("close"), None, None, None).settings.segments);
        assert!(
            resolve(None, None, Some("lots"), None).settings.segments,
            "an ignored size fixes nothing"
        );
    }

    /// Restart is the default way on to the next segment; `off` keeps the
    /// cast to its first segment for comparison, and neither applies while
    /// segments are off.
    #[test]
    fn continuation_follows_its_switch_while_segments_are_on() {
        let with = |framing: Option<&str>, continuation: Option<&str>| {
            PcmHttpSwitches::resolve(RawSwitches {
                framing,
                continuation,
                ..RawSwitches::default()
            })
        };
        let off = with(None, Some(" OFF "));
        assert_eq!(off.settings.continuation, PcmContinuation::Off);
        assert!(off.any_set);
        assert!(off.problems.is_empty());
        assert_eq!(
            with(None, Some("restart")).settings.continuation,
            PcmContinuation::Restart
        );

        let unknown = with(None, Some("gapless"));
        assert_eq!(unknown.settings.continuation, PcmContinuation::Restart);
        assert_eq!(unknown.problems.len(), 1);
        assert!(unknown.problems[0].contains("expected restart or off"));

        let length = with(Some("length"), Some("off"));
        assert_eq!(length.settings.continuation, PcmContinuation::Restart);
        assert!(length.problems[0].contains("segments are off"));
        assert_eq!(PcmContinuation::Off.to_string(), "off");
    }

    #[test]
    fn the_riff_size_follows_the_data_size() {
        assert_eq!(riff_size_for(10_485_760), 10_485_796);
        assert_eq!(riff_size_for(0), 36);
        assert_eq!(riff_size_for(u32::MAX), u32::MAX);
        assert_eq!(riff_size_for(u32::MAX - 10), u32::MAX);
    }
}
