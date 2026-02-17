//! Retry logic for transient SOAP errors.
//!
//! Provides exponential backoff for SOAP requests that fail with
//! transient faults (701, 714, 716) or timeouts.

use std::time::Duration;

use crate::error::SoapResult;

/// Retry delays for transient SOAP errors (exponential backoff).
const RETRY_DELAYS_MS: [u64; 3] = [200, 500, 1000];

/// Executes a SOAP request with retry logic for transient errors.
///
/// Retries on transient SOAP faults (701, 714, 716) and timeouts with
/// exponential backoff (200ms, 500ms, 1000ms).
///
/// # Arguments
/// * `action` - Action name for logging
/// * `operation` - Closure that performs the SOAP request
pub(crate) async fn with_retry<F, Fut>(action: &str, mut operation: F) -> SoapResult<String>
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
