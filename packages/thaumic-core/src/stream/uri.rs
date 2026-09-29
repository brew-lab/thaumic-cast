//! The URLs a stream is served under, and telling them apart by stream id.
//!
//! A stream is fetched from one of these paths on the companion's HTTP server:
//!
//! | Path | Used for |
//! |---|---|
//! | `/stream/{id}/live` | MP3 and AAC (Sonos is given it under `x-rincon-mp3radio://`) |
//! | `/stream/{id}/live.wav` | PCM, and segment 0 of a segmented PCM cast |
//! | `/stream/{id}/live.flac` | FLAC |
//! | `/stream/{id}/live/{n}.wav` | segment `n` (n ≥ 1) of a segmented PCM cast |
//!
//! A WAV header can declare at most 4 GiB of audio, and a Sonos speaker obeys
//! it, so a long PCM cast is served as consecutive segments, each a URL of its
//! own. All of them are still one cast: a speaker moving from `live.wav` to
//! `live/1.wav` has not changed source. [`same_stream`] is the one place that
//! decides that, by host and stream id rather than by the exact URL.

/// Which of a stream's resources a URL names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamResource {
    /// `live`: MP3 and AAC.
    Live,
    /// `live.wav`: PCM, and segment 0 of a segmented PCM cast.
    LiveWav,
    /// `live.flac`: FLAC.
    LiveFlac,
    /// `live/{n}.wav`: segment `n` (always ≥ 1) of a segmented PCM cast.
    Segment(u32),
}

impl StreamResource {
    /// The PCM segment this resource serves, if it serves one: `live.wav` is
    /// segment 0, `live/{n}.wav` segment `n`, and the other resources none.
    #[must_use]
    pub fn pcm_segment(self) -> Option<u32> {
        match self {
            Self::LiveWav => Some(0),
            Self::Segment(n) => Some(n),
            Self::Live | Self::LiveFlac => None,
        }
    }
}

/// A URL that names one of our streams, split into the parts that identify it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamRef<'a> {
    /// `host:port` of the server the URL points at.
    pub authority: &'a str,
    /// The stream id from the path.
    pub stream_id: &'a str,
    /// Which of the stream's resources the path names.
    pub resource: StreamResource,
}

/// Extension of a segment's file name, which Sonos uses to sniff the format.
const SEGMENT_EXTENSION: &str = ".wav";

/// Largest number of digits a segment number can have (`u32::MAX` has ten).
const MAX_SEGMENT_DIGITS: usize = 10;

/// Returns everything after the last `://`, or the whole URI if it has none.
///
/// Sonos nests schemes (`aac://http://host/path`) and we hand MP3 and AAC out
/// as `x-rincon-mp3radio://host/path`, so only what follows the innermost
/// scheme is the address the speaker actually fetches.
fn strip_schemes(uri: &str) -> &str {
    uri.rfind("://").map_or(uri, |idx| &uri[idx + 3..])
}

/// Parses the file name of a PCM segment, `{n}.wav`, into its number.
///
/// Only the canonical spelling a server would hand out is accepted: decimal
/// digits with no sign and no leading zero, and never `0.wav`, because
/// segment 0 is `live.wav`. So each segment has exactly one URL, and a URL no
/// server produced is refused rather than quietly served as some segment.
#[must_use]
pub fn parse_segment_file(file: &str) -> Option<u32> {
    let len = file.len();
    if len <= SEGMENT_EXTENSION.len()
        || !file.is_char_boundary(len - SEGMENT_EXTENSION.len())
        || !file[len - SEGMENT_EXTENSION.len()..].eq_ignore_ascii_case(SEGMENT_EXTENSION)
    {
        return None;
    }
    let digits = &file[..len - SEGMENT_EXTENSION.len()];
    if digits.len() > MAX_SEGMENT_DIGITS
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || digits.starts_with('0')
    {
        return None;
    }
    digits.parse().ok()
}

/// Splits a URL naming one of our streams into host, stream id and resource.
///
/// Any scheme prefix is ignored (see [`strip_schemes`]). Returns `None` for
/// anything that is not exactly one of the paths in the module table, with no
/// query or fragment: another app's URI (`x-sonos-htastream:…`,
/// `x-sonos-spotify:…`), group membership (`x-rincon:…`), and a path we never
/// serve.
#[must_use]
pub fn parse_stream_uri(uri: &str) -> Option<StreamRef<'_>> {
    let rest = strip_schemes(uri);
    let (authority, path) = rest.split_once('/')?;
    if authority.is_empty() || path.contains(['?', '#']) {
        return None;
    }
    let path = path.strip_prefix("stream/")?;
    let (stream_id, tail) = path.split_once('/')?;
    if stream_id.is_empty() {
        return None;
    }
    let resource = if tail.eq_ignore_ascii_case("live") {
        StreamResource::Live
    } else if tail.eq_ignore_ascii_case("live.wav") {
        StreamResource::LiveWav
    } else if tail.eq_ignore_ascii_case("live.flac") {
        StreamResource::LiveFlac
    } else {
        let file = tail
            .get(..5)
            .filter(|dir| dir.eq_ignore_ascii_case("live/"))
            .map(|_| &tail[5..])?;
        StreamResource::Segment(parse_segment_file(file)?)
    };
    Some(StreamRef {
        authority,
        stream_id,
        resource,
    })
}

/// Returns the URL of PCM segment `segment` of the stream at `base_url`.
///
/// `base_url` is the stream's URL without an extension
/// (`http://host:port/stream/{id}/live`, what `UrlBuilder::stream_url` gives).
/// Segment 0 is `live.wav`, the URL every PCM cast has always used, and
/// segment `n` is `live/{n}.wav`.
#[must_use]
pub fn pcm_segment_uri(base_url: &str, segment: u32) -> String {
    if segment == 0 {
        format!("{base_url}{SEGMENT_EXTENSION}")
    } else {
        format!("{base_url}/{segment}{SEGMENT_EXTENSION}")
    }
}

/// Returns `uri`, a PCM URL of one of our streams, as the URL of its segment
/// 0 (`live.wav`), keeping everything before the resource as it was: the
/// one URL every segment of a cast is known by. `None` for a URL that names
/// no PCM segment of ours.
#[must_use]
pub fn segment_base_uri(uri: &str) -> Option<String> {
    let parsed = parse_stream_uri(uri)?;
    parsed.resource.pcm_segment()?;
    let marker = format!("/stream/{}/", parsed.stream_id);
    let at = uri.rfind(&marker)? + marker.len();
    Some(format!("{}live{SEGMENT_EXTENSION}", &uri[..at]))
}

/// Returns `true` if a speaker playing `current` is still playing the stream
/// the companion gave it as `expected`.
///
/// When `expected` names one of our streams, `current` matches if it names a
/// resource of the same stream on the same server, so every segment of a PCM
/// cast is one source. A different stream id, a different server, or a URI
/// that names no stream of ours at all (the TV input taking over a Playbar,
/// another app) does not match, and ends the session as a source change.
///
/// Anything else (an `x-rincon:` URI a grouped slave follows) is compared as
/// before: everything after the innermost scheme, ignoring ASCII case.
#[must_use]
pub fn same_stream(current: &str, expected: &str) -> bool {
    match (parse_stream_uri(current), parse_stream_uri(expected)) {
        (Some(current), Some(expected)) => {
            current.authority.eq_ignore_ascii_case(expected.authority)
                && current.stream_id.eq_ignore_ascii_case(expected.stream_id)
        }
        (None, Some(_)) | (Some(_), None) => false,
        (None, None) => strip_schemes(current).eq_ignore_ascii_case(strip_schemes(expected)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "http://192.168.1.2:49400/stream/abc-123/live";

    #[test]
    fn segment_urls_name_live_wav_first_then_numbered_files() {
        assert_eq!(
            pcm_segment_uri(BASE, 0),
            "http://192.168.1.2:49400/stream/abc-123/live.wav"
        );
        assert_eq!(
            pcm_segment_uri(BASE, 1),
            "http://192.168.1.2:49400/stream/abc-123/live/1.wav"
        );
        assert_eq!(
            pcm_segment_uri(BASE, u32::MAX),
            "http://192.168.1.2:49400/stream/abc-123/live/4294967295.wav"
        );
    }

    #[test]
    fn every_segment_url_parses_back_to_its_segment() {
        for segment in [0, 1, 2, 9, 10, 99, 1_000, u32::MAX] {
            let uri = pcm_segment_uri(BASE, segment);
            let parsed = parse_stream_uri(&uri).expect("our own URL parses");
            assert_eq!(parsed.authority, "192.168.1.2:49400");
            assert_eq!(parsed.stream_id, "abc-123");
            assert_eq!(parsed.resource.pcm_segment(), Some(segment), "{uri}");
        }
    }

    #[test]
    fn only_canonical_segment_file_names_parse() {
        assert_eq!(parse_segment_file("1.wav"), Some(1));
        assert_eq!(parse_segment_file("42.WAV"), Some(42));
        assert_eq!(parse_segment_file("4294967295.wav"), Some(u32::MAX));
        for bad in [
            "0.wav",          // segment 0 is live.wav
            "01.wav",         // one spelling per segment
            "+1.wav",         // no sign
            "-1.wav",         // no sign
            ".wav",           // no number
            "wav",            // no extension
            "1.flac",         // segments are PCM only
            "1.wav.wav",      // not a number
            "1",              // no extension
            "4294967296.wav", // past u32
            "99999999999.wav",
            "1 .wav",
            "é.wav",
        ] {
            assert_eq!(parse_segment_file(bad), None, "{bad} must not parse");
        }
    }

    #[test]
    fn every_resource_of_a_stream_parses() {
        let cases = [
            ("http://h:1/stream/s/live", StreamResource::Live),
            (
                "x-rincon-mp3radio://h:1/stream/s/live",
                StreamResource::Live,
            ),
            ("http://h:1/stream/s/live.wav", StreamResource::LiveWav),
            ("http://h:1/stream/s/live.flac", StreamResource::LiveFlac),
            ("http://h:1/stream/s/live/7.wav", StreamResource::Segment(7)),
            ("aac://http://h:1/stream/s/live", StreamResource::Live),
        ];
        for (uri, resource) in cases {
            let parsed = parse_stream_uri(uri).unwrap_or_else(|| panic!("{uri} must parse"));
            assert_eq!(parsed.authority, "h:1", "{uri}");
            assert_eq!(parsed.stream_id, "s", "{uri}");
            assert_eq!(parsed.resource, resource, "{uri}");
        }
    }

    #[test]
    fn uris_that_are_not_our_streams_do_not_parse() {
        for uri in [
            "x-sonos-htastream:RINCON_000E58000000001400:spdif",
            "x-rincon:RINCON_000E58000000001400",
            "x-sonos-spotify:spotify%3atrack%3a4uLU6hMCjMI75M1A2tKUQC",
            "x-rincon-queue:RINCON_000E58000000001400#0",
            "http://h:1/stream/s/live.mp3",
            "http://h:1/stream/s/live/0.wav",
            "http://h:1/stream/s/live/1.flac",
            "http://h:1/stream/s/live/1.wav/extra",
            "http://h:1/stream/s/live.wav?seg=1",
            "http://h:1/stream/s/live.wav#t=1",
            "http://h:1/stream//live.wav",
            "http://h:1/stream/s",
            "http://h:1/radio/s/live.wav",
            "http:///stream/s/live.wav",
            "",
        ] {
            assert_eq!(parse_stream_uri(uri), None, "{uri} must not parse");
        }
    }

    #[test]
    fn a_segment_switch_is_the_same_stream() {
        let expected = pcm_segment_uri(BASE, 0);
        for segment in [0, 1, 2, 3, 1_000] {
            assert!(
                same_stream(&pcm_segment_uri(BASE, segment), &expected),
                "segment {segment} must stay the same stream"
            );
        }
        // And whichever segment the session was started on.
        assert!(same_stream(&expected, &pcm_segment_uri(BASE, 5)));
    }

    #[test]
    fn scheme_and_case_differences_are_the_same_stream() {
        let expected = "x-rincon-mp3radio://192.168.1.2:49400/stream/abc-123/live";
        assert!(same_stream(
            "aac://http://192.168.1.2:49400/stream/abc-123/live",
            expected
        ));
        assert!(same_stream(
            "http://192.168.1.2:49400/stream/ABC-123/live.wav",
            "http://192.168.1.2:49400/stream/abc-123/live.wav"
        ));
    }

    #[test]
    fn another_stream_or_server_is_a_different_stream() {
        let expected = pcm_segment_uri(BASE, 0);
        // Another client's cast on the same server.
        assert!(!same_stream(
            "http://192.168.1.2:49400/stream/other/live/1.wav",
            &expected
        ));
        // The same id on another server (or port) is not ours.
        assert!(!same_stream(
            "http://192.168.1.3:49400/stream/abc-123/live/1.wav",
            &expected
        ));
        assert!(!same_stream(
            "http://192.168.1.2:49401/stream/abc-123/live.wav",
            &expected
        ));
        // A stream id that merely starts with ours.
        assert!(!same_stream(
            "http://192.168.1.2:49400/stream/abc-1234/live.wav",
            &expected
        ));
    }

    #[test]
    fn a_foreign_source_is_a_different_stream() {
        let expected = pcm_segment_uri(BASE, 0);
        for current in [
            // The Sonos TV input taking over a Playbar when a stream ends.
            "x-sonos-htastream:RINCON_000E58000000001400:spdif",
            "x-sonos-spotify:spotify%3atrack%3a4uLU6hMCjMI75M1A2tKUQC",
            "x-rincon-queue:RINCON_000E58000000001400#0",
            "x-rincon:RINCON_000E58000000001400",
            // A URL on our server that no route serves.
            "http://192.168.1.2:49400/stream/abc-123/live/1.wav?x",
        ] {
            assert!(!same_stream(current, &expected), "{current}");
        }
    }

    #[test]
    fn uris_that_name_no_stream_compare_as_before() {
        // Grouped slaves follow the coordinator by x-rincon URI.
        assert!(same_stream(
            "x-rincon:RINCON_000E58000000001400",
            "x-rincon:RINCON_000E58000000001400"
        ));
        assert!(!same_stream(
            "x-rincon:RINCON_000E58000000001401",
            "x-rincon:RINCON_000E58000000001400"
        ));
        assert!(!same_stream(
            "x-sonos-htastream:RINCON_000E58000000001400:spdif",
            "x-rincon:RINCON_000E58000000001400"
        ));
        assert!(same_stream(
            "aac://http://192.168.1.100:8080/stream.aac",
            "http://192.168.1.100:8080/Stream.AAC"
        ));
        assert!(!same_stream(
            "http://192.168.1.100:8080/other.aac",
            "http://192.168.1.100:8080/stream.aac"
        ));
    }

    #[test]
    fn every_segment_is_known_by_its_live_wav_url() {
        let base = "http://192.168.1.5:49400/stream/abc/live.wav";
        assert_eq!(segment_base_uri(base).as_deref(), Some(base));
        assert_eq!(
            segment_base_uri("http://192.168.1.5:49400/stream/abc/live/7.wav").as_deref(),
            Some(base)
        );
        assert_eq!(
            segment_base_uri("x-file://http://192.168.1.5:49400/stream/abc/live/2.wav").as_deref(),
            Some("x-file://http://192.168.1.5:49400/stream/abc/live.wav")
        );
        assert_eq!(
            segment_base_uri("http://192.168.1.5:49400/stream/abc/live"),
            None
        );
        assert_eq!(
            segment_base_uri("http://192.168.1.5:49400/stream/abc/live.flac"),
            None
        );
        assert_eq!(segment_base_uri("x-rincon:RINCON_000E58000000001400"), None);
    }
}
