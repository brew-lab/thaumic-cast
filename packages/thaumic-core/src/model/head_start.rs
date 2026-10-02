//! The PCM connect burst (the speaker head start) setting.

/// Environment variable that sets the PCM connect burst, in milliseconds
/// (`0` turns it off). Read once at start-up (see
/// [`crate::companion_settings`] and [`crate::Config::pcm_connect_burst_ms`]).
pub const PCM_CONNECT_BURST_ENV: &str = "THAUMIC_PCM_CONNECT_BURST_MS";

/// Parses a PCM connect burst in milliseconds: a whole number from `0` to
/// [`MAX_PCM_CONNECT_BURST_MS`].
///
/// [`MAX_PCM_CONNECT_BURST_MS`]: crate::protocol_constants::MAX_PCM_CONNECT_BURST_MS
pub fn parse_pcm_connect_burst_ms(value: &str) -> Result<u64, String> {
    use crate::protocol_constants::MAX_PCM_CONNECT_BURST_MS;
    let ms: u64 = value.trim().parse().map_err(|_| {
        format!("expected milliseconds (0-{MAX_PCM_CONNECT_BURST_MS}), got {value:?}")
    })?;
    if ms > MAX_PCM_CONNECT_BURST_MS {
        return Err(format!(
            "at most {MAX_PCM_CONNECT_BURST_MS} ms, got {ms} ms"
        ));
    }
    Ok(ms)
}

/// The PCM connect burst for a new connection, in milliseconds, given the
/// configured setting: `configured`, held to [`MAX_PCM_CONNECT_BURST_MS`].
/// The environment plays no part here; it was settled at start-up (see
/// [`crate::companion_settings`]).
///
/// [`MAX_PCM_CONNECT_BURST_MS`]: crate::protocol_constants::MAX_PCM_CONNECT_BURST_MS
pub fn pcm_connect_burst_ms(configured: u64) -> u64 {
    use crate::protocol_constants::MAX_PCM_CONNECT_BURST_MS;
    let ms = configured;
    if ms > MAX_PCM_CONNECT_BURST_MS {
        static WARNED: std::sync::Once = std::sync::Once::new();
        WARNED.call_once(|| {
            log::warn!(
                "[Stream] PCM connect burst of {}ms is above the {}ms maximum; using {}ms",
                ms,
                MAX_PCM_CONNECT_BURST_MS,
                MAX_PCM_CONNECT_BURST_MS
            );
        });
    }
    ms.min(MAX_PCM_CONNECT_BURST_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_burst_setting_is_parsed_and_bounded() {
        assert_eq!(parse_pcm_connect_burst_ms("0"), Ok(0));
        assert_eq!(parse_pcm_connect_burst_ms(" 750 "), Ok(750));
        assert_eq!(parse_pcm_connect_burst_ms("2000"), Ok(2000));
        assert!(parse_pcm_connect_burst_ms("2001").is_err());
        assert!(parse_pcm_connect_burst_ms("-1").is_err());
        assert!(parse_pcm_connect_burst_ms("half a second").is_err());

        assert_eq!(pcm_connect_burst_ms(500), 500);
        assert_eq!(pcm_connect_burst_ms(0), 0);
        assert_eq!(pcm_connect_burst_ms(9000), 2000, "clamped");
    }
}
