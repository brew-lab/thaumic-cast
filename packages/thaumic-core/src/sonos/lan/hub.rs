//! The household's Control API sockets: one per speaker that is talked to,
//! opened on first use and reopened after it closes.
//!
//! A call goes to one speaker. If that speaker answers that it no longer
//! leads the group (`GROUP_STATUS_MOVED`), the call is sent once more to the
//! leader the answer names. A socket that will not open is retried no sooner
//! than the backoff allows (1, 2, 5, 10, then every 30 s), so a speaker that
//! has gone away costs one fast failure per call, not a connect each time.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{broadcast, Mutex};

use super::protocol::{code, transport_error, Command, Frame, Groups, SpeakerIdentity, Target};
use super::socket::{LanConnector, LanEvent, LanSocket, Reply};
use crate::sonos::soap::SoapResult;

/// How long a call waits for its reply.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(5);

/// How long opening a socket may take, handshake included.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// The wait before each further attempt to open a socket that failed to open.
const RECONNECT_BACKOFF: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
];

/// How often [`LanHub::wait_for_groups`] reads the groups again.
const GROUPS_POLL: Duration = Duration::from_millis(100);

/// Capacity of the event channel. A subscriber that falls this far behind
/// misses events; the event pump polls, so it recovers on its next poll.
const EVENT_CAPACITY: usize = 512;

/// A reply and the speaker that sent it, which differs from the one asked
/// when the group had moved.
#[derive(Debug, Clone)]
pub struct HubReply {
    /// The reply, a success (refusals are errors).
    pub reply: Reply,
    /// The speaker that answered.
    pub ip: String,
}

impl HubReply {
    /// The reply's frame.
    #[must_use]
    pub fn frame(&self) -> &Frame {
        &self.reply.frame
    }
}

#[derive(Default)]
struct Slot {
    socket: Option<Arc<LanSocket>>,
    /// Whether a socket was ever open, so a new one counts as a reconnect.
    was_open: bool,
    /// Failed opens since the last success.
    failures: usize,
    /// No open is attempted before this.
    retry_at: Option<Instant>,
}

/// The household's sockets.
pub struct LanHub {
    connector: Arc<dyn LanConnector>,
    slots: parking_lot::Mutex<HashMap<String, Arc<Mutex<Slot>>>>,
    /// The player id each IP should answer as (see [`LanHub::know`]).
    players: parking_lot::Mutex<HashMap<String, String>>,
    events: broadcast::Sender<LanEvent>,
    call_timeout: Duration,
    backoff: Vec<Duration>,
}

impl LanHub {
    /// A hub that opens its sockets through `connector`.
    #[must_use]
    pub fn new(connector: Arc<dyn LanConnector>) -> Self {
        Self {
            connector,
            slots: parking_lot::Mutex::default(),
            players: parking_lot::Mutex::default(),
            events: broadcast::channel(EVENT_CAPACITY).0,
            call_timeout: CALL_TIMEOUT,
            backoff: RECONNECT_BACKOFF.to_vec(),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_timings(mut self, call_timeout: Duration, backoff: Vec<Duration>) -> Self {
        self.call_timeout = call_timeout;
        self.backoff = backoff;
        self
    }

    /// Events from every socket, tagged with the speaker's IP.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<LanEvent> {
        self.events.subscribe()
    }

    /// Records which player answers at `ip`. A socket is opened only to a
    /// known player, and only if its certificate names that player. A
    /// different player at a known IP (an address reused) drops the old
    /// socket.
    pub fn know(&self, ip: &str, player_id: &str) {
        let before = self
            .players
            .lock()
            .insert(ip.to_string(), player_id.to_string());
        if before.is_some_and(|b| b != player_id) {
            log::info!("[Lan] {ip} is now {player_id}");
            self.slots.lock().remove(ip);
        }
    }

    /// The player known to answer at `ip`.
    #[must_use]
    pub fn player_at(&self, ip: &str) -> Option<String> {
        self.players.lock().get(ip).cloned()
    }

    fn slot(&self, ip: &str) -> Arc<Mutex<Slot>> {
        self.slots.lock().entry(ip.to_string()).or_default().clone()
    }

    /// The open socket to `ip`, opening one if allowed.
    async fn socket(&self, ip: &str, household_id: &str) -> SoapResult<Arc<LanSocket>> {
        let Some(player_id) = self.players.lock().get(ip).cloned() else {
            return Err(transport_error(
                code::CONNECT_FAILED,
                format!("{ip}: no player known at this address"),
            ));
        };
        let expect = SpeakerIdentity {
            player_id,
            household_id: (!household_id.is_empty()).then(|| household_id.to_string()),
        };
        let slot = self.slot(ip);
        let mut s = slot.lock().await;
        if let Some(sock) = s.socket.as_ref().filter(|x| !x.is_closed()) {
            return Ok(sock.clone());
        }
        s.socket = None;
        if let Some(at) = s.retry_at.filter(|at| Instant::now() < *at) {
            return Err(transport_error(
                code::CONNECT_FAILED,
                format!(
                    "{ip}: not reachable; next attempt in {} ms",
                    at.saturating_duration_since(Instant::now()).as_millis()
                ),
            ));
        }
        let opened = LanSocket::open(
            &*self.connector,
            ip,
            &expect,
            self.events.clone(),
            CONNECT_TIMEOUT,
        )
        .await;
        match opened {
            Ok(sock) => {
                let sock = Arc::new(sock);
                let reconnected = s.was_open;
                s.socket = Some(sock.clone());
                s.was_open = true;
                s.failures = 0;
                s.retry_at = None;
                drop(s);
                log::info!(
                    "[Lan] {ip}: socket open{}",
                    if reconnected { " again" } else { "" }
                );
                if reconnected {
                    let _ = self
                        .events
                        .send(LanEvent::Reconnected { ip: ip.to_string() });
                }
                Ok(sock)
            }
            Err(e) => {
                let wait = self.backoff[s.failures.min(self.backoff.len() - 1)];
                s.failures += 1;
                s.retry_at = Some(Instant::now() + wait);
                log::warn!("[Lan] {e}; next attempt in {} ms", wait.as_millis());
                Err(e)
            }
        }
    }

    /// Sends a command to the speaker at `ip` and returns its successful
    /// reply. A refusal is an error (see [`Frame::into_result`]); a moved
    /// group is followed once to its new leader.
    pub async fn call(&self, ip: &str, household_id: &str, cmd: &Command) -> SoapResult<HubReply> {
        let first = self.call_once(ip, household_id, cmd).await?;
        let Some(moved) = first.frame.group_moved() else {
            return Self::finish(first, ip);
        };
        match moved.ip.filter(|to| to != ip) {
            Some(to) => {
                if let Some(pid) = &moved.player_id {
                    self.know(&to, pid);
                }
                log::info!(
                    "[Lan] {}: group moved from {ip} to {to}; sending there",
                    cmd.key()
                );
                let again = self.call_once(&to, household_id, cmd).await?;
                Self::finish(again, &to)
            }
            None => Self::finish(first, ip),
        }
    }

    async fn call_once(&self, ip: &str, household_id: &str, cmd: &Command) -> SoapResult<Reply> {
        let sock = self.socket(ip, household_id).await?;
        let reply = sock.call(household_id, cmd, self.call_timeout).await;
        if matches!(&reply, Err(crate::sonos::soap::SoapError::Lan { code: c, .. }) if c == code::TIMEOUT)
        {
            sock.abandon();
        }
        reply
    }

    fn finish(reply: Reply, ip: &str) -> SoapResult<HubReply> {
        let Reply {
            frame,
            sent_at,
            answered_at,
        } = reply;
        let frame = frame.into_result()?;
        Ok(HubReply {
            reply: Reply {
                frame,
                sent_at,
                answered_at,
            },
            ip: ip.to_string(),
        })
    }

    /// The household's groups, as `ip` sees them.
    pub async fn groups(&self, ip: &str, household_id: &str) -> SoapResult<Groups> {
        let r = self
            .call(
                ip,
                household_id,
                &Command::new("groups:1", "getGroups", Target::Household),
            )
            .await?;
        Groups::from_body(&r.frame().body)
    }

    /// Reads the groups from `ip` until `done` holds, or fails after
    /// `timeout`. Group writes are confirmed this way: their replies can
    /// arrive before the change, or not at all.
    pub async fn wait_for_groups(
        &self,
        ip: &str,
        household_id: &str,
        timeout: Duration,
        done: impl Fn(&Groups) -> bool,
    ) -> SoapResult<Groups> {
        let until = Instant::now() + timeout;
        loop {
            let last = self.groups(ip, household_id).await;
            if let Ok(g) = &last {
                if done(g) {
                    return last;
                }
            }
            if Instant::now() + GROUPS_POLL > until {
                return Err(match last {
                    Err(e) => e,
                    Ok(_) => transport_error(
                        code::TIMEOUT,
                        format!("{ip}: groups did not change in {} ms", timeout.as_millis()),
                    ),
                });
            }
            tokio::time::sleep(GROUPS_POLL).await;
        }
    }

    /// Closes the socket to `ip`, if one is open, and forgets its backoff.
    pub async fn forget(&self, ip: &str) {
        let slot = self.slots.lock().remove(ip);
        if let Some(slot) = slot {
            if let Some(sock) = slot.lock().await.socket.take() {
                sock.close();
            }
        }
    }
}
