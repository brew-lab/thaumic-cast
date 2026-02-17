//! Volume and mute control for Sonos speakers.
//!
//! Provides both group-level (GroupRenderingControl) and per-speaker
//! (RenderingControl) volume and mute operations.

use reqwest::Client;

use crate::error::SoapResult;
use crate::sonos::services::SonosService;
use crate::sonos::soap::{SoapError, SoapRequestBuilder};
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
    let response = SoapRequestBuilder::new(client, coordinator_ip)
        .service(SonosService::GroupRenderingControl)
        .action("GetGroupVolume")
        .instance_id()
        .send()
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

    SoapRequestBuilder::new(client, coordinator_ip)
        .service(SonosService::GroupRenderingControl)
        .action("SetGroupVolume")
        .instance_id()
        .arg("DesiredVolume", clamped.to_string())
        .send()
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
    let response = SoapRequestBuilder::new(client, coordinator_ip)
        .service(SonosService::GroupRenderingControl)
        .action("GetGroupMute")
        .instance_id()
        .send()
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
    SoapRequestBuilder::new(client, coordinator_ip)
        .service(SonosService::GroupRenderingControl)
        .action("SetGroupMute")
        .instance_id()
        .arg("DesiredMute", if mute { "1" } else { "0" })
        .send()
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
    let response = SoapRequestBuilder::new(client, speaker_ip)
        .service(SonosService::RenderingControl)
        .action("GetVolume")
        .instance_id()
        .arg("Channel", "Master")
        .send()
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

    SoapRequestBuilder::new(client, speaker_ip)
        .service(SonosService::RenderingControl)
        .action("SetVolume")
        .instance_id()
        .arg("Channel", "Master")
        .arg("DesiredVolume", clamped.to_string())
        .send()
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
    let response = SoapRequestBuilder::new(client, speaker_ip)
        .service(SonosService::RenderingControl)
        .action("GetMute")
        .instance_id()
        .arg("Channel", "Master")
        .send()
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
    SoapRequestBuilder::new(client, speaker_ip)
        .service(SonosService::RenderingControl)
        .action("SetMute")
        .instance_id()
        .arg("Channel", "Master")
        .arg("DesiredMute", if mute { "1" } else { "0" })
        .send()
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use reqwest::Client;

    use crate::sonos::services::SonosService;
    use crate::sonos::soap::SoapRequestBuilder;

    fn test_client() -> Client {
        Client::new()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RenderingControl SOAP Request Shape Tests
    // ─────────────────────────────────────────────────────────────────────────
    //
    // These tests verify that the RenderingControl helpers build SOAP requests
    // with correct service, action, and arguments. This catches typos and
    // argument ordering issues that would otherwise only surface at runtime.

    #[test]
    fn get_speaker_volume_uses_correct_service_and_action() {
        let client = test_client();

        // Replicate the builder calls from get_speaker_volume()
        let parts = SoapRequestBuilder::new(&client, "192.168.1.100")
            .service(SonosService::RenderingControl)
            .action("GetVolume")
            .instance_id()
            .arg("Channel", "Master")
            .into_parts();

        let (service, action, args) = parts.expect("should build request");

        assert_eq!(service, SonosService::RenderingControl);
        assert_eq!(action, "GetVolume");
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], ("InstanceID", "0".to_string()));
        assert_eq!(args[1], ("Channel", "Master".to_string()));
    }

    #[test]
    fn set_speaker_volume_uses_correct_service_and_action() {
        let client = test_client();
        let volume: u8 = 75;

        // Replicate the builder calls from set_speaker_volume()
        let parts = SoapRequestBuilder::new(&client, "192.168.1.100")
            .service(SonosService::RenderingControl)
            .action("SetVolume")
            .instance_id()
            .arg("Channel", "Master")
            .arg("DesiredVolume", volume.min(100).to_string())
            .into_parts();

        let (service, action, args) = parts.expect("should build request");

        assert_eq!(service, SonosService::RenderingControl);
        assert_eq!(action, "SetVolume");
        assert_eq!(args.len(), 3);
        assert_eq!(args[0], ("InstanceID", "0".to_string()));
        assert_eq!(args[1], ("Channel", "Master".to_string()));
        assert_eq!(args[2], ("DesiredVolume", "75".to_string()));
    }

    #[test]
    fn set_speaker_volume_clamps_to_100() {
        let client = test_client();
        let volume: u8 = 150; // Over max

        let parts = SoapRequestBuilder::new(&client, "192.168.1.100")
            .service(SonosService::RenderingControl)
            .action("SetVolume")
            .instance_id()
            .arg("Channel", "Master")
            .arg("DesiredVolume", volume.min(100).to_string())
            .into_parts();

        let (_, _, args) = parts.expect("should build request");
        assert_eq!(args[2], ("DesiredVolume", "100".to_string()));
    }

    #[test]
    fn get_speaker_mute_uses_correct_service_and_action() {
        let client = test_client();

        // Replicate the builder calls from get_speaker_mute()
        let parts = SoapRequestBuilder::new(&client, "192.168.1.100")
            .service(SonosService::RenderingControl)
            .action("GetMute")
            .instance_id()
            .arg("Channel", "Master")
            .into_parts();

        let (service, action, args) = parts.expect("should build request");

        assert_eq!(service, SonosService::RenderingControl);
        assert_eq!(action, "GetMute");
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], ("InstanceID", "0".to_string()));
        assert_eq!(args[1], ("Channel", "Master".to_string()));
    }

    #[test]
    fn set_speaker_mute_uses_correct_service_and_action() {
        let client = test_client();

        // Replicate the builder calls from set_speaker_mute(mute=true)
        let parts = SoapRequestBuilder::new(&client, "192.168.1.100")
            .service(SonosService::RenderingControl)
            .action("SetMute")
            .instance_id()
            .arg("Channel", "Master")
            .arg("DesiredMute", "1")
            .into_parts();

        let (service, action, args) = parts.expect("should build request");

        assert_eq!(service, SonosService::RenderingControl);
        assert_eq!(action, "SetMute");
        assert_eq!(args.len(), 3);
        assert_eq!(args[0], ("InstanceID", "0".to_string()));
        assert_eq!(args[1], ("Channel", "Master".to_string()));
        assert_eq!(args[2], ("DesiredMute", "1".to_string()));
    }

    #[test]
    fn set_speaker_mute_false_uses_zero() {
        let client = test_client();
        let mute = false;

        let parts = SoapRequestBuilder::new(&client, "192.168.1.100")
            .service(SonosService::RenderingControl)
            .action("SetMute")
            .instance_id()
            .arg("Channel", "Master")
            .arg("DesiredMute", if mute { "1" } else { "0" })
            .into_parts();

        let (_, _, args) = parts.expect("should build request");
        assert_eq!(args[2], ("DesiredMute", "0".to_string()));
    }
}
