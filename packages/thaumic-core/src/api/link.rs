//! TCP statistics for the connections speakers fetch audio over.
//!
//! The delivery counters in the pipeline snapshot say when a frame was handed
//! to the socket, not when it left the machine: the kernel's send buffer
//! absorbs a Wi-Fi stall of seconds without the writer ever noticing. The
//! kernel does keep score, though. Retransmissions and the smoothed round
//! trip on the speaker's connection are read here and written into the same
//! snapshot, so a stall shows up in the log next to a delivery window that
//! looks perfect.
//!
//! The socket is captured when the connection is accepted, keyed by the peer
//! address, and claimed by the stream handler for that peer. The handle is
//! only ever read with a statistics query and only while the response body
//! that claimed it is alive; the connection outlives the body, so the handle
//! cannot have been reused by then.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use parking_lot::Mutex;
use serde::Serialize;

use crate::events::LinkQuality;
use crate::protocol_constants::MAX_JITTER_BUFFER_MS;

/// Accepted connections not yet claimed by a handler, by peer address.
#[derive(Default)]
pub struct TcpLinkRegistry {
    sockets: DashMap<SocketAddr, (u64, Instant)>,
}

/// Unclaimed entries older than this are dropped on the next registration:
/// only the stream handler claims them, and it does so as the request starts.
const UNCLAIMED_TTL: Duration = Duration::from_secs(120);

impl TcpLinkRegistry {
    /// Creates an empty registry.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Records the raw socket of a connection just accepted from `peer`.
    pub fn register(&self, peer: SocketAddr, raw_socket: u64) {
        let now = Instant::now();
        self.sockets
            .retain(|_, (_, at)| now.duration_since(*at) < UNCLAIMED_TTL);
        self.sockets.insert(peer, (raw_socket, now));
    }

    /// Claims the connection from `peer` for statistics, if it was registered.
    pub fn claim(&self, peer: SocketAddr) -> Option<TcpLinkProbe> {
        self.sockets
            .remove(&peer)
            .map(|(_, (raw, _))| TcpLinkProbe::new(raw))
    }
}

/// Reads TCP statistics for one connection, reporting deltas between reads.
pub struct TcpLinkProbe {
    raw_socket: u64,
    last: Mutex<Option<TcpSample>>,
    total_retransmitted: Mutex<u64>,
}

/// Cumulative counters as the kernel reports them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TcpSample {
    /// Smoothed round-trip time, in microseconds.
    rtt_us: u32,
    /// Retransmitted data so far: segments on Linux, bytes on Windows.
    retransmitted: u64,
    /// Retransmission timeouts so far (Windows counts episodes; Linux the
    /// current backoff count, which is what is available without root).
    timeouts: u32,
}

/// What happened on the connection since the previous read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TcpLinkWindow {
    /// Smoothed round-trip time at the time of the read, in milliseconds.
    pub rtt_ms: u32,
    /// Retransmitted data since the previous read (segments on Linux, bytes
    /// on Windows). Zero on a clean link.
    pub retransmitted: u64,
    /// Retransmission timeouts since the previous read.
    pub timeouts: u32,
}

impl TcpLinkProbe {
    fn new(raw_socket: u64) -> Self {
        Self {
            raw_socket,
            last: Mutex::new(None),
            total_retransmitted: Mutex::new(0),
        }
    }

    /// Reads the connection's counters and returns the change since the last
    /// read, or `None` where the platform cannot report them.
    pub fn sample(&self) -> Option<TcpLinkWindow> {
        let now = sample_raw(self.raw_socket)?;
        let mut last = self.last.lock();
        let window = match *last {
            Some(prev) => TcpLinkWindow {
                rtt_ms: now.rtt_us / 1000,
                retransmitted: now.retransmitted.saturating_sub(prev.retransmitted),
                timeouts: now.timeouts.saturating_sub(prev.timeouts),
            },
            None => TcpLinkWindow {
                rtt_ms: now.rtt_us / 1000,
                retransmitted: 0,
                timeouts: 0,
            },
        };
        *last = Some(now);
        *self.total_retransmitted.lock() += window.retransmitted;
        Some(window)
    }

    /// Retransmitted data over the probe's life (segments on Linux, bytes on Windows).
    pub fn total_retransmitted(&self) -> u64 {
        *self.total_retransmitted.lock()
    }
}

#[cfg(target_os = "linux")]
fn sample_raw(raw_socket: u64) -> Option<TcpSample> {
    // The leading fields of `struct tcp_info` from linux/tcp.h: eight bytes of
    // u8 state and flags, then u32 counters up to `tcpi_total_retrans`. The
    // kernel fills as much as the caller's length allows, so this prefix is
    // stable across kernel versions.
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct TcpInfoHead {
        flags: [u8; 8],
        words: [u32; 24],
    }
    const RTT: usize = 15; // tcpi_rtt, microseconds
    const TOTAL_RETRANS: usize = 23; // tcpi_total_retrans, segments
    const RETRANSMITS: usize = 2; // tcpi_retransmits, in `flags`

    let mut info = TcpInfoHead::default();
    let mut len = std::mem::size_of::<TcpInfoHead>() as libc::socklen_t;
    // SAFETY: the descriptor belongs to a live TCP socket the caller holds a
    // probe for, and the buffer is sized by `len`.
    let rc = unsafe {
        libc::getsockopt(
            raw_socket as libc::c_int,
            libc::IPPROTO_TCP,
            libc::TCP_INFO,
            (&mut info as *mut TcpInfoHead).cast(),
            &mut len,
        )
    };
    if rc != 0 || (len as usize) < std::mem::size_of::<TcpInfoHead>() {
        return None;
    }
    Some(TcpSample {
        rtt_us: info.words[RTT],
        retransmitted: u64::from(info.words[TOTAL_RETRANS]),
        timeouts: u32::from(info.flags[RETRANSMITS]),
    })
}

#[cfg(windows)]
fn sample_raw(raw_socket: u64) -> Option<TcpSample> {
    use windows_sys::Win32::Networking::WinSock::{TCP_INFO_v0, WSAIoctl, SIO_TCP_INFO, SOCKET};

    let version: u32 = 0;
    // SAFETY: zeroed is a valid bit pattern for this plain-data struct.
    let mut info: TCP_INFO_v0 = unsafe { std::mem::zeroed() };
    let mut returned: u32 = 0;
    // SAFETY: the socket belongs to a live connection the caller holds a
    // probe for; the buffers are sized by the lengths passed.
    let rc = unsafe {
        WSAIoctl(
            raw_socket as SOCKET,
            SIO_TCP_INFO,
            (&version as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
            (&mut info as *mut TCP_INFO_v0).cast(),
            std::mem::size_of::<TCP_INFO_v0>() as u32,
            &mut returned,
            std::ptr::null_mut(),
            None,
        )
    };
    if rc != 0 {
        return None;
    }
    Some(TcpSample {
        rtt_us: info.RttUs,
        retransmitted: u64::from(info.BytesRetrans),
        timeouts: info.TimeoutEpisodes,
    })
}

#[cfg(not(any(target_os = "linux", windows)))]
fn sample_raw(_raw_socket: u64) -> Option<TcpSample> {
    None
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;

    #[test]
    fn a_loopback_connection_reports_a_clean_link() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let peer = std::net::TcpStream::connect(listener.local_addr().unwrap()).expect("connect");
        let (accepted, _) = listener.accept().expect("accept");

        let registry = TcpLinkRegistry::new();
        let peer_addr = accepted.peer_addr().unwrap();
        registry.register(peer_addr, accepted.as_raw_fd() as u64);
        let probe = registry.claim(peer_addr).expect("registered");
        assert!(registry.claim(peer_addr).is_none(), "claimed once");

        let first = probe.sample().expect("linux reports tcp_info");
        assert_eq!(first.retransmitted, 0);
        let second = probe.sample().expect("second read");
        assert_eq!(second.retransmitted, 0);
        assert_eq!(probe.total_retransmitted(), 0);
        drop(peer);
    }
}

/// How far back samples count towards a link's quality.
const JUDGE_WINDOW: Duration = Duration::from_secs(60);

/// A smoothed round trip at or above this is a spike on a LAN.
const JUDGE_SPIKE_RTT_MS: u32 = 50;

/// Troubled samples in one window at which the link is poor, not degraded.
const JUDGE_POOR_SPIKES: u32 = 4;

/// What one lost segment costs before the kernel resends it: Windows and
/// Linux both floor the retransmission timeout near this.
const RETRANSMIT_TIMEOUT_MS: u64 = 300;

/// One window's verdict on a connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkReport {
    /// The judged quality.
    pub quality: LinkQuality,
    /// Median smoothed round trip over the window, in milliseconds.
    pub rtt_median_ms: u32,
    /// Worst smoothed round trip over the window, in milliseconds.
    pub rtt_max_ms: u32,
    /// Samples in the window that showed trouble: a retransmission, a timeout
    /// or a round-trip spike.
    pub spikes: u32,
    /// Samples in the window that showed a retransmission timeout.
    pub failures: u32,
    /// The jitter buffer the stream runs with.
    pub jitter_buffer_ms: u64,
    /// The jitter buffer that would ride out what the window showed, when
    /// raising it would help.
    pub suggested_jitter_buffer_ms: Option<u64>,
}

/// Judges a connection from its TCP samples over the last [`JUDGE_WINDOW`].
///
/// A sample is troubled when data had to be retransmitted, a retransmission
/// timed out, or the smoothed round trip spiked. One troubled sample makes
/// the link degraded; [`JUDGE_POOR_SPIKES`] of them, or any timeout, make it
/// poor. The verdict is reported only when it changes.
pub struct LinkJudge {
    samples: VecDeque<(Instant, TcpLinkWindow)>,
    reported: Option<LinkQuality>,
    jitter_buffer_ms: u64,
}

impl LinkJudge {
    /// Creates a judge for a stream running with `jitter_buffer_ms`.
    pub fn new(jitter_buffer_ms: u64) -> Self {
        Self {
            samples: VecDeque::new(),
            reported: None,
            jitter_buffer_ms,
        }
    }

    /// Records one sample taken at `now`; returns the new report when the
    /// quality changed.
    pub fn record(&mut self, now: Instant, window: TcpLinkWindow) -> Option<LinkReport> {
        self.samples.push_back((now, window));
        while let Some((at, _)) = self.samples.front() {
            if now.duration_since(*at) > JUDGE_WINDOW {
                self.samples.pop_front();
            } else {
                break;
            }
        }
        let report = self.report();
        if self.reported == Some(report.quality) {
            return None;
        }
        self.reported = Some(report.quality);
        Some(report)
    }

    fn report(&self) -> LinkReport {
        let mut rtts: Vec<u32> = self.samples.iter().map(|(_, w)| w.rtt_ms).collect();
        rtts.sort_unstable();
        let troubled = |w: &TcpLinkWindow| {
            w.retransmitted > 0 || w.timeouts > 0 || w.rtt_ms >= JUDGE_SPIKE_RTT_MS
        };
        let spikes = self.samples.iter().filter(|(_, w)| troubled(w)).count() as u32;
        let failures = self.samples.iter().filter(|(_, w)| w.timeouts > 0).count() as u32;
        let quality = if failures > 0 || spikes >= JUDGE_POOR_SPIKES {
            LinkQuality::Poor
        } else if spikes > 0 {
            LinkQuality::Degraded
        } else {
            LinkQuality::Good
        };
        let rtt_max_ms = rtts.last().copied().unwrap_or(0);
        LinkReport {
            quality,
            rtt_median_ms: rtts.get(rtts.len() / 2).copied().unwrap_or(0),
            rtt_max_ms,
            spikes,
            failures,
            jitter_buffer_ms: self.jitter_buffer_ms,
            suggested_jitter_buffer_ms: suggest_jitter_buffer(
                quality,
                rtt_max_ms,
                failures,
                self.jitter_buffer_ms,
            ),
        }
    }
}

/// The jitter buffer that would ride out the stalls a window showed.
///
/// A retransmission costs a round trip plus the retransmission timeout
/// before the data moves again, so that is the least the speaker must hold
/// ahead of its playhead; a timeout means the stall ran longer than one
/// retransmission, and only the largest buffer stands a chance. Rounded up
/// to the next hundred milliseconds, the granularity the setting is offered
/// in. `None` when the link is fine, when the current buffer already covers
/// the stall, or when the buffer is already at its maximum.
fn suggest_jitter_buffer(
    quality: LinkQuality,
    rtt_max_ms: u32,
    failures: u32,
    current_ms: u64,
) -> Option<u64> {
    if quality == LinkQuality::Good || current_ms >= MAX_JITTER_BUFFER_MS {
        return None;
    }
    let needed = if failures > 0 {
        MAX_JITTER_BUFFER_MS
    } else {
        (u64::from(rtt_max_ms) + RETRANSMIT_TIMEOUT_MS).div_ceil(100) * 100
    };
    let needed = needed.min(MAX_JITTER_BUFFER_MS);
    (needed > current_ms).then_some(needed)
}

#[cfg(test)]
mod judge_tests {
    use super::*;

    fn quiet(rtt_ms: u32) -> TcpLinkWindow {
        TcpLinkWindow {
            rtt_ms,
            retransmitted: 0,
            timeouts: 0,
        }
    }

    #[test]
    fn a_clean_connection_is_reported_good_once_and_then_stays_quiet() {
        let mut judge = LinkJudge::new(200);
        let t0 = Instant::now();
        let first = judge.record(t0, quiet(4)).expect("first sample reports");
        assert_eq!(first.quality, LinkQuality::Good);
        assert_eq!(first.suggested_jitter_buffer_ms, None);
        for i in 1..120 {
            let at = t0 + Duration::from_millis(500 * i);
            assert!(judge.record(at, quiet(3 + (i % 4) as u32)).is_none());
        }
    }

    #[test]
    fn a_retransmission_degrades_the_link_and_suggests_a_buffer_that_covers_it() {
        let mut judge = LinkJudge::new(200);
        let t0 = Instant::now();
        judge.record(t0, quiet(4));
        let report = judge
            .record(
                t0 + Duration::from_millis(500),
                TcpLinkWindow {
                    rtt_ms: 60,
                    retransmitted: 2,
                    timeouts: 0,
                },
            )
            .expect("transition");
        assert_eq!(report.quality, LinkQuality::Degraded);
        assert_eq!(report.spikes, 1);
        assert_eq!(report.rtt_max_ms, 60);
        // 60 ms round trip plus a 300 ms retransmission timeout, rounded up.
        assert_eq!(report.suggested_jitter_buffer_ms, Some(400));
    }

    #[test]
    fn repeated_trouble_or_a_timeout_makes_the_link_poor() {
        let mut judge = LinkJudge::new(200);
        let t0 = Instant::now();
        judge.record(t0, quiet(4));
        for i in 1..=3 {
            judge.record(t0 + Duration::from_secs(i), quiet(80));
        }
        let poor = judge
            .record(t0 + Duration::from_secs(4), quiet(70))
            .expect("fourth spike");
        assert_eq!(poor.quality, LinkQuality::Poor);
        assert_eq!(poor.spikes, 4);

        let mut judge = LinkJudge::new(500);
        judge.record(t0, quiet(4));
        let poor = judge
            .record(
                t0 + Duration::from_secs(1),
                TcpLinkWindow {
                    rtt_ms: 20,
                    retransmitted: 3,
                    timeouts: 1,
                },
            )
            .expect("timeout");
        assert_eq!(poor.quality, LinkQuality::Poor);
        assert_eq!(poor.failures, 1);
        assert_eq!(poor.suggested_jitter_buffer_ms, Some(MAX_JITTER_BUFFER_MS));
    }

    #[test]
    fn no_suggestion_when_the_buffer_already_covers_the_stall_or_is_at_its_maximum() {
        let mut judge = LinkJudge::new(500);
        let t0 = Instant::now();
        judge.record(t0, quiet(4));
        let report = judge
            .record(
                t0 + Duration::from_secs(1),
                TcpLinkWindow {
                    rtt_ms: 60,
                    retransmitted: 1,
                    timeouts: 0,
                },
            )
            .expect("transition");
        assert_eq!(report.quality, LinkQuality::Degraded);
        assert_eq!(report.suggested_jitter_buffer_ms, None, "500 covers 400");

        let mut judge = LinkJudge::new(MAX_JITTER_BUFFER_MS);
        judge.record(t0, quiet(4));
        let report = judge
            .record(
                t0 + Duration::from_secs(1),
                TcpLinkWindow {
                    rtt_ms: 20,
                    retransmitted: 1,
                    timeouts: 1,
                },
            )
            .expect("transition");
        assert_eq!(
            report.suggested_jitter_buffer_ms, None,
            "already at the maximum"
        );
    }

    #[test]
    fn the_link_recovers_once_the_trouble_ages_out() {
        let mut judge = LinkJudge::new(200);
        let t0 = Instant::now();
        judge.record(t0, quiet(4));
        judge.record(
            t0 + Duration::from_secs(1),
            TcpLinkWindow {
                rtt_ms: 30,
                retransmitted: 1,
                timeouts: 0,
            },
        );
        let mut last = None;
        for i in 2..=125 {
            last = judge
                .record(t0 + Duration::from_millis(500 * i), quiet(4))
                .or(last);
        }
        assert_eq!(last.map(|r| r.quality), Some(LinkQuality::Good));
    }
}
