//! A PCM playout carried across segment connections.
//!
//! A WAV header can declare at most 4 GiB of audio, and a Sonos speaker plays
//! exactly the length it declares, so a long PCM cast is served as a sequence
//! of segments, each under its own URL (see [`crate::stream::uri`]), each a
//! connection with its own WAV header declaring [`SegmentLayout::data_bytes`].
//! For the switch from one segment to the next to be sample-exact, segment
//! `k + 1` must start at the output byte right after segment `k`'s last one,
//! however much of `k` the speaker still holds when it fetches `k + 1`.
//!
//! So one [`PlayoutChain`] per stream and speaker owns the one cadence that
//! produces the speaker's audio (its queue, metronome, silence state and drift
//! adapter), and outlives the HTTP connections it is carried on:
//!
//! - **Serving:** the connection's [`SegmentBody`] polls the cadence directly,
//!   so the steady state costs no task hop and no channel. When the next
//!   frame would cross the segment's end, it is split there: the head ends the
//!   segment and the tail waits for the next one. Segments and frames are
//!   whole sample frames, so the split always falls on a sample boundary.
//! - **Parked:** once a body stops being served, whether it reached its end
//!   or its client hung up, a park pump task polls the cadence at real-time
//!   pace into a backlog, so the broadcast receiver behind it never lags and
//!   drops audio. The pump keeps polling while the next body drains the
//!   backlog, and hands the cadence over only once the backlog is empty.
//! - **Handed back on every exit:** a body hands its connection back to the
//!   chain when it is dropped, however it ends (hyper drops a body without
//!   polling it to its end when the client goes away).
//!
//! What a new fetch becomes is decided before anything else about it (see
//! [`PlayoutRegistry::route`]): a continuation of the playout (no prefill
//! wait, no new epoch, no resume `Play`), an early fetch held until the
//! current segment ends, a side fetch that must not disturb the connection
//! being served, or a new playout from the live edge, as every fetch used to
//! be. A fetch with `Range: bytes=X-` resuming a segment is answered `206`
//! with exactly the rest of that segment, so it still ends where its header
//! said and the next segment stays aligned.
//!
//! What moves the speaker on to the next segment lives outside the playout:
//! it tells a [`PlayoutEvents`] when a segment nears its end, ends, is
//! continued or is closed part way. The continuation service queues each
//! next segment as the speaker's next item, which it fetches the moment the
//! current body ends (an ordinary continuation here), and restarts a speaker
//! that did not on the next segment once it has played the last one out
//! (see [`PlayoutChain::prepare_restart`] and [`Rejoin`]).

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use bytes::Bytes;
use futures::Stream;
use tokio::time::Instant;

use super::cadence::{ChainStats, LoggingStreamGuard};
use super::pcm_http::{PcmContinuation, PcmSegmentDidl};
use super::tap::{ConnectionTap, WAV_HEADER_BYTES};
use super::uri::{parse_stream_uri, segment_base_uri};
use super::AudioFormat;
use crate::services::speaker_monitor::control::drift_active;
use crate::services::speaker_monitor::{PlayoutTimeline, TimelineEntry};

/// A body stream of audio bytes, as the cadence produces it.
pub type PcmStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

/// Largest data size a segment's WAV header declares: 2^32 − 64 KiB, which
/// leaves room for the 44-byte header plus margin under 4 GiB, whether a
/// speaker honours the header or counts bytes in 32 bits. At 48 kHz 16-bit
/// stereo it is an exact number of 10 ms frames, 6h12m49.28s.
pub const PCM_SEGMENT_BYTES_MAX: u64 = 0xFFFF_0000;

/// Smallest data size [`crate::stream::PCM_SEGMENT_BYTES_ENV`] may ask for.
pub const PCM_SEGMENT_BYTES_MIN: u64 = 1 << 20;

/// How long a playout stays parked with no connection before it is dropped,
/// counted from the later of the last connection closing and the speaker
/// reporting STOPPED (see [`PlayoutChain::note_stopped`]). A speaker was seen
/// to stop reading 18 s before it hung up, and STOPPED follows a clean end by
/// about 1.2 s; 60 s of PCM is about 11.5 MB.
pub const PARK_MAX: Duration = Duration::from_secs(60);

/// Most audio a playout holds in its backlog before it is dropped, however
/// recent the speaker's STOPPED: a bound on memory.
pub const BACKLOG_MAX: Duration = Duration::from_secs(120);

/// How much of each segment, from its first byte, is kept to be sent again
/// to a speaker that fetches the segment afresh having provably played none
/// of it.
pub const REPLAY_MAX: Duration = Duration::from_secs(10);

/// How long after a segment's connection starts being served its first
/// seconds are still treated as the boundary: the speaker is playing out the
/// previous segment's reserve and then refilling, which says nothing about a
/// stall, running low or drift.
pub const BOUNDARY_SETTLE: Duration = Duration::from_secs(15);

/// How long a side fetch (see [`Route::Side`]) is held open before it is
/// ended, should its speaker not close it first (Sonos closes one after about
/// 10 s).
pub const SIDE_HOLD_MAX: Duration = Duration::from_secs(60);

/// How long before a segment's end its handoff begins (see
/// [`PlayoutEvent::HandoffNear`]): from then until the speaker plays the
/// next segment, a transport state that is only the switch is kept from
/// clients.
pub const HANDOFF_LEAD: Duration = Duration::from_secs(2);

/// Most latency a restart adds that is kept, rather than trimmed, when the
/// drift controller can pay it back (see [`Rejoin`]). At the controller's
/// 150 ppm, 2 s takes almost four hours to repay.
pub const REJOIN_EXACT_MAX: Duration = Duration::from_secs(2);

/// How long the audio fades in after a trimmed rejoin, so the cut does not
/// click.
const REJOIN_FADE: Duration = Duration::from_millis(5);

/// Chain ids, unique for the process, for log lines.
static NEXT_CHAIN_ID: AtomicU64 = AtomicU64::new(1);

/// How a PCM playout is cut into segments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentLayout {
    /// Data bytes in every segment: the size its WAV header declares.
    data_bytes: u64,
    /// Bytes in one sample frame (all channels).
    block_align: u64,
    /// Bytes of audio per second.
    byte_rate: u64,
}

impl SegmentLayout {
    /// The layout for `format`, with segments of `requested` data bytes
    /// rounded down to whole 10 ms frames, and kept between one such frame
    /// and [`PCM_SEGMENT_BYTES_MAX`].
    pub fn new(format: &AudioFormat, requested: u64) -> Self {
        let block_align = (u64::from(format.channels) * format.bytes_per_sample() as u64).max(1);
        let byte_rate = (u64::from(format.sample_rate) * block_align).max(1);
        let frame10 = block_align * (u64::from(format.sample_rate) / 100).max(1);
        let max = PCM_SEGMENT_BYTES_MAX / frame10 * frame10;
        let data_bytes = (requested.min(max) / frame10 * frame10).max(frame10);
        Self {
            data_bytes,
            block_align,
            byte_rate,
        }
    }

    /// Data bytes in every segment.
    pub fn data_bytes(&self) -> u64 {
        self.data_bytes
    }

    /// Bytes of one whole segment on the wire: the WAV header and its data.
    pub fn total_bytes(&self) -> u64 {
        u64::from(WAV_HEADER_BYTES) + self.data_bytes
    }

    /// Bytes of audio per second.
    pub fn byte_rate(&self) -> u64 {
        self.byte_rate
    }

    /// Bytes in one sample frame.
    pub fn block_align(&self) -> u64 {
        self.block_align
    }

    /// Milliseconds of audio in `bytes`.
    fn ms(&self, bytes: u64) -> u64 {
        bytes.saturating_mul(1000) / self.byte_rate
    }

    /// Bytes of audio in `duration`, in whole sample frames.
    fn bytes_in(&self, duration: Duration) -> u64 {
        let bytes = self.byte_rate.saturating_mul(duration.as_millis() as u64) / 1000;
        bytes / self.block_align * self.block_align
    }

    /// A segment's length as `h:mm:ss.cc`, for log lines.
    fn duration_label(&self) -> String {
        let centis = self.data_bytes.saturating_mul(100) / self.byte_rate;
        format!(
            "{}:{:02}:{:02}.{:02}",
            centis / 360_000,
            centis / 6_000 % 60,
            centis / 100 % 60,
            centis % 100
        )
    }
}

/// Where a connection starts in its segment, from the fetch that asked for
/// it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentStart {
    /// The segment the fetch's URL named (0 for `live.wav`).
    pub url_segment: u32,
    /// Leading bytes of the WAV header to skip: a `Range` starting inside it,
    /// or all of them for one starting past it.
    header_skip: u64,
    /// Zero bytes sent after any header to reach the next sample boundary,
    /// when a `Range` starts inside a sample frame.
    pad: u64,
    /// Data bytes of the segment the speaker already holds, the pad
    /// included: the index of the first data byte the playout sends.
    consumed: u64,
}

impl SegmentStart {
    /// The start for a fetch of segment `url_segment` asking for the body
    /// from byte `range_start` on (`None` or `0`: the whole segment), in
    /// `layout`. `None` if the range starts at or past the segment's end.
    pub fn new(url_segment: u32, range_start: Option<u64>, layout: &SegmentLayout) -> Option<Self> {
        let header = u64::from(WAV_HEADER_BYTES);
        let x = range_start.unwrap_or(0);
        if x >= layout.total_bytes() {
            return None;
        }
        if x <= header {
            return Some(Self {
                url_segment,
                header_skip: x,
                pad: 0,
                consumed: 0,
            });
        }
        let into_data = x - header;
        let misaligned = into_data % layout.block_align;
        let pad = if misaligned == 0 {
            0
        } else {
            layout.block_align - misaligned
        };
        Some(Self {
            url_segment,
            header_skip: header,
            pad,
            consumed: (into_data + pad).min(layout.data_bytes),
        })
    }

    /// Whether the fetch asked for part of the segment rather than all of
    /// it, to be answered `206`.
    pub fn is_partial(&self) -> bool {
        self.header_skip > 0
    }

    /// The segment's first body byte the response carries.
    pub fn first_byte(&self) -> u64 {
        if self.consumed > 0 {
            u64::from(WAV_HEADER_BYTES) + self.consumed - self.pad
        } else {
            self.header_skip
        }
    }

    /// Body bytes the response carries: whatever of the header was asked
    /// for, then the rest of the segment.
    pub fn body_bytes(&self, layout: &SegmentLayout) -> u64 {
        layout.total_bytes() - self.first_byte()
    }

    /// Audio the speaker takes to precede the first data byte sent. A new
    /// playout's epoch is anchored that much earlier, so the speaker's
    /// RelTime maps onto what it was sent.
    pub fn preroll(&self, layout: &SegmentLayout) -> Duration {
        Duration::from_millis(layout.ms(self.consumed))
    }
}

/// What a playout tells the speaker monitor about its segments, readable
/// without the playout's lock (it lives in the playout's [`ChainStats`]).
#[derive(Default)]
pub struct PlayoutView {
    inner: parking_lot::Mutex<ViewInner>,
}

/// [`PlayoutView`]'s state.
#[derive(Default)]
struct ViewInner {
    /// Bytes of audio per second, `0` for a connection with no playout.
    byte_rate: u64,
    /// Where recent segments' data started, oldest first.
    starts: VecDeque<StartRecord>,
    /// The playout is parked, and whether its last connection reached the
    /// end of its segment.
    parked: Option<bool>,
    /// Until when the segment being served is still settling after its
    /// boundary (see [`BOUNDARY_SETTLE`]).
    settle_until: Option<Instant>,
    /// Latency the last restart left to pay back, until the monitor sees it
    /// repaid.
    debt: Option<LatencyDebt>,
}

/// Latency a restart left for the drift controller to pay back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LatencyDebt {
    /// The playout's segment the restart continued into.
    pub seg: u32,
    /// Audio the speaker was sent beyond its head start when it rejoined.
    pub debt_ms: u64,
    /// When it rejoined.
    pub since: Instant,
}

/// Where one connection's segment data started in the playout's output.
#[derive(Debug, Clone, Copy)]
struct StartRecord {
    /// The segment the connection's URL named.
    url_segment: u32,
    /// Output byte of the segment's data byte 0.
    start: u64,
    /// How the speaker came to be playing the segment.
    entry: TimelineEntry,
    /// Whether a position poll has reported the speaker on this segment.
    observed: bool,
}

/// A speaker's reported position, mapped onto its playout (see
/// [`PlayoutView::continuous_position`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedPosition {
    /// The stream's `live.wav` URL, whichever segment the speaker named.
    pub track_uri: String,
    /// RelTime counted from the playout's start.
    pub rel_ms: u64,
    /// The segment the position was counted on, when the playout has a
    /// record of it.
    pub timeline: Option<PlayoutTimeline>,
}

/// How many segment starts are remembered for mapping positions.
const MAX_STARTS: usize = 4;

/// How far a mapped position may run ahead of the audio handed over before
/// it is taken for an earlier connection's: RelTime has one-second
/// precision.
const POSITION_SLACK_MS: u64 = 2_000;

impl PlayoutView {
    /// Lays the view out for `byte_rate` bytes of audio per second.
    fn set_byte_rate(&self, byte_rate: u64) {
        self.inner.lock().byte_rate = byte_rate;
    }

    /// Records that segment `url_segment`'s data starts at output byte
    /// `start`, the speaker having come to it by `entry`.
    fn push_start(&self, url_segment: u32, start: u64, entry: TimelineEntry) {
        let mut inner = self.inner.lock();
        if inner.starts.len() >= MAX_STARTS {
            inner.starts.pop_front();
        }
        inner.starts.push_back(StartRecord {
            url_segment,
            start,
            entry,
            observed: false,
        });
    }

    /// Records that the playout parked, its last connection having reached
    /// the end of its segment (`by_length`) or not.
    fn set_parked(&self, by_length: bool) {
        self.inner.lock().parked = Some(by_length);
    }

    /// Records that a connection is being served again, the segment settling
    /// until `settle_until` if it follows a boundary.
    fn set_serving(&self, settle_until: Option<Instant>) {
        let mut inner = self.inner.lock();
        inner.parked = None;
        inner.settle_until = settle_until;
    }

    /// Whether the playout is at a segment boundary: parked with no
    /// connection, or settling after one started.
    pub fn at_boundary(&self) -> bool {
        let inner = self.inner.lock();
        inner.parked.is_some() || inner.settle_until.is_some_and(|t| Instant::now() < t)
    }

    /// Whether the playout is parked after its last connection reached the
    /// end of its segment: the speaker has the whole item.
    pub fn parked_at_end(&self) -> bool {
        self.inner.lock().parked == Some(true)
    }

    /// Records the latency a restart left for the drift controller to pay
    /// back.
    fn set_debt(&self, debt: LatencyDebt) {
        self.inner.lock().debt = Some(debt);
    }

    /// The latency the last restart left to pay back, if it is not yet
    /// repaid.
    pub fn debt(&self) -> Option<LatencyDebt> {
        self.inner.lock().debt
    }

    /// Records that the speaker monitor saw the debt repaid.
    pub fn clear_debt(&self) {
        self.inner.lock().debt = None;
    }

    /// Whether a position poll has reported the speaker on the segment whose
    /// data starts at `start` under URL segment `url_segment`.
    fn observed(&self, url_segment: u32, start: u64) -> bool {
        self.inner
            .lock()
            .starts
            .iter()
            .any(|s| s.url_segment == url_segment && s.start == start && s.observed)
    }

    /// Maps a speaker's position on one of stream `stream_id`'s URLs onto
    /// the playout: the URL with any segment replaced by `live.wav`, and
    /// RelTime counted from the playout's start rather than the segment's.
    ///
    /// `position` is the output byte the playout has handed over up to. A
    /// URL naming another stream, or none of this stream's segments, gives
    /// `None`; one naming a segment this playout has no record of keeps its
    /// RelTime, and has no timeline.
    pub fn continuous_position(
        &self,
        stream_id: &str,
        track_uri: &str,
        rel_ms: u64,
        position: u64,
    ) -> Option<MappedPosition> {
        let parsed = parse_stream_uri(track_uri)?;
        if !parsed.stream_id.eq_ignore_ascii_case(stream_id) {
            return None;
        }
        let url_segment = parsed.resource.pcm_segment()?;
        let base = segment_base_uri(track_uri)?;
        let mut inner = self.inner.lock();
        let byte_rate = inner.byte_rate;
        let unmapped = |track_uri| MappedPosition {
            track_uri,
            rel_ms,
            timeline: None,
        };
        if byte_rate == 0 {
            return Some(unmapped(base));
        }
        let ms = |bytes: u64| bytes.saturating_mul(1000) / byte_rate;
        let position_ms = ms(position);
        // Newest first; a later connection under the same URL (a speaker
        // reopening it) is taken unless the position cannot yet have been
        // reached on it.
        let mut chosen = None;
        for (i, record) in inner.starts.iter().enumerate().rev() {
            if record.url_segment != url_segment {
                continue;
            }
            if chosen.is_none() {
                chosen = Some(i);
            }
            if ms(record.start) + rel_ms <= position_ms + POSITION_SLACK_MS {
                chosen = Some(i);
                break;
            }
        }
        let Some(i) = chosen else {
            return Some(unmapped(base));
        };
        let record = &mut inner.starts[i];
        record.observed = true;
        Some(MappedPosition {
            track_uri: base,
            rel_ms: ms(record.start) + rel_ms,
            timeline: Some(PlayoutTimeline {
                start: record.start,
                entry: record.entry,
            }),
        })
    }
}

/// Why a new playout is started for a fetch rather than an existing one
/// continued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewReason {
    /// There is no playout for the speaker, or it ended.
    NoPlayout,
    /// The speaker fetched a segment whose connection it had closed part
    /// way through (a pause, a network drop): served from the live edge, as
    /// every reconnect always was.
    Resume,
    /// As [`Self::Resume`], with `Range: bytes=X-`: the rest of the segment,
    /// from the live edge.
    RangeResume,
    /// A segment the playout cannot continue into.
    Stale,
}

impl NewReason {
    /// The name used for this reason in log lines.
    pub fn label(self) -> &'static str {
        match self {
            Self::NoPlayout => "no_playout",
            Self::Resume => "resume",
            Self::RangeResume => "range_resume",
            Self::Stale => "stale_segment",
        }
    }
}

/// How a fetch continues an existing playout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachKind {
    /// The next segment, after the previous one reached its end.
    Continuation,
    /// The segment that just reached its end, fetched again: it is served
    /// the next segment's audio under the old URL.
    Reopen,
    /// The next segment, after the previous one was closed part way through
    /// (the user pressed Next): it starts at the next unsent byte.
    UserNext,
    /// The same segment fetched again after its connection closed, when the
    /// speaker provably played none of it: sent again from its first byte.
    Replay,
    /// The next segment, fetched while the previous one was still being
    /// served; its audio starts where the previous one ends.
    Early,
}

impl AttachKind {
    /// The name used for this kind in log lines.
    pub fn label(self) -> &'static str {
        match self {
            Self::Continuation => "continuation",
            Self::Reopen => "reopen",
            Self::UserNext => "user_next",
            Self::Replay => "replay",
            Self::Early => "early",
        }
    }
}

/// Something a playout tells whatever moves its speaker between segments
/// (see [`PlayoutEvents`]). Segment numbers are the playout's own; URL
/// segments are those of the fetches that carry them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayoutEvent {
    /// The segment being served has [`HANDOFF_LEAD`] or less left to hand
    /// over.
    HandoffNear {
        /// The segment.
        seg: u32,
        /// The URL segment of the connection serving it.
        url_segment: u32,
    },
    /// A segment handed over its last byte and no fetch of the next one was
    /// waiting: the playout is parked until the speaker fetches it.
    SegmentEnded {
        /// The segment that ended.
        seg: u32,
        /// The URL segment of the connection that carried it; the speaker
        /// is expected to fetch the one after.
        url_segment: u32,
        /// A lower bound on what the speaker still held to play when it
        /// ended.
        reserve_floor_ms: u64,
    },
    /// A fetch continued the playout.
    Continued {
        /// The segment it carries.
        seg: u32,
        /// Its URL segment.
        url_segment: u32,
        /// How it continued the playout.
        kind: AttachKind,
    },
    /// The speaker closed the connection being served part way through its
    /// segment: a pause, a skip or a network drop, not a boundary.
    ClosedMid {
        /// The segment it carried.
        seg: u32,
        /// Its URL segment.
        url_segment: u32,
    },
    /// A new playout started for the speaker, from the live edge.
    Started {
        /// The URL segment of its first fetch.
        url_segment: u32,
    },
    /// The playout was dropped.
    Retired,
}

/// Receives a playout's [`PlayoutEvent`]s. Called with no lock held, from
/// the streaming runtime, so it must not block.
pub trait PlayoutEvents: Send + Sync {
    /// `chain` did what `event` says.
    fn playout_event(&self, chain: &Arc<PlayoutChain>, event: PlayoutEvent);
}

/// How a speaker that is restarted on the next segment rejoins the playout
/// (see [`PlayoutChain::prepare_restart`]).
///
/// Between the previous segment's end and the fetch that follows the
/// restart, the playout keeps producing audio into its backlog: the speaker
/// played out its reserve, stopped, was told to play and fetched. Sending
/// that backlog whole keeps the sample stream exact but adds the pause to the
/// cast's latency for good, unless something pays it back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejoin {
    /// Send the whole backlog: the drift controller is steering this speaker
    /// and pays the extra latency back, as long as it is no more than
    /// [`REJOIN_EXACT_MAX`]; more than that is trimmed after all.
    Exact,
    /// Keep only the configured head start of the backlog, the newest, and
    /// drop the rest: nothing would pay back more. The speaker was silent
    /// across the restart, so the dropped audio is heard as part of that
    /// pause, never as a skip.
    Trim,
}

impl Rejoin {
    /// The name used for this policy in log lines.
    pub fn label(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Trim => "trim",
        }
    }
}

/// A restart the continuation service has told the speaker to make.
#[derive(Debug, Clone, Copy)]
struct RestartPlan {
    /// The URL segment the speaker was told to play.
    url_segment: u32,
    rejoin: Rejoin,
}

/// What to do with one fetch of a PCM segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    /// Continue the playout on this connection.
    Attach(AttachKind),
    /// Hold the connection after its header until the current segment ends,
    /// then continue on it.
    Pending,
    /// Answer without touching the playout (see [`Route::Side`]).
    Side,
    /// The range starts at or past the segment's end.
    Unsatisfiable,
    /// Start a new playout.
    New(NewReason),
}

/// How the playout's last connection ended, while no connection is served.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EndKind {
    /// It handed over its whole segment.
    Length,
    /// Its client closed it part way through.
    ClientMid,
}

/// The last segment connection's end, while no connection is served.
#[derive(Debug, Clone, Copy)]
struct SegmentEnd {
    kind: EndKind,
    /// The playout's segment it carried.
    logical: u32,
    /// The segment its URL named.
    url_segment: u32,
    /// When it ended.
    at: Instant,
}

/// What [`decide`] knows about the connection a playout is serving.
#[derive(Debug, Clone, Copy)]
struct CurrentFacts {
    /// The segment its URL named.
    url_segment: u32,
    /// Whether it took over from an early fetch at the boundary and the
    /// speaker provably played none of it (see
    /// [`PlayoutChain::segment_unplayed`]): a fresh fetch of the same URL is
    /// then the one the speaker plays from, and the early one was a probe.
    replayable: bool,
}

/// What [`decide`] knows about a playout.
#[derive(Debug, Clone, Copy)]
struct ChainFacts {
    /// No playout to continue: none exists, or it ended.
    dead: bool,
    /// The connection being served, if there is one.
    current: Option<CurrentFacts>,
    /// How the last connection ended, if none is served.
    ended: Option<SegmentEnd>,
    /// Whether the speaker provably played none of the segment its last
    /// connection carried (see [`PlayoutChain::replay_proven`]).
    replay_proven: bool,
}

/// Decides what a fetch of URL segment `url_segment` from byte
/// `range_start` on is, for a playout in the state `facts`, whose segments
/// are `total_bytes` long on the wire.
fn decide(
    facts: &ChainFacts,
    url_segment: u32,
    range_start: Option<u64>,
    total_bytes: u64,
) -> Decision {
    let ranged = range_start.is_some_and(|x| x > 0);
    if range_start.is_some_and(|x| x >= total_bytes) {
        return Decision::Unsatisfiable;
    }
    if facts.dead {
        return Decision::New(NewReason::NoPlayout);
    }
    if let Some(current) = facts.current {
        // A speaker resuming after a pause fetches its segment plainly, then
        // again with a range from where it stopped: the ranged fetch is the
        // one it plays from, whatever became of the plain one.
        if ranged && url_segment == current.url_segment {
            return Decision::New(NewReason::RangeResume);
        }
        if !ranged && url_segment == current.url_segment.wrapping_add(1) {
            return Decision::Pending;
        }
        if !ranged && url_segment == current.url_segment && current.replayable {
            return Decision::Attach(AttachKind::Replay);
        }
        // Otherwise never disturb the connection being served: another
        // fetch while it is alive is a speaker probing the item (a Playbar
        // fetches the segment it just switched to a second time, briefly).
        return Decision::Side;
    }
    let Some(end) = facts.ended else {
        return Decision::New(NewReason::NoPlayout);
    };
    let next = end.url_segment.wrapping_add(1);
    match end.kind {
        EndKind::Length if !ranged && url_segment == next => {
            Decision::Attach(AttachKind::Continuation)
        }
        EndKind::Length if !ranged && url_segment == end.url_segment => {
            Decision::Attach(AttachKind::Reopen)
        }
        EndKind::Length if ranged => Decision::New(NewReason::RangeResume),
        EndKind::ClientMid if !ranged && url_segment == next => {
            Decision::Attach(AttachKind::UserNext)
        }
        EndKind::ClientMid if url_segment == end.url_segment => {
            if ranged {
                Decision::New(NewReason::RangeResume)
            } else if facts.replay_proven {
                Decision::Attach(AttachKind::Replay)
            } else {
                Decision::New(NewReason::Resume)
            }
        }
        EndKind::Length | EndKind::ClientMid => Decision::New(NewReason::Stale),
    }
}

/// How the handler serves one fetch of a PCM segment (see
/// [`PlayoutRegistry::route`]).
pub enum Route {
    /// Continue an existing playout: the body is ready, and needs no prefill
    /// wait, no new epoch and no resume `Play`.
    Attach(SegmentBody),
    /// Answer with the part of the header asked for, then hold the
    /// connection empty, never touching the playout: another fetch while a
    /// connection is served is a speaker probing the item, and must neither
    /// take nor consume the audio of the connection it plays from.
    Side(SegmentStart),
    /// Answer `416`: the range starts at or past the end of a segment of
    /// this many bytes.
    Unsatisfiable(u64),
    /// Start a new playout from the live edge, for this reason.
    New(NewReason, SegmentStart),
}

/// The playouts of one stream, one per speaker address.
#[derive(Default)]
pub struct PlayoutRegistry {
    chains: parking_lot::Mutex<HashMap<IpAddr, Arc<PlayoutChain>>>,
}

impl PlayoutRegistry {
    /// The live playout for `ip`, if there is one.
    pub fn get(&self, ip: IpAddr) -> Option<Arc<PlayoutChain>> {
        let ip = ip.to_canonical();
        let mut chains = self.chains.lock();
        match chains.get(&ip) {
            Some(chain) if chain.is_dead() => {
                chains.remove(&ip);
                None
            }
            Some(chain) => Some(Arc::clone(chain)),
            None => None,
        }
    }

    /// Records that `ip` reported STOPPED, which a parked playout counts its
    /// time from (see [`PARK_MAX`]).
    pub fn note_stopped(&self, ip: IpAddr) {
        if let Some(chain) = self.get(ip) {
            chain.note_stopped();
        }
    }

    /// Decides how to serve a fetch from `ip` of URL segment `url_segment`
    /// from byte `range_start` on, in `layout` unless a playout already
    /// exists (whose own layout then applies). A continuation's body is made
    /// at once, with the connection record `make_guard` returns for a body
    /// of the byte count it is given.
    ///
    /// Deciding and attaching happen under the playout's lock, so two
    /// fetches never both take it.
    pub fn route(
        &self,
        ip: IpAddr,
        url_segment: u32,
        range_start: Option<u64>,
        layout: &SegmentLayout,
        make_guard: impl FnOnce(u64) -> Arc<LoggingStreamGuard>,
    ) -> Route {
        match self.get(ip) {
            Some(chain) => chain.route(url_segment, range_start, make_guard),
            None => match SegmentStart::new(url_segment, range_start, layout) {
                Some(start) => Route::New(NewReason::NoPlayout, start),
                None => Route::Unsatisfiable(layout.total_bytes()),
            },
        }
    }

    /// Makes `chain` the playout for its speaker, retiring any other.
    fn register(&self, chain: &Arc<PlayoutChain>) {
        let old = self
            .chains
            .lock()
            .insert(chain.speaker_ip, Arc::clone(chain));
        if let Some(old) = old.filter(|old| !Arc::ptr_eq(old, chain)) {
            old.retire("replaced");
        }
    }

    /// Forgets `chain`, if it is still the playout for its speaker.
    fn unregister(&self, chain: &PlayoutChain) {
        let mut chains = self.chains.lock();
        if chains
            .get(&chain.speaker_ip)
            .is_some_and(|c| std::ptr::eq(Arc::as_ptr(c), chain))
        {
            chains.remove(&chain.speaker_ip);
        }
    }

    /// How many playouts are registered.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.chains.lock().len()
    }
}

/// Everything a new playout is made from (see [`PlayoutChain::start`]).
pub struct ChainParts {
    /// The stream it plays.
    pub stream_id: String,
    /// The speaker it plays to.
    pub speaker_ip: IpAddr,
    /// The stream's audio format, for the segments' WAV headers.
    pub format: AudioFormat,
    /// How it is cut into segments.
    pub layout: SegmentLayout,
    /// Its cadence.
    pub cadence: PcmStream,
    /// Its statistics, which the cadence and tap report into.
    pub stats: Arc<ChainStats>,
    /// The speaker monitor's handle on it, kept for the playout's life.
    pub tap: Option<Arc<ConnectionTap>>,
    /// Where its first connection starts.
    pub start: SegmentStart,
    /// Its first connection's record.
    pub guard: Arc<LoggingStreamGuard>,
    /// Where it is registered, so later fetches can continue it. `None`
    /// for a reader whose fetches are not tracked: its playout ends with
    /// its connection.
    pub registry: Option<Arc<PlayoutRegistry>>,
    /// How its speaker is moved on from one segment to the next.
    pub continuation: PcmContinuation,
    /// How a segment queued as its speaker's next item is described.
    pub segment_didl: PcmSegmentDidl,
    /// The head start its first connection was configured to: what a
    /// trimmed rejoin keeps (see [`Rejoin::Trim`]).
    pub head_start: Duration,
    /// Who is told what happens to it (see [`PlayoutEvent`]).
    pub events: Option<Arc<dyn PlayoutEvents>>,
}

/// One speaker's PCM playout of a stream, carried across the connections of
/// its segments (see the [module docs](self)).
pub struct PlayoutChain {
    /// Unique for the process, for log lines.
    id: u64,
    stream_id: String,
    speaker_ip: IpAddr,
    format: AudioFormat,
    layout: SegmentLayout,
    stats: Arc<ChainStats>,
    /// Held for the playout's life: the speaker monitor holds it weakly, so
    /// monitoring ends when the playout does, not with each connection.
    tap: Option<Arc<ConnectionTap>>,
    /// Where the park pump is spawned: the streaming runtime.
    runtime: tokio::runtime::Handle,
    registry: Option<Weak<PlayoutRegistry>>,
    continuation: PcmContinuation,
    segment_didl: PcmSegmentDidl,
    head_start: Duration,
    events: Option<Arc<dyn PlayoutEvents>>,
    inner: parking_lot::Mutex<Inner>,
}

/// The mutable state of a [`PlayoutChain`], behind its lock. Nothing holds
/// the lock across an await; bodies and the pump take it for one poll.
struct Inner {
    /// The one cadence; `None` once it ended or the playout was retired.
    cadence: Option<PcmStream>,
    /// The cadence ran out: the stream is gone.
    cadence_ended: bool,
    /// The playout was dropped; every body of it ends.
    retired: bool,
    /// Audio produced while no body polled the cadence, oldest first, led
    /// by the tail of a frame that crossed a segment's end.
    backlog: VecDeque<Bytes>,
    backlog_bytes: u64,
    /// Output bytes taken from the cadence so far, plus any the speaker held
    /// before a partial first fetch.
    produced: u64,
    /// The segment being served, or next to be.
    seg: Cursor,
    /// The connection being served.
    current: Option<Slot>,
    /// A connection for the next segment, fetched before the current one
    /// ended.
    pending: Option<Slot>,
    /// The body that handed over the end of its segment and has yet to end.
    finished: Option<u64>,
    /// How the last connection ended, while none is served.
    ended: Option<SegmentEnd>,
    /// When the previous segment's last byte was handed over.
    boundary_at: Option<Instant>,
    /// When the playout last lost its connection.
    parked_at: Option<Instant>,
    /// When its speaker last reported STOPPED.
    stopped_at: Option<Instant>,
    pump: Pump,
    replay: Replay,
    next_gen: u64,
    /// The segment whose nearing end has been told (see
    /// [`PlayoutEvent::HandoffNear`]).
    near_told: Option<u32>,
    /// The restart the speaker was told to make, until its fetch arrives.
    restart: Option<RestartPlan>,
}

/// Where the playout is in its current segment.
#[derive(Debug, Clone, Copy)]
struct Cursor {
    /// The playout's segment number.
    logical: u32,
    /// The segment the URL of the connection carrying it named.
    url_segment: u32,
    /// Output byte of the segment's data byte 0.
    start: u64,
    /// Data bytes of the segment handed over, or held by the speaker.
    sent: u64,
}

/// One connection of the playout.
struct Slot {
    gen: u64,
    /// The segment its URL named.
    url_segment: u32,
    guard: Arc<LoggingStreamGuard>,
    waker: Option<Waker>,
    /// When the fetch arrived.
    arrived_at: Instant,
    /// Whether it was fetched before its segment began and took over at the
    /// boundary (see [`AttachKind::Early`]).
    early: bool,
}

/// The park pump's state.
#[derive(Default)]
struct Pump {
    /// The pump should be polling the cadence.
    active: bool,
    /// A pump task exists.
    running: bool,
    waker: Option<Waker>,
}

/// The current segment's audio as handed over, from its first byte, for
/// sending it again.
struct Replay {
    /// The segment it holds.
    logical: u32,
    frames: VecDeque<Bytes>,
    bytes: u64,
    /// Whether it holds everything handed over of the segment.
    complete: bool,
}

impl Replay {
    /// Empties the buffer for segment `logical`, complete only if nothing
    /// of it has been handed over.
    fn reset(&mut self, logical: u32, complete: bool) {
        self.logical = logical;
        self.frames.clear();
        self.bytes = 0;
        self.complete = complete;
    }
}

/// Work found under the lock and done once it is released: waking tasks,
/// spawning the pump, unregistering, dropping the cadence.
#[derive(Default)]
struct Deferred {
    wakers: [Option<Waker>; 3],
    spawn_pump: bool,
    unregister: bool,
    cadence: Option<PcmStream>,
    /// Events to tell, in order.
    events: [Option<PlayoutEvent>; 3],
}

impl Deferred {
    /// Queues `event` to be told. There are never more than three at once
    /// (a retirement follows at most a segment's end and a continuation).
    fn tell(&mut self, event: PlayoutEvent) {
        if let Some(slot) = self.events.iter_mut().find(|e| e.is_none()) {
            *slot = Some(event);
        } else {
            debug_assert!(false, "more playout events than slots");
        }
    }

    /// Queues `waker` to be woken.
    fn wake(&mut self, waker: Option<Waker>) {
        let Some(waker) = waker else {
            return;
        };
        match self.wakers.iter_mut().find(|w| w.is_none()) {
            Some(slot) => *slot = Some(waker),
            None => waker.wake(),
        }
    }
}

/// What a body gets when it polls its playout.
enum BodyPoll {
    Data(Bytes),
    End(BodyEnd),
    Pending,
}

/// Why a body ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyEnd {
    /// It handed over the whole data size its header declared.
    SegmentComplete,
    /// Another connection took its place, or the playout was retired.
    Superseded,
    /// The cadence ran out: the stream is gone.
    StreamEnded,
}

impl PlayoutChain {
    /// Starts a playout from `parts`, registering it if it has a registry,
    /// and returns its first connection's body.
    pub fn start(parts: ChainParts) -> SegmentBody {
        let ChainParts {
            stream_id,
            speaker_ip,
            format,
            layout,
            cadence,
            stats,
            tap,
            start,
            guard,
            registry,
            continuation,
            segment_didl,
            head_start,
            events,
        } = parts;
        let speaker_ip = speaker_ip.to_canonical();
        let now = Instant::now();
        stats.playout.set_byte_rate(layout.byte_rate);
        stats
            .playout
            .push_start(start.url_segment, 0, TimelineEntry::Played);
        stats.playout.set_serving(None);
        stats.set_position(start.consumed);
        stats.attach_connection(&guard);
        let chain = Arc::new(Self {
            id: NEXT_CHAIN_ID.fetch_add(1, Ordering::Relaxed),
            stream_id,
            speaker_ip,
            format,
            layout,
            stats,
            tap,
            runtime: tokio::runtime::Handle::current(),
            registry: registry.as_ref().map(Arc::downgrade),
            continuation,
            segment_didl,
            head_start,
            events,
            inner: parking_lot::Mutex::new(Inner {
                cadence: Some(cadence),
                cadence_ended: false,
                retired: false,
                backlog: VecDeque::new(),
                backlog_bytes: 0,
                produced: start.consumed,
                seg: Cursor {
                    logical: start.url_segment,
                    url_segment: start.url_segment,
                    start: 0,
                    sent: start.consumed,
                },
                current: Some(Slot {
                    gen: 0,
                    url_segment: start.url_segment,
                    guard: Arc::clone(&guard),
                    waker: None,
                    arrived_at: now,
                    early: false,
                }),
                pending: None,
                finished: None,
                ended: None,
                boundary_at: None,
                parked_at: None,
                stopped_at: None,
                pump: Pump::default(),
                replay: Replay {
                    logical: start.url_segment,
                    frames: VecDeque::new(),
                    bytes: 0,
                    complete: start.consumed == 0,
                },
                next_gen: 1,
                near_told: None,
                restart: None,
            }),
        });
        log::info!(
            "[Stream] Segments: stream={} speaker={} chain={} D={} ({}) segment={} first_byte={} \
             continuation={} didl={}{}",
            chain.stream_id,
            chain.speaker_ip,
            chain.id,
            layout.data_bytes,
            layout.duration_label(),
            start.url_segment,
            start.first_byte(),
            chain.continuation,
            chain.segment_didl,
            if registry.is_some() { "" } else { " untracked" }
        );
        if let Some(registry) = &registry {
            registry.register(&chain);
        }
        if chain.moves_on() {
            if let Some(events) = &chain.events {
                events.playout_event(
                    &chain,
                    PlayoutEvent::Started {
                        url_segment: start.url_segment,
                    },
                );
            }
        }
        SegmentBody::new(Arc::clone(&chain), 0, start, guard)
    }

    /// How the playout is cut into segments.
    pub fn layout(&self) -> SegmentLayout {
        self.layout
    }

    /// Its id, unique for the process.
    pub fn id(&self) -> u64 {
        self.id
    }

    /// The stream it plays.
    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    /// The speaker it plays to.
    pub fn speaker_ip(&self) -> IpAddr {
        self.speaker_ip
    }

    /// How its speaker is moved on from one segment to the next.
    pub fn continuation(&self) -> PcmContinuation {
        self.continuation
    }

    /// How a segment queued as its speaker's next item is described.
    pub fn segment_didl(&self) -> PcmSegmentDidl {
        self.segment_didl
    }

    /// How much audio is left to hand over of the segment being served, if
    /// the connection serving it is one of URL segment `url_segment`.
    /// `None` while no such connection is served: the playout is parked, has
    /// moved on to a later segment, or is gone.
    pub fn serving_left(&self, url_segment: u32) -> Option<Duration> {
        let inner = self.inner.lock();
        if inner.retired || inner.cadence_ended {
            return None;
        }
        inner
            .current
            .as_ref()
            .filter(|slot| slot.url_segment == url_segment)
            .map(|_| {
                Duration::from_millis(
                    self.layout
                        .ms(self.layout.data_bytes.saturating_sub(inner.seg.sent)),
                )
            })
    }

    /// The latency its last restart left for the drift controller to pay
    /// back, if not yet repaid.
    pub fn latency_debt(&self) -> Option<LatencyDebt> {
        self.stats.playout.debt()
    }

    /// Whether something moves its speaker on to later segments, and so is
    /// told what happens to it.
    fn moves_on(&self) -> bool {
        self.continues() && self.continuation != PcmContinuation::Off && self.events.is_some()
    }

    /// Whether the playout is parked after its speaker took the whole of the
    /// segment carried under URL segment `url_segment`, with no fetch since:
    /// the speaker has yet to fetch the one after.
    pub fn awaiting_after(&self, url_segment: u32) -> bool {
        let inner = self.inner.lock();
        Self::waiting_after(&inner, url_segment)
    }

    /// [`Self::awaiting_after`] under the lock.
    fn waiting_after(inner: &Inner, url_segment: u32) -> bool {
        !inner.retired
            && !inner.cadence_ended
            && inner.current.is_none()
            && inner.pending.is_none()
            && inner
                .ended
                .is_some_and(|e| e.kind == EndKind::Length && e.url_segment == url_segment)
    }

    /// Readies the playout for its speaker being told to play URL segment
    /// `url_segment`, the one after the segment it took whole, and says how
    /// the fetch that follows will rejoin (see [`Rejoin`]). `None`, and
    /// nothing readied, if the playout is no longer parked waiting for that
    /// segment: the speaker fetched it after all, or the playout is gone.
    ///
    /// The fetch is then continued as usual, except that its backlog may be
    /// trimmed to the head start, and the latency it adds is recorded for
    /// the speaker monitor.
    pub fn prepare_restart(&self, url_segment: u32) -> Option<Rejoin> {
        // Only the drift controller pays latency back: a forced rate is a
        // listening test that steers nothing.
        let steered = self.tap.as_ref().is_some_and(|tap| {
            let control = tap.rate_control().map(|c| &**c);
            drift_active(tap.drift_mode(), control)
                && control.is_some_and(|c| c.forced_ppm().is_none())
        });
        let rejoin = if steered { Rejoin::Exact } else { Rejoin::Trim };
        let mut inner = self.inner.lock();
        if url_segment == 0 || !Self::waiting_after(&inner, url_segment - 1) {
            return None;
        }
        inner.restart = Some(RestartPlan {
            url_segment,
            rejoin,
        });
        Some(rejoin)
    }

    /// Forgets a restart readied by [`Self::prepare_restart`] that was not
    /// sent after all.
    pub fn cancel_restart(&self) {
        self.inner.lock().restart = None;
    }

    /// Whether the playout can no longer be continued.
    fn is_dead(&self) -> bool {
        let inner = self.inner.lock();
        inner.retired || inner.cadence_ended
    }

    /// Records that the speaker reported STOPPED: a parked playout counts
    /// [`PARK_MAX`] from now at the earliest.
    pub fn note_stopped(&self) {
        self.inner.lock().stopped_at = Some(Instant::now());
    }

    /// Drops the playout: its cadence goes, and every body of it ends.
    pub fn retire(self: &Arc<Self>, reason: &str) {
        let mut deferred = Deferred::default();
        {
            let mut inner = self.inner.lock();
            if inner.retired {
                return;
            }
            self.retire_locked(&mut inner, reason, &mut deferred);
        }
        self.run_deferred(deferred);
    }

    /// [`Self::retire`] under the lock.
    fn retire_locked(&self, inner: &mut Inner, reason: &str, deferred: &mut Deferred) {
        inner.retired = true;
        inner.restart = None;
        if self.moves_on() {
            deferred.tell(PlayoutEvent::Retired);
        }
        deferred.cadence = inner.cadence.take();
        inner.backlog.clear();
        inner.backlog_bytes = 0;
        inner.replay.reset(inner.seg.logical, false);
        inner.pump.active = false;
        deferred.wake(inner.pump.waker.take());
        if let Some(slot) = inner.current.as_mut() {
            deferred.wake(slot.waker.take());
        }
        if let Some(slot) = inner.pending.as_mut() {
            deferred.wake(slot.waker.take());
        }
        deferred.unregister = true;
        let level = if matches!(reason, "replaced" | "untracked_reader") {
            log::Level::Info
        } else {
            log::Level::Warn
        };
        log::log!(
            level,
            "[Stream] Continuation broken: stream={} speaker={} chain={} reason={} seg={} \
             out_total={}",
            self.stream_id,
            self.speaker_ip,
            self.id,
            reason,
            inner.seg.logical,
            inner.produced - inner.backlog_bytes
        );
    }

    /// Does the work collected under the lock: spawning the pump, dropping
    /// the cadence, unregistering, waking tasks and telling events.
    fn run_deferred(self: &Arc<Self>, deferred: Deferred) {
        let Deferred {
            wakers,
            spawn_pump,
            unregister,
            cadence,
            events,
        } = deferred;
        if spawn_pump {
            let chain = Arc::clone(self);
            self.runtime.spawn(async move {
                std::future::poll_fn(|cx| chain.poll_pump(cx)).await;
            });
        }
        drop(cadence);
        if unregister {
            if let Some(registry) = self.registry.as_ref().and_then(Weak::upgrade) {
                registry.unregister(self);
            }
        }
        for waker in wakers.into_iter().flatten() {
            waker.wake();
        }
        if let Some(sink) = &self.events {
            for event in events.into_iter().flatten() {
                sink.playout_event(self, event);
            }
        }
    }

    /// Asks the park pump to poll the cadence, spawning it if needed.
    fn start_pump(inner: &mut Inner, deferred: &mut Deferred) {
        if inner.retired || inner.cadence_ended {
            return;
        }
        inner.pump.active = true;
        if !inner.pump.running {
            inner.pump.running = true;
            deferred.spawn_pump = true;
        }
    }

    /// Hands the cadence back from the pump to the body being served.
    fn stop_pump(inner: &mut Inner, deferred: &mut Deferred) {
        if inner.pump.active {
            inner.pump.active = false;
            deferred.wake(inner.pump.waker.take());
        }
    }

    /// A lower bound on the speaker's reserve at the end of a segment: the
    /// head start its playout was sent, or less if the speaker monitor has
    /// measured less.
    fn reserve_floor(&self) -> Duration {
        let head_start = self
            .tap
            .as_ref()
            .and_then(|tap| tap.head_start())
            .map_or(0, |h| u64::from(h.sent_ms));
        let measured = self.stats.speaker.snapshot().and_then(|s| {
            let reserve = i64::from(s.reserve_ms?);
            let precision = i64::from(s.precision_ms?);
            Some((reserve - precision).max(0) as u64)
        });
        Duration::from_millis(measured.map_or(head_start, |m| m.min(head_start)))
    }

    /// Whether the speaker provably played none of the segment its last
    /// connection carried, so a fresh fetch of it can be sent the segment
    /// again from its first byte (see [`Self::segment_unplayed`]).
    fn replay_proven(&self, inner: &Inner, now: Instant) -> bool {
        inner
            .ended
            .is_some_and(|e| e.kind == EndKind::ClientMid && inner.seg.logical == e.logical)
            && self.segment_unplayed(inner, now)
    }

    /// Whether the speaker provably played none of the current segment.
    ///
    /// Only when none of it was handed over, or when all of it is still in
    /// the replay buffer, no position poll has reported the speaker on it,
    /// and so little time has passed since the previous segment's last byte
    /// that the speaker cannot yet have played out that segment's reserve
    /// (see [`Self::reserve_floor`]). A playout's first segment is played at
    /// once, so it never is, unless nothing of it was sent.
    fn segment_unplayed(&self, inner: &Inner, now: Instant) -> bool {
        if inner.seg.sent == 0 {
            return true;
        }
        let Some(boundary_at) = inner.boundary_at else {
            return false;
        };
        inner.replay.complete
            && inner.replay.logical == inner.seg.logical
            && inner.replay.bytes == inner.seg.sent
            && !self
                .stats
                .playout
                .observed(inner.seg.url_segment, inner.seg.start)
            && now.saturating_duration_since(boundary_at) < self.reserve_floor()
    }

    /// Decides a fetch and, for a continuation, attaches it (see
    /// [`PlayoutRegistry::route`]).
    fn route(
        self: &Arc<Self>,
        url_segment: u32,
        range_start: Option<u64>,
        make_guard: impl FnOnce(u64) -> Arc<LoggingStreamGuard>,
    ) -> Route {
        let now = Instant::now();
        let total = self.layout.total_bytes();
        let mut deferred = Deferred::default();
        let route = {
            let mut inner = self.inner.lock();
            let facts = ChainFacts {
                dead: inner.retired || inner.cadence_ended,
                current: inner.current.as_ref().map(|slot| CurrentFacts {
                    url_segment: slot.url_segment,
                    replayable: slot.early && self.segment_unplayed(&inner, now),
                }),
                ended: inner.ended,
                replay_proven: self.replay_proven(&inner, now),
            };
            let decision = decide(&facts, url_segment, range_start, total);
            let start = SegmentStart::new(url_segment, range_start, &self.layout);
            match (decision, start) {
                (Decision::Unsatisfiable, _) | (_, None) => Route::Unsatisfiable(total),
                (Decision::New(reason), Some(start)) => Route::New(reason, start),
                (Decision::Side, Some(start)) => {
                    log::info!(
                        "[Stream] Side fetch: stream={} speaker={} chain={} url_segment={} \
                         range_start={:?} while segment {} is served; holding it without audio",
                        self.stream_id,
                        self.speaker_ip,
                        self.id,
                        url_segment,
                        range_start,
                        inner.seg.logical
                    );
                    Route::Side(start)
                }
                (Decision::Pending, Some(start)) => {
                    let guard = make_guard(start.body_bytes(&self.layout));
                    let gen = inner.next_gen;
                    inner.next_gen += 1;
                    let replaced = inner.pending.replace(Slot {
                        gen,
                        url_segment,
                        guard: Arc::clone(&guard),
                        waker: None,
                        arrived_at: now,
                        early: false,
                    });
                    if let Some(mut old) = replaced {
                        deferred.wake(old.waker.take());
                    }
                    log::info!(
                        "[Stream] Continuation fetch: stream={} speaker={} chain={} \
                         url_segment={} early, {}ms of segment {} left; holding it until that \
                         segment ends",
                        self.stream_id,
                        self.speaker_ip,
                        self.id,
                        url_segment,
                        self.layout.ms(self.layout.data_bytes - inner.seg.sent),
                        inner.seg.logical
                    );
                    Route::Attach(SegmentBody::new(Arc::clone(self), gen, start, guard))
                }
                (Decision::Attach(kind), Some(start)) => {
                    let guard = make_guard(start.body_bytes(&self.layout));
                    let gen = self.attach_locked(
                        &mut inner,
                        kind,
                        url_segment,
                        &guard,
                        now,
                        &mut deferred,
                    );
                    Route::Attach(SegmentBody::new(Arc::clone(self), gen, start, guard))
                }
            }
        };
        self.run_deferred(deferred);
        route
    }

    /// Makes a fetch of URL segment `url_segment` the connection being
    /// served, continuing the playout as `kind` says, and returns its body's
    /// generation.
    fn attach_locked(
        &self,
        inner: &mut Inner,
        kind: AttachKind,
        url_segment: u32,
        guard: &Arc<LoggingStreamGuard>,
        now: Instant,
        deferred: &mut Deferred,
    ) -> u64 {
        let gen = inner.next_gen;
        inner.next_gen += 1;
        if let Some(mut superseded) = inner.current.take() {
            // A replay in place of a connection that was only a probe.
            deferred.wake(superseded.waker.take());
        }
        let end = inner.ended.take();
        let after_end_ms = end.map_or(0, |e| {
            now.saturating_duration_since(e.at).as_millis() as i64
        });
        let mut replayed = 0;
        let restart = inner.restart.take();
        let mut rejoined = None;
        let expected = match kind {
            AttachKind::Continuation => {
                let expected = inner.seg.start;
                if let Some(plan) = restart.filter(|p| p.url_segment == url_segment) {
                    rejoined = Some(self.rejoin_locked(inner, plan.rejoin, now));
                }
                expected
            }
            AttachKind::Reopen | AttachKind::Early => inner.seg.start,
            AttachKind::UserNext => {
                // The previous segment stopped short; this one starts at the
                // first byte its connection did not take.
                let expected = inner.seg.start + self.layout.data_bytes;
                inner.seg = Cursor {
                    logical: inner.seg.logical.wrapping_add(1),
                    url_segment,
                    start: inner.produced - inner.backlog_bytes,
                    sent: 0,
                };
                inner.replay.reset(inner.seg.logical, true);
                inner.boundary_at = Some(now);
                expected
            }
            AttachKind::Replay => {
                replayed = inner.replay.bytes;
                while let Some(frame) = inner.replay.frames.pop_back() {
                    inner.backlog.push_front(frame);
                }
                inner.backlog_bytes += replayed;
                inner.replay.bytes = 0;
                inner.seg.sent = 0;
                inner.seg.start
            }
        };
        inner.seg.url_segment = url_segment;
        let first_byte = inner.produced - inner.backlog_bytes;
        self.stats.attach_connection(guard);
        // A restart is told to play; only a gapless move to the next item
        // counts RelTime from the audio.
        let entry = match kind {
            _ if rejoined.is_some() => TimelineEntry::Played,
            AttachKind::Continuation | AttachKind::Early => TimelineEntry::Next,
            AttachKind::Reopen | AttachKind::UserNext | AttachKind::Replay => TimelineEntry::Other,
        };
        self.stats
            .playout
            .push_start(url_segment, inner.seg.start, entry);
        self.stats.playout.set_serving(Some(now + BOUNDARY_SETTLE));
        self.stats.set_position(first_byte);
        inner.current = Some(Slot {
            gen,
            url_segment,
            guard: Arc::clone(guard),
            waker: None,
            arrived_at: now,
            early: false,
        });
        // The pump keeps the cadence until the backlog is drained.
        Self::start_pump(inner, deferred);
        self.log_joined(
            inner,
            kind,
            after_end_ms,
            first_byte,
            expected,
            replayed,
            rejoined,
        );
        if self.moves_on() {
            deferred.tell(PlayoutEvent::Continued {
                seg: inner.seg.logical,
                url_segment,
                kind,
            });
        }
        gen
    }

    /// Rejoins a speaker restarted on the next segment: sends the backlog
    /// whole, or trims it to the head start (see [`Rejoin`]), and records
    /// the latency the rejoin adds. The segment then starts at the first
    /// byte sent, so RelTime on it maps onto what the speaker plays.
    fn rejoin_locked(&self, inner: &mut Inner, policy: Rejoin, now: Instant) -> RejoinOutcome {
        let keep = self.layout.bytes_in(self.head_start);
        let debt = inner.backlog_bytes.saturating_sub(keep);
        let trim = match policy {
            Rejoin::Trim => debt > 0,
            Rejoin::Exact => debt > self.layout.bytes_in(REJOIN_EXACT_MAX),
        };
        let dropped = if trim {
            self.trim_backlog(inner, keep)
        } else {
            0
        };
        inner.seg.start += dropped;
        let debt_ms = self.layout.ms(debt.saturating_sub(dropped));
        if debt_ms > 0 {
            self.stats.playout.set_debt(LatencyDebt {
                seg: inner.seg.logical,
                debt_ms,
                since: now,
            });
        }
        RejoinOutcome {
            policy: if trim { Rejoin::Trim } else { Rejoin::Exact },
            dropped,
            debt_ms,
        }
    }

    /// Drops the oldest of the backlog until `keep` bytes are left, whole
    /// sample frames, and fades the rest in. Returns the bytes dropped.
    fn trim_backlog(&self, inner: &mut Inner, keep: u64) -> u64 {
        let block = self.layout.block_align;
        let keep = keep / block * block;
        let mut dropped = 0;
        while inner.backlog_bytes > keep {
            let Some(mut frame) = inner.backlog.pop_front() else {
                break;
            };
            let excess = inner.backlog_bytes - keep;
            let len = frame.len() as u64;
            if len <= excess {
                inner.backlog_bytes -= len;
                dropped += len;
            } else {
                let cut = excess / block * block;
                let tail = frame.split_off(cut as usize);
                inner.backlog_bytes -= cut;
                dropped += cut;
                inner.backlog.push_front(tail);
                break;
            }
        }
        if let Some(first) = inner.backlog.pop_front() {
            inner.backlog.push_front(fade_in(
                first,
                &self.format,
                self.layout.bytes_in(REJOIN_FADE),
            ));
        }
        dropped
    }

    /// Logs a fetch continuing the playout. The first byte it is sent must
    /// be the one the previous segment's end left off at; anything else,
    /// apart from a segment the user skipped out of, is logged as an error.
    #[allow(clippy::too_many_arguments)]
    fn log_joined(
        &self,
        inner: &Inner,
        kind: AttachKind,
        after_end_ms: i64,
        first_byte: u64,
        expected: u64,
        replayed: u64,
        rejoined: Option<RejoinOutcome>,
    ) {
        log::info!(
            "[Stream] Continuation fetch: stream={} speaker={} chain={} seg={} url_segment={} \
             after_end_ms={}",
            self.stream_id,
            self.speaker_ip,
            self.id,
            inner.seg.logical,
            inner.seg.url_segment,
            after_end_ms
        );
        let rejoin = rejoined.map_or_else(String::new, |r| {
            format!(
                " mode=restart rejoin={} dropped_ms={} latency_debt_ms={}",
                r.policy.label(),
                self.layout.ms(r.dropped),
                r.debt_ms
            )
        });
        let dropped = rejoined.map_or(0, |r| r.dropped);
        let line = format!(
            "[Stream] Continuation joined: stream={} speaker={} chain={} seg={} reason={} \
             first_byte={} expected_byte={} backlog_ms={}{}{}",
            self.stream_id,
            self.speaker_ip,
            self.id,
            inner.seg.logical,
            kind.label(),
            first_byte,
            expected,
            self.layout.ms(inner.backlog_bytes),
            if replayed > 0 {
                format!(" replayed_ms={}", self.layout.ms(replayed))
            } else {
                String::new()
            },
            rejoin
        );
        // A trimmed rejoin starts that much later, on purpose.
        if first_byte == expected + dropped || kind == AttachKind::UserNext {
            log::info!("{}", line);
        } else {
            log::error!("{}", line);
        }
    }

    /// Polls for body `gen`'s next item.
    fn poll_body(self: &Arc<Self>, gen: u64, cx: &mut Context<'_>) -> BodyPoll {
        let mut deferred = Deferred::default();
        let result = {
            let mut inner = self.inner.lock();
            self.poll_body_locked(&mut inner, gen, cx, &mut deferred)
        };
        self.run_deferred(deferred);
        result
    }

    /// [`Self::poll_body`] under the lock.
    fn poll_body_locked(
        &self,
        inner: &mut Inner,
        gen: u64,
        cx: &mut Context<'_>,
        deferred: &mut Deferred,
    ) -> BodyPoll {
        if inner.finished == Some(gen) {
            return BodyPoll::End(BodyEnd::SegmentComplete);
        }
        if inner.retired {
            return BodyPoll::End(BodyEnd::Superseded);
        }
        if let Some(slot) = inner.pending.as_mut().filter(|s| s.gen == gen) {
            if !slot.waker.as_ref().is_some_and(|w| w.will_wake(cx.waker())) {
                slot.waker = Some(cx.waker().clone());
            }
            return BodyPoll::Pending;
        }
        if inner.current.as_ref().map(|s| s.gen) != Some(gen) {
            return BodyPoll::End(BodyEnd::Superseded);
        }
        let left = self.layout.data_bytes - inner.seg.sent;
        let mut frame = match inner.backlog.pop_front() {
            Some(frame) => {
                inner.backlog_bytes -= frame.len() as u64;
                frame
            }
            None => {
                // The backlog is drained: the body takes the cadence back.
                Self::stop_pump(inner, deferred);
                let Some(cadence) = inner.cadence.as_mut() else {
                    return BodyPoll::End(BodyEnd::StreamEnded);
                };
                match cadence.as_mut().poll_next(cx) {
                    Poll::Ready(Some(Ok(frame))) => {
                        inner.produced += frame.len() as u64;
                        frame
                    }
                    Poll::Ready(Some(Err(e))) => {
                        log::warn!(
                            "[Stream] Playout cadence failed: stream={} speaker={} chain={}: {}",
                            self.stream_id,
                            self.speaker_ip,
                            self.id,
                            e
                        );
                        return Self::cadence_ended(inner, deferred);
                    }
                    Poll::Ready(None) => return Self::cadence_ended(inner, deferred),
                    Poll::Pending => {
                        // Kept so a body superseded or retired while it
                        // waits is woken to end.
                        if let Some(slot) = inner.current.as_mut() {
                            if !slot.waker.as_ref().is_some_and(|w| w.will_wake(cx.waker())) {
                                slot.waker = Some(cx.waker().clone());
                            }
                        }
                        return BodyPoll::Pending;
                    }
                }
            }
        };
        if frame.len() as u64 > left {
            let tail = frame.split_off(left as usize);
            inner.backlog_bytes += tail.len() as u64;
            inner.backlog.push_front(tail);
        }
        let len = frame.len() as u64;
        inner.seg.sent += len;
        let replay_limit = self.layout.bytes_in(REPLAY_MAX);
        let logical = inner.seg.logical;
        let replay = &mut inner.replay;
        if replay.complete && replay.logical == logical {
            if replay.bytes + len <= replay_limit {
                replay.frames.push_back(frame.clone());
                replay.bytes += len;
            } else {
                replay.frames.clear();
                replay.bytes = 0;
                replay.complete = false;
            }
        }
        self.stats.set_position(inner.seg.start + inner.seg.sent);
        if inner.near_told != Some(inner.seg.logical)
            && self.layout.data_bytes - inner.seg.sent <= self.layout.bytes_in(HANDOFF_LEAD)
        {
            inner.near_told = Some(inner.seg.logical);
            if self.moves_on() {
                deferred.tell(PlayoutEvent::HandoffNear {
                    seg: inner.seg.logical,
                    url_segment: inner.seg.url_segment,
                });
            }
        }
        if inner.seg.sent == self.layout.data_bytes {
            self.end_segment(inner, gen, deferred);
        }
        BodyPoll::Data(frame)
    }

    /// Records that the cadence ran out: the stream is gone, and the body
    /// polling it ends.
    fn cadence_ended(inner: &mut Inner, deferred: &mut Deferred) -> BodyPoll {
        inner.cadence_ended = true;
        deferred.cadence = inner.cadence.take();
        deferred.unregister = true;
        if let Some(slot) = inner.pending.as_mut() {
            deferred.wake(slot.waker.take());
        }
        BodyPoll::End(BodyEnd::StreamEnded)
    }

    /// Body `gen` handed over its segment's last data byte: the segment has
    /// ended. An early fetch of the next segment takes over at once;
    /// otherwise the playout parks until one arrives.
    fn end_segment(&self, inner: &mut Inner, gen: u64, deferred: &mut Deferred) {
        let now = Instant::now();
        let ended_logical = inner.seg.logical;
        let url_segment = inner.seg.url_segment;
        log::info!(
            "[Stream] Segment ended: stream={} speaker={} chain={} seg={} url_segment={} \
             data_bytes={} out_total={} ended_by=length reserve_left_ms={}",
            self.stream_id,
            self.speaker_ip,
            self.id,
            ended_logical,
            url_segment,
            self.layout.data_bytes,
            inner.seg.start + inner.seg.sent,
            self.stats
                .speaker
                .snapshot()
                .and_then(|s| s.reserve_ms)
                .map_or_else(|| "\u{2014}".to_string(), |r| r.to_string())
        );
        inner.finished = Some(gen);
        inner.current = None;
        inner.boundary_at = Some(now);
        inner.seg = Cursor {
            logical: ended_logical.wrapping_add(1),
            url_segment,
            start: inner.seg.start + self.layout.data_bytes,
            sent: 0,
        };
        inner.replay.reset(inner.seg.logical, true);
        if !self.continues() {
            self.retire_locked(inner, "untracked_reader", deferred);
            return;
        }
        match inner.pending.take() {
            Some(mut slot) => {
                let after_end_ms =
                    -(now.saturating_duration_since(slot.arrived_at).as_millis() as i64);
                let first_byte = inner.produced - inner.backlog_bytes;
                inner.seg.url_segment = slot.url_segment;
                self.stats.attach_connection(&slot.guard);
                self.stats.playout.push_start(
                    slot.url_segment,
                    inner.seg.start,
                    TimelineEntry::Next,
                );
                self.stats.playout.set_serving(Some(now + BOUNDARY_SETTLE));
                deferred.wake(slot.waker.take());
                slot.early = true;
                inner.current = Some(slot);
                Self::start_pump(inner, deferred);
                let expected = inner.seg.start;
                self.log_joined(
                    inner,
                    AttachKind::Early,
                    after_end_ms,
                    first_byte,
                    expected,
                    0,
                    None,
                );
                if self.moves_on() {
                    deferred.tell(PlayoutEvent::Continued {
                        seg: inner.seg.logical,
                        url_segment: inner.seg.url_segment,
                        kind: AttachKind::Early,
                    });
                }
            }
            None => {
                inner.ended = Some(SegmentEnd {
                    kind: EndKind::Length,
                    logical: ended_logical,
                    url_segment,
                    at: now,
                });
                inner.parked_at = Some(now);
                self.stats.playout.set_parked(true);
                Self::start_pump(inner, deferred);
                if self.moves_on() {
                    deferred.tell(PlayoutEvent::SegmentEnded {
                        seg: ended_logical,
                        url_segment,
                        reserve_floor_ms: self.reserve_floor().as_millis() as u64,
                    });
                }
            }
        }
    }

    /// Whether later fetches can continue this playout.
    fn continues(&self) -> bool {
        self.registry.is_some()
    }

    /// Body `gen` was dropped: the connection it served is handed back.
    fn body_dropped(self: &Arc<Self>, gen: u64) {
        let now = Instant::now();
        let mut deferred = Deferred::default();
        {
            let mut inner = self.inner.lock();
            if inner.pending.as_ref().is_some_and(|s| s.gen == gen) {
                inner.pending = None;
                log::info!(
                    "[Stream] Early fetch closed before its segment began: stream={} speaker={} \
                     chain={}; none of the playout's audio was sent on it",
                    self.stream_id,
                    self.speaker_ip,
                    self.id
                );
            } else if inner.finished == Some(gen) {
                inner.finished = None;
                if inner.current.is_none() {
                    inner.parked_at = Some(now);
                }
            } else if inner.current.as_ref().is_some_and(|s| s.gen == gen) && !inner.retired {
                inner.current = None;
                log::info!(
                    "[Stream] Segment connection closed by the speaker: stream={} speaker={} \
                     chain={} seg={} url_segment={} at {} of {} data bytes",
                    self.stream_id,
                    self.speaker_ip,
                    self.id,
                    inner.seg.logical,
                    inner.seg.url_segment,
                    inner.seg.sent,
                    self.layout.data_bytes
                );
                if self.continues() {
                    inner.ended = Some(SegmentEnd {
                        kind: EndKind::ClientMid,
                        logical: inner.seg.logical,
                        url_segment: inner.seg.url_segment,
                        at: now,
                    });
                    inner.parked_at = Some(now);
                    self.stats.playout.set_parked(false);
                    Self::start_pump(&mut inner, &mut deferred);
                    if self.moves_on() {
                        deferred.tell(PlayoutEvent::ClosedMid {
                            seg: inner.seg.logical,
                            url_segment: inner.seg.url_segment,
                        });
                    }
                } else {
                    self.retire_locked(&mut inner, "untracked_reader", &mut deferred);
                }
            }
        }
        self.run_deferred(deferred);
    }

    /// One poll of the park pump: moves whatever the cadence has into the
    /// backlog, and ends the pump once a body has the cadence back or the
    /// playout has been parked too long.
    fn poll_pump(self: &Arc<Self>, cx: &mut Context<'_>) -> Poll<()> {
        let now = Instant::now();
        let mut deferred = Deferred::default();
        let result = {
            let mut inner = self.inner.lock();
            self.poll_pump_locked(&mut inner, now, cx, &mut deferred)
        };
        self.run_deferred(deferred);
        result
    }

    /// [`Self::poll_pump`] under the lock.
    fn poll_pump_locked(
        &self,
        inner: &mut Inner,
        now: Instant,
        cx: &mut Context<'_>,
        deferred: &mut Deferred,
    ) -> Poll<()> {
        if !inner.pump.active || inner.retired {
            inner.pump.running = false;
            return Poll::Ready(());
        }
        if inner.current.is_none() {
            let since = inner.parked_at.max(inner.stopped_at).unwrap_or(now);
            if now.saturating_duration_since(since) >= PARK_MAX {
                self.retire_locked(inner, "park_timeout", deferred);
                inner.pump.running = false;
                return Poll::Ready(());
            }
        }
        let backlog_limit = self.layout.bytes_in(BACKLOG_MAX);
        loop {
            let Some(cadence) = inner.cadence.as_mut() else {
                inner.pump.running = false;
                return Poll::Ready(());
            };
            match cadence.as_mut().poll_next(cx) {
                Poll::Ready(Some(Ok(frame))) => {
                    inner.produced += frame.len() as u64;
                    inner.backlog_bytes += frame.len() as u64;
                    inner.backlog.push_back(frame);
                    if inner.backlog_bytes > backlog_limit {
                        self.retire_locked(inner, "backlog_full", deferred);
                        inner.pump.running = false;
                        return Poll::Ready(());
                    }
                }
                Poll::Ready(Some(Err(_)) | None) => {
                    Self::cadence_ended(inner, deferred);
                    if let Some(slot) = inner.current.as_mut() {
                        deferred.wake(slot.waker.take());
                    }
                    inner.pump.running = false;
                    return Poll::Ready(());
                }
                Poll::Pending => break,
            }
        }
        if !inner
            .pump
            .waker
            .as_ref()
            .is_some_and(|w| w.will_wake(cx.waker()))
        {
            inner.pump.waker = Some(cx.waker().clone());
        }
        Poll::Pending
    }

    /// Output bytes taken from the cadence so far.
    #[cfg(test)]
    pub(crate) fn produced(&self) -> u64 {
        self.inner.lock().produced
    }
}

/// What a restart's rejoin did (see [`PlayoutChain::rejoin_locked`]).
#[derive(Debug, Clone, Copy)]
struct RejoinOutcome {
    /// The policy applied: an exact rejoin whose debt was too large is
    /// trimmed after all.
    policy: Rejoin,
    /// Bytes of backlog dropped.
    dropped: u64,
    /// Latency the rejoin adds beyond the head start, in ms.
    debt_ms: u64,
}

/// `frame` with its first `fade_bytes` faded in from silence (see
/// [`super::apply_fade_in`]). Only 16-bit PCM is faded, as the cadence's own
/// crossfades are; any other depth is returned as it is.
fn fade_in(frame: Bytes, format: &AudioFormat, fade_bytes: u64) -> Bytes {
    let block = format.bytes_per_sample() * usize::from(format.channels.max(1));
    if format.bits_per_sample != 16 || frame.len() < block {
        return frame;
    }
    let mut out = frame.to_vec();
    super::apply_fade_in(&mut out, format.channels, fade_bytes as usize / block);
    Bytes::from(out)
}

/// The body of one PCM segment connection: its lead-in (the WAV header, or
/// the part of it asked for, and any pad to a sample boundary), then its
/// segment's data from the playout, ending exactly at the data size the
/// header declared.
pub struct SegmentBody {
    chain: Arc<PlayoutChain>,
    gen: u64,
    /// Bytes sent before the playout's data: header, then pad.
    lead: [Option<Bytes>; 2],
    /// Where the connection starts in its segment.
    start: SegmentStart,
    guard: Arc<LoggingStreamGuard>,
    ended: bool,
}

impl SegmentBody {
    /// The body of connection `gen` of `chain`, starting at `start`.
    fn new(
        chain: Arc<PlayoutChain>,
        gen: u64,
        start: SegmentStart,
        guard: Arc<LoggingStreamGuard>,
    ) -> Self {
        let header = segment_header(&chain.format, &chain.layout);
        let header = (start.header_skip < u64::from(WAV_HEADER_BYTES))
            .then(|| header.slice(start.header_skip as usize..));
        let pad = (start.pad > 0).then(|| Bytes::from(vec![0u8; start.pad as usize]));
        Self {
            chain,
            gen,
            lead: [header, pad],
            start,
            guard,
            ended: false,
        }
    }

    /// The playout this body belongs to.
    pub fn playout(&self) -> &Arc<PlayoutChain> {
        &self.chain
    }

    /// Where the connection starts in its segment: a partial one is
    /// answered `206`.
    pub fn start(&self) -> SegmentStart {
        self.start
    }

    /// The connection's record.
    pub fn guard(&self) -> &Arc<LoggingStreamGuard> {
        &self.guard
    }
}

/// The WAV header every segment of `layout` starts with.
fn segment_header(format: &AudioFormat, layout: &SegmentLayout) -> Bytes {
    super::create_wav_header_with_data_size(
        format.sample_rate,
        format.channels,
        format.bits_per_sample,
        layout.data_bytes.min(u64::from(u32::MAX)) as u32,
    )
}

impl Stream for SegmentBody {
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.ended {
            return Poll::Ready(None);
        }
        if let Some(bytes) = self.lead.iter_mut().find_map(Option::take) {
            return Poll::Ready(Some(Ok(bytes)));
        }
        match self.chain.poll_body(self.gen, cx) {
            BodyPoll::Data(bytes) => Poll::Ready(Some(Ok(bytes))),
            BodyPoll::Pending => Poll::Pending,
            BodyPoll::End(end) => {
                self.ended = true;
                match end {
                    BodyEnd::SegmentComplete => self.guard.mark_segment_end(),
                    BodyEnd::Superseded => log::info!(
                        "[Stream] Segment connection superseded: stream={} speaker={} chain={}",
                        self.chain.stream_id,
                        self.chain.speaker_ip,
                        self.chain.id
                    ),
                    BodyEnd::StreamEnded => {}
                }
                Poll::Ready(None)
            }
        }
    }
}

impl Drop for SegmentBody {
    fn drop(&mut self) {
        self.chain.body_dropped(self.gen);
    }
}

/// The body of a side fetch (see [`Route::Side`]): the part of the header
/// asked for, then nothing, until the speaker closes it or [`SIDE_HOLD_MAX`]
/// passes.
pub fn side_body(start: SegmentStart, layout: &SegmentLayout, format: &AudioFormat) -> PcmStream {
    use futures::StreamExt;
    let lead = (start.header_skip < u64::from(WAV_HEADER_BYTES))
        .then(|| Ok(segment_header(format, layout).slice(start.header_skip as usize..)));
    let hold = futures::stream::once(tokio::time::sleep(SIDE_HOLD_MAX))
        .filter_map(|()| futures::future::ready(None::<Result<Bytes, std::io::Error>>));
    Box::pin(futures::stream::iter(lead).chain(hold))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> SegmentLayout {
        SegmentLayout::new(&AudioFormat::default(), 10_485_760)
    }

    #[test]
    fn segments_are_whole_10ms_frames_under_4gib() {
        let full = SegmentLayout::new(&AudioFormat::default(), PCM_SEGMENT_BYTES_MAX);
        assert_eq!(
            full.data_bytes(),
            0xFFFF_0000,
            "an exact multiple at 48 kHz"
        );
        assert_eq!(full.duration_label(), "6:12:49.28");
        assert!(full.total_bytes() < 1 << 32);

        let cd = SegmentLayout::new(&AudioFormat::new(44_100, 2, 16), PCM_SEGMENT_BYTES_MAX);
        assert_eq!(cd.data_bytes() % 1764, 0);
        assert!(PCM_SEGMENT_BYTES_MAX - cd.data_bytes() < 1764);

        assert_eq!(layout().data_bytes(), 10_485_120, "54.61 s per segment");
        assert_eq!(layout().duration_label(), "0:00:54.61");
        assert_eq!(
            SegmentLayout::new(&AudioFormat::default(), u64::MAX).data_bytes(),
            0xFFFF_0000
        );
        assert_eq!(
            SegmentLayout::new(&AudioFormat::default(), 1).data_bytes(),
            1920
        );
    }

    #[test]
    fn a_range_start_maps_to_the_rest_of_the_segment() {
        let layout = layout();
        let whole = SegmentStart::new(3, None, &layout).unwrap();
        assert!(!whole.is_partial());
        assert_eq!(whole.first_byte(), 0);
        assert_eq!(whole.body_bytes(&layout), layout.total_bytes());
        assert_eq!(SegmentStart::new(3, Some(0), &layout), Some(whole));

        // Inside the header: the rest of it, then all the data.
        let in_header = SegmentStart::new(3, Some(10), &layout).unwrap();
        assert!(in_header.is_partial());
        assert_eq!(in_header.consumed, 0);
        assert_eq!(in_header.first_byte(), 10);
        assert_eq!(in_header.body_bytes(&layout), layout.total_bytes() - 10);

        // The field case: bytes=4227072- after a pause.
        let resumed = SegmentStart::new(1, Some(4_227_072), &layout).unwrap();
        assert_eq!(resumed.consumed, 4_227_028);
        assert_eq!(resumed.pad, 0);
        assert_eq!(resumed.first_byte(), 4_227_072);
        assert_eq!(
            resumed.body_bytes(&layout),
            layout.total_bytes() - 4_227_072
        );
        assert_eq!(resumed.preroll(&layout), Duration::from_millis(22_015));

        // Inside a sample frame: padded to the next boundary.
        let odd = SegmentStart::new(1, Some(44 + 4001), &layout).unwrap();
        assert_eq!(odd.pad, 3);
        assert_eq!(odd.consumed, 4004);
        assert_eq!(odd.first_byte(), 44 + 4001);

        assert_eq!(
            SegmentStart::new(1, Some(layout.total_bytes()), &layout),
            None
        );
        assert!(SegmentStart::new(1, Some(layout.total_bytes() - 1), &layout).is_some());
    }

    fn facts() -> ChainFacts {
        ChainFacts {
            dead: false,
            current: None,
            ended: None,
            replay_proven: false,
        }
    }

    fn ended(kind: EndKind, logical: u32, url_segment: u32) -> Option<SegmentEnd> {
        Some(SegmentEnd {
            kind,
            logical,
            url_segment,
            at: Instant::now(),
        })
    }

    /// The rules for a fetch, one row each.
    #[test]
    fn each_fetch_is_decided_by_the_playouts_state() {
        let total = layout().total_bytes();
        let d = |f: &ChainFacts, url: u32, range: Option<u64>| decide(f, url, range, total);

        let dead = ChainFacts {
            dead: true,
            ..facts()
        };
        assert_eq!(d(&dead, 0, None), Decision::New(NewReason::NoPlayout));
        assert_eq!(d(&dead, 4, None), Decision::New(NewReason::NoPlayout));
        assert_eq!(d(&dead, 0, Some(total)), Decision::Unsatisfiable);

        // Segment 2 being served.
        let serving = ChainFacts {
            current: Some(CurrentFacts {
                url_segment: 2,
                replayable: false,
            }),
            ..facts()
        };
        assert_eq!(
            d(&serving, 3, None),
            Decision::Pending,
            "an early fetch of the next"
        );
        assert_eq!(d(&serving, 2, None), Decision::Side, "a duplicate fetch");
        assert_eq!(d(&serving, 3, Some(1000)), Decision::Side);
        assert_eq!(
            d(&serving, 2, Some(total)),
            Decision::Unsatisfiable,
            "a Playbar's probe past the end"
        );
        assert_eq!(d(&serving, 5, None), Decision::Side);
        assert_eq!(
            d(&serving, 2, Some(4_227_072)),
            Decision::New(NewReason::RangeResume),
            "a resume's ranged fetch replaces the plain one before it"
        );
        let probed = ChainFacts {
            current: Some(CurrentFacts {
                url_segment: 2,
                replayable: true,
            }),
            ..facts()
        };
        assert_eq!(
            d(&probed, 2, None),
            Decision::Attach(AttachKind::Replay),
            "the real fetch after an early one that was only a probe"
        );
        assert_eq!(d(&probed, 3, None), Decision::Pending);

        // Segment 2 reached its end.
        let at_end = ChainFacts {
            ended: ended(EndKind::Length, 2, 2),
            ..facts()
        };
        assert_eq!(
            d(&at_end, 3, None),
            Decision::Attach(AttachKind::Continuation)
        );
        assert_eq!(d(&at_end, 2, None), Decision::Attach(AttachKind::Reopen));
        assert_eq!(d(&at_end, 2, Some(total)), Decision::Unsatisfiable);
        assert_eq!(
            d(&at_end, 2, Some(5000)),
            Decision::New(NewReason::RangeResume)
        );
        assert_eq!(d(&at_end, 7, None), Decision::New(NewReason::Stale));

        // Segment 2 closed by its client part way through.
        let closed = ChainFacts {
            ended: ended(EndKind::ClientMid, 2, 2),
            ..facts()
        };
        assert_eq!(d(&closed, 3, None), Decision::Attach(AttachKind::UserNext));
        assert_eq!(d(&closed, 2, None), Decision::New(NewReason::Resume));
        assert_eq!(
            d(&closed, 2, Some(4_227_072)),
            Decision::New(NewReason::RangeResume)
        );
        assert_eq!(d(&closed, 1, None), Decision::New(NewReason::Stale));
        let unplayed = ChainFacts {
            replay_proven: true,
            ..closed
        };
        assert_eq!(d(&unplayed, 2, None), Decision::Attach(AttachKind::Replay));
        assert_eq!(
            d(&unplayed, 2, Some(4_227_072)),
            Decision::New(NewReason::RangeResume),
            "a range is never replayed"
        );
    }

    #[test]
    fn positions_on_later_segments_continue_from_the_first() {
        let view = PlayoutView::default();
        let layout = layout();
        view.set_byte_rate(layout.byte_rate());
        view.push_start(0, 0, TimelineEntry::Played);
        view.push_start(1, layout.data_bytes(), TimelineEntry::Next);
        let uri = |tail: &str| format!("http://10.0.0.5:49400/stream/abc/{tail}");
        let base = uri("live.wav");
        let d_ms = layout.data_bytes() * 1000 / layout.byte_rate();
        let position = layout.data_bytes() + 192_000 * 3;
        let mapped = |rel_ms, start, entry| {
            Some(MappedPosition {
                track_uri: base.clone(),
                rel_ms,
                timeline: Some(PlayoutTimeline { start, entry }),
            })
        };

        assert_eq!(
            view.continuous_position("abc", &uri("live/1.wav"), 2_000, position),
            mapped(d_ms + 2_000, layout.data_bytes(), TimelineEntry::Next)
        );
        assert!(view.observed(1, layout.data_bytes()));
        assert!(!view.observed(0, 0));
        assert_eq!(
            view.continuous_position("abc", &uri("live.wav"), 54_000, position),
            mapped(54_000, 0, TimelineEntry::Played),
            "a poll still on the previous segment keeps its own start"
        );
        assert_eq!(
            view.continuous_position("other", &uri("live/1.wav"), 0, position),
            None
        );
        assert_eq!(
            view.continuous_position("abc", "x-sonos-htastream:RINCON_1:spdif", 0, position),
            None
        );
        assert_eq!(
            view.continuous_position("abc", &uri("live/7.wav"), 3_000, position),
            Some(MappedPosition {
                track_uri: base.clone(),
                rel_ms: 3_000,
                timeline: None,
            }),
            "a segment with no record keeps its RelTime and has no timeline"
        );

        // Reopened under the same URL: the new start, unless the position
        // cannot have been reached on it yet.
        view.push_start(1, layout.data_bytes() * 2, TimelineEntry::Other);
        let reopened_position = layout.data_bytes() * 2 + 192_000;
        assert_eq!(
            view.continuous_position("abc", &uri("live/1.wav"), 500, reopened_position),
            mapped(
                2 * d_ms + 500,
                layout.data_bytes() * 2,
                TimelineEntry::Other
            )
        );
        assert_eq!(
            view.continuous_position("abc", &uri("live/1.wav"), 54_000, reopened_position),
            mapped(d_ms + 54_000, layout.data_bytes(), TimelineEntry::Next)
        );
    }
}

#[cfg(test)]
#[path = "playout_continuity_tests.rs"]
mod continuity_tests;
