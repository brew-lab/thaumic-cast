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
//!
//! Connections are kept alive, so the one a stream claims may already have
//! carried other responses (a `HEAD`, an error, artwork). The kernel's byte
//! counters cover the whole connection, so the probe reads them once as it
//! claims the connection and counts only what came after.

use std::collections::VecDeque;
use std::net::SocketAddr;
#[cfg(any(windows, test))]
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// The byte counters as the probe found them, before the response it
    /// was claimed for; `None` where they could not be read, in which case
    /// no acknowledged bytes are reported.
    baseline: Option<TcpBaseline>,
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
    /// Bytes the peer has acknowledged since the probe claimed the
    /// connection, where the platform reports them (Linux 4.1 and later,
    /// Windows) and they are consistent with what the body handed over.
    bytes_acked: Option<u64>,
    /// Bytes written to the socket that the kernel has not yet sent, where
    /// the platform reports them (Linux 4.6 and later).
    notsent: Option<u32>,
}

/// What happened on the connection since the previous read.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct TcpLinkWindow {
    /// Smoothed round-trip time at the time of the read, in milliseconds.
    pub rtt_ms: u32,
    /// Retransmitted data since the previous read (segments on Linux, bytes
    /// on Windows). Zero on a clean link.
    pub retransmitted: u64,
    /// Retransmission timeouts since the previous read.
    pub timeouts: u32,
    /// Bytes the response body had handed over at the time of the read that
    /// the speaker had not yet acknowledged: what sat in our buffers, in the
    /// kernel's send buffer or on the air. The speaker cannot play them yet,
    /// so this is how far its reserve lags the delivered count. `None` where
    /// the platform does not report acknowledged bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unacked_bytes: Option<u64>,
    /// Bytes in the kernel's send buffer not yet sent, where reported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notsent_bytes: Option<u32>,
}

impl TcpLinkProbe {
    fn new(raw_socket: u64) -> Self {
        Self {
            raw_socket,
            baseline: read_baseline(raw_socket),
            last: Mutex::new(None),
            total_retransmitted: Mutex::new(0),
        }
    }

    /// Reads the connection's counters and returns the change since the last
    /// read, or `None` where the platform cannot report them.
    ///
    /// `body_bytes` is how many bytes the response body has handed over so
    /// far. The bytes acknowledged are counted against it, so they must be
    /// read in the same breath: the cadence loop samples between frames,
    /// when nothing else can be yielded.
    pub fn sample(&self, body_bytes: u64) -> Option<TcpLinkWindow> {
        let now = sample_raw(self.raw_socket, self.baseline, body_bytes, true)?;
        let mut last = self.last.lock();
        let (retransmitted, timeouts) = match *last {
            Some(prev) => (
                now.retransmitted.saturating_sub(prev.retransmitted),
                now.timeouts.saturating_sub(prev.timeouts),
            ),
            None => (0, 0),
        };
        let window = TcpLinkWindow {
            rtt_ms: now.rtt_us / 1000,
            retransmitted,
            timeouts,
            unacked_bytes: now
                .bytes_acked
                .map(|acked| body_bytes.saturating_sub(acked)),
            notsent_bytes: now.notsent,
        };
        *last = Some(now);
        *self.total_retransmitted.lock() += window.retransmitted;
        Some(window)
    }

    /// Bytes of the `body_bytes` handed over so far that the peer has not yet
    /// acknowledged, or `None` where the platform does not report
    /// acknowledged bytes. Reads the counters without disturbing the deltas
    /// [`Self::sample`] reports.
    ///
    /// For a read from outside the body, where `body_bytes` cannot be read
    /// in the same breath: it never teaches the process anything about how
    /// the stack counts (see `windows_acked_bytes`), since a frame handed
    /// over between the two reads could look like a stack counting resent
    /// bytes. The caller must know the body is still open (see the module
    /// documentation on handle reuse).
    pub fn unacked_bytes(&self, body_bytes: u64) -> Option<u64> {
        let now = sample_raw(self.raw_socket, self.baseline, body_bytes, false)?;
        now.bytes_acked
            .map(|acked| body_bytes.saturating_sub(acked))
    }

    /// Retransmitted data over the probe's life (segments on Linux, bytes on Windows).
    pub fn total_retransmitted(&self) -> u64 {
        *self.total_retransmitted.lock()
    }
}

/// The leading fields of `struct tcp_info` from linux/tcp.h, through
/// `tcpi_bytes_retrans`: eight bytes of u8 state and flags, u32 counters up
/// to `tcpi_total_retrans`, then the u64 and u32 fields later kernels added.
/// The kernel copies as much of its structure as the caller's length allows
/// and reports how much that was, so the prefix is stable across kernels and
/// each later field is trusted only when the reported length covers it.
#[cfg(target_os = "linux")]
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct TcpInfoPrefix {
    flags: [u8; 8],
    words: [u32; 24],
    pacing_rate: u64,
    max_pacing_rate: u64,
    /// Linux 4.1 and later.
    bytes_acked: u64,
    bytes_received: u64,
    segs_out: u32,
    segs_in: u32,
    /// Linux 4.6 and later.
    notsent_bytes: u32,
    min_rtt: u32,
    data_segs_in: u32,
    data_segs_out: u32,
    delivery_rate: u64,
    busy_time: u64,
    rwnd_limited: u64,
    sndbuf_limited: u64,
    delivered: u32,
    delivered_ce: u32,
    /// Linux 4.19 and later: bytes sent, retransmissions included.
    bytes_sent: u64,
    /// Linux 4.19 and later.
    bytes_retrans: u64,
}

// The offsets linux/tcp.h gives these fields; a layout that disagreed would
// read the wrong counters silently.
#[cfg(target_os = "linux")]
const _: () = {
    assert!(std::mem::offset_of!(TcpInfoPrefix, pacing_rate) == 104);
    assert!(std::mem::offset_of!(TcpInfoPrefix, bytes_acked) == 120);
    assert!(std::mem::offset_of!(TcpInfoPrefix, notsent_bytes) == 144);
    assert!(std::mem::offset_of!(TcpInfoPrefix, delivery_rate) == 160);
    assert!(std::mem::offset_of!(TcpInfoPrefix, bytes_sent) == 200);
    assert!(std::mem::offset_of!(TcpInfoPrefix, bytes_retrans) == 208);
    assert!(std::mem::size_of::<TcpInfoPrefix>() == 216);
};

#[cfg(target_os = "linux")]
impl TcpInfoPrefix {
    const RTT: usize = 15; // tcpi_rtt, microseconds
    const TOTAL_RETRANS: usize = 23; // tcpi_total_retrans, segments
    const RETRANSMITS: usize = 2; // tcpi_retransmits, in `flags`

    /// Decodes the fields the kernel filled, given the length it reported:
    /// `None` if it did not reach `tcpi_total_retrans`, and each later field
    /// `None` unless the length covers it. `bytes_acked` is the kernel's,
    /// counted over the connection's whole life.
    fn decode(&self, len: usize) -> Option<TcpSample> {
        if !Self::covers(len, std::mem::offset_of!(Self, words), 24 * 4) {
            return None;
        }
        Some(TcpSample {
            rtt_us: self.words[Self::RTT],
            retransmitted: u64::from(self.words[Self::TOTAL_RETRANS]),
            timeouts: u32::from(self.flags[Self::RETRANSMITS]),
            bytes_acked: Self::covers(len, std::mem::offset_of!(Self, bytes_acked), 8)
                .then_some(self.bytes_acked),
            notsent: Self::covers(len, std::mem::offset_of!(Self, notsent_bytes), 4)
                .then_some(self.notsent_bytes),
        })
    }

    /// Whether a reported length of `len` covers `size` bytes at `offset`.
    fn covers(len: usize, offset: usize, size: usize) -> bool {
        len >= offset + size
    }

    /// Every byte written to the connection so far, given the length the
    /// kernel reported: sent once, or still waiting to be. Before 4.19 only
    /// the bytes acknowledged are known; they stand in, which holds when the
    /// peer has read every earlier response before asking for the next, as
    /// a request's own acknowledgement then covers them.
    fn bytes_written(&self, len: usize) -> Option<u64> {
        if Self::covers(len, std::mem::offset_of!(Self, bytes_retrans), 8) {
            let sent_once = self.bytes_sent.saturating_sub(self.bytes_retrans);
            return Some(sent_once + u64::from(self.notsent_bytes));
        }
        Self::covers(len, std::mem::offset_of!(Self, bytes_acked), 8).then_some(self.bytes_acked)
    }
}

/// What the connection had carried before the probe claimed it: every byte
/// written to it so far.
#[cfg(target_os = "linux")]
type TcpBaseline = u64;

/// Reads `tcp_info`, returning it with the length the kernel filled.
#[cfg(target_os = "linux")]
fn read_tcp_info(raw_socket: u64) -> Option<(TcpInfoPrefix, usize)> {
    let mut info = TcpInfoPrefix::default();
    let mut len = std::mem::size_of::<TcpInfoPrefix>() as libc::socklen_t;
    // SAFETY: the descriptor belongs to a live TCP socket the caller holds a
    // probe for, and the buffer is sized by `len`.
    let rc = unsafe {
        libc::getsockopt(
            raw_socket as libc::c_int,
            libc::IPPROTO_TCP,
            libc::TCP_INFO,
            (&mut info as *mut TcpInfoPrefix).cast(),
            &mut len,
        )
    };
    (rc == 0).then_some((info, len as usize))
}

#[cfg(target_os = "linux")]
fn read_baseline(raw_socket: u64) -> Option<TcpBaseline> {
    let (info, len) = read_tcp_info(raw_socket)?;
    info.bytes_written(len)
}

/// Samples the connection, counting acknowledged bytes from `baseline`. An
/// earlier response still unacknowledged when the probe claimed the
/// connection holds the count at zero until its bytes are, never above.
#[cfg(target_os = "linux")]
fn sample_raw(
    raw_socket: u64,
    baseline: Option<TcpBaseline>,
    _body_bytes: u64,
    _may_learn: bool,
) -> Option<TcpSample> {
    let (info, len) = read_tcp_info(raw_socket)?;
    let mut sample = info.decode(len)?;
    sample.bytes_acked = sample
        .bytes_acked
        .zip(baseline)
        .map(|(acked, before)| acked.saturating_sub(before));
    Some(sample)
}

/// What the connection had carried before the probe claimed it: Windows'
/// `BytesOut` and `BytesRetrans` at the time.
#[cfg(windows)]
#[derive(Debug, Clone, Copy)]
struct TcpBaseline {
    bytes_out: u64,
    bytes_retrans: u32,
}

/// Whether this machine's `BytesOut` counts retransmitted bytes. Windows
/// does not document it; it is learned from the first connection that
/// shows it (see [`windows_acked_bytes`]) and holds for every connection
/// after, since it is a property of the TCP stack.
#[cfg(windows)]
static BYTES_OUT_COUNTS_RETRANSMITS: AtomicBool = AtomicBool::new(false);

/// What may precede the response body on the connection once earlier
/// responses are taken off: the HTTP response head, a few hundred bytes.
/// The bytes acknowledged can exceed the body's by this much without
/// meaning anything.
#[cfg(any(windows, test))]
const RESPONSE_HEAD_SLACK_BYTES: u64 = 2048;

/// Bytes the peer has acknowledged, from Windows' `TCP_INFO_v0` counted
/// since the probe claimed the connection: everything sent less what is
/// still in flight.
///
/// If `BytesOut` counts retransmissions, that overstates the bytes
/// acknowledged by every byte resent. It shows as a difference exceeding
/// all the body has handed over (`body_bytes`) by more than a response head
/// could explain, but by no more than the bytes resent (plus a head) do;
/// from then on, on this and every later connection (`counts_retransmits`
/// latches), the retransmitted bytes are taken off. An excess the resent
/// bytes do not explain says nothing about the stack: the counters are not
/// what they are taken to be, and the read reports `None`, as does any
/// count still past the body after the resent bytes are taken off.
#[cfg(any(windows, test))]
fn windows_acked_bytes(
    bytes_out: u64,
    bytes_in_flight: u32,
    bytes_retransmitted: u32,
    body_bytes: u64,
    counts_retransmits: &AtomicBool,
) -> Option<u64> {
    let sent_less_in_flight = bytes_out.saturating_sub(u64::from(bytes_in_flight));
    let retransmitted = u64::from(bytes_retransmitted);
    let plausible = body_bytes.saturating_add(RESPONSE_HEAD_SLACK_BYTES);
    if sent_less_in_flight > plausible && !counts_retransmits.load(Ordering::Relaxed) {
        let excess = sent_less_in_flight - body_bytes;
        if retransmitted == 0 || excess > retransmitted + RESPONSE_HEAD_SLACK_BYTES {
            return None;
        }
        if !counts_retransmits.swap(true, Ordering::Relaxed) {
            log::info!(
                "[Stream] TCP BytesOut counts retransmitted bytes on this machine ({} sent \
                 less in flight against {} handed over, {} retransmitted); acknowledged bytes \
                 are counted net of them from now on",
                sent_less_in_flight,
                body_bytes,
                retransmitted
            );
        }
    }
    let acked = if counts_retransmits.load(Ordering::Relaxed) {
        sent_less_in_flight.saturating_sub(retransmitted)
    } else {
        sent_less_in_flight
    };
    (acked <= plausible).then_some(acked)
}

/// Reads `TCP_INFO_v0` for the socket.
#[cfg(windows)]
fn read_tcp_info(raw_socket: u64) -> Option<windows_sys::Win32::Networking::WinSock::TCP_INFO_v0> {
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
    (rc == 0).then_some(info)
}

#[cfg(windows)]
fn read_baseline(raw_socket: u64) -> Option<TcpBaseline> {
    let info = read_tcp_info(raw_socket)?;
    Some(TcpBaseline {
        bytes_out: info.BytesOut,
        bytes_retrans: info.BytesRetrans,
    })
}

/// Samples the connection. `may_learn` is whether this read may latch
/// [`BYTES_OUT_COUNTS_RETRANSMITS`]; one that may not works on a copy.
#[cfg(windows)]
fn sample_raw(
    raw_socket: u64,
    baseline: Option<TcpBaseline>,
    body_bytes: u64,
    may_learn: bool,
) -> Option<TcpSample> {
    let info = read_tcp_info(raw_socket)?;
    let scratch;
    let latch = if may_learn {
        &BYTES_OUT_COUNTS_RETRANSMITS
    } else {
        scratch = AtomicBool::new(BYTES_OUT_COUNTS_RETRANSMITS.load(Ordering::Relaxed));
        &scratch
    };
    Some(TcpSample {
        rtt_us: info.RttUs,
        retransmitted: u64::from(info.BytesRetrans),
        timeouts: info.TimeoutEpisodes,
        bytes_acked: baseline.and_then(|before| {
            windows_acked_bytes(
                info.BytesOut.saturating_sub(before.bytes_out),
                info.BytesInFlight,
                info.BytesRetrans.wrapping_sub(before.bytes_retrans),
                body_bytes,
                latch,
            )
        }),
        notsent: None,
    })
}

#[cfg(not(any(target_os = "linux", windows)))]
type TcpBaseline = ();

#[cfg(not(any(target_os = "linux", windows)))]
fn read_baseline(_raw_socket: u64) -> Option<TcpBaseline> {
    None
}

#[cfg(not(any(target_os = "linux", windows)))]
fn sample_raw(
    _raw_socket: u64,
    _baseline: Option<TcpBaseline>,
    _body_bytes: u64,
    _may_learn: bool,
) -> Option<TcpSample> {
    None
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
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

        let first = probe.sample(0).expect("linux reports tcp_info");
        assert_eq!(first.retransmitted, 0);
        assert_eq!(first.unacked_bytes, Some(0));
        let second = probe.sample(0).expect("second read");
        assert_eq!(second.retransmitted, 0);
        assert_eq!(probe.total_retransmitted(), 0);
        drop(peer);
    }

    #[test]
    fn a_loopback_connection_reports_its_acknowledged_bytes() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let mut peer =
            std::net::TcpStream::connect(listener.local_addr().unwrap()).expect("connect");
        let (mut accepted, _) = listener.accept().expect("accept");
        let registry = TcpLinkRegistry::new();
        let peer_addr = accepted.peer_addr().unwrap();
        registry.register(peer_addr, accepted.as_raw_fd() as u64);
        let probe = registry.claim(peer_addr).expect("registered");

        let body = vec![0u8; 64 * 1024];
        accepted.write_all(&body).expect("write");
        let mut received = vec![0u8; body.len()];
        peer.read_exact(&mut received).expect("read");
        // Everything has arrived; its acknowledgement follows within a
        // delayed-ACK timeout at most.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let window = probe.sample(body.len() as u64).expect("tcp_info");
            let unacked = window.unacked_bytes.expect("kernel 4.1 or later");
            assert!(window.notsent_bytes.is_some(), "kernel 4.6 or later");
            if unacked == 0 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "{unacked} bytes never acknowledged"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        // Counting the acknowledged bytes against more than was handed over
        // shows the difference as still unacknowledged.
        let window = probe.sample(body.len() as u64 + 1000).unwrap();
        assert_eq!(window.unacked_bytes, Some(1000));
    }

    #[test]
    fn earlier_responses_on_a_kept_alive_connection_are_not_counted() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let mut peer =
            std::net::TcpStream::connect(listener.local_addr().unwrap()).expect("connect");
        let (mut accepted, _) = listener.accept().expect("accept");
        let registry = TcpLinkRegistry::new();
        let peer_addr = accepted.peer_addr().unwrap();
        registry.register(peer_addr, accepted.as_raw_fd() as u64);

        // An earlier response, read in full, then the next request (whose
        // segment acknowledges it) before the stream claims the connection.
        let earlier = vec![0u8; 20 * 1024];
        accepted.write_all(&earlier).expect("write");
        let mut received = vec![0u8; earlier.len()];
        peer.read_exact(&mut received).expect("read");
        let request = b"GET /stream HTTP/1.1\r\n\r\n";
        peer.write_all(request).expect("request");
        let mut read_back = [0u8; 24];
        accepted.read_exact(&mut read_back).expect("read request");
        assert_eq!(&read_back, request);
        let probe = registry.claim(peer_addr).expect("registered");

        let body = vec![0u8; 8 * 1024];
        accepted.write_all(&body).expect("write");
        let mut received = vec![0u8; body.len()];
        peer.read_exact(&mut received).expect("read");
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let window = probe.sample(body.len() as u64).expect("tcp_info");
            if window.unacked_bytes == Some(0) {
                break;
            }
            assert!(Instant::now() < deadline, "never acknowledged: {window:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
        // Were the earlier response counted, the acknowledged bytes would
        // cover this too, and the stall hide behind the clamp at zero.
        let window = probe.sample(body.len() as u64 + 1000).unwrap();
        assert_eq!(window.unacked_bytes, Some(1000));
    }

    #[test]
    fn truncated_optlen_yields_none_fields() {
        let info = TcpInfoPrefix {
            bytes_acked: 5_000,
            notsent_bytes: 300,
            words: {
                let mut w = [0u32; 24];
                w[TcpInfoPrefix::RTT] = 4_000;
                w[TcpInfoPrefix::TOTAL_RETRANS] = 7;
                w
            },
            ..TcpInfoPrefix::default()
        };
        let full = std::mem::size_of::<TcpInfoPrefix>();
        let sample = info.decode(full).expect("full length");
        assert_eq!(
            (sample.rtt_us, sample.retransmitted),
            (4_000, 7),
            "the base fields are read"
        );
        assert_eq!(sample.bytes_acked, Some(5_000));
        assert_eq!(sample.notsent, Some(300));

        // A 4.1–4.5 kernel: acknowledged bytes, but no notsent.
        let sample = info.decode(144).expect("through tcpi_segs_in");
        assert_eq!((sample.bytes_acked, sample.notsent), (Some(5_000), None));
        // Short of the end of tcpi_bytes_acked by one byte.
        let sample = info.decode(127).expect("base fields");
        assert_eq!((sample.bytes_acked, sample.notsent), (None, None));
        // A pre-4.1 kernel stops after tcpi_total_retrans.
        let sample = info.decode(104).expect("base fields");
        assert_eq!(sample.retransmitted, 7);
        assert_eq!((sample.bytes_acked, sample.notsent), (None, None));
        // Anything shorter cannot be read at all.
        assert!(info.decode(103).is_none());
        assert!(info.decode(0).is_none());
    }

    #[test]
    fn bytes_written_prefers_bytes_sent_and_falls_back_to_bytes_acked() {
        let info = TcpInfoPrefix {
            bytes_acked: 5_000,
            notsent_bytes: 300,
            bytes_sent: 9_000,
            bytes_retrans: 1_500,
            ..TcpInfoPrefix::default()
        };
        let full = std::mem::size_of::<TcpInfoPrefix>();
        // Sent once (9000 less 1500 resent), plus what waits to be sent.
        assert_eq!(info.bytes_written(full), Some(7_800));
        // A 4.1–4.18 kernel has only the bytes acknowledged.
        assert_eq!(info.bytes_written(215), Some(5_000));
        assert_eq!(info.bytes_written(128), Some(5_000));
        assert_eq!(info.bytes_written(127), None);
    }
}

#[cfg(test)]
mod windows_arithmetic_tests {
    use super::*;

    #[test]
    fn windows_acked_bytes_arithmetic() {
        // A stack whose BytesOut excludes retransmissions: acknowledged is
        // sent less in flight, and a resend changes nothing.
        let latch = AtomicBool::new(false);
        assert_eq!(
            windows_acked_bytes(100_000, 20_000, 0, 100_000, &latch),
            Some(80_000)
        );
        assert_eq!(
            windows_acked_bytes(100_300, 0, 1_460, 100_000, &latch),
            Some(100_300)
        );
        assert!(
            !latch.load(Ordering::Relaxed),
            "a response head's worth over the body proves nothing"
        );

        // A stack whose BytesOut counts them: sent less in flight runs past
        // everything the body handed over, by no more than was resent.
        let latch = AtomicBool::new(false);
        let acked = windows_acked_bytes(110_000, 2_000, 10_000, 100_000, &latch);
        assert!(latch.load(Ordering::Relaxed), "learned");
        assert_eq!(acked, Some(98_000));
        // Once learned, retransmissions are taken off even while too few to
        // show on their own.
        assert_eq!(
            windows_acked_bytes(51_000, 1_000, 1_000, 60_000, &latch),
            Some(49_000)
        );

        // Counters that disagree never go below zero.
        assert_eq!(
            windows_acked_bytes(1_000, 5_000, 0, 0, &AtomicBool::new(false)),
            Some(0)
        );
        assert_eq!(windows_acked_bytes(1_000, 0, 5_000, 0, &latch), Some(0));
    }

    #[test]
    fn an_excess_retransmissions_do_not_explain_teaches_nothing() {
        // An earlier response's bytes, with nothing resent: the counters are
        // not what they are taken to be, so the read reports nothing, and
        // the stack is not assumed to count resent bytes.
        let latch = AtomicBool::new(false);
        assert_eq!(windows_acked_bytes(130_000, 0, 0, 100_000, &latch), None);
        assert!(!latch.load(Ordering::Relaxed), "no retransmits, no latch");
        // Resent bytes that fall well short of the excess explain it no
        // better.
        assert_eq!(
            windows_acked_bytes(130_000, 0, 1_460, 100_000, &latch),
            None
        );
        assert!(
            !latch.load(Ordering::Relaxed),
            "too few retransmits to latch"
        );
        // The next consistent read is reported as usual.
        assert_eq!(
            windows_acked_bytes(100_500, 500, 1_460, 100_000, &latch),
            Some(100_000)
        );

        // Once learned, a count still past the body after the resent bytes
        // are taken off is reported as nothing, not as acknowledged.
        let latch = AtomicBool::new(true);
        assert_eq!(
            windows_acked_bytes(130_000, 0, 1_460, 100_000, &latch),
            None
        );
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
            ..TcpLinkWindow::default()
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
                    ..TcpLinkWindow::default()
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
                    ..TcpLinkWindow::default()
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
                    ..TcpLinkWindow::default()
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
                    ..TcpLinkWindow::default()
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
                ..TcpLinkWindow::default()
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
