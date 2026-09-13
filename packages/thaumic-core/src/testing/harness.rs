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
use crate::services::{PlaybackResult, PlaybackSession, StreamCoordinator};
use crate::sonos::utils::build_sonos_stream_uri;
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

/// Builder for a [`TestSystem`].
pub(crate) struct TestSystemBuilder {
    speakers: Vec<String>,
    codec: AudioCodec,
    gena_timeout_secs: Option<u64>,
    soap_timeout: Duration,
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

        let config = Config::default();
        let network = NetworkContext::explicit(0, IpAddr::V4(Ipv4Addr::LOCALHOST));
        let services = bootstrap_services_with_speaker_port(
            &config,
            network,
            tokio::runtime::Handle::current(),
            fake.port(),
            self.soap_timeout,
        )
        .expect("bootstrap services against the fake household");

        // The real router on a real listener: speakers fetch streams from it
        // and deliver NOTIFYs to it. Bound on every address so a test that
        // moves the advertised address to another loopback address keeps
        // working.
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .await
            .expect("bind the test server");
        let port = listener.local_addr().expect("server address").port();
        services.network.set_port(port);

        let app_state = AppState::new(
            &services,
            Arc::new(RwLock::new(config)),
            ArtworkConfig::default(),
            AppInfo::new("0.0.0-test", AppType::Server),
        );
        let router = create_router(app_state);
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .expect("test server");
        });

        let (events, collector) = EventLog::start(services.broadcast_tx.subscribe());

        // Seed the topology the way the monitor would, through the real
        // SOAP call and parser, against the first speaker.
        let first_ip = fake.speakers()[0].ip_string();
        let groups = services
            .sonos
            .get_zone_groups(&first_ip)
            .await
            .expect("zone groups from the fake household");
        *services.sonos_state.groups.write() = groups;

        let system = TestSystem {
            fake,
            services,
            events,
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
    /// Every broadcast event emitted since the system was built.
    pub events: Arc<EventLog>,
    codec: AudioCodec,
    tasks: Vec<JoinHandle<()>>,
}

impl TestSystem {
    pub fn builder() -> TestSystemBuilder {
        TestSystemBuilder {
            speakers: vec!["Kitchen".to_string()],
            codec: AudioCodec::Aac,
            gena_timeout_secs: None,
            soap_timeout: Duration::from_secs(SOAP_TIMEOUT_SECS),
        }
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

    /// Runs the topology monitor's quick refresh against the current
    /// callback URL: fetches the zone groups over SOAP and reconciles the
    /// GENA subscriptions with them.
    pub async fn refresh_topology(&self) {
        let callback_url = self.services.network.gena_callback_url();
        self.services
            .discovery_service
            .topology_monitor()
            .quick_refresh_zone_groups(&callback_url)
            .await
            .expect("quick topology refresh");
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
