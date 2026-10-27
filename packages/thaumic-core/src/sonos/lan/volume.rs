//! Volume and mute over port 1443.
//!
//! `playerVolume:1` is one room's own level, as RenderingControl is on port
//! 1400, and goes to that room's socket. `groupVolume:1` is a group's, as
//! GroupRenderingControl is: it reads as the average of the rooms and a set
//! keeps their relative levels (measured: rooms at 20 and 10 set to 24 end at
//! 28 and 20), and it goes to the coordinator's socket. Both answer and push
//! `{volume, muted, fixed}`; a subscription pushes the current level at once,
//! as a GENA subscription's first NOTIFY does, and every change after it.
//! A write that changes nothing pushes nothing.

use serde::Deserialize;
use serde_json::Value;

use super::protocol::{code, transport_error, Frame};
use crate::sonos::gena::SonosEvent;
use crate::sonos::soap::SoapError;
use crate::utils::now_millis;

/// One room's own level.
pub const PLAYER_VOLUME: &str = "playerVolume:1";

/// A group's level.
pub const GROUP_VOLUME: &str = "groupVolume:1";

/// A level, as replies and events carry it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct VolumeState {
    /// The level, 0-100.
    pub volume: u8,
    /// Whether it is muted.
    pub muted: bool,
    /// Whether the output is fixed (line level), so the level cannot be set.
    #[serde(default)]
    pub fixed: bool,
}

impl VolumeState {
    /// Reads the body of a `getVolume` reply or a volume event.
    pub fn from_body(body: &Value) -> Result<Self, SoapError> {
        let mut state = Self::deserialize(body)
            .map_err(|e| transport_error(code::BAD_REPLY, format!("volume: {e}")))?;
        state.volume = state.volume.min(100);
        Ok(state)
    }
}

/// The events GENA would have sent for a volume event from the speaker at
/// `ip`, or none when it is not the source that counts for that speaker.
///
/// As on port 1400, a speaker in a sync session (`in_sync`, kept by the
/// subscription arbiter) is followed by its own level, and any other by its
/// group's. Both arrive here, and forwarding both would let one overwrite
/// the other in the volume cache, which is keyed by IP alone.
#[must_use]
pub fn volume_events(ip: &str, frame: &Frame, in_sync: bool) -> Vec<SonosEvent> {
    let own = match frame.namespace() {
        PLAYER_VOLUME => true,
        GROUP_VOLUME => false,
        _ => return Vec::new(),
    };
    if frame.cmd_id().is_some() || own != in_sync {
        return Vec::new();
    }
    let Ok(state) = VolumeState::from_body(&frame.body) else {
        log::warn!("[Lan] {ip}: unreadable {} event", frame.namespace());
        return Vec::new();
    };
    let timestamp = now_millis();
    vec![
        SonosEvent::GroupVolume {
            speaker_ip: ip.to_string(),
            volume: state.volume,
            // RenderingControl does not report it either.
            fixed: (!own).then_some(state.fixed),
            own,
            timestamp,
        },
        SonosEvent::GroupMute {
            speaker_ip: ip.to_string(),
            muted: state.muted,
            own,
            timestamp,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sonos::lan::protocol::tests::recorded;

    const OFFICE: &str = "192.168.1.10";

    fn event(namespace: &str, volume: u8, muted: bool) -> Frame {
        let name = namespace.trim_end_matches(":1");
        Frame::parse(&format!(
            r#"[{{"namespace":"{namespace}","householdId":"Sonos_H","name":"{name}","type":"{name}"}},
                {{"_objectType":"{name}","volume":{volume},"muted":{muted},"fixed":false}}]"#
        ))
        .unwrap()
    }

    #[test]
    fn a_recorded_reply_reads_as_a_level() {
        let frame = Frame::parse(&recorded("reply_get_volume")).unwrap();
        assert_eq!(
            VolumeState::from_body(&frame.body).unwrap(),
            VolumeState {
                volume: 48,
                muted: false,
                fixed: false
            }
        );
        assert!(VolumeState::from_body(&serde_json::json!({ "volume": 1 })).is_err());
    }

    #[test]
    fn a_group_level_is_followed_unless_the_room_is_in_a_sync_session() {
        let group = event(GROUP_VOLUME, 15, true);
        match volume_events(OFFICE, &group, false).as_slice() {
            [SonosEvent::GroupVolume {
                speaker_ip,
                volume: 15,
                fixed: Some(false),
                own: false,
                ..
            }, SonosEvent::GroupMute {
                muted: true,
                own: false,
                ..
            }] => assert_eq!(speaker_ip, OFFICE),
            other => panic!("unexpected {other:?}"),
        }
        assert!(volume_events(OFFICE, &group, true).is_empty());
    }

    #[test]
    fn a_room_s_own_level_is_followed_only_in_a_sync_session() {
        let player = event(PLAYER_VOLUME, 20, false);
        assert!(volume_events(OFFICE, &player, false).is_empty());
        match volume_events(OFFICE, &player, true).as_slice() {
            [SonosEvent::GroupVolume {
                volume: 20,
                fixed: None,
                own: true,
                ..
            }, SonosEvent::GroupMute {
                muted: false,
                own: true,
                ..
            }] => {}
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn replies_and_other_namespaces_are_not_volume_events() {
        let reply = Frame::parse(&recorded("reply_get_volume")).unwrap();
        assert!(volume_events(OFFICE, &reply, true).is_empty());
        let status = Frame::parse(&recorded("event_playback_status")).unwrap();
        assert!(volume_events(OFFICE, &status, false).is_empty());
    }
}
