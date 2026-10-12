//! A companion for checking the built desktop frontend in a real browser,
//! without Tauri and without speakers: the real router and services against
//! the fake household (the real-extension companion's, pump included), with
//! the desktop's IPC served over HTTP.
//!
//! On the control port (127.0.0.1:49499), besides the real-extension
//! companion's control API:
//!
//! - `POST /ipc/{command}` takes the command's arguments as a JSON object and
//!   answers its result as JSON, or a 400 with `{ code, message }` as a
//!   failed Tauri command rejects. Each of the desktop's commands
//!   (`generate_handler!` in `apps/desktop/src-tauri/src/lib.rs`) has an arm
//!   below that calls the same services the Tauri command calls. What only
//!   the operating system or the Tauri app can do is a stub, marked "Stub"
//!   (launch at login is kept in memory, the platform is `REALAPP_PLATFORM`,
//!   showing the window and restarting the app do nothing, saved settings
//!   live in memory). `apps/desktop/real-app/run.sh` fails when a command
//!   has no arm.
//! - `GET /ipc/events` streams the frontend's events as server-sent events,
//!   each `{ event, payload }`, mapped by core's `frontend_event` as the
//!   Tauri emitter maps them.
//! - `POST /cast?rooms=Kitchen,Office&codec=pcm|aac` starts a cast to the
//!   rooms as one Sonos group, as the extension's start does, and answers
//!   its stream id. Nothing feeds it audio.
//! - `POST /health?room=&reserve=&floor=&target=` sends one speaker-health
//!   reading for the room's cast. Injected: the fake speakers have no
//!   playout clock, so the monitor never measures a reserve here.
//! - `GET /ipc/calls` lists the stubs called so far, one per line.
//!
//! Ignored, so it never runs with the suite. `apps/desktop/real-app/run.sh`
//! starts it; by hand:
//! `cargo test -p thaumic-core --lib real_desktop_companion -- --ignored --nocapture`.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, LazyLock};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::Json;
use futures::Stream;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use super::harness::TestSystem;
use super::real_ext_companion::{control_routes, param, serve_control, start_companion};
use crate::api::AppType;
use crate::events::{frontend_event, EventEmitter, NetworkEvent, SpeakerHealthState};
use crate::services::DriftMode;
use crate::stream::{AudioCodec, AudioFormat};
use crate::utils::now_millis;

type Sys = State<Arc<TestSystem>>;
type Params = Query<HashMap<String, String>>;
type IpcResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

/// What the stubs keep between calls.
struct Desk {
    autostart: bool,
    manual_ips: Vec<String>,
    calls: Vec<String>,
}

static DESK: LazyLock<Mutex<Desk>> = LazyLock::new(|| {
    Mutex::new(Desk {
        autostart: true,
        manual_ips: Vec::new(),
        calls: Vec::new(),
    })
});

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "a long-running companion for the real-desktop check, started by hand"]
async fn real_desktop_companion() {
    let system = start_companion(AppType::Desktop).await;
    let app = control_routes()
        .route("/ipc/events", get(events))
        .route("/ipc/calls", get(|| async { DESK.lock().calls.join("\n") }))
        .route("/ipc/{command}", post(ipc))
        .route("/cast", post(cast))
        .route("/health", post(health))
        .with_state(system);
    serve_control(app, "REALAPP").await;
}

/// A failed command, as `CommandError` serializes.
fn fail(code: &str, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "code": code, "message": message.into() })),
    )
}

/// A string argument.
fn arg_str(args: &Value, name: &str) -> String {
    args.get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Records a stub call for `GET /ipc/calls`.
fn record(command: &str, args: &Value) {
    DESK.lock().calls.push(format!("{command} {args}"));
}

/// The setting shapes the Settings view reads, as `commands.rs` builds them
/// (no environment override here).
fn speaker_monitor(sys: &TestSystem) -> Value {
    json!({ "enabled": sys.app_state.config.read().speaker_monitor, "envOverride": null, "origin": "file" })
}

fn head_start(sys: &TestSystem) -> Value {
    json!({ "ms": sys.app_state.config.read().pcm_connect_burst_ms, "envOverride": null })
}

fn drift(sys: &TestSystem) -> Value {
    json!({ "mode": sys.app_state.config.read().drift_compensation, "envOverride": null })
}

/// One desktop command. The arms follow `generate_handler!` in order.
async fn ipc(State(sys): Sys, Path(command): Path<String>, body: Bytes) -> IpcResult {
    let args: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let services = &sys.services;
    let value = match command.as_str() {
        // Stub: the real command runs SSDP and mDNS discovery; the household's
        // topology names the same speakers.
        "get_speakers" => {
            let groups = services.sonos_state.groups.read().clone();
            let speakers: Vec<Value> = groups
                .iter()
                .flat_map(|g| g.members.iter())
                .map(|m| json!({ "uuid": m.uuid, "name": m.zone_name, "model": m.model, "ip": m.ip }))
                .collect();
            json!(speakers)
        }
        "get_groups" => json!(services.sonos_state.groups.read().clone()),
        "get_stats" => json!({
            "connectionCount": services.ws_manager.connection_count(),
            "subscriptionCount": services.discovery_service.gena_manager().subscription_count(),
            "streamCount": services.stream_coordinator.stream_count(),
            "localIp": services.network.get_local_ip(),
            "port": services.network.get_port(),
            "maxStreams": sys.app_state.config.read().streaming.max_concurrent_streams,
        }),
        "get_transport_states" => {
            let states: HashMap<String, String> = services
                .sonos_state
                .shown_transport_states()
                .into_iter()
                .map(|(ip, state)| (ip, state.to_string()))
                .collect();
            json!(states)
        }
        "get_playback_sessions" => json!(services.stream_coordinator.get_all_sessions()),
        "get_network_health" => {
            let health = services
                .discovery_service
                .topology_monitor()
                .get_network_health();
            json!({ "health": health.health, "reason": health.reason })
        }
        // Stub: the operating system the app was built for.
        "get_platform" => json!(std::env::var("REALAPP_PLATFORM").unwrap_or("linux".into())),
        "start_playback" => {
            let artwork = sys.artwork_url();
            services
                .stream_coordinator
                .start_playback(
                    &arg_str(&args, "ip"),
                    &arg_str(&args, "streamId"),
                    None,
                    &artwork,
                )
                .await
                .map_err(|e| fail(e.code(), e.to_string()))?;
            Value::Null
        }
        "get_server_port" => json!(services.network.get_port()),
        // The harness started every service already.
        "start_network_services" => Value::Null,
        // The real command wakes the topology monitor, which the harness does
        // not run; do what it would, after the command has answered.
        "refresh_topology" => {
            let sys = Arc::clone(&sys);
            tokio::spawn(async move { sys.refresh_topology().await });
            Value::Null
        }
        // Stub: restarting would end this process.
        "restart_server" => {
            record(&command, &args);
            Value::Null
        }
        "clear_all_streams" => {
            let host_ip = services.network.get_local_ip().parse().ok();
            json!(services.stop_all_casts(host_ip).await)
        }
        "clear_all_connections" => json!(services.ws_manager.close_all()),
        // Stub: launch at login, in memory.
        "get_autostart_enabled" => json!(DESK.lock().autostart),
        "set_autostart_enabled" => {
            DESK.lock().autostart = args.get("enabled").and_then(Value::as_bool) == Some(true);
            Value::Null
        }
        // Stub (the saving): the settings file is the app's; the value goes
        // into the companion's config as the app applies it.
        "get_speaker_monitor" => speaker_monitor(&sys),
        "set_speaker_monitor" => {
            sys.app_state.config.write().speaker_monitor =
                args.get("enabled").and_then(Value::as_bool) == Some(true);
            speaker_monitor(&sys)
        }
        "get_pcm_connect_burst_ms" => head_start(&sys),
        "set_pcm_connect_burst_ms" => {
            sys.app_state.config.write().pcm_connect_burst_ms =
                args.get("ms").and_then(Value::as_u64).unwrap_or(0);
            head_start(&sys)
        }
        "get_drift_compensation" => drift(&sys),
        "set_drift_compensation" => {
            let mode = DriftMode::parse(&arg_str(&args, "mode"))
                .ok_or_else(|| fail("invalid_drift_compensation", "expected on, observe or off"))?;
            sys.app_state.config.write().drift_compensation = mode;
            drift(&sys)
        }
        // Stub: the real probe asks port 1400, where no fake speaker listens;
        // a fake speaker's address answers with its room, anything else is
        // unreachable.
        "probe_speaker_ip" => {
            let ip = arg_str(&args, "ip");
            let found = sys.fake.speakers().iter().find(|s| s.ip_string() == ip);
            match found {
                Some(s) => {
                    json!({ "ip": ip, "name": s.name, "uuid": s.uuid, "modelName": "Sonos One" })
                }
                None => return Err(fail("ip_unreachable", format!("{ip} did not answer"))),
            }
        }
        // Stub: the manual speakers file is the app's; kept in memory.
        "add_manual_speaker_ip" => {
            let ip = arg_str(&args, "ip");
            let mut desk = DESK.lock();
            if !desk.manual_ips.contains(&ip) {
                desk.manual_ips.push(ip);
            }
            Value::Null
        }
        "remove_manual_speaker_ip" => {
            let ip = arg_str(&args, "ip");
            DESK.lock().manual_ips.retain(|i| *i != ip);
            Value::Null
        }
        "get_manual_speaker_ips" => json!(DESK.lock().manual_ips.clone()),
        // Stub: there is no window to show.
        "show_main_window" => Value::Null,
        // Stub: WASAPI capture is Windows-only.
        "get_capture_capabilities" => json!({ "wasapiAvailable": false }),
        _ => return Err(fail("unknown_command", format!("no arm for {command}"))),
    };
    Ok(Json(value))
}

/// The frontend's events, as server-sent events.
async fn events(State(sys): Sys) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = BroadcastStream::new(sys.services.broadcast_tx.subscribe()).filter_map(|event| {
        let (name, payload) = frontend_event(&event.ok()?)?;
        let data = json!({ "event": name, "payload": payload }).to_string();
        Some(Ok(Event::default().data(data)))
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Starts a cast to `rooms` (comma-separated) as one Sonos group.
async fn cast(State(sys): Sys, Query(q): Params) -> Result<String, (StatusCode, String)> {
    let codec = match param(&q, "codec") {
        "aac" => AudioCodec::Aac,
        "flac" => AudioCodec::Flac,
        _ => AudioCodec::Pcm,
    };
    let names: Vec<&str> = param(&q, "rooms")
        .split(',')
        .filter(|n| !n.is_empty())
        .collect();
    let stream_id = sys
        .coordinator()
        .create_stream(codec, AudioFormat::default(), 200, 20)
        .map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let results = sys.start_rooms(&stream_id, &names, None).await;
    if let Some(failed) = results.iter().find(|r| !r.success) {
        return Err((StatusCode::BAD_REQUEST, format!("{failed:?}")));
    }
    Ok(format!("{stream_id}\n"))
}

/// Sends one speaker-health reading for the room's cast.
async fn health(State(sys): Sys, Query(q): Params) -> Result<&'static str, (StatusCode, String)> {
    let ip = sys.ip(param(&q, "room"));
    let session = sys
        .sessions()
        .into_iter()
        .find(|s| s.speaker_ip == ip)
        .ok_or((
            StatusCode::BAD_REQUEST,
            "that room is not casting".to_string(),
        ))?;
    let number = |name: &str| param(&q, name).parse::<i32>().ok();
    let floor = number("floor").and_then(|v| u32::try_from(v).ok());
    sys.services
        .event_bridge
        .emit_network(NetworkEvent::SpeakerHealth {
            stream_id: session.stream_id,
            speaker_ip: ip,
            epoch_id: 1,
            state: SpeakerHealthState::Ok,
            reserve_ms: number("reserve"),
            reserve_precision_ms: Some(20),
            reserve_min_ms: number("reserve"),
            reserve_p10_ms: number("reserve"),
            reserve_acked: true,
            target_ms: number("target"),
            head_start_ms: None,
            head_start_configured_ms: None,
            floor_ms: floor,
            stall_ms: None,
            clock_ppm: None,
            clock_se_ppm: None,
            time_to_floor_s: None,
            drift_mode: None,
            command_ppm: None,
            net_inserted_ms: None,
            notice: None,
            timestamp: now_millis(),
        });
    Ok("ok\n")
}
