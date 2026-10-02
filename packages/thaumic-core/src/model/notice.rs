//! What the user is told about one speaker, as it rides the speaker health
//! event.

use serde::Serialize;

/// What a notice is about. Wire strings are part of the client protocol:
/// never rename a variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeakerNoticeKind {
    /// A stall outlasted the speaker head start and the speaker cut out.
    HeadStartRanOut,
    /// A stall nearly outlasted the speaker head start.
    HeadStartClose,
    /// A cut-out that the longest head start would not have covered either.
    HeadStartNoRemedy,
    /// The reserve itself is below the floor.
    RunningLow,
    /// The speaker's clock is draining the reserve and nothing corrects it.
    DriftUncorrected,
    /// Drift correction is running but cannot keep up with the speaker's
    /// clock.
    DriftSaturated,
}

impl SpeakerNoticeKind {
    /// The kind as a log token (its wire string).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HeadStartRanOut => "head_start_ran_out",
            Self::HeadStartClose => "head_start_close",
            Self::HeadStartNoRemedy => "head_start_no_remedy",
            Self::RunningLow => "running_low",
            Self::DriftUncorrected => "drift_uncorrected",
            Self::DriftSaturated => "drift_saturated",
        }
    }

    /// Whether the kind is about the speaker head start.
    pub fn is_head_start(self) -> bool {
        matches!(
            self,
            Self::HeadStartRanOut | Self::HeadStartClose | Self::HeadStartNoRemedy
        )
    }
}

impl std::fmt::Display for SpeakerNoticeKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why a notice's speaker is in trouble, where the kind alone does not say.
/// Wire strings are part of the client protocol: never rename a variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeakerNoticeCause {
    /// The speaker's clock runs faster than the audio arrives, net of any
    /// drift correction, and that, not a stall, drained the reserve.
    Drift,
}

impl SpeakerNoticeCause {
    /// The cause as a log token (its wire string).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Drift => "drift",
        }
    }
}

/// What the user is told about one speaker, with the figures its wording
/// needs. Clients pick the words; every value is in ms unless named
/// otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerNotice {
    /// What the notice is about.
    pub kind: SpeakerNoticeKind,
    /// The episode, counted per stream and speaker: the same while the
    /// notice is repeated, new on a new episode or an escalation. Clients
    /// dismiss by it.
    pub notice_id: u64,
    /// The audio a stall held back from the speaker (head-start kinds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stall_ms: Option<u32>,
    /// The audio the speaker had left at its lowest (head start close,
    /// ran out) or holds most of the time (running low).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_ms: Option<i32>,
    /// The speaker head start the connection was sent (PCM only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_start_ms: Option<u32>,
    /// The head start that would have covered the stall (head start close
    /// and ran out).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_head_start_ms: Option<u32>,
    /// Minutes until the speaker runs low (drift).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u32>,
    /// Whether stopping and restarting the cast refills the speaker: only
    /// when its connection got the whole configured head start, and that is
    /// not off, since a restart gives a partial one the same partial burst
    /// again and one that is off nothing.
    pub restart_helps: bool,
    /// Why the speaker is in trouble, when the core can tell and the kind
    /// does not say (running low: [`SpeakerNoticeCause::Drift`] when the
    /// clock drained it). Absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<SpeakerNoticeCause>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notice_wire_shape() {
        let notice = SpeakerNotice {
            kind: SpeakerNoticeKind::HeadStartRanOut,
            notice_id: 3,
            stall_ms: Some(521),
            left_ms: Some(-21),
            head_start_ms: Some(500),
            suggested_head_start_ms: Some(750),
            minutes: None,
            restart_helps: false,
            cause: None,
        };
        assert_eq!(
            serde_json::to_value(notice).unwrap(),
            serde_json::json!({
                "kind": "head_start_ran_out",
                "noticeId": 3,
                "stallMs": 521,
                "leftMs": -21,
                "headStartMs": 500,
                "suggestedHeadStartMs": 750,
                "restartHelps": false,
            })
        );
        let wire = |k: SpeakerNoticeKind| serde_json::to_string(&k).unwrap();
        for kind in [
            SpeakerNoticeKind::HeadStartRanOut,
            SpeakerNoticeKind::HeadStartClose,
            SpeakerNoticeKind::HeadStartNoRemedy,
            SpeakerNoticeKind::RunningLow,
            SpeakerNoticeKind::DriftUncorrected,
            SpeakerNoticeKind::DriftSaturated,
        ] {
            assert_eq!(wire(kind), format!("\"{}\"", kind.as_str()));
        }
        let low = SpeakerNotice {
            kind: SpeakerNoticeKind::RunningLow,
            notice_id: 4,
            stall_ms: None,
            left_ms: Some(149),
            head_start_ms: Some(500),
            suggested_head_start_ms: None,
            minutes: None,
            restart_helps: true,
            cause: Some(SpeakerNoticeCause::Drift),
        };
        assert_eq!(
            serde_json::to_value(low).unwrap(),
            serde_json::json!({
                "kind": "running_low",
                "noticeId": 4,
                "leftMs": 149,
                "headStartMs": 500,
                "restartHelps": true,
                "cause": "drift",
            })
        );
        assert_eq!(
            serde_json::to_string(&SpeakerNoticeCause::Drift).unwrap(),
            format!("\"{}\"", SpeakerNoticeCause::Drift.as_str())
        );
    }
}
