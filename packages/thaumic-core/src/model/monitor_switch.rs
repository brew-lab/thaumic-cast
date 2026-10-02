//! The speaker monitoring setting: its environment variables and the
//! parser for its switch values.

/// Environment variable that forces speaker monitoring on for this process,
/// whatever the configuration says. Kept from before monitoring was on by
/// default, for anyone whose setup already sets it. Read once at start-up
/// (see [`crate::companion_settings`]).
pub const SPEAKER_DIAGNOSTICS_ENV: &str = "THAUMIC_SPEAKER_DIAGNOSTICS";

/// Environment variable that sets speaker monitoring: `on` or `off` (also
/// `true`/`false`, `1`/`0`, `yes`/`no`). Read once at start-up (see
/// [`crate::companion_settings`]).
pub const SPEAKER_MONITOR_ENV: &str = "THAUMIC_SPEAKER_MONITOR";

/// Parses a speaker-monitor switch value, or `None` if it is not one.
pub fn parse_speaker_monitor_switch(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "on" | "true" | "1" | "yes" => Some(true),
        "off" | "false" | "0" | "no" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_speaker_monitor_switch_accepts_on_and_off() {
        for on in ["on", "ON", " true ", "1", "yes"] {
            assert_eq!(parse_speaker_monitor_switch(on), Some(true), "{on:?}");
        }
        for off in ["off", "Off", "false", "0", "no"] {
            assert_eq!(parse_speaker_monitor_switch(off), Some(false), "{off:?}");
        }
        assert_eq!(parse_speaker_monitor_switch("sometimes"), None);
    }
}
