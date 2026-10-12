//! A companion for checking the built extension in a real browser, without
//! speakers: the real router and services against the fake household, served
//! on a fixed port (49400, the extension's default).
//!
//! The fake speakers answer SOAP but send events only when a test tells them
//! to. Real speakers send one on every subscribe and on every change, so a
//! pump here does what they would: each subscription gets its first event,
//! RenderingControl sends on a volume or mute change, AVTransport on a
//! transport or URI change, GroupRenderingControl on a member's level change
//! (the group level is kept as the members' mean), and ZoneGroupTopology on a
//! regroup, after which the topology is refreshed as the monitor would.
//!
//! A control API on 127.0.0.1:49499 changes the household from outside:
//! `GET /state`, `GET /log`, and `POST` to `/volume?room=&v=`,
//! `/play_music?room=`, `/regroup?member=&coordinator=`, `/standalone?room=`,
//! `/vanish?room=`, `/slow?room=&action=&ms=`, `/refresh` and
//! `/knobs?initial_rc=0|1&initial_grc=0|1&initial_avt=0|1&zgt_delay=ms`.
//! `/slow` makes a room answer one SOAP action only after `ms` (0 undoes it),
//! as a slow speaker does: a room joining a cast stays "Joining…" that long.
//! `initial_rc=0` drops each RenderingControl subscription's first event, as
//! a speaker's first event lost to the subscribe race is; `initial_grc=0`
//! and `initial_avt=0` do the same for GroupRenderingControl and
//! AVTransport; `zgt_delay` holds the topology event back, as a slow
//! household does.
//!
//! Environment: `REALEXT_ROOMS` (comma-separated names), `REALEXT_GROUPS`
//! (`Coordinator+Member;...`), `REALEXT_PORT`, `REALEXT_CONTROL_PORT`,
//! `REALEXT_VERSION`, `REALEXT_APPTYPE=desktop` and `REALEXT_LOG` (`info`,
//! `debug`, ...: the companion's log on stderr).
//!
//! Ignored, so it never runs with the suite. `apps/extension/real-ext/run.sh`
//! starts it; by hand:
//! `cargo test -p thaumic-core --lib real_ext_companion -- --ignored --nocapture`.

use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::Router;

use super::fake_sonos::Failure;
use super::harness::TestSystem;
use crate::api::{AppInfo, AppType};
use crate::sonos::services::SonosService;

type Params = Query<HashMap<String, String>>;
type Sys = State<Arc<TestSystem>>;

/// How long the topology event is held back (`/knobs?zgt_delay=`).
static ZGT_DELAY_MS: AtomicU64 = AtomicU64::new(0);
/// Whether a RenderingControl subscription gets its first event.
static INITIAL_RC: AtomicBool = AtomicBool::new(true);
/// Whether a GroupRenderingControl subscription gets its first event.
static INITIAL_GRC: AtomicBool = AtomicBool::new(true);
/// Whether an AVTransport subscription gets its first event.
static INITIAL_AVT: AtomicBool = AtomicBool::new(true);

/// The control API's port, unless `REALEXT_CONTROL_PORT` names another.
const CONTROL_PORT: u16 = 49499;

/// What the pump compares between ticks, per speaker.
#[derive(Clone, PartialEq)]
struct Snapshot {
    transport: String,
    uri: String,
    coordinator: String,
    volume: u8,
    mute: bool,
}

/// Writes the companion's log to stderr, at the level `REALEXT_LOG` names.
struct StderrLog;

impl log::Log for StderrLog {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }

    fn log(&self, record: &log::Record<'_>) {
        if record.target().starts_with("thaumic_core") {
            eprintln!(
                "{} {:5} {}",
                crate::utils::now_millis(),
                record.level(),
                record.args()
            );
        }
    }

    fn flush(&self) {}
}

static STDERR_LOG: StderrLog = StderrLog;

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "a long-running companion for the real-extension check, started by hand"]
async fn real_ext_companion() {
    let system = start_companion(AppType::Server).await;
    serve_control(control_routes().with_state(system), "REALEXT").await;
}

/// Starts the companion on the fake household, as the environment shapes it,
/// with the pump running: the part the real-extension companion and the
/// real-desktop companion (`real_desktop`) share. `app_type` is what it
/// claims to be unless `REALEXT_APPTYPE` says otherwise.
pub(super) async fn start_companion(app_type: AppType) -> Arc<TestSystem> {
    let names: Vec<String> = env_or(
        "REALEXT_ROOMS",
        "Kitchen,Office,Living Room,Bedroom,Bathroom,Study",
    )
    .split(',')
    .map(str::to_string)
    .collect();
    let groups_env = env_or("REALEXT_GROUPS", "Bathroom+Office");
    let groups: Vec<Vec<&str>> = groups_env
        .split(';')
        .filter(|g| !g.is_empty())
        .map(|g| g.split('+').collect())
        .collect();
    let group_refs: Vec<&[&str]> = groups.iter().map(Vec::as_slice).collect();
    let port: u16 = env_or("REALEXT_PORT", "49400").parse().unwrap_or(49400);
    let version: &'static str = Box::leak(env_or("REALEXT_VERSION", "0.12.0").into_boxed_str());
    let app_type = match std::env::var("REALEXT_APPTYPE").as_deref() {
        Ok("desktop") => AppType::Desktop,
        Ok("server") => AppType::Server,
        _ => app_type,
    };

    if let Ok(level) = std::env::var("REALEXT_LOG") {
        if log::set_logger(&STDERR_LOG).is_ok() {
            log::set_max_level(level.parse().unwrap_or(log::LevelFilter::Info));
        }
    }

    let system = Arc::new(
        TestSystem::builder()
            .speakers(names)
            .groups(&group_refs)
            .port(port)
            .app_info(AppInfo::new(version, app_type))
            .build()
            .await,
    );
    // Distinct starting levels, so each room's level can be told apart.
    for (i, speaker) in system.fake.speakers().iter().enumerate() {
        speaker.set_volume(14 + u8::try_from(i).unwrap_or(0) * 9);
    }
    // The harness leaves the speaker monitor stopped; its command queue then
    // fills after a few dozen starts and stops, and a stop waiting on it holds
    // up every later command on its connection. Run it, as the app does.
    system.services.speaker_monitor.start();
    eprintln!("REALEXT companion on :{port} ({version})");

    tokio::spawn(pump(Arc::clone(&system)));
    system
}

/// The mean level and whether every member is muted, for the group led by
/// `coordinator_uuid`.
fn group_level(system: &TestSystem, coordinator_uuid: &str) -> (u8, bool) {
    let speakers = system.fake.speakers();
    let members: Vec<_> = speakers
        .iter()
        .filter(|m| m.coordinator_uuid() == coordinator_uuid)
        .collect();
    if members.is_empty() {
        return (0, false);
    }
    let sum: usize = members.iter().map(|m| usize::from(m.volume())).sum();
    let mean = u8::try_from(sum / members.len()).unwrap_or(u8::MAX);
    (mean, members.iter().all(|m| m.muted()))
}

/// Sends the events real speakers would, every 250 ms.
async fn pump(system: Arc<TestSystem>) {
    let fake = &system.fake;
    let mut seen_subs: HashSet<String> = HashSet::new();
    let mut last: HashMap<String, Snapshot> = HashMap::new();
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        for coordinator in fake.speakers() {
            let (level, _) = group_level(&system, &coordinator.uuid);
            coordinator.set_group_volume(level);
        }

        let mut transport_changed: HashSet<String> = HashSet::new();
        let mut volume_changed: HashSet<String> = HashSet::new();
        let mut regrouped = false;
        for speaker in fake.speakers() {
            let now = Snapshot {
                transport: format!("{:?}", speaker.transport_state()),
                uri: speaker.current_uri(),
                coordinator: speaker.coordinator_uuid(),
                volume: speaker.volume(),
                mute: speaker.muted(),
            };
            let ip = speaker.ip_string();
            let prev = last.get(&ip);
            if prev == Some(&now) {
                continue;
            }
            regrouped |= prev.is_some_and(|p| p.coordinator != now.coordinator);
            if prev.is_none_or(|p| p.volume != now.volume || p.mute != now.mute) {
                volume_changed.insert(ip.clone());
            }
            if prev.is_none_or(|p| p.transport != now.transport || p.uri != now.uri) {
                transport_changed.insert(ip.clone());
            }
            last.insert(ip, now);
        }

        let mut sends: HashSet<(String, SonosService)> = HashSet::new();
        // Subscriptions whose first event is due this tick.
        let mut first: HashSet<(String, SonosService)> = HashSet::new();
        for sub in fake.subscriptions() {
            if seen_subs.insert(sub.sid.clone()) {
                first.insert((sub.speaker_ip.clone(), sub.service));
                sends.insert((sub.speaker_ip, sub.service));
            }
        }
        let lost = |ip: &str, service: SonosService, changed: bool, knob: &AtomicBool| {
            first.contains(&(ip.to_string(), service)) && !changed && !knob.load(Ordering::SeqCst)
        };
        for ip in &transport_changed {
            sends.insert((ip.clone(), SonosService::AVTransport));
        }
        let level_moved = volume_changed
            .iter()
            .chain(transport_changed.iter().filter(|_| regrouped));
        for ip in level_moved {
            if volume_changed.contains(ip) {
                sends.insert((ip.clone(), SonosService::RenderingControl));
            }
            let coordinator = fake.speaker_at(ip).coordinator_uuid();
            if let Some(c) = fake.speakers().iter().find(|s| s.uuid == coordinator) {
                sends.insert((c.ip_string(), SonosService::GroupRenderingControl));
            }
        }
        if regrouped {
            for speaker in fake.speakers() {
                sends.insert((speaker.ip_string(), SonosService::ZoneGroupTopology));
            }
        }

        // A speaker's own events come at once; the topology is refreshed a
        // round trip later, and only then are a new member's subscriptions
        // dropped. So the topology event goes last, after every speaker has
        // reported its change.
        let mut sends: Vec<(String, SonosService)> = sends.into_iter().collect();
        sends.sort_by_key(|(_, service)| *service == SonosService::ZoneGroupTopology);
        let mut topology_sent = false;
        for (ip, service) in sends {
            if fake.subscription(&ip, service).is_none() {
                continue;
            }
            let speaker = fake.speaker_at(&ip);
            match service {
                SonosService::AVTransport
                    if lost(&ip, service, transport_changed.contains(&ip), &INITIAL_AVT) => {}
                SonosService::AVTransport => {
                    fake.notify_av_transport(
                        &ip,
                        speaker.transport_state(),
                        &speaker.current_uri(),
                    )
                    .await;
                }
                SonosService::RenderingControl => {
                    if !lost(&ip, service, volume_changed.contains(&ip), &INITIAL_RC) {
                        fake.notify_rendering_control(&ip, speaker.volume(), speaker.muted())
                            .await;
                    }
                }
                // A group level that moves as the speaker comes to lead a group
                // is in the first event of the subscription made for it then.
                SonosService::GroupRenderingControl if lost(&ip, service, false, &INITIAL_GRC) => {}
                SonosService::GroupRenderingControl => {
                    let (level, muted) = group_level(&system, &speaker.coordinator_uuid());
                    fake.notify_group_rendering(&ip, level, muted).await;
                }
                SonosService::ZoneGroupTopology if !topology_sent => {
                    topology_sent = true;
                    let delay = ZGT_DELAY_MS.load(Ordering::SeqCst);
                    if delay > 0 {
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    }
                    fake.notify_zone_group_topology().await;
                    // The harness runs no topology monitor to answer the
                    // event's refresh request; do what it would.
                    system.refresh_topology().await;
                }
                SonosService::ZoneGroupTopology => {}
            }
        }
    }
}

/// A query parameter, or "" when it is missing.
pub(super) fn param<'a>(q: &'a HashMap<String, String>, name: &str) -> &'a str {
    q.get(name).map_or("", String::as_str)
}

/// The control API's routes, without their state.
pub(super) fn control_routes() -> Router<Arc<TestSystem>> {
    Router::new()
        .route(
            "/state",
            get(|State(sys): Sys| async move {
                let mut out = String::new();
                for s in sys.fake.speakers() {
                    out.push_str(&format!(
                        "{}\t{}\tvol={}\tgv={}\tmute={}\t{:?}\tcoord={}\turi={}\n",
                        s.name,
                        s.ip_string(),
                        s.volume(),
                        s.group_volume(),
                        s.muted(),
                        s.transport_state(),
                        sys.fake.coordinator_name_of(&s.name),
                        s.current_uri()
                    ));
                }
                out.push_str(&format!("grouping={:?}\n", sys.fake.grouping()));
                out
            }),
        )
        .route(
            "/log",
            get(|State(sys): Sys| async move { sys.fake.format_log() }),
        )
        .route(
            "/volume",
            post(|State(sys): Sys, Query(q): Params| async move {
                let level = param(&q, "v").parse().unwrap_or(30);
                sys.fake.speaker_named(param(&q, "room")).set_volume(level);
                "ok\n"
            }),
        )
        .route(
            "/play_music",
            post(|State(sys): Sys, Query(q): Params| async move {
                sys.fake
                    .play_music(param(&q, "room"), "x-sonos-spotify:spotify%3atrack%3a1");
                "ok\n"
            }),
        )
        .route(
            "/forget",
            post(|State(sys): Sys, Query(q): Params| async move {
                // As for a room that has only ever followed another: no
                // transport state recorded for it.
                let ip = sys.ip(param(&q, "room"));
                sys.services.sonos_state.transport_states.remove(&ip);
                sys.services
                    .sonos_state
                    .transport_state_received
                    .remove(&ip);
                "ok\n"
            }),
        )
        .route(
            "/regroup",
            post(|State(sys): Sys, Query(q): Params| async move {
                sys.fake
                    .regroup_externally(param(&q, "member"), param(&q, "coordinator"));
                "ok\n"
            }),
        )
        .route(
            "/standalone",
            post(|State(sys): Sys, Query(q): Params| async move {
                sys.fake.make_standalone_externally(param(&q, "room"));
                "ok\n"
            }),
        )
        .route(
            "/vanish",
            post(|State(sys): Sys, Query(q): Params| async move {
                sys.fake.vanish(param(&q, "room"));
                sys.refresh_topology().await;
                "ok\n"
            }),
        )
        .route(
            "/slow",
            post(|State(sys): Sys, Query(q): Params| async move {
                let ms = param(&q, "ms").parse().unwrap_or(0);
                sys.fake.fail(
                    &sys.ip(param(&q, "room")),
                    param(&q, "action"),
                    Failure::Delay(Duration::from_millis(ms)),
                );
                "ok\n"
            }),
        )
        .route(
            "/refresh",
            post(|State(sys): Sys| async move {
                sys.refresh_topology().await;
                "ok\n"
            }),
        )
        .route(
            "/knobs",
            post(|Query(q): Params| async move {
                if let Some(ms) = q.get("zgt_delay").and_then(|v| v.parse().ok()) {
                    ZGT_DELAY_MS.store(ms, Ordering::SeqCst);
                }
                for (knob, flag) in [
                    ("initial_rc", &INITIAL_RC),
                    ("initial_grc", &INITIAL_GRC),
                    ("initial_avt", &INITIAL_AVT),
                ] {
                    if let Some(on) = q.get(knob) {
                        flag.store(on == "1", Ordering::SeqCst);
                    }
                }
                "ok\n"
            }),
        )
}

/// Serves `app` on the control port until the test is stopped, saying
/// "`{tag}` control on ..." once it listens (the scripts wait for it).
pub(super) async fn serve_control(app: Router, tag: &str) {
    let port: u16 = env_or("REALEXT_CONTROL_PORT", &CONTROL_PORT.to_string())
        .parse()
        .unwrap_or(CONTROL_PORT);
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .expect("bind the control port");
    eprintln!("{tag} control on 127.0.0.1:{port}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("control server");
}
