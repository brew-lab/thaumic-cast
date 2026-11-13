//! The cloud queues of casts over port 1443, served to the speakers that
//! play them (see [`crate::sonos::lan::queue`]).
//!
//! `/cq/{stream}/{gen}/v2.3/{context|itemWindow|version}` and
//! `POST …/timePlayed`. Only a speaker that may read the stream itself may
//! read its queue: the same list the stream handler admits speakers by,
//! which holds a speaker from the moment its start begins. Anyone else is
//! answered 404, as for a queue that does not exist.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::AppState;
use crate::sonos::lan::queue::QueueAnswer;

/// The route, under [`crate::sonos::lan::queue::PATH_PREFIX`].
pub(super) const ROUTE: &str = "/cq/{stream_id}/{gen}/v2.3/{endpoint}";

/// Whether `peer` is one of `speaker_ips`, either side canonicalised.
fn is_reader(peer: IpAddr, speaker_ips: &[String]) -> bool {
    let peer = peer.to_canonical();
    speaker_ips
        .iter()
        .filter_map(|ip| ip.parse::<IpAddr>().ok())
        .any(|ip| ip.to_canonical() == peer)
}

/// Answers a queue request.
pub(super) async fn handle(
    State(state): State<AppState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    method: Method,
    Path((stream_id, gen, endpoint)): Path<(String, String, String)>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let readers = state.stream_coordinator.allowed_reader_ips(&stream_id);
    if !is_reader(remote.ip(), &readers) {
        log::warn!(
            "[CloudQueue] {} asked for {endpoint} of {stream_id}/{gen} and is not one of its \
             speakers; refused",
            remote.ip()
        );
        return StatusCode::NOT_FOUND.into_response();
    }
    let answer = state
        .cloud_queues
        .answer(&stream_id, &gen, method.as_str(), &endpoint, &query);
    log::debug!(
        "[CloudQueue] {} {method} {endpoint} {query:?} of {stream_id}/{gen}: {answer:?}",
        remote.ip()
    );
    match answer {
        QueueAnswer::Json(body) => Json(body).into_response(),
        QueueAnswer::NoContent => StatusCode::NO_CONTENT.into_response(),
        QueueAnswer::NotFound => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_speaker_of_the_stream_reads_its_queue() {
        let speakers = vec!["192.168.1.10".to_string(), "not an ip".to_string()];
        assert!(is_reader("192.168.1.10".parse().unwrap(), &speakers));
        assert!(is_reader("::ffff:192.168.1.10".parse().unwrap(), &speakers));
        assert!(!is_reader("192.168.1.11".parse().unwrap(), &speakers));
        assert!(!is_reader("127.0.0.1".parse().unwrap(), &speakers));
    }
}
