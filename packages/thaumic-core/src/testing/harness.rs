//! Wires the crate's real services to a [`FakeSonosSystem`].
//!
//! [`TestSystem`] bootstraps the production composition root
//! (`bootstrap_services_with_speaker_port`) against a household of fake
//! speakers, serves the real HTTP router on a loopback listener so speakers
//! can fetch streams and deliver GENA NOTIFYs, seeds the topology through the
//! real `GetZoneGroupState` parser, and records every broadcast event.
//!
//! The topology monitor's background loop is *not* started: its first
//! iteration always runs SSDP discovery against the real network. Refreshes
//! are driven explicitly through [`TestSystem::refresh_topology`], which runs
//! the same quick-refresh path the monitor uses for manual refreshes.
//!
//! A household can start with UPnP switched off ([`TestSystemBuilder::route`]),
//! so the services find it on the local Control API, which the fake serves on
//! the same port; [`both_routes!`] runs a test once on each route.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Notify};
use tokio::task::JoinHandle;

use crate::api::http::create_router;
use crate::api::{AppInfo, AppState, AppType};
use crate::artwork::ArtworkConfig;
use crate::bootstrap::{bootstrap_services_with_speaker_port, BootstrappedServices};
use crate::context::NetworkContext;
use crate::events::{BroadcastEvent, SonosEvent, StreamEvent};
use crate::protocol_constants::SOAP_TIMEOUT_SECS;
use crate::services::start_volume::StartVolumeRequest;
use crate::services::stream_coordinator::{RoomsRequest, StartLevels};
use crate::services::{PlaybackResult, PlaybackSession, StreamCoordinator};
use crate::sonos::lan::fake::PlainConnector;
use crate::sonos::utils::build_sonos_stream_uri;
use crate::sonos::Route;
use crate::state::Config;
use crate::stream::{AudioCodec, AudioFormat};

use super::fake_sonos::FakeSonosSystem;

/// How long an event or a whole scenario may take before the test fails.
const WAIT_TIMEOUT: Duration = Duration::from_secs(10);

/// Runs `future`, failing the test with `what` if it takes longer than
/// [`WAIT_TIMEOUT`] doubled. Use it around whole scenarios so a hang shows up
/// as a named failure rather than a stuck test binary.
pub(crate) async fn within<F: std::future::Future>(what: &str, future: F) -> F::Output {
    match tokio::time::timeout(WAIT_TIMEOUT * 2, future).await {
        Ok(output) => output,
        Err(_) => panic!("timed out waiting for {what}"),
    }
}

/// Every [`BroadcastEvent`] the services emitted, in order.
pub(crate) struct EventLog {
    events: Mutex<Vec<BroadcastEvent>>,
    changed: Notify,
}

impl EventLog {
    fn start(mut rx: broadcast::Receiver<BroadcastEvent>) -> (Arc<Self>, JoinHandle<()>) {
        let log = Arc::new(Self {
            events: Mutex::new(Vec::new()),
            changed: Notify::new(),
        });
        let collector = Arc::clone(&log);
        let task = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        collector.events.lock().push(event);
                        collector.changed.notify_waiters();
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        (log, task)
    }

    /// Every event so far.
    pub fn all(&self) -> Vec<BroadcastEvent> {
        self.events.lock().clone()
    }

    /// Every stream event so far, in order.
    pub fn stream_events(&self) -> Vec<StreamEvent> {
        self.all()
            .into_iter()
            .filter_map(|event| match event {
                BroadcastEvent::Stream(event) => Some(event),
                _ => None,
            })
            .collect()
    }

    /// Every Sonos (GENA-derived) event so far, in order.
    pub fn sonos_events(&self) -> Vec<SonosEvent> {
        self.all()
            .into_iter()
            .filter_map(|event| match event {
                BroadcastEvent::Sonos(event) => Some(event),
                _ => None,
            })
            .collect()
    }

    /// `(stream_id, speaker_ip, reason)` of every `PlaybackStopped` so far.
    pub fn playback_stopped(
        &self,
    ) -> Vec<(String, String, Option<crate::events::SpeakerRemovalReason>)> {
        self.stream_events()
            .into_iter()
            .filter_map(|event| match event {
                StreamEvent::PlaybackStopped {
                    stream_id,
                    speaker_ip,
                    reason,
                    ..
                } => Some((stream_id, speaker_ip, reason)),
                _ => None,
            })
            .collect()
    }

    /// Waits for a stream event matching `matches` and returns it.
    pub async fn wait_for_stream(&self, matches: impl Fn(&StreamEvent) -> bool) -> StreamEvent {
        self.wait_for(|event| match event {
            BroadcastEvent::Stream(event) if matches(event) => Some(event.clone()),
            _ => None,
        })
        .await
    }

    /// Waits for a Sonos event matching `matches` and returns it.
    pub async fn wait_for_sonos(&self, matches: impl Fn(&SonosEvent) -> bool) -> SonosEvent {
        self.wait_for(|event| match event {
            BroadcastEvent::Sonos(event) if matches(event) => Some(event.clone()),
            _ => None,
        })
        .await
    }

    async fn wait_for<T>(&self, pick: impl Fn(&BroadcastEvent) -> Option<T>) -> T {
        let wait = async {
            loop {
                let changed = self.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if let Some(found) = self.events.lock().iter().find_map(&pick) {
                    return found;
                }
                changed.await;
            }
        };
        match tokio::time::timeout(WAIT_TIMEOUT, wait).await {
            Ok(found) => found,
            Err(_) => panic!(
                "no matching event within {:?}; events so far:\n{:#?}",
                WAIT_TIMEOUT,
                self.all()
            ),
        }
    }
}

/// Runs a household test once on each route: UPnP, and the local Control
/// API with UPnP switched off from the start. The body is an async fn of the
/// route, which it passes to [`TestSystemBuilder::route`].
///
/// ```ignore
/// both_routes! {
///     /// Proves: ...
///     async fn a_household_reads_back(route) {
///         let sys = TestSystem::builder().route(route).build().await;
///     }
/// }
/// ```
macro_rules! both_routes {
    ($(#[$meta:meta])* async fn $name:ident($route:ident) $body:block) => {
        $(#[$meta])*
        mod $name {
            #[allow(unused_imports)]
            use super::*;

            async fn run($route: crate::sonos::Route) $body

            #[tokio::test]
            async fn upnp() {
                run(crate::sonos::Route::Upnp).await
            }

            #[tokio::test]
            async fn lan() {
                run(crate::sonos::Route::Lan).await
            }
        }
    };
}
pub(crate) use both_routes;

/// Builder for a [`TestSystem`].
pub(crate) struct TestSystemBuilder {
    speakers: Vec<String>,
    /// Sonos groups to start in, each coordinator first.
    groups: Vec<Vec<String>>,
    /// Home theatres: a primary and the satellites bonded to it.
    home_theatres: Vec<(String, Vec<String>)>,
    codec: AudioCodec,
    gena_timeout_secs: Option<u64>,
    soap_timeout: Duration,
    /// Port the real router listens on; 0 picks a free one.
    port: u16,
    /// What the companion says it is.
    app_info: AppInfo,
    /// The route the household starts on.
    route: Route,
}

impl TestSystemBuilder {
    /// Room names of the fake speakers to start, in address order.
    pub fn speakers<I, S>(mut self, names: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.speakers = names.into_iter().map(Into::into).collect();
        self
    }

    /// Sonos groups the household starts in, each named coordinator first,
    /// as the user grouped them in the Sonos app before any cast.
    pub fn groups(mut self, groups: &[&[&str]]) -> Self {
        self.groups = groups
            .iter()
            .map(|group| group.iter().map(|name| (*name).to_string()).collect())
            .collect();
        self
    }

    /// Bonds `satellites` (speakers named in [`Self::speakers`]) to
    /// `primary` as a home theatre: one room, its satellites invisible.
    pub fn home_theatre(mut self, primary: &str, satellites: &[&str]) -> Self {
        self.home_theatres.push((
            primary.to_string(),
            satellites.iter().map(|name| (*name).to_string()).collect(),
        ));
        self
    }

    /// Codec streams are created with. AAC by default: it needs no prefill
    /// delay, so a fetch answers immediately.
    pub fn codec(mut self, codec: AudioCodec) -> Self {
        self.codec = codec;
        self
    }

    /// Subscription lifetime the fake speakers grant, in seconds.
    pub fn gena_timeout_secs(mut self, secs: u64) -> Self {
        self.gena_timeout_secs = Some(secs);
        self
    }

    /// Port the real router listens on, for a companion a browser connects
    /// to on a known port. A free one by default.
    pub fn port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }

    /// The route the household starts on: UPnP by default, or the local
    /// Control API, with UPnP switched off before anything is read.
    pub fn route(mut self, route: Route) -> Self {
        assert_ne!(route, Route::None, "a household needs a route to start on");
        self.route = route;
        self
    }

    /// What the companion reports as its version and kind.
    pub fn app_info(mut self, app_info: AppInfo) -> Self {
        self.app_info = app_info;
        self
    }

    /// How long the real SOAP client waits for a speaker to answer. The
    /// production value by default; tests that make a speaker hang shorten it
    /// so the wait costs milliseconds.
    pub fn soap_timeout(mut self, timeout: Duration) -> Self {
        self.soap_timeout = timeout;
        self
    }

    /// Starts the fakes, bootstraps the real services against them, serves
    /// the real router and seeds the topology.
    pub async fn build(self) -> TestSystem {
        let names: Vec<&str> = self.speakers.iter().map(String::as_str).collect();
        let fake = FakeSonosSystem::start(&names).await;
        if let Some(secs) = self.gena_timeout_secs {
            fake.set_gena_timeout_secs(secs);
        }
        for (primary, satellites) in &self.home_theatres {
            for satellite in satellites {
                fake.bond_satellite(primary, satellite);
            }
        }
        for group in &self.groups {
            if let Some((coordinator, members)) = group.split_first() {
                let members: Vec<&str> = members.iter().map(String::as_str).collect();
                fake.group(coordinator, &members);
            }
        }
        if self.route == Route::Lan {
            fake.set_upnp_enabled(false);
        }
        let lan = Arc::new(PlainConnector::new(fake.port()));

        let config = Config::default();
        let network = NetworkContext::explicit(0, IpAddr::V4(Ipv4Addr::LOCALHOST));
        let services = bootstrap_services_with_speaker_port(
            &config,
            network,
            tokio::runtime::Handle::current(),
            fake.port(),
            self.soap_timeout,
            Arc::clone(&lan) as _,
        )
        .expect("bootstrap services against the fake household");

        // The real router on a real listener: speakers fetch streams from it
        // and deliver NOTIFYs to it. Bound on every address so a test that
        // moves the advertised address to another loopback address keeps
        // working.
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, self.port))
            .await
            .expect("bind the test server");
        let port = listener.local_addr().expect("server address").port();
        services.network.set_port(port);

        let app_state = AppState::new(
            &services,
            Arc::new(RwLock::new(config)),
            ArtworkConfig::default(),
            self.app_info,
        );
        let router = create_router(app_state.clone());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .expect("test server");
        });

        let (events, collector) = EventLog::start(services.broadcast_tx.subscribe());
        // What the GENA manager reports itself reaches the event processor,
        // as with the monitor running.
        services.discovery_service.start_event_forwarder();

        // Seed the topology the way the monitor would, through the real
        // call and parser on the household's route, against the first speaker.
        let first = &fake.speakers()[0];
        let snapshot = services
            .sonos
            .refresh_zone_groups(&first.ip_string(), &first.uuid)
            .await
            .expect("zone groups from the fake household");
        *services.sonos_state.groups.write() = snapshot.groups;

        let system = TestSystem {
            fake,
            app_state,
            services,
            events,
            lan,
            codec: self.codec,
            tasks: vec![server, collector],
        };
        system.refresh_topology().await;
        system
    }
}

/// The real services running against a fake household.
pub(crate) struct TestSystem {
    /// The fake speakers, with their call log.
    pub fake: Arc<FakeSonosSystem>,
    /// The production services, wired by the real bootstrap.
    pub services: BootstrappedServices,
    /// The state the real router serves, for driving API handlers directly.
    pub app_state: AppState,
    /// Every broadcast event emitted since the system was built.
    pub events: Arc<EventLog>,
    /// How the services reach the fake's local Control API, with the
    /// identity each connection expected.
    pub lan: Arc<PlainConnector>,
    codec: AudioCodec,
    tasks: Vec<JoinHandle<()>>,
}

impl TestSystem {
    pub fn builder() -> TestSystemBuilder {
        TestSystemBuilder {
            speakers: vec!["Kitchen".to_string()],
            groups: Vec::new(),
            home_theatres: Vec::new(),
            codec: AudioCodec::Aac,
            gena_timeout_secs: None,
            soap_timeout: Duration::from_secs(SOAP_TIMEOUT_SECS),
            port: 0,
            app_info: AppInfo::new("0.0.0-test", AppType::Server),
            route: Route::Upnp,
        }
    }

    /// The household's route now.
    pub fn route(&self) -> Route {
        self.services.route.get()
    }

    pub fn coordinator(&self) -> &Arc<StreamCoordinator> {
        &self.services.stream_coordinator
    }

    /// Address of the fake speaker in room `name`, as the crate addresses it.
    pub fn ip(&self, name: &str) -> String {
        self.fake.speaker_named(name).ip_string()
    }

    /// UUID of the fake speaker in room `name`.
    pub fn uuid(&self, name: &str) -> String {
        self.fake.speaker_named(name).uuid.clone()
    }

    /// Artwork URL as the API handlers pass it to playback.
    pub fn artwork_url(&self) -> String {
        self.services.network.url_builder().artwork_url()
    }

    /// The stream URL handed to speakers for `stream_id`.
    pub fn stream_url(&self, stream_id: &str) -> String {
        self.services.network.stream_url(stream_id)
    }

    /// The URI a speaker is told to play for `stream_id`, in the scheme the
    /// codec dictates (what `SetAVTransportURI` carries).
    pub fn speaker_uri(&self, stream_id: &str) -> String {
        build_sonos_stream_uri(&self.stream_url(stream_id), self.codec)
    }

    /// Creates a stream with the builder's codec and default timing.
    pub fn new_stream(&self) -> String {
        self.coordinator()
            .create_stream(self.codec, AudioFormat::default(), 200, 20)
            .expect("create stream")
    }

    /// Starts `stream_id` on the named speakers, synced or independent.
    pub async fn start(&self, stream_id: &str, names: &[&str], sync: bool) -> Vec<PlaybackResult> {
        let ips: Vec<String> = names.iter().map(|name| self.ip(name)).collect();
        self.coordinator()
            .start_playback_multi(&ips, stream_id, None, &self.artwork_url(), sync)
            .await
    }

    /// Starts `stream_id` on the named speakers the way `START_PLAYBACK`
    /// does when it carries a start volume: start levels first, then playback.
    pub async fn start_with_volume(
        &self,
        stream_id: &str,
        names: &[&str],
        sync: bool,
        start_volume: &StartVolumeRequest,
    ) -> Vec<PlaybackResult> {
        let ips: Vec<String> = names.iter().map(|name| self.ip(name)).collect();
        self.coordinator()
            .apply_start_volume(self.services.sonos.as_ref(), stream_id, &ips, start_volume)
            .await;
        self.coordinator()
            .start_playback_multi(&ips, stream_id, None, &self.artwork_url(), sync)
            .await
    }

    /// Casts `stream_id` to the named rooms as one Sonos group, the way
    /// `START_PLAYBACK` does when it carries `rooms`, with each room's start
    /// level set from `start_volume` if one is given.
    pub async fn start_rooms(
        &self,
        stream_id: &str,
        names: &[&str],
        start_volume: Option<&StartVolumeRequest>,
    ) -> Vec<PlaybackResult> {
        let rooms: Vec<String> = names.iter().map(|name| self.uuid(name)).collect();
        let ips: Vec<String> = names.iter().map(|name| self.ip(name)).collect();
        let start_levels = start_volume.map(|request| StartLevels {
            volume: self.services.sonos.as_ref(),
            request,
        });
        self.coordinator()
            .start_rooms(
                RoomsRequest {
                    stream_id,
                    rooms: &rooms,
                    room_ips: &ips,
                    metadata: None,
                    artwork_url: &self.artwork_url(),
                },
                start_levels,
            )
            .await
    }

    /// The results of a cast in room names: `(name, success)` per result.
    pub fn outcome(&self, results: &[PlaybackResult]) -> Vec<(String, bool)> {
        results
            .iter()
            .map(|result| {
                (
                    self.fake.speaker_at(&result.speaker_ip).name.clone(),
                    result.success,
                )
            })
            .collect()
    }

    /// Every playback session the coordinator holds.
    pub fn sessions(&self) -> Vec<PlaybackSession> {
        self.coordinator().get_all_sessions()
    }

    /// The session for `stream_id` on the speaker in room `name`, if any.
    pub fn session(&self, stream_id: &str, name: &str) -> Option<PlaybackSession> {
        let ip = self.ip(name);
        self.sessions()
            .into_iter()
            .find(|session| session.stream_id == stream_id && session.speaker_ip == ip)
    }

    /// Runs the topology monitor's quick refresh: fetches the zone groups
    /// over SOAP and reconciles the GENA subscriptions with them, against the
    /// callback URL the network context advertises at that moment.
    pub async fn refresh_topology(&self) {
        self.try_refresh_topology()
            .await
            .expect("quick topology refresh");
    }

    /// [`Self::refresh_topology`], for a refresh that may fail.
    pub async fn try_refresh_topology(&self) -> crate::error::ThaumicResult<()> {
        self.services
            .discovery_service
            .topology_monitor()
            .quick_refresh_zone_groups()
            .await
    }
}

impl Drop for TestSystem {
    fn drop(&mut self) {
        self.services.cancel_token.cancel();
        for task in self.tasks.drain(..) {
            task.abort();
        }
    }
}
