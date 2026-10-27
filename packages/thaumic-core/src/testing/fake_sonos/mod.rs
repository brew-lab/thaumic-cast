//! A fake Sonos household served over real HTTP.
//!
//! Every fake speaker is an Axum server bound to its own loopback address
//! (`127.0.0.2`, `127.0.0.3`, ...) on one port shared by the household, so
//! the crate's real SOAP client, XML parsers, GENA client and services talk
//! to it exactly as they would to hardware: only the port differs from 1400.
//! The port is chosen from below the kernel's ephemeral range and claimed by
//! binding `127.0.0.1` and every speaker address on it; a port that is
//! taken on any of them is skipped. Ports the kernel hands out to outbound
//! connections (a speaker's own stream fetch, sourced from `127.0.0.k`)
//! all come from the ephemeral range, so they can never coincide with a
//! household's port, and the `127.0.0.1` listener is held for as long as any
//! speaker listener is open so two households never share one.
//!
//! # Behaviour model
//!
//! Each speaker keeps a transport state, its current URI, volume and mute,
//! and the UUID of the coordinator it follows (its own when standalone). The
//! household's zone-group model is derived from those coordinator UUIDs, so
//! `GetZoneGroupState` and ZoneGroupTopology NOTIFYs always describe the
//! groups the SOAP traffic has built.
//!
//! * `SetAVTransportURI` with an `x-rincon:<uuid>` URI joins that
//!   coordinator's group and takes on its transport state at once, with no
//!   `Play` needed (hardware: in the group and PLAYING 0.2 s later). Each
//!   such join is recorded with how many speakers followed the joining one
//!   at that moment ([`FakeSonosSystem::joins`]). Any other URI makes a
//!   member its own coordinator; a coordinator keeps its group.
//! * `BecomeCoordinatorOfStandaloneGroup` leaves the group. When the speaker
//!   coordinated others, the first remaining member (in speaker order) is
//!   promoted: it keeps the group's URI and transport state, the rest follow
//!   it, and a playing track is recorded as restarted from 0:00
//!   ([`FakeSonosSystem::restarts`]), as hardware does. A promoted member
//!   does not open a fetch of a stream its old coordinator was fetching.
//! * A household can start pre-grouped ([`FakeSonosSystem::group`]), with
//!   music from another source playing ([`FakeSonosSystem::play_music`]),
//!   with home-theatre satellites bonded to a primary
//!   ([`FakeSonosSystem::bond_satellite`]: listed as an invisible
//!   `<Satellite>` of the primary, never part of any grouping), and can be
//!   regrouped from outside, as the Sonos app would
//!   ([`FakeSonosSystem::regroup_externally`],
//!   [`FakeSonosSystem::make_standalone_externally`]).
//! * `Play` on an `http://` or `x-rincon-mp3radio://` URI fetches the stream
//!   from the speaker's own address, as hardware does, holding the connection
//!   open and discarding the body until `Stop`, a new URI, or teardown. The
//!   `Play` response is withheld until that fetch has received its response
//!   headers, which is the earliest moment a real speaker could be fetching,
//!   so a test can assert on the fetch the instant `play_uri` returns.
//!   `x-rincon:` and `x-rincon-queue:` URIs never fetch.
//! * `SetNextAVTransportURI` queues one next item. When the body of the
//!   stream being played ends on its own (the server closed a segment at its
//!   declared length), the speaker moves to the queued item and fetches it
//!   the same way, staying `PLAYING`; with nothing queued it stays as it is.
//!   A `SetAVTransportURI` or leaving a group empties the queue, and the
//!   AVTransport NOTIFY reports it as `NextAVTransportURI`, empty when
//!   nothing is queued.
//! * The local Control API (port 1443 on hardware) is served on the same
//!   port: the player's description of itself and the WebSocket, answering
//!   `getGroups` from the same model (see `lan`). Its commands have their
//!   own log ([`FakeSonosSystem::lan_calls`]).
//! * Every SOAP action and GENA request is appended to one ordered call log
//!   for the household. Unknown actions answer with a SOAP fault (UPnP 401)
//!   so a test fails loudly instead of silently succeeding.
//! * A failure can be injected per (speaker, action): a SOAP fault, a delay,
//!   or a hang that never answers. It stays in force for the household's life.
//! * `SUBSCRIBE` grants a SID and a `TIMEOUT` (configurable) and records the
//!   callback URL; a renewal carries the SID alone, like hardware;
//!   `UNSUBSCRIBE` forgets it. The household can push a NOTIFY to a recorded
//!   callback for AVTransport, RenderingControl, GroupRenderingControl and
//!   ZoneGroupTopology, built from the current model.
//!
//! Not modelled: bridges, group volume propagation to members,
//! transport transitions over time (a speaker that plays a stream out never
//! reports `STOPPED` by itself, and its position does not advance), the
//! header-only fetch a Play:1 makes of a queued item the moment it is queued,
//! and the 1400/1410 device-description
//! probe (`probe_speaker_by_ip` hard-codes those ports, so the description
//! this serves is only reachable through the port-aware client).

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::sonos::services::SonosService;
use crate::sonos::types::TransportState;

mod lan;
mod lan_cast;
mod server;
mod xml;

pub(crate) use lan::{LanCall, FAKE_HOUSEHOLD_ID};
pub(crate) use lan_cast::QueueRead;

/// How long [`FakeSonosSystem::wait_for_call`] waits before failing the test.
const WAIT_FOR_CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// GENA subscription lifetime granted by default, in seconds.
const DEFAULT_GENA_TIMEOUT_SECS: u64 = 3600;

/// One SOAP action or GENA request a fake speaker received.
#[derive(Debug, Clone)]
pub(crate) struct Call {
    /// Position in the household's log, from 0.
    pub seq: usize,
    /// Address of the speaker that received it.
    pub speaker_ip: String,
    /// Room name of that speaker.
    pub speaker_name: String,
    /// Service the request targeted.
    pub service: SonosService,
    /// SOAP action name, or `SUBSCRIBE`, `RENEW` or `UNSUBSCRIBE` for GENA.
    pub action: String,
    /// SOAP arguments in wire order, or the GENA headers of interest
    /// (`CALLBACK`, `SID`, `TIMEOUT`).
    pub args: Vec<(String, String)>,
}

impl Call {
    /// Value of the argument or header `name`, if present.
    pub fn arg(&self, name: &str) -> Option<&str> {
        self.args
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// Whether this is a GENA request rather than a SOAP action.
    pub fn is_gena(&self) -> bool {
        matches!(self.action.as_str(), "SUBSCRIBE" | "RENEW" | "UNSUBSCRIBE")
    }

    /// Whether this is `action` on the speaker at `speaker_ip`.
    pub fn is(&self, speaker_ip: &str, action: &str) -> bool {
        self.speaker_ip == speaker_ip && self.action == action
    }

    /// Whether this is a `SetAVTransportURI` on `speaker_ip` whose URI
    /// starts with `prefix`.
    pub fn sets_uri_starting_with(&self, speaker_ip: &str, prefix: &str) -> bool {
        self.is(speaker_ip, "SetAVTransportURI")
            && self
                .arg("CurrentURI")
                .is_some_and(|uri| uri.starts_with(prefix))
    }
}

/// How an injected failure manifests.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Failure {
    /// Answer with a SOAP fault carrying this UPnP error code.
    Fault(u16),
    /// Like [`Failure::Fault`], but only for the next request; the one after
    /// is answered normally. For proving that a retry recovers.
    FaultOnce(u16),
    /// Never answer. The client's own timeout is the only way out.
    Hang,
    /// Answer normally, but only after this long.
    Delay(Duration),
}

/// One HTTP fetch of a stream URL a fake speaker made.
#[derive(Debug, Clone)]
pub(crate) struct FetchRecord {
    /// The URL fetched, after `x-rincon-mp3radio://` was mapped back to `http://`.
    pub url: String,
    /// The address the fetch was made from (the speaker's own).
    pub local_ip: IpAddr,
    /// HTTP status received, or 0 if the connection failed.
    pub status: u16,
}

/// One `SetAVTransportURI x-rincon:` a fake speaker received.
#[derive(Debug, Clone)]
pub(crate) struct JoinRecord {
    /// Room name of the speaker that was told to join.
    pub speaker_name: String,
    /// UUID of the coordinator it was told to join.
    pub coordinator_uuid: String,
    /// How many other speakers followed the joining speaker at that moment.
    /// Anything above 0 is a coordinator joining with its members still
    /// attached, which Sonos does not document.
    pub followers: usize,
}

/// A group whose track restarted from 0:00 because its coordinator left.
#[derive(Debug, Clone)]
pub(crate) struct Restart {
    /// Room name of the member promoted to coordinator.
    pub promoted: String,
    /// Room name of the coordinator that left.
    pub left: String,
    /// The URI that restarted.
    pub uri: String,
}

/// A GENA subscription a fake speaker currently holds.
#[derive(Debug, Clone)]
pub(crate) struct Subscription {
    pub sid: String,
    pub speaker_ip: String,
    pub service: SonosService,
    pub callback_url: String,
}

/// Called just before a fake speaker issues a stream fetch, with the speaker
/// and the URL it is about to fetch.
type FetchObserver = Box<dyn Fn(&FakeSpeaker, &str) + Send + Sync>;

/// Mutable state of one fake speaker.
struct SpeakerState {
    transport: TransportState,
    current_uri: String,
    /// The item queued with `SetNextAVTransportURI`; empty when none is.
    next_uri: String,
    coordinator_uuid: String,
    volume: u8,
    mute: bool,
    /// Whether the output is fixed (line level): `SetVolume` is refused.
    output_fixed: bool,
    group_volume: u8,
    group_mute: bool,
    /// What the local Control API plays, when a cloud queue item is loaded.
    lan: LanPlay,
    /// Task draining the body of the current stream fetch, if one is open.
    fetch: Option<JoinHandle<()>>,
    fetches: Vec<FetchRecord>,
}

/// A cloud queue item loaded over the local Control API (see `lan`).
#[derive(Debug, Clone, Default)]
pub(super) struct LanPlay {
    /// The item playing, if one is loaded.
    pub item_id: Option<String>,
    /// The item played before it.
    pub previous_item_id: Option<String>,
    /// Its declared length.
    pub duration_ms: Option<u64>,
    /// The position reported: a fixed 5 s while playing, as RelTime is,
    /// and the declared length once the item has played out.
    pub position_ms: u64,
}

/// One fake speaker: identity plus the state its SOAP surface reads and writes.
pub(crate) struct FakeSpeaker {
    /// Room name, as reported in the zone group topology.
    pub name: String,
    /// `RINCON_...` identifier.
    pub uuid: String,
    /// Loopback address this speaker is served on.
    pub ip: Ipv4Addr,
    state: Mutex<SpeakerState>,
    /// HTTP client bound to this speaker's address, so its fetches arrive
    /// from it exactly as a hardware speaker's would.
    fetcher: reqwest::Client,
}

impl FakeSpeaker {
    fn new(name: &str, ip: Ipv4Addr) -> Self {
        let tag: String = name
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .map(|c| c.to_ascii_uppercase())
            .take(12)
            .collect();
        let fetcher = reqwest::Client::builder()
            .local_address(IpAddr::V4(ip))
            .no_proxy()
            .build()
            .expect("fake speaker HTTP client");
        Self {
            name: name.to_string(),
            uuid: format!("RINCON_{tag:X<12}01400"),
            ip,
            state: Mutex::new(SpeakerState {
                transport: TransportState::Stopped,
                current_uri: String::new(),
                next_uri: String::new(),
                coordinator_uuid: String::new(),
                volume: 25,
                mute: false,
                output_fixed: false,
                group_volume: 25,
                group_mute: false,
                lan: LanPlay::default(),
                fetch: None,
                fetches: Vec::new(),
            }),
            fetcher,
        }
    }

    /// The address as the crate addresses it: a plain IP string.
    pub fn ip_string(&self) -> String {
        self.ip.to_string()
    }

    pub fn transport_state(&self) -> TransportState {
        self.state.lock().transport
    }

    pub fn current_uri(&self) -> String {
        self.state.lock().current_uri.clone()
    }

    /// The URI queued as this speaker's next item; empty when none is.
    pub fn next_uri(&self) -> String {
        self.state.lock().next_uri.clone()
    }

    /// UUID of the coordinator this speaker follows; its own when standalone.
    pub fn coordinator_uuid(&self) -> String {
        self.state.lock().coordinator_uuid.clone()
    }

    pub fn volume(&self) -> u8 {
        self.state.lock().volume
    }

    pub fn muted(&self) -> bool {
        self.state.lock().mute
    }

    /// The level GroupRenderingControl reports for this speaker's group.
    pub fn group_volume(&self) -> u8 {
        self.state.lock().group_volume
    }

    /// Sets the level GroupRenderingControl reports, as a real coordinator
    /// keeps it in step with its members.
    pub fn set_group_volume(&self, volume: u8) {
        self.state.lock().group_volume = volume;
    }

    /// Sets the speaker's own volume, as if someone turned it in the Sonos app.
    pub fn set_volume(&self, volume: u8) {
        self.state.lock().volume = volume;
    }

    /// Makes the output fixed (line level), like a Port on fixed line out.
    /// A fixed speaker reports volume 100 and refuses `SetVolume`.
    pub fn set_output_fixed(&self, fixed: bool) {
        let mut state = self.state.lock();
        state.output_fixed = fixed;
        if fixed {
            state.volume = 100;
        }
    }

    /// Every stream fetch this speaker has made, oldest first.
    pub fn fetches(&self) -> Vec<FetchRecord> {
        self.state.lock().fetches.clone()
    }

    /// Whether a stream fetch is currently open.
    pub fn is_fetching(&self) -> bool {
        self.state
            .lock()
            .fetch
            .as_ref()
            .is_some_and(|task| !task.is_finished())
    }

    fn abort_fetch(&self) {
        if let Some(task) = self.state.lock().fetch.take() {
            task.abort();
        }
    }

    /// Fetches `url` from this speaker's own address, records the outcome,
    /// and keeps the connection open (discarding the body) until aborted.
    ///
    /// A body that ends on its own hands over to the queued next item, if
    /// there is one: see [`Self::drain_and_follow_queue`].
    async fn start_fetch(self: &Arc<Self>, system: &Arc<FakeSonosSystem>, url: String) {
        self.abort_fetch();
        let response = self.fetch_once(system, url).await;
        let drain = response.map(|response| {
            tokio::spawn(Arc::clone(self).drain_and_follow_queue(Arc::downgrade(system), response))
        });
        self.state.lock().fetch = drain;
    }

    /// Issues one stream fetch and records its outcome. Returns the response
    /// when the server answered, with its body still unread.
    async fn fetch_once(&self, system: &FakeSonosSystem, url: String) -> Option<reqwest::Response> {
        system.observe_fetch(self, &url);

        let response = self.fetcher.get(&url).send().await;
        let (status, body) = match response {
            Ok(response) => (response.status().as_u16(), Some(response)),
            Err(error) => {
                log::warn!(
                    "[FakeSonos] {} could not fetch {}: {}",
                    self.name,
                    url,
                    error
                );
                (0, None)
            }
        };

        self.state.lock().fetches.push(FetchRecord {
            url,
            local_ip: IpAddr::V4(self.ip),
            status,
        });
        body
    }

    /// Discards a stream body for as long as it lasts. When it ends on its
    /// own and an item is queued, moves on to that item as hardware does at
    /// the end of a track: it becomes the current URI, the queue empties, and
    /// its stream is fetched and drained in turn.
    ///
    /// Runs as the speaker's fetch task, so `Stop` or a new URI ends it at
    /// whichever point it has reached.
    async fn drain_and_follow_queue(
        self: Arc<Self>,
        system: SystemHandle,
        mut response: reqwest::Response,
    ) {
        loop {
            loop {
                match response.chunk().await {
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    // The connection broke: not the end of the track.
                    Err(_) => return,
                }
            }

            let Some(next) = self.advance_to_queued() else {
                if let Some(system) = system.upgrade() {
                    system.lan_item_ended(&self);
                }
                return;
            };
            let Some(url) = stream_fetch_url(&next) else {
                return;
            };
            let Some(system) = system.upgrade() else {
                return;
            };
            match self.fetch_once(&system, url).await {
                Some(next_response) => response = next_response,
                None => return,
            }
        }
    }

    /// Makes the queued item the current one, if the speaker is playing and
    /// has one queued, and returns its URI.
    fn advance_to_queued(&self) -> Option<String> {
        let mut state = self.state.lock();
        if state.transport != TransportState::Playing || state.next_uri.is_empty() {
            return None;
        }
        state.current_uri = std::mem::take(&mut state.next_uri);
        Some(state.current_uri.clone())
    }

    /// Applies one SOAP action to this speaker's state.
    ///
    /// Returns the response arguments, or the UPnP error code of a fault.
    async fn apply(
        self: &Arc<Self>,
        system: &Arc<FakeSonosSystem>,
        service: SonosService,
        action: &str,
        args: &[(String, String)],
    ) -> Result<Vec<(String, String)>, u16> {
        let arg = |name: &str| {
            args.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
                .unwrap_or("")
        };
        let parse_u8 = |name: &str| arg(name).parse::<u8>().map_err(|_| 402u16);
        let parse_bool = |name: &str| match arg(name) {
            "1" | "true" => Ok(true),
            "0" | "false" => Ok(false),
            _ => Err(402u16),
        };

        let out = match (service, action) {
            (SonosService::AVTransport, "SetAVTransportURI") => {
                let uri = arg("CurrentURI").to_string();
                self.abort_fetch();
                let joining = uri.strip_prefix("x-rincon:").map(str::to_string);
                if let Some(coordinator) = &joining {
                    let refused = (self.ip_string(), coordinator.clone());
                    if system.refused_joins.lock().contains(&refused) {
                        return Err(800);
                    }
                }
                // A member that joins a group plays what the group plays.
                let transport = match &joining {
                    Some(coordinator) => {
                        system.record_join(self, coordinator);
                        system
                            .speakers
                            .iter()
                            .find(|s| &s.uuid == coordinator && s.uuid != self.uuid)
                            .map_or(TransportState::Stopped, |s| s.transport_state())
                    }
                    None => TransportState::Stopped,
                };
                let mut state = self.state.lock();
                state.transport = transport;
                state.coordinator_uuid = joining.unwrap_or_else(|| self.uuid.clone());
                state.current_uri = uri;
                state.next_uri.clear();
                vec![]
            }
            (SonosService::AVTransport, "SetNextAVTransportURI") => {
                self.state.lock().next_uri = arg("NextURI").to_string();
                vec![]
            }
            (SonosService::AVTransport, "Play") => {
                let uri = {
                    let mut state = self.state.lock();
                    state.transport = TransportState::Playing;
                    state.current_uri.clone()
                };
                if let Some(url) = stream_fetch_url(&uri) {
                    self.start_fetch(system, url).await;
                }
                vec![]
            }
            (SonosService::AVTransport, "Pause") => {
                self.state.lock().transport = TransportState::Paused;
                vec![]
            }
            (SonosService::AVTransport, "Stop") => {
                self.abort_fetch();
                self.state.lock().transport = TransportState::Stopped;
                vec![]
            }
            (SonosService::AVTransport, "BecomeCoordinatorOfStandaloneGroup") => {
                system.leave_group(self);
                vec![]
            }
            (SonosService::AVTransport, "GetPositionInfo") => {
                let uri = self.current_uri();
                pairs(&[
                    ("Track", "1"),
                    ("TrackDuration", "0:00:00"),
                    ("TrackMetaData", ""),
                    ("TrackURI", &uri),
                    ("RelTime", "0:00:05"),
                    ("AbsTime", "NOT_IMPLEMENTED"),
                    ("RelCount", "2147483647"),
                    ("AbsCount", "2147483647"),
                ])
            }
            (SonosService::AVTransport, "GetTransportInfo") => pairs(&[
                (
                    "CurrentTransportState",
                    xml::transport_state_str(self.transport_state()),
                ),
                ("CurrentTransportStatus", "OK"),
                ("CurrentSpeed", "1"),
            ]),
            (SonosService::RenderingControl, "GetVolume") => {
                pairs(&[("CurrentVolume", &self.volume().to_string())])
            }
            (SonosService::RenderingControl, "SetVolume") => {
                let volume = parse_u8("DesiredVolume")?;
                let mut state = self.state.lock();
                if state.output_fixed {
                    // A fixed output refuses a volume change.
                    return Err(501);
                }
                state.volume = volume;
                vec![]
            }
            (SonosService::RenderingControl, "GetOutputFixed") => {
                let fixed = self.state.lock().output_fixed;
                pairs(&[("CurrentFixed", if fixed { "1" } else { "0" })])
            }
            (SonosService::RenderingControl, "GetMute") => {
                pairs(&[("CurrentMute", if self.muted() { "1" } else { "0" })])
            }
            (SonosService::RenderingControl, "SetMute") => {
                self.state.lock().mute = parse_bool("DesiredMute")?;
                vec![]
            }
            (SonosService::GroupRenderingControl, "GetGroupVolume") => {
                pairs(&[("CurrentVolume", &self.state.lock().group_volume.to_string())])
            }
            (SonosService::GroupRenderingControl, "SetGroupVolume") => {
                self.state.lock().group_volume = parse_u8("DesiredVolume")?;
                vec![]
            }
            (SonosService::GroupRenderingControl, "GetGroupMute") => {
                let muted = self.state.lock().group_mute;
                pairs(&[("CurrentMute", if muted { "1" } else { "0" })])
            }
            (SonosService::GroupRenderingControl, "SetGroupMute") => {
                self.state.lock().group_mute = parse_bool("DesiredMute")?;
                vec![]
            }
            (SonosService::ZoneGroupTopology, "GetZoneGroupState") => {
                pairs(&[("ZoneGroupState", &system.zone_group_state_xml())])
            }
            _ => return Err(401),
        };
        Ok(out)
    }
}

impl Drop for FakeSpeaker {
    fn drop(&mut self) {
        self.abort_fetch();
    }
}

/// Owned copies of borrowed name/value pairs.
fn pairs(values: &[(&str, &str)]) -> Vec<(String, String)> {
    values
        .iter()
        .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
        .collect()
}

/// The URL a speaker fetches for a transport URI, if that URI is a stream.
fn stream_fetch_url(uri: &str) -> Option<String> {
    if uri.starts_with("http://") {
        Some(uri.to_string())
    } else {
        uri.strip_prefix("x-rincon-mp3radio://")
            .map(|rest| format!("http://{rest}"))
    }
}

/// A household of fake speakers sharing one call log, one port and one
/// zone-group model.
pub(crate) struct FakeSonosSystem {
    port: u16,
    speakers: Vec<Arc<FakeSpeaker>>,
    calls: Mutex<Vec<Call>>,
    calls_changed: Notify,
    failures: Mutex<HashMap<(String, String), Failure>>,
    subscriptions: Mutex<HashMap<String, Subscription>>,
    next_sid: AtomicUsize,
    notify_seq: AtomicUsize,
    gena_timeout_secs: AtomicU64,
    /// The household's Connection Security > UPnP switch; while off every
    /// control and event request is refused with a bare 403.
    upnp_enabled: AtomicBool,
    /// The household's Authentication switch; while on, every command on
    /// the local Control API is refused.
    lan_authentication: AtomicBool,
    /// Every command received on the local Control API, in order.
    lan_calls: Mutex<Vec<LanCall>>,
    /// The local Control API's sockets, subscriptions and sessions.
    lan: lan::LanState,
    /// Every cloud queue request the speakers made.
    queue_reads: Mutex<Vec<QueueRead>>,
    fetch_observer: Mutex<Option<FetchObserver>>,
    /// Satellite UUID to the UUID of the primary it is bonded to.
    satellites: Mutex<HashMap<String, String>>,
    joins: Mutex<Vec<JoinRecord>>,
    restarts: Mutex<Vec<Restart>>,
    /// `(speaker IP, coordinator UUID)` joins that are refused with a fault.
    refused_joins: Mutex<Vec<(String, String)>>,
    /// UUIDs of speakers that have dropped out of the household's topology.
    vanished: Mutex<std::collections::HashSet<String>>,
    /// Client used to push NOTIFYs to the recorded callback URLs.
    notifier: reqwest::Client,
    /// Holds the household's port on `127.0.0.1` so no other test is handed it.
    ///
    /// Shared with every speaker's server task: an aborted task drops its
    /// listener only when the runtime next reaps it, so the reservation must
    /// outlive the listeners or another household could claim the port in
    /// between and collide on a speaker address.
    _port_reservation: Arc<TcpListener>,
    servers: Mutex<Vec<JoinHandle<()>>>,
}

/// Lowest and highest port a household may use. Linux hands outbound
/// connections ports from `net.ipv4.ip_local_port_range` (32768–60999 by
/// default), so anything below that is never taken by a speaker's own stream
/// fetch, whose source address is the same `127.0.0.k` a listener needs.
const HOUSEHOLD_PORT_RANGE: std::ops::Range<u16> = 20000..30000;

/// Binds `127.0.0.1` and every speaker address on one port from
/// [`HOUSEHOLD_PORT_RANGE`], moving to the next port whenever any of them is
/// taken. Returns the `127.0.0.1` reservation, the port, and one listener per
/// speaker address in the order given.
///
/// Candidates start from a process-wide counter, so households started in
/// parallel try different ports first and a collision only costs one retry.
async fn claim_household_port(
    speaker_ips: impl Iterator<Item = Ipv4Addr> + Clone,
) -> (TcpListener, u16, Vec<TcpListener>) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let span = u64::from(HOUSEHOLD_PORT_RANGE.end - HOUSEHOLD_PORT_RANGE.start);
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
        ^ u64::from(std::process::id());
    let first = NEXT.fetch_add(97, Ordering::Relaxed).wrapping_add(seed) % span;

    for attempt in 0..span {
        let port = HOUSEHOLD_PORT_RANGE.start + ((first + attempt) % span) as u16;
        let Ok(reservation) = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await else {
            continue;
        };
        let mut listeners = Vec::new();
        for ip in speaker_ips.clone() {
            match TcpListener::bind(SocketAddr::from((ip, port))).await {
                Ok(listener) => listeners.push(listener),
                Err(_) => break,
            }
        }
        if listeners.len() == speaker_ips.clone().count() {
            return (reservation, port, listeners);
        }
        // Something else holds this port on one of the speaker addresses;
        // drop everything bound so far and try the next port.
    }
    panic!("no free port for a fake household in {HOUSEHOLD_PORT_RANGE:?}");
}

impl FakeSonosSystem {
    /// Starts one fake speaker per room name, each on its own loopback
    /// address, all on one port claimed on every address at once.
    pub async fn start(names: &[&str]) -> Arc<Self> {
        assert!(
            !names.is_empty() && names.len() < 200,
            "between 1 and 199 fake speakers"
        );
        let speakers: Vec<Arc<FakeSpeaker>> = names
            .iter()
            .enumerate()
            .map(|(index, name)| {
                Arc::new(FakeSpeaker::new(
                    name,
                    Ipv4Addr::new(127, 0, 0, 2 + index as u8),
                ))
            })
            .collect();
        for speaker in &speakers {
            speaker.state.lock().coordinator_uuid = speaker.uuid.clone();
        }

        let (reservation, port, listeners) =
            claim_household_port(speakers.iter().map(|speaker| speaker.ip)).await;

        let system = Arc::new(Self {
            port,
            speakers,
            calls: Mutex::new(Vec::new()),
            calls_changed: Notify::new(),
            failures: Mutex::new(HashMap::new()),
            subscriptions: Mutex::new(HashMap::new()),
            next_sid: AtomicUsize::new(1),
            notify_seq: AtomicUsize::new(0),
            gena_timeout_secs: AtomicU64::new(DEFAULT_GENA_TIMEOUT_SECS),
            upnp_enabled: AtomicBool::new(true),
            lan_authentication: AtomicBool::new(false),
            lan_calls: Mutex::new(Vec::new()),
            lan: lan::LanState::default(),
            queue_reads: Mutex::new(Vec::new()),
            fetch_observer: Mutex::new(None),
            satellites: Mutex::new(HashMap::new()),
            joins: Mutex::new(Vec::new()),
            restarts: Mutex::new(Vec::new()),
            refused_joins: Mutex::new(Vec::new()),
            vanished: Mutex::new(std::collections::HashSet::new()),
            notifier: reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("fake NOTIFY client"),
            _port_reservation: Arc::new(reservation),
            servers: Mutex::new(Vec::new()),
        });

        for (speaker, listener) in system.speakers.iter().zip(listeners) {
            let router = server::router(Arc::downgrade(&system), Arc::clone(speaker));
            let reservation = Arc::clone(&system._port_reservation);
            let task = tokio::spawn(async move {
                let _held_until_the_listener_closes = reservation;
                axum::serve(listener, router)
                    .await
                    .expect("fake speaker server");
            });
            system.servers.lock().push(task);
        }

        system
    }

    /// The port every speaker in this household listens on.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// All speakers, in the order they were named.
    pub fn speakers(&self) -> &[Arc<FakeSpeaker>] {
        &self.speakers
    }

    /// The speaker in room `name`.
    pub fn speaker_named(&self, name: &str) -> &Arc<FakeSpeaker> {
        self.speakers
            .iter()
            .find(|speaker| speaker.name == name)
            .unwrap_or_else(|| panic!("no fake speaker named {name}"))
    }

    /// The speaker served on `ip`.
    pub fn speaker_at(&self, ip: &str) -> &Arc<FakeSpeaker> {
        self.speakers
            .iter()
            .find(|speaker| speaker.ip_string() == ip)
            .unwrap_or_else(|| panic!("no fake speaker at {ip}"))
    }

    // ── Call log ────────────────────────────────────────────────────────────

    fn record(
        &self,
        speaker: &FakeSpeaker,
        service: SonosService,
        action: &str,
        args: Vec<(String, String)>,
    ) {
        let mut calls = self.calls.lock();
        let call = Call {
            seq: calls.len(),
            speaker_ip: speaker.ip_string(),
            speaker_name: speaker.name.clone(),
            service,
            action: action.to_string(),
            args,
        };
        log::info!(
            "[FakeSonos] #{} {} <- {} {}",
            call.seq,
            call.speaker_name,
            call.service.name(),
            call.action
        );
        calls.push(call);
        drop(calls);
        self.calls_changed.notify_waiters();
    }

    /// Every request received so far, in arrival order.
    pub fn calls(&self) -> Vec<Call> {
        self.calls.lock().clone()
    }

    /// Requests received by the speaker at `speaker_ip`, in arrival order.
    pub fn calls_for(&self, speaker_ip: &str) -> Vec<Call> {
        self.calls
            .lock()
            .iter()
            .filter(|call| call.speaker_ip == speaker_ip)
            .cloned()
            .collect()
    }

    /// Sequence number the next request will get; a cursor for
    /// [`Self::calls_since`] and [`Self::wait_for_call_after`].
    pub fn next_seq(&self) -> usize {
        self.calls.lock().len()
    }

    /// Requests received at or after `seq`.
    pub fn calls_since(&self, seq: usize) -> Vec<Call> {
        self.calls
            .lock()
            .iter()
            .filter(|call| call.seq >= seq)
            .cloned()
            .collect()
    }

    /// Waits until a request at or after `seq` matching `matches` has
    /// arrived and returns it.
    ///
    /// Panics with the whole log after [`WAIT_FOR_CALL_TIMEOUT`].
    pub async fn wait_for_call(&self, seq: usize, matches: impl Fn(&Call) -> bool) -> Call {
        let wait = async {
            loop {
                let changed = self.calls_changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                let found = self
                    .calls
                    .lock()
                    .iter()
                    .filter(|call| call.seq >= seq)
                    .find(|call| matches(call))
                    .cloned();
                if let Some(call) = found {
                    return call;
                }
                changed.await;
            }
        };
        match tokio::time::timeout(WAIT_FOR_CALL_TIMEOUT, wait).await {
            Ok(call) => call,
            Err(_) => panic!(
                "no matching request within {:?}; log so far:\n{}",
                WAIT_FOR_CALL_TIMEOUT,
                self.format_log()
            ),
        }
    }

    /// One line per request, for failure messages.
    pub fn format_log(&self) -> String {
        self.calls
            .lock()
            .iter()
            .map(|call| {
                let args: Vec<String> = call
                    .args
                    .iter()
                    .map(|(name, value)| {
                        let shown: String = value.chars().take(80).collect();
                        format!("{name}={shown}")
                    })
                    .collect();
                format!(
                    "#{} {} ({}) {} {} [{}]",
                    call.seq,
                    call.speaker_name,
                    call.speaker_ip,
                    call.service.name(),
                    call.action,
                    args.join(", ")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    // ── Failure injection ───────────────────────────────────────────────────

    /// Makes every `action` on the speaker at `speaker_ip` fail as `failure`
    /// from now on. The request is still logged first.
    pub fn fail(&self, speaker_ip: &str, action: &str, failure: Failure) {
        self.failures
            .lock()
            .insert((speaker_ip.to_string(), action.to_string()), failure);
    }

    fn failure_for(&self, speaker_ip: &str, action: &str) -> Option<Failure> {
        let key = (speaker_ip.to_string(), action.to_string());
        let mut failures = self.failures.lock();
        match failures.get(&key).copied() {
            Some(once @ Failure::FaultOnce(_)) => {
                failures.remove(&key);
                Some(once)
            }
            other => other,
        }
    }

    // ── Stream fetches ──────────────────────────────────────────────────────

    /// Installs a hook called just before any speaker issues a stream fetch.
    pub fn on_fetch(&self, observer: impl Fn(&FakeSpeaker, &str) + Send + Sync + 'static) {
        *self.fetch_observer.lock() = Some(Box::new(observer));
    }

    fn observe_fetch(&self, speaker: &FakeSpeaker, url: &str) {
        if let Some(observer) = self.fetch_observer.lock().as_ref() {
            observer(speaker, url);
        }
    }

    // ── Zone groups ─────────────────────────────────────────────────────────

    /// The household's groups as (coordinator, members) in speaker order,
    /// derived from which coordinator each speaker follows.
    ///
    /// Satellites are left out: they belong to their primary, not to a group
    /// (see [`Self::satellites_of`]).
    pub fn zone_groups(&self) -> Vec<(Arc<FakeSpeaker>, Vec<Arc<FakeSpeaker>>)> {
        let coordinator_of = |speaker: &Arc<FakeSpeaker>| -> Arc<FakeSpeaker> {
            let followed = speaker.coordinator_uuid();
            self.speakers
                .iter()
                .find(|candidate| {
                    candidate.uuid == followed && candidate.coordinator_uuid() == followed
                })
                .cloned()
                .unwrap_or_else(|| Arc::clone(speaker))
        };

        let satellites = self.satellites.lock().clone();
        let vanished = self.vanished.lock().clone();
        let mut groups: Vec<(Arc<FakeSpeaker>, Vec<Arc<FakeSpeaker>>)> = Vec::new();
        for speaker in self
            .speakers
            .iter()
            .filter(|speaker| !satellites.contains_key(&speaker.uuid))
            .filter(|speaker| !vanished.contains(&speaker.uuid))
        {
            let coordinator = coordinator_of(speaker);
            match groups
                .iter_mut()
                .find(|(existing, _)| existing.uuid == coordinator.uuid)
            {
                Some((_, members)) => members.push(Arc::clone(speaker)),
                None => groups.push((coordinator, vec![Arc::clone(speaker)])),
            }
        }
        groups
    }

    /// The `ZoneGroupState` document describing [`Self::zone_groups`].
    pub fn zone_group_state_xml(&self) -> String {
        let satellites = |primary: &FakeSpeaker| self.satellites_of(primary);
        xml::zone_group_state(&self.zone_groups(), &satellites, self.port)
    }

    /// The satellites bonded to `primary`, in speaker order.
    pub fn satellites_of(&self, primary: &FakeSpeaker) -> Vec<Arc<FakeSpeaker>> {
        let satellites = self.satellites.lock();
        self.speakers
            .iter()
            .filter(|s| satellites.get(&s.uuid) == Some(&primary.uuid))
            .cloned()
            .collect()
    }

    // ── Grouping ────────────────────────────────────────────────────────────

    /// Groups `members` under `coordinator`, as the Sonos app would, without
    /// a SOAP call or a log entry. Each member follows the coordinator and
    /// takes on its transport state.
    pub fn group(&self, coordinator: &str, members: &[&str]) {
        let coordinator = self.speaker_named(coordinator);
        let transport = coordinator.transport_state();
        for name in members {
            let member = self.speaker_named(name);
            member.abort_fetch();
            let mut state = member.state.lock();
            state.coordinator_uuid = coordinator.uuid.clone();
            state.current_uri = format!("x-rincon:{}", coordinator.uuid);
            state.next_uri.clear();
            state.transport = transport;
        }
    }

    /// Moves `member` into `coordinator`'s group from outside, as someone in
    /// the Sonos app would. A coordinator that is moved hands its own group
    /// to its first member first. Push a topology NOTIFY or refresh for the
    /// services to see it.
    pub fn regroup_externally(&self, member: &str, coordinator: &str) {
        self.leave_group(self.speaker_named(member));
        self.group(coordinator, &[member]);
    }

    /// Makes `name` standalone from outside, as someone in the Sonos app
    /// would, promoting a member if it coordinated others.
    pub fn make_standalone_externally(&self, name: &str) {
        self.leave_group(self.speaker_named(name));
    }

    /// Drops `name` out of the household's topology, as a speaker that was
    /// unplugged: it is no longer listed in any group. Its HTTP server keeps
    /// answering, so a test can still tell what it was sent.
    pub fn vanish(&self, name: &str) {
        self.leave_group(self.speaker_named(name));
        self.vanished
            .lock()
            .insert(self.speaker_named(name).uuid.clone());
    }

    /// Bonds `satellite` to `primary` as a home-theatre satellite: it is
    /// listed as an invisible `<Satellite>` of the primary and takes no part
    /// in any grouping.
    pub fn bond_satellite(&self, primary: &str, satellite: &str) {
        let primary = self.speaker_named(primary);
        let satellite = self.speaker_named(satellite);
        satellite.state.lock().coordinator_uuid = primary.uuid.clone();
        self.satellites
            .lock()
            .insert(satellite.uuid.clone(), primary.uuid.clone());
    }

    /// Plays `uri` (music from another source, not a stream) on the group
    /// `coordinator` leads: the coordinator and every member report PLAYING.
    pub fn play_music(&self, coordinator: &str, uri: &str) {
        let coordinator = self.speaker_named(coordinator);
        {
            let mut state = coordinator.state.lock();
            state.current_uri = uri.to_string();
            state.transport = TransportState::Playing;
        }
        for member in self.followers_of(coordinator) {
            member.state.lock().transport = TransportState::Playing;
        }
    }

    /// The speakers other than `speaker` that follow it, satellites left out.
    fn followers_of(&self, speaker: &FakeSpeaker) -> Vec<Arc<FakeSpeaker>> {
        let satellites = self.satellites.lock().clone();
        self.speakers
            .iter()
            .filter(|s| s.uuid != speaker.uuid && !satellites.contains_key(&s.uuid))
            .filter(|s| s.coordinator_uuid() == speaker.uuid)
            .cloned()
            .collect()
    }

    /// `BecomeCoordinatorOfStandaloneGroup` on `speaker`: it stops and stands
    /// alone. If it coordinated others, the first of them is promoted with
    /// the group's URI and transport, the rest follow it, and a playing track
    /// is recorded as restarted.
    fn leave_group(&self, speaker: &FakeSpeaker) {
        let followers = self.followers_of(speaker);
        speaker.abort_fetch();
        let (uri, transport) = {
            let mut state = speaker.state.lock();
            let was = (std::mem::take(&mut state.current_uri), state.transport);
            state.transport = TransportState::Stopped;
            state.coordinator_uuid = speaker.uuid.clone();
            state.next_uri.clear();
            was
        };
        let Some((promoted, rest)) = followers.split_first() else {
            return;
        };
        {
            let mut state = promoted.state.lock();
            state.coordinator_uuid = promoted.uuid.clone();
            state.current_uri = uri.clone();
            state.next_uri.clear();
            state.transport = transport;
        }
        for member in rest {
            let mut state = member.state.lock();
            state.coordinator_uuid = promoted.uuid.clone();
            state.current_uri = format!("x-rincon:{}", promoted.uuid);
        }
        if transport == TransportState::Playing && !uri.is_empty() {
            self.restarts.lock().push(Restart {
                promoted: promoted.name.clone(),
                left: speaker.name.clone(),
                uri,
            });
        }
    }

    fn record_join(&self, speaker: &FakeSpeaker, coordinator_uuid: &str) {
        let followers = self.followers_of(speaker).len();
        self.joins.lock().push(JoinRecord {
            speaker_name: speaker.name.clone(),
            coordinator_uuid: coordinator_uuid.to_string(),
            followers,
        });
    }

    /// Makes `speaker` refuse, with a SOAP fault, every join to
    /// `coordinator`'s group from now on. Its other URIs, and joins to any
    /// other group, are accepted.
    pub fn refuse_join(&self, speaker: &str, coordinator: &str) {
        let speaker = self.speaker_named(speaker).ip_string();
        let coordinator = self.speaker_named(coordinator).uuid.clone();
        self.refused_joins.lock().push((speaker, coordinator));
    }

    /// Every `x-rincon:` join received so far, in arrival order.
    pub fn joins(&self) -> Vec<JoinRecord> {
        self.joins.lock().clone()
    }

    /// Panics if any speaker was told to join a group while others still
    /// followed it: the regroup always makes a room standalone first.
    pub fn assert_no_grouped_coordinator_joined(&self) {
        let bad: Vec<JoinRecord> = self
            .joins()
            .into_iter()
            .filter(|join| join.followers > 0)
            .collect();
        assert!(
            bad.is_empty(),
            "x-rincon sent to a coordinator with members: {bad:?}\n{}",
            self.format_log()
        );
    }

    /// Every group whose track restarted because its coordinator left.
    pub fn restarts(&self) -> Vec<Restart> {
        self.restarts.lock().clone()
    }

    /// Who the speaker in room `name` follows, by room name; its own name
    /// when it coordinates.
    pub fn coordinator_name_of(&self, name: &str) -> String {
        let followed = self.speaker_named(name).coordinator_uuid();
        self.speakers
            .iter()
            .find(|s| s.uuid == followed)
            .map_or(followed, |s| s.name.clone())
    }

    /// The household's groups as sorted room names, each group sorted, for
    /// comparing whole groupings in tests. Satellites are left out.
    pub fn grouping(&self) -> Vec<Vec<String>> {
        let mut groups: Vec<Vec<String>> = self
            .zone_groups()
            .into_iter()
            .map(|(_, members)| {
                let mut names: Vec<String> = members.iter().map(|m| m.name.clone()).collect();
                names.sort();
                names
            })
            .collect();
        groups.sort();
        groups
    }

    // ── GENA ────────────────────────────────────────────────────────────────

    /// Flips the household's Connection Security > UPnP switch in the Sonos
    /// app. Off, every SOAP and GENA request is refused with a bare 403 as
    /// on real hardware; the device description is still served.
    pub fn set_upnp_enabled(&self, enabled: bool) {
        self.upnp_enabled.store(enabled, Ordering::SeqCst);
    }

    pub(super) fn upnp_enabled(&self) -> bool {
        self.upnp_enabled.load(Ordering::SeqCst)
    }

    // ── Local Control API ───────────────────────────────────────────────────

    /// Flips the household's Authentication switch in the Sonos app. On,
    /// every command on the local Control API is refused with
    /// `ERROR_NO_PERMISSION`.
    pub fn set_lan_authentication(&self, on: bool) {
        self.lan_authentication.store(on, Ordering::SeqCst);
    }

    pub(super) fn lan_authentication(&self) -> bool {
        self.lan_authentication.load(Ordering::SeqCst)
    }

    pub(super) fn record_lan(&self, call: LanCall) {
        self.lan_calls.lock().push(call);
    }

    /// Every command received on the local Control API so far, in order.
    pub fn lan_calls(&self) -> Vec<LanCall> {
        self.lan_calls.lock().clone()
    }

    /// Sets the room `name`'s own level, as the Sonos app would, and
    /// pushes it to the local Control API's subscribers.
    pub fn change_volume_in_app(&self, name: &str, volume: u8) {
        let speaker = self.speaker_named(name);
        speaker.set_volume(volume);
        self.push_player_volume(speaker);
    }

    /// Sets the level of the group `coordinator` leads, as the Sonos app
    /// would, and pushes it to the local Control API's subscribers.
    pub fn change_group_volume_in_app(&self, coordinator: &str, volume: u8) {
        let speaker = self.speaker_named(coordinator);
        speaker.set_group_volume(volume);
        self.push_group_volume(speaker);
    }

    /// Sets the subscription lifetime granted to SUBSCRIBE and renewals.
    pub fn set_gena_timeout_secs(&self, secs: u64) {
        self.gena_timeout_secs.store(secs, Ordering::SeqCst);
    }

    fn gena_timeout_secs(&self) -> u64 {
        self.gena_timeout_secs.load(Ordering::SeqCst)
    }

    fn subscribe(
        &self,
        speaker: &FakeSpeaker,
        service: SonosService,
        callback_url: &str,
    ) -> String {
        let sid = format!(
            "uuid:{}_sub{}",
            speaker.uuid,
            self.next_sid.fetch_add(1, Ordering::SeqCst)
        );
        self.subscriptions.lock().insert(
            sid.clone(),
            Subscription {
                sid: sid.clone(),
                speaker_ip: speaker.ip_string(),
                service,
                callback_url: callback_url.to_string(),
            },
        );
        sid
    }

    fn has_subscription(&self, sid: &str) -> bool {
        self.subscriptions.lock().contains_key(sid)
    }

    fn unsubscribe(&self, sid: &str) -> bool {
        self.subscriptions.lock().remove(sid).is_some()
    }

    /// Every subscription currently held, in no particular order.
    pub fn subscriptions(&self) -> Vec<Subscription> {
        self.subscriptions.lock().values().cloned().collect()
    }

    /// The subscription for `service` on the speaker at `speaker_ip`, if any.
    pub fn subscription(&self, speaker_ip: &str, service: SonosService) -> Option<Subscription> {
        self.subscriptions
            .lock()
            .values()
            .find(|sub| sub.speaker_ip == speaker_ip && sub.service == service)
            .cloned()
    }

    fn required_subscription(&self, speaker_ip: &str, service: SonosService) -> Subscription {
        self.subscription(speaker_ip, service).unwrap_or_else(|| {
            panic!(
                "no {} subscription on {}; held: {:?}",
                service.name(),
                speaker_ip,
                self.subscriptions()
            )
        })
    }

    /// Pushes an AVTransport NOTIFY for the speaker at `speaker_ip` and
    /// returns the HTTP status the callback answered with. The event names
    /// the item the speaker has queued as its next, empty when none is.
    pub async fn notify_av_transport(
        &self,
        speaker_ip: &str,
        state: TransportState,
        current_uri: &str,
    ) -> u16 {
        let sub = self.required_subscription(speaker_ip, SonosService::AVTransport);
        let next_uri = self.speaker_at(speaker_ip).next_uri();
        self.push_notify(
            &sub,
            xml::av_transport_notify(state, current_uri, &next_uri),
        )
        .await
    }

    /// Pushes a RenderingControl NOTIFY (per-speaker volume and mute).
    pub async fn notify_rendering_control(&self, speaker_ip: &str, volume: u8, mute: bool) -> u16 {
        let sub = self.required_subscription(speaker_ip, SonosService::RenderingControl);
        self.push_notify(&sub, xml::rendering_control_notify(volume, mute))
            .await
    }

    /// Pushes a GroupRenderingControl NOTIFY (group volume and mute).
    pub async fn notify_group_rendering(&self, speaker_ip: &str, volume: u8, mute: bool) -> u16 {
        let sub = self.required_subscription(speaker_ip, SonosService::GroupRenderingControl);
        self.push_notify(&sub, xml::group_rendering_notify(volume, mute))
            .await
    }

    /// Pushes a ZoneGroupTopology NOTIFY carrying the current zone-group model
    /// through whichever speaker holds that subscription.
    pub async fn notify_zone_group_topology(&self) -> u16 {
        let sub = self
            .subscriptions()
            .into_iter()
            .find(|sub| sub.service == SonosService::ZoneGroupTopology)
            .expect("a ZoneGroupTopology subscription");
        self.push_notify(
            &sub,
            xml::zone_group_topology_notify(&self.zone_group_state_xml()),
        )
        .await
    }

    async fn push_notify(&self, sub: &Subscription, body: String) -> u16 {
        let seq = self.notify_seq.fetch_add(1, Ordering::SeqCst);
        let method = reqwest::Method::from_bytes(b"NOTIFY").expect("NOTIFY method");
        let response = self
            .notifier
            .request(method, &sub.callback_url)
            .header("NT", "upnp:event")
            .header("NTS", "upnp:propchange")
            .header("SID", &sub.sid)
            .header("SEQ", seq.to_string())
            .header("CONTENT-TYPE", "text/xml; charset=\"utf-8\"")
            .body(body)
            .send()
            .await
            .unwrap_or_else(|e| panic!("NOTIFY to {} failed: {}", sub.callback_url, e));
        response.status().as_u16()
    }
}

impl Drop for FakeSonosSystem {
    fn drop(&mut self) {
        for server in self.servers.lock().drain(..) {
            server.abort();
        }
        // A fetch task keeps its speaker alive, so the speaker's own drop
        // cannot be what ends it.
        for speaker in &self.speakers {
            speaker.abort_fetch();
        }
    }
}

/// Weak handle handed to the per-speaker servers, so the household is torn
/// down when the test drops its last strong reference.
pub(super) type SystemHandle = Weak<FakeSonosSystem>;
