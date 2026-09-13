//! The HTTP surface of one fake speaker: device description, SOAP control
//! endpoints and GENA event endpoints, dispatched on path and method.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;

use crate::sonos::services::SonosService;

use super::{xml, Failure, FakeSonosSystem, FakeSpeaker, SystemHandle};

/// Largest SOAP body accepted; DIDL metadata is well under this.
const MAX_BODY_BYTES: usize = 1 << 20;

const ALL_SERVICES: [SonosService; 4] = [
    SonosService::AVTransport,
    SonosService::GroupRenderingControl,
    SonosService::RenderingControl,
    SonosService::ZoneGroupTopology,
];

#[derive(Clone)]
struct Ctx {
    system: SystemHandle,
    speaker: Arc<FakeSpeaker>,
}

/// Builds the router serving `speaker` on behalf of `system`.
pub(super) fn router(system: SystemHandle, speaker: Arc<FakeSpeaker>) -> Router {
    Router::new()
        .fallback(any(handle))
        .with_state(Ctx { system, speaker })
}

async fn handle(State(ctx): State<Ctx>, request: Request) -> Response {
    let Some(system) = ctx.system.upgrade() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let method = request.method().clone();
    let path = request.uri().path().to_string();

    if method == Method::GET && path == "/xml/device_description.xml" {
        return xml_response(
            StatusCode::OK,
            xml::device_description(&ctx.speaker.uuid, &ctx.speaker.name, ctx.speaker.ip),
        );
    }

    if let Some(service) = service_with(|s| s.control_path() == path) {
        if method == Method::POST {
            return handle_soap(&system, &ctx.speaker, service, request).await;
        }
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }

    if let Some(service) = service_with(|s| s.event_path() == path) {
        return match method.as_str() {
            "SUBSCRIBE" => handle_subscribe(&system, &ctx.speaker, service, request.headers()),
            "UNSUBSCRIBE" => handle_unsubscribe(&system, &ctx.speaker, service, request.headers()),
            _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        };
    }

    StatusCode::NOT_FOUND.into_response()
}

fn service_with(matches: impl Fn(SonosService) -> bool) -> Option<SonosService> {
    ALL_SERVICES.into_iter().find(|service| matches(*service))
}

async fn handle_soap(
    system: &Arc<FakeSonosSystem>,
    speaker: &Arc<FakeSpeaker>,
    service: SonosService,
    request: Request,
) -> Response {
    let (parts, body) = request.into_parts();
    let action = parts
        .headers
        .get("SOAPAction")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim_matches('"'))
        .and_then(|value| value.rsplit('#').next())
        .unwrap_or("")
        .to_string();
    let bytes = match axum::body::to_bytes(body, MAX_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    let args = xml::parse_soap_args(&String::from_utf8_lossy(&bytes), &action);

    system.record(speaker, service, &action, args.clone());

    match system.failure_for(&speaker.ip_string(), &action) {
        Some(Failure::Fault(code) | Failure::FaultOnce(code)) => {
            return fault_response(code, "Injected fault")
        }
        Some(Failure::Hang) => std::future::pending::<()>().await,
        Some(Failure::Delay(delay)) => tokio::time::sleep(delay).await,
        None => {}
    }

    match speaker.apply(system, service, &action, &args).await {
        Ok(out) => xml_response(StatusCode::OK, xml::soap_response(service, &action, &out)),
        Err(401) => fault_response(401, "Invalid Action"),
        Err(code) => fault_response(code, "Invalid Args"),
    }
}

fn handle_subscribe(
    system: &Arc<FakeSonosSystem>,
    speaker: &Arc<FakeSpeaker>,
    service: SonosService,
    headers: &HeaderMap,
) -> Response {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string()
    };
    let requested_timeout = header("TIMEOUT");
    let granted = format!("Second-{}", system.gena_timeout_secs());

    if headers.contains_key("SID") {
        let sid = header("SID");
        // CALLBACK and NT are recorded when present so a test can prove a
        // renewal carried neither; hardware rejects a renewal that does.
        let mut args = vec![
            ("SID".to_string(), sid.clone()),
            ("TIMEOUT".to_string(), requested_timeout),
        ];
        let mut malformed = false;
        for name in ["CALLBACK", "NT"] {
            if headers.contains_key(name) {
                args.push((name.to_string(), header(name)));
                malformed = true;
            }
        }
        system.record(speaker, service, "RENEW", args);
        if malformed {
            return StatusCode::BAD_REQUEST.into_response();
        }
        if let Some(failure) = system.failure_for(&speaker.ip_string(), "RENEW") {
            return gena_failure(failure);
        }
        if !system.has_subscription(&sid) {
            return StatusCode::PRECONDITION_FAILED.into_response();
        }
        return gena_ok(&sid, &granted);
    }

    let callback = header("CALLBACK");
    let callback_url = callback.trim_matches(|c| c == '<' || c == '>').to_string();
    let nt = header("NT");
    system.record(
        speaker,
        service,
        "SUBSCRIBE",
        vec![
            ("CALLBACK".to_string(), callback.clone()),
            ("NT".to_string(), nt.clone()),
            ("TIMEOUT".to_string(), requested_timeout),
        ],
    );
    if let Some(failure) = system.failure_for(&speaker.ip_string(), "SUBSCRIBE") {
        return gena_failure(failure);
    }
    if nt != "upnp:event" || callback_url.is_empty() {
        return StatusCode::PRECONDITION_FAILED.into_response();
    }
    let sid = system.subscribe(speaker, service, &callback_url);
    gena_ok(&sid, &granted)
}

fn handle_unsubscribe(
    system: &Arc<FakeSonosSystem>,
    speaker: &Arc<FakeSpeaker>,
    service: SonosService,
    headers: &HeaderMap,
) -> Response {
    let sid = headers
        .get("SID")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    system.record(
        speaker,
        service,
        "UNSUBSCRIBE",
        vec![("SID".to_string(), sid.clone())],
    );
    if let Some(failure) = system.failure_for(&speaker.ip_string(), "UNSUBSCRIBE") {
        return gena_failure(failure);
    }
    if system.unsubscribe(&sid) {
        StatusCode::OK.into_response()
    } else {
        StatusCode::PRECONDITION_FAILED.into_response()
    }
}

/// GENA endpoints have no fault envelope; a fault or hang is an HTTP 500,
/// and a delay is not supported on this path.
fn gena_failure(failure: Failure) -> Response {
    match failure {
        Failure::Fault(_) | Failure::FaultOnce(_) | Failure::Hang | Failure::Delay(_) => {
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

fn gena_ok(sid: &str, timeout: &str) -> Response {
    (
        StatusCode::OK,
        [("SID", sid.to_string()), ("TIMEOUT", timeout.to_string())],
    )
        .into_response()
}

fn xml_response(status: StatusCode, body: String) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/xml; charset=\"utf-8\"")],
        Body::from(body),
    )
        .into_response()
}

fn fault_response(code: u16, description: &str) -> Response {
    xml_response(
        StatusCode::INTERNAL_SERVER_ERROR,
        xml::soap_fault(code, description),
    )
}
