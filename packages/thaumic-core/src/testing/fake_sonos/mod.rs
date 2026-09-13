//! A fake Sonos household served over real HTTP.
//!
//! Every fake speaker is an Axum server bound to its own loopback address
//! (`127.0.0.2`, `127.0.0.3`, ...) on one port shared by the household, so
//! the crate's real SOAP client, XML parsers, GENA client and services talk
//! to it exactly as they would to hardware: only the port differs from 1400.
//! The port is reserved by holding a listener on `127.0.0.1` for as long as
//! any speaker listener is open, so households in parallel tests never
//! collide.
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
//!   coordinator's group; `BecomeCoordinatorOfStandaloneGroup` leaves it.
//!   Any other URI makes the speaker its own coordinator.
//! * `Play` on an `http://` or `x-rincon-mp3radio://` URI fetches the stream
//!   from the speaker's own address, as hardware does, holding the connection
//!   open and discarding the body until `Stop`, a new URI, or teardown. The
//!   `Play` response is withheld until that fetch has received its response
//!   headers, which is the earliest moment a real speaker could be fetching,
//!   so a test can assert on the fetch the instant `play_uri` returns.
//!   `x-rincon:` and `x-rincon-queue:` URIs never fetch.
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
//! Not modelled: satellites and bridges, group volume propagation to members,
//! transport transitions over time, and the 1400/1410 device-description
//! probe (`probe_speaker_by_ip` hard-codes those ports, so the description
//! this serves is only reachable through the port-aware client).

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::sonos::services::SonosService;
use crate::sonos::types::TransportState;

mod server;
mod xml;

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
    coordinator_uuid: String,
    volume: u8,
    mute: bool,
    group_volume: u8,
    group_mute: bool,
    /// Task draining the body of the current stream fetch, if one is open.
    fetch: Option<JoinHandle<()>>,
    fetches: Vec<FetchRecord>,
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
                coordinator_uuid: String::new(),
                volume: 25,
                mute: false,
                group_volume: 25,
                group_mute: false,
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
    async fn start_fetch(&self, system: &FakeSonosSystem, url: String) {
        self.abort_fetch();
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

        let drain = body.map(|mut response| {
            tokio::spawn(async move { while let Ok(Some(_)) = response.chunk().await {} })
        });

        let mut state = self.state.lock();
        state.fetches.push(FetchRecord {
            url,
            local_ip: IpAddr::V4(self.ip),
            status,
        });
        state.fetch = drain;
    }

    /// Applies one SOAP action to this speaker's state.
    ///
    /// Returns the response arguments, or the UPnP error code of a fault.
    async fn apply(
        &self,
        system: &FakeSonosSystem,
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
                let mut state = self.state.lock();
                state.transport = TransportState::Stopped;
                state.coordinator_uuid = match uri.strip_prefix("x-rincon:") {
                    Some(coordinator) => coordinator.to_string(),
                    None => self.uuid.clone(),
                };
                state.current_uri = uri;
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
                self.abort_fetch();
                let mut state = self.state.lock();
                state.transport = TransportState::Stopped;
                state.coordinator_uuid = self.uuid.clone();
                state.current_uri.clear();
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
                self.state.lock().volume = parse_u8("DesiredVolume")?;
                vec![]
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
    fetch_observer: Mutex<Option<FetchObserver>>,
    /// Client used to push NOTIFYs to the recorded callback URLs.
    notifier: reqwest::Client,
    /// Holds the household's port on `127.0.0.1` so no other test is handed it.
    ///
    /// Shared with every speaker's server task: an aborted task drops its
    /// listener only when the runtime next reaps it, so the reservation must
    /// outlive the listeners or another test could be handed the port in
    /// between and collide on a speaker address.
    _port_reservation: Arc<TcpListener>,
    servers: Mutex<Vec<JoinHandle<()>>>,
}

impl FakeSonosSystem {
    /// Starts one fake speaker per room name, each on its own loopback
    /// address, all on one freshly reserved port.
    pub async fn start(names: &[&str]) -> Arc<Self> {
        assert!(
            !names.is_empty() && names.len() < 200,
            "between 1 and 199 fake speakers"
        );
        let reservation = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("reserve a port on 127.0.0.1");
        let port = reservation.local_addr().expect("reserved address").port();

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
            fetch_observer: Mutex::new(None),
            notifier: reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("fake NOTIFY client"),
            _port_reservation: Arc::new(reservation),
            servers: Mutex::new(Vec::new()),
        });

        for speaker in &system.speakers {
            let address = SocketAddr::from((speaker.ip, port));
            let listener = TcpListener::bind(address).await.unwrap_or_else(|e| {
                panic!("bind fake speaker {} on {}: {}", speaker.name, address, e)
            });
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
        self.failures
            .lock()
            .get(&(speaker_ip.to_string(), action.to_string()))
            .copied()
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

        let mut groups: Vec<(Arc<FakeSpeaker>, Vec<Arc<FakeSpeaker>>)> = Vec::new();
        for speaker in &self.speakers {
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
        xml::zone_group_state(&self.zone_groups(), self.port)
    }

    // ── GENA ────────────────────────────────────────────────────────────────

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
    /// returns the HTTP status the callback answered with.
    pub async fn notify_av_transport(
        &self,
        speaker_ip: &str,
        state: TransportState,
        current_uri: &str,
    ) -> u16 {
        let sub = self.required_subscription(speaker_ip, SonosService::AVTransport);
        self.push_notify(&sub, xml::av_transport_notify(state, current_uri))
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
    }
}

/// Weak handle handed to the per-speaker servers, so the household is torn
/// down when the test drops its last strong reference.
pub(super) type SystemHandle = Weak<FakeSonosSystem>;
