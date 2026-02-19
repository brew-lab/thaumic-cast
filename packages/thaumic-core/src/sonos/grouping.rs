//! Group coordination commands for Sonos speakers.
//!
//! Handles joining speakers to coordinators for synchronized playback
//! and unjoining them back to standalone mode.

use reqwest::Client;

use crate::error::SoapResult;
use crate::sonos::retry::with_retry;
use crate::sonos::services::SonosService;
use crate::sonos::soap::soap_request;

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

    let set_uri_args = [
        ("InstanceID", "0"),
        ("CurrentURI", group_uri.as_str()),
        ("CurrentURIMetaData", ""),
    ];
    with_retry("SetAVTransportURI", || {
        soap_request(
            client,
            ip,
            SonosService::AVTransport,
            "SetAVTransportURI",
            &set_uri_args,
        )
    })
    .await?;

    log::debug!(
        "[Sonos] SetAVTransportURI succeeded for {}, sending Play",
        ip
    );

    let play_args = [("InstanceID", "0"), ("Speed", "1")];
    with_retry("Play", || {
        soap_request(client, ip, SonosService::AVTransport, "Play", &play_args)
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

    soap_request(
        client,
        ip,
        SonosService::AVTransport,
        "BecomeCoordinatorOfStandaloneGroup",
        &[("InstanceID", "0")],
    )
    .await?;

    log::debug!("[Sonos] Leave group succeeded for {}", ip);

    Ok(())
}
