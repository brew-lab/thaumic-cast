//! Power/battery state detection using starship-battery.
//!
//! Provides system power state information to the extension via WebSocket,
//! bypassing browser Battery API restrictions.

use serde::Serialize;
use starship_battery::{Manager, State};
use tracing::{debug, warn};

/// Power state information sent to clients.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerState {
    /// Whether device is currently on AC power (plugged in).
    pub on_ac_power: bool,
    /// Battery level 0-100 (null if no battery or unknown).
    pub battery_level: Option<u8>,
    /// Whether battery is currently charging.
    pub charging: bool,
}

/// Detects the current system power state.
///
/// Returns `None` if power state cannot be determined (e.g., desktop without battery).
pub fn get_power_state() -> Option<PowerState> {
    let manager = match Manager::new() {
        Ok(m) => m,
        Err(e) => {
            warn!("Failed to create battery manager: {}", e);
            return None;
        }
    };

    let batteries: Vec<_> = match manager.batteries() {
        Ok(b) => b.filter_map(|b| b.ok()).collect(),
        Err(e) => {
            warn!("Failed to enumerate batteries: {}", e);
            return None;
        }
    };

    if batteries.is_empty() {
        // No batteries found - likely a desktop
        debug!("No batteries found, assuming desktop on AC power");
        return Some(PowerState {
            on_ac_power: true,
            battery_level: None,
            charging: false,
        });
    }

    // Use the first battery (primary)
    let battery = &batteries[0];
    let state = battery.state();
    let level = (battery
        .state_of_charge()
        .get::<starship_battery::units::ratio::percent>()) as u8;

    let charging = matches!(state, State::Charging);
    // On AC power if charging, full, or not actively discharging
    let on_ac_power = !matches!(state, State::Discharging | State::Empty);

    debug!(
        "Battery state: level={}%, state={:?}, on_ac={}",
        level, state, on_ac_power
    );

    Some(PowerState {
        on_ac_power,
        battery_level: Some(level),
        charging,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_power_state() {
        // Just verify it doesn't panic
        let state = get_power_state();
        println!("Power state: {:?}", state);
    }
}
