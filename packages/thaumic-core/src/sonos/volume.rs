//! Volume and mute control for Sonos speakers.
//!
//! Provides both group-level (GroupRenderingControl) and per-speaker
//! (RenderingControl) volume and mute operations.

use reqwest::Client;

use crate::error::SoapResult;
use crate::sonos::services::SonosService;
use crate::sonos::soap::{soap_request, SoapError};
use crate::sonos::utils::extract_xml_text;

// ─────────────────────────────────────────────────────────────────────────────
// Group Volume Control
// ─────────────────────────────────────────────────────────────────────────────

/// Gets the current group volume from the coordinator (0-100).
///
/// This returns the combined volume for all speakers in the group.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `coordinator_ip` - IP address of the group coordinator
pub async fn get_group_volume(client: &Client, coordinator_ip: &str) -> SoapResult<u8> {
    let response = soap_request(
        client,
        coordinator_ip,
        SonosService::GroupRenderingControl,
        "GetGroupVolume",
        &[("InstanceID", "0")],
    )
    .await?;

    let volume_str =
        extract_xml_text(&response, "CurrentVolume").ok_or_else(|| SoapError::Parse)?;

    volume_str.parse().map_err(|_| SoapError::Parse)
}

/// Sets the group volume on the coordinator (0-100).
///
/// This adjusts volume proportionally across all speakers in the group.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `coordinator_ip` - IP address of the group coordinator
/// * `volume` - Desired volume level (0-100, values > 100 are clamped)
pub async fn set_group_volume(client: &Client, coordinator_ip: &str, volume: u8) -> SoapResult<()> {
    let clamped = volume.min(100);

    let clamped_str = clamped.to_string();
    soap_request(
        client,
        coordinator_ip,
        SonosService::GroupRenderingControl,
        "SetGroupVolume",
        &[("InstanceID", "0"), ("DesiredVolume", &clamped_str)],
    )
    .await?;

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Group Mute Control
// ─────────────────────────────────────────────────────────────────────────────

/// Gets the current group mute state from the coordinator.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `coordinator_ip` - IP address of the group coordinator
///
/// # Returns
/// `true` if the group is muted, `false` otherwise
pub async fn get_group_mute(client: &Client, coordinator_ip: &str) -> SoapResult<bool> {
    let response = soap_request(
        client,
        coordinator_ip,
        SonosService::GroupRenderingControl,
        "GetGroupMute",
        &[("InstanceID", "0")],
    )
    .await?;

    let mute_str = extract_xml_text(&response, "CurrentMute").ok_or_else(|| SoapError::Parse)?;

    Ok(mute_str == "1")
}

/// Sets the group mute state on the coordinator.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `coordinator_ip` - IP address of the group coordinator
/// * `mute` - `true` to mute, `false` to unmute
pub async fn set_group_mute(client: &Client, coordinator_ip: &str, mute: bool) -> SoapResult<()> {
    soap_request(
        client,
        coordinator_ip,
        SonosService::GroupRenderingControl,
        "SetGroupMute",
        &[
            ("InstanceID", "0"),
            ("DesiredMute", if mute { "1" } else { "0" }),
        ],
    )
    .await?;

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-Speaker Volume Control (for Synchronized Playback)
// ─────────────────────────────────────────────────────────────────────────────

/// Gets volume from an individual speaker (0-100).
///
/// Uses the RenderingControl service to query a single speaker's volume,
/// independent of its group membership.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `speaker_ip` - IP address of the speaker
pub async fn get_speaker_volume(client: &Client, speaker_ip: &str) -> SoapResult<u8> {
    let response = soap_request(
        client,
        speaker_ip,
        SonosService::RenderingControl,
        "GetVolume",
        &[("InstanceID", "0"), ("Channel", "Master")],
    )
    .await?;

    extract_xml_text(&response, "CurrentVolume")
        .and_then(|v| v.parse().ok())
        .ok_or(SoapError::Parse)
}

/// Sets volume on an individual speaker (0-100).
///
/// Uses the RenderingControl service to control a single speaker's volume,
/// independent of its group membership. This enables per-room volume control
/// during synchronized multi-room playback where multiple rooms are x-rincon
/// joined but should maintain independent volume levels.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `speaker_ip` - IP address of the speaker
/// * `volume` - Desired volume level (0-100, values > 100 are clamped)
pub async fn set_speaker_volume(client: &Client, speaker_ip: &str, volume: u8) -> SoapResult<()> {
    let clamped = volume.min(100);

    let clamped_str = clamped.to_string();
    soap_request(
        client,
        speaker_ip,
        SonosService::RenderingControl,
        "SetVolume",
        &[
            ("InstanceID", "0"),
            ("Channel", "Master"),
            ("DesiredVolume", &clamped_str),
        ],
    )
    .await?;

    Ok(())
}

/// Gets mute state from an individual speaker.
///
/// Uses the RenderingControl service to query a single speaker's mute state,
/// independent of its group membership.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `speaker_ip` - IP address of the speaker
pub async fn get_speaker_mute(client: &Client, speaker_ip: &str) -> SoapResult<bool> {
    let response = soap_request(
        client,
        speaker_ip,
        SonosService::RenderingControl,
        "GetMute",
        &[("InstanceID", "0"), ("Channel", "Master")],
    )
    .await?;

    extract_xml_text(&response, "CurrentMute")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .ok_or(SoapError::Parse)
}

/// Sets mute state on an individual speaker.
///
/// Uses the RenderingControl service to control a single speaker's mute state,
/// independent of its group membership. This enables per-room mute control
/// during synchronized multi-room playback.
///
/// # Arguments
/// * `client` - The HTTP client to use for the request
/// * `speaker_ip` - IP address of the speaker
/// * `mute` - `true` to mute, `false` to unmute
pub async fn set_speaker_mute(client: &Client, speaker_ip: &str, mute: bool) -> SoapResult<()> {
    soap_request(
        client,
        speaker_ip,
        SonosService::RenderingControl,
        "SetMute",
        &[
            ("InstanceID", "0"),
            ("Channel", "Master"),
            ("DesiredMute", if mute { "1" } else { "0" }),
        ],
    )
    .await?;

    Ok(())
}
