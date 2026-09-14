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

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use parking_lot::Mutex;
use serde::Serialize;

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
