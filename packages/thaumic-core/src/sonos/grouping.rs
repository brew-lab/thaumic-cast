//! Group coordination commands for Sonos speakers.
//!
//! Handles joining speakers to coordinators for synchronized playback
//! and unjoining them back to standalone mode.

use reqwest::Client;
use std::time::Duration;

use crate::error::SoapResult;
use crate::sonos::services::SonosService;
use crate::sonos::soap::SoapRequestBuilder;

/// Retry delays for transient SOAP errors (exponential backoff).
const RETRY_DELAYS_MS: [u64; 3] = [200, 500, 1000];

/// Executes a SOAP request with retry logic for transient errors.
///
/// Retries on transient SOAP faults (701, 714, 716) and timeouts with
/// exponential backoff (200ms, 500ms, 1000ms).
async fn with_retry<F, Fut>(action: &str, mut operation: F) -> SoapResult<String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = SoapResult<String>>,
{
    let mut last_error = None;
    for (attempt, &delay_ms) in std::iter::once(&0)
        .chain(RETRY_DELAYS_MS.iter())
        .enumerate()
    {
        if attempt > 0 {
            log::info!(
                "[Sonos] Retrying {} (attempt {}/{}) after {}ms",
                action,
                attempt + 1,
                RETRY_DELAYS_MS.len() + 1,
                delay_ms
            );
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        }

        match operation().await {
            Ok(r) => return Ok(r),
            Err(e) if e.is_transient() => {
                log::warn!("[Sonos] {} transient error: {}", action, e);
                last_error = Some(e);
            }
            Err(e) => return Err(e),
        }
    }

    Err(last_error.expect("retry loop should have set last_error"))
}

/// Joins a speaker to a coordinator for synchronized playback.
///
/// This sets the speaker's AVTransport URI to point to the coordinator using
/// the x-rincon protocol, then sends a Play command to start playback. The
/// speaker becomes a "slave" that syncs its playback timing to the coordinator,
/// enabling synchronized multi-room audio.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of the speaker to join (will become a slave)
/// * `coordinator_uuid` - UUID of the coordinator speaker (RINCON_xxx format)
///
/// # Note
/// This creates a temporary group for streaming purposes and does not modify
/// the user's permanent Sonos group configuration.
pub async fn join_group(client: &Client, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
    let group_uri = format!("x-rincon:{}", coordinator_uuid);

    log::info!(
        "[Sonos] Joining {} to coordinator {} (uri: {})",
        ip,
        coordinator_uuid,
        group_uri
    );

    with_retry("SetAVTransportURI", || {
        SoapRequestBuilder::new(client, ip)
            .service(SonosService::AVTransport)
            .action("SetAVTransportURI")
            .instance_id()
            .arg("CurrentURI", &group_uri)
            .arg("CurrentURIMetaData", "")
            .send()
    })
    .await?;

    log::debug!(
        "[Sonos] SetAVTransportURI succeeded for {}, sending Play",
        ip
    );

    with_retry("Play", || {
        SoapRequestBuilder::new(client, ip)
            .service(SonosService::AVTransport)
            .action("Play")
            .instance_id()
            .arg("Speed", "1")
            .send()
    })
    .await?;

    log::debug!("[Sonos] Join group succeeded for {}", ip);

    Ok(())
}

/// Makes a speaker leave its current group and become standalone.
///
/// Uses the BecomeCoordinatorOfStandaloneGroup action to cleanly unjoin
/// the speaker from any group it's currently part of. After this call,
/// the speaker will be its own coordinator with no slaves.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `ip` - IP address of the speaker to unjoin
///
/// # Note
/// This is safe to call on speakers that are already standalone - the
/// action is idempotent.
pub async fn leave_group(client: &Client, ip: &str) -> SoapResult<()> {
    log::info!("[Sonos] Speaker {} leaving group (becoming standalone)", ip);

    SoapRequestBuilder::new(client, ip)
        .service(SonosService::AVTransport)
        .action("BecomeCoordinatorOfStandaloneGroup")
        .instance_id()
        .send()
        .await?;

    log::debug!("[Sonos] Leave group succeeded for {}", ip);

    Ok(())
}
