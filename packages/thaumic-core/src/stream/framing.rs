//! How an audio response body is delimited on the wire, and who ended it.
//!
//! A speaker cannot tell us why it stopped fetching, and an HTTP body can end
//! for several reasons that all look alike from inside the body stream: the
//! speaker hung up, hyper stopped at the declared `Content-Length`, the stream
//! was ended on our side, or the body failed. These types let the connection's
//! guard name which one it was, and count the bytes each body item really puts
//! on the wire, which chunked framing makes larger than the payload.
//!
//! A PCM body also has an end the speaker reads to whatever hyper does: the
//! length its WAV header declares (see [`DeclaredEnd`]). A speaker that stops
//! reading there has reached the end of the item, not stalled.

use std::fmt;

use axum::http::Version;

/// Bytes hyper writes to end a chunked body: the zero-length last chunk.
const CHUNKED_TERMINATOR_LEN: u64 = b"0\r\n\r\n".len() as u64;

/// How a response body is delimited, as hyper chooses it for a response to
/// a request of a given HTTP version.
///
/// This mirrors hyper 1.x's choice rather than steering it: a response with
/// a `Content-Length` is sent with that length, a response without one to an
/// HTTP/1.1 client is sent chunked, and one to an HTTP/1.0 client is ended by
/// closing the connection (hyper answers an HTTP/1.0 request as HTTP/1.0).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyFraming {
    /// `Content-Length` of this many bytes. hyper stops polling the body once
    /// that many bytes are written, cutting the last item short, so the body
    /// has a fixed end.
    Length(u64),
    /// `Transfer-Encoding: chunked`: each body item is one chunk, framed by its
    /// length in hex and two CRLFs, and the body ends with a zero-length chunk.
    Chunked,
    /// No length and no chunking: the body ends only when the connection is
    /// closed.
    Close,
    /// HTTP/2 or later, where the body travels in DATA frames. Frame overhead
    /// is not counted: wire bytes are the payload.
    Http2,
}

impl BodyFraming {
    /// The framing hyper uses for a response to a request of
    /// `request_version` that declares `content_length`, if any.
    pub fn for_response(request_version: Version, content_length: Option<u64>) -> Self {
        if request_version >= Version::HTTP_2 {
            return BodyFraming::Http2;
        }
        match content_length {
            Some(len) => BodyFraming::Length(len),
            None if request_version >= Version::HTTP_11 => BodyFraming::Chunked,
            None => BodyFraming::Close,
        }
    }

    /// The name used for this framing in log lines.
    pub fn label(self) -> &'static str {
        match self {
            BodyFraming::Length(_) => "length",
            BodyFraming::Chunked => "chunked",
            BodyFraming::Close => "close",
            BodyFraming::Http2 => "h2",
        }
    }

    /// The body length the response declares, if it declares one.
    pub fn declared_len(self) -> Option<u64> {
        match self {
            BodyFraming::Length(len) => Some(len),
            BodyFraming::Chunked | BodyFraming::Close | BodyFraming::Http2 => None,
        }
    }

    /// Bytes a body item of `item_len` puts on the wire when `body_before`
    /// payload bytes have already been handed over.
    ///
    /// An empty item puts nothing on the wire: hyper discards it rather than
    /// write a chunk that would end the body. Past a declared length nothing
    /// more is written.
    pub fn wire_len(self, body_before: u64, item_len: u64) -> u64 {
        if item_len == 0 {
            return 0;
        }
        match self {
            BodyFraming::Length(len) => item_len.min(len.saturating_sub(body_before)),
            BodyFraming::Chunked => item_len + chunk_framing_len(item_len),
            BodyFraming::Close | BodyFraming::Http2 => item_len,
        }
    }

    /// Bytes written after the last item when the body ends on its own.
    pub fn end_len(self) -> u64 {
        match self {
            BodyFraming::Chunked => CHUNKED_TERMINATOR_LEN,
            BodyFraming::Length(_) | BodyFraming::Close | BodyFraming::Http2 => 0,
        }
    }
}

/// Audio a connection is treated as being at its declared end for before its
/// body reaches it, in milliseconds (see [`DeclaredEnd::is_near`]).
pub const DECLARED_END_LEAD_MS: u64 = 2_000;

/// Audio a connection's body may run past its declared end and still be at
/// it, in milliseconds (see [`DeclaredEnd::is_near`]).
///
/// A speaker that stops reading at its declared end leaves our side writing
/// only into the socket's buffers until they fill: a Playbar that stopped at
/// the 4 GiB WAV length was handed about 9 s more before it hung up. A body
/// that runs well beyond that is being read, so the speaker is not honouring
/// the length, and its connection is measured as any other again.
pub const DECLARED_END_GRACE_MS: u64 = 60_000;

/// Where a connection's body ends as the speaker reads it: the byte, counted
/// in body bytes handed to the connection (a WAV header included), after
/// which the speaker takes the item to be over.
///
/// For PCM that is the WAV header plus the data size it declares, unless a
/// declared `Content-Length` or a test cap ends the body sooner. A speaker
/// reads to it, plays out what it holds, and hangs up or goes to STOPPED, so
/// near and after it the speaker no longer acknowledging audio is the end of
/// the item: no stall, no running low and no drift should be read into it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeclaredEnd {
    /// Body bytes up to and including the last one the speaker reads.
    bytes: u64,
    /// Body bytes before `bytes` from which the connection counts as at its
    /// end ([`DECLARED_END_LEAD_MS`] of audio).
    lead_bytes: u64,
    /// Body bytes past `bytes` up to which it still does
    /// ([`DECLARED_END_GRACE_MS`] of audio).
    grace_bytes: u64,
}

impl DeclaredEnd {
    /// The end after `bytes` body bytes of a connection carrying `byte_rate`
    /// bytes of audio per second.
    pub fn new(bytes: u64, byte_rate: u32) -> Self {
        let audio = |ms: u64| u64::from(byte_rate).saturating_mul(ms) / 1000;
        Self {
            bytes,
            lead_bytes: audio(DECLARED_END_LEAD_MS),
            grace_bytes: audio(DECLARED_END_GRACE_MS),
        }
    }

    /// Body bytes up to the declared end.
    pub fn bytes(self) -> u64 {
        self.bytes
    }

    /// Whether a body that has handed over `sent` bytes is near or at its
    /// declared end: from [`DECLARED_END_LEAD_MS`] of audio before it until
    /// [`DECLARED_END_GRACE_MS`] past it. Ack-lag stalls and the notices
    /// judged from them mean nothing there.
    pub fn is_near(self, sent: u64) -> bool {
        sent.saturating_add(self.lead_bytes) >= self.bytes && !self.is_past(sent)
    }

    /// Whether a body that has handed over `sent` bytes has reached its
    /// declared end and not run on well past it (see
    /// [`DECLARED_END_GRACE_MS`]): a connection that ends here ended with
    /// the item.
    pub fn is_reached(self, sent: u64) -> bool {
        sent >= self.bytes && !self.is_past(sent)
    }

    /// Whether the body ran on further past its declared end than the
    /// socket's buffers could hold, so the speaker was still reading.
    fn is_past(self, sent: u64) -> bool {
        sent >= self.bytes.saturating_add(self.grace_bytes)
    }
}

/// Framing hyper adds around one chunk of `len` payload bytes: the length in
/// hex digits, then CRLF before and after the payload.
fn chunk_framing_len(len: u64) -> u64 {
    let hex_digits = (u64::BITS - len.leading_zeros()).div_ceil(4).max(1);
    u64::from(hex_digits) + 4
}

/// Why a speaker's HTTP body ended, as logged on the `HTTP stream ended`
/// lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndedBy {
    /// The body was dropped without error, short of any declared length and
    /// before the stream ended: the client closed the connection (or it
    /// failed underneath hyper).
    Client,
    /// hyper wrote the whole declared `Content-Length` and stopped: the
    /// response ended itself, whatever the speaker does next.
    Length,
    /// A test cap ended the body on our side after a set number of bytes
    /// (see [`crate::stream::LoggingStreamGuard::mark_server_cap`]).
    ServerCap,
    /// The body yielded an error, which aborts the response.
    Error,
    /// The stream ended on our side, so the body ran out: the cast was
    /// stopped, the stream was removed, or the server was shutting down.
    ServerShutdown,
}

impl EndedBy {
    /// Decides why a body ended from what its guard recorded.
    ///
    /// `errored` wins, since an error aborts the response whatever else
    /// happened. A test cap and the stream running out are both our own
    /// doing and recorded when they happen. Otherwise hyper dropped the body:
    /// having handed over at least the declared length means it stopped at
    /// that length, anything less means the client went away.
    pub fn classify(
        errored: bool,
        server_capped: bool,
        source_ended: bool,
        framing: Option<BodyFraming>,
        bytes_sent: u64,
    ) -> Self {
        if errored {
            EndedBy::Error
        } else if server_capped {
            EndedBy::ServerCap
        } else if source_ended {
            EndedBy::ServerShutdown
        } else if framing
            .and_then(BodyFraming::declared_len)
            .is_some_and(|len| bytes_sent >= len)
        {
            EndedBy::Length
        } else {
            EndedBy::Client
        }
    }

    /// The name used for this cause in log lines.
    pub fn label(self) -> &'static str {
        match self {
            EndedBy::Client => "client",
            EndedBy::Length => "length",
            EndedBy::ServerCap => "server_cap",
            EndedBy::Error => "error",
            EndedBy::ServerShutdown => "server_shutdown",
        }
    }
}

impl fmt::Display for EndedBy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_follows_the_declared_length_then_the_request_version() {
        assert_eq!(
            BodyFraming::for_response(Version::HTTP_11, Some(4096)),
            BodyFraming::Length(4096)
        );
        assert_eq!(
            BodyFraming::for_response(Version::HTTP_10, Some(4096)),
            BodyFraming::Length(4096),
            "hyper honours a length for an HTTP/1.0 client too"
        );
        assert_eq!(
            BodyFraming::for_response(Version::HTTP_11, None),
            BodyFraming::Chunked
        );
        assert_eq!(
            BodyFraming::for_response(Version::HTTP_10, None),
            BodyFraming::Close,
            "an HTTP/1.0 client cannot be sent chunks"
        );
        assert_eq!(
            BodyFraming::for_response(Version::HTTP_09, None),
            BodyFraming::Close
        );
        assert_eq!(
            BodyFraming::for_response(Version::HTTP_2, Some(4096)),
            BodyFraming::Http2
        );
    }

    #[test]
    fn labels_and_declared_lengths() {
        assert_eq!(BodyFraming::Length(7).label(), "length");
        assert_eq!(BodyFraming::Chunked.label(), "chunked");
        assert_eq!(BodyFraming::Close.label(), "close");
        assert_eq!(BodyFraming::Http2.label(), "h2");
        assert_eq!(BodyFraming::Length(7).declared_len(), Some(7));
        assert_eq!(BodyFraming::Chunked.declared_len(), None);
        assert_eq!(BodyFraming::Close.declared_len(), None);
    }

    /// A 20 ms stereo frame at 48 kHz is 3840 bytes, `F00` in hex: three
    /// digits plus two CRLFs.
    #[test]
    fn a_chunk_costs_its_hex_length_and_two_crlfs() {
        assert_eq!(BodyFraming::Chunked.wire_len(0, 3840), 3840 + 3 + 4);
        assert_eq!(BodyFraming::Chunked.wire_len(0, 1920), 1920 + 3 + 4);
        assert_eq!(BodyFraming::Chunked.wire_len(0, 44), 44 + 2 + 4);
        assert_eq!(BodyFraming::Chunked.wire_len(0, 15), 15 + 1 + 4);
        assert_eq!(BodyFraming::Chunked.wire_len(0, 16), 16 + 2 + 4);
        assert_eq!(BodyFraming::Chunked.wire_len(0, 1), 1 + 1 + 4);
        assert_eq!(
            BodyFraming::Chunked.wire_len(0, 0),
            0,
            "empty items are discarded"
        );
        assert_eq!(BodyFraming::Chunked.end_len(), 5);
    }

    #[test]
    fn a_declared_length_caps_the_wire_bytes() {
        let framing = BodyFraming::Length(4096);
        assert_eq!(framing.wire_len(0, 1000), 1000);
        assert_eq!(framing.wire_len(3000, 1000), 1000);
        assert_eq!(
            framing.wire_len(4000, 1000),
            96,
            "hyper cuts the last item short"
        );
        assert_eq!(framing.wire_len(5000, 1000), 0);
        assert_eq!(framing.end_len(), 0);
        assert_eq!(BodyFraming::Close.wire_len(123, 1000), 1000);
        assert_eq!(BodyFraming::Close.end_len(), 0);
    }

    #[test]
    fn an_end_is_classified_by_what_was_recorded() {
        let length = Some(BodyFraming::Length(4096));
        let chunked = Some(BodyFraming::Chunked);
        assert_eq!(
            EndedBy::classify(false, false, false, length, 4095),
            EndedBy::Client,
            "a drop short of the declared length is the client going away"
        );
        assert_eq!(
            EndedBy::classify(false, false, false, length, 4096),
            EndedBy::Length
        );
        assert_eq!(
            EndedBy::classify(false, false, false, length, 5000),
            EndedBy::Length,
            "the last item is counted in full though hyper cut it short"
        );
        assert_eq!(
            EndedBy::classify(false, false, false, chunked, u64::MAX),
            EndedBy::Client,
            "no declared length, so no length end"
        );
        assert_eq!(
            EndedBy::classify(false, false, false, None, 10),
            EndedBy::Client
        );
        assert_eq!(
            EndedBy::classify(false, false, true, length, 10),
            EndedBy::ServerShutdown
        );
        assert_eq!(
            EndedBy::classify(false, true, true, chunked, 10),
            EndedBy::ServerCap,
            "a cap ends the body by running it out, and says so"
        );
        assert_eq!(
            EndedBy::classify(true, true, true, length, 5000),
            EndedBy::Error
        );
    }

    /// 48 kHz stereo PCM behind the default 0xFFFFFFFF WAV header: the
    /// Playbar reads 44 + 4294967295 bytes, 6h12m50s of audio.
    #[test]
    fn a_body_is_near_its_declared_end_from_2s_before_until_60s_after() {
        let end = DeclaredEnd::new(44 + u64::from(u32::MAX), 192_000);
        let at = end.bytes();
        assert_eq!(at, 4_294_967_339);
        assert!(!end.is_near(at - 384_001), "more than 2 s short");
        assert!(end.is_near(at - 384_000));
        assert!(!end.is_reached(at - 1));
        assert!(end.is_near(at) && end.is_reached(at));
        // The field's end: 1.79 MB handed over past the length before the
        // speaker hung up.
        assert!(end.is_near(4_296_760_364) && end.is_reached(4_296_760_364));
        assert!(end.is_near(at + 11_519_999));
        assert!(
            !end.is_near(at + 11_520_000) && !end.is_reached(at + 11_520_000),
            "a speaker still reading a minute past the end is not honouring it"
        );
    }

    #[test]
    fn end_labels() {
        let labels: Vec<String> = [
            EndedBy::Client,
            EndedBy::Length,
            EndedBy::ServerCap,
            EndedBy::Error,
            EndedBy::ServerShutdown,
        ]
        .iter()
        .map(ToString::to_string)
        .collect();
        assert_eq!(
            labels,
            ["client", "length", "server_cap", "error", "server_shutdown"]
        );
    }
}
