//! GENA HTTP client for subscription operations.
//!
//! Handles the HTTP protocol aspects of GENA subscriptions.

use reqwest::{Client, Method};

use crate::protocol_constants::GENA_SUBSCRIPTION_TIMEOUT_SECS;
use crate::sonos::utils::SONOS_PORT;

use super::gena::GenaError;

/// Convenient Result alias for GENA operations.
type GenaResult<T> = Result<T, GenaError>;
use super::services::SonosService;
use super::utils::build_sonos_url_with_port;

/// Response from a successful GENA subscription.
pub struct SubscribeResponse {
    /// The subscription ID returned by the speaker.
    pub sid: String,
    /// The timeout value in seconds for this subscription.
    pub timeout_secs: u64,
}

/// HTTP client for GENA (UPnP eventing) operations.
///
/// This struct handles only the HTTP protocol aspects.
/// State management is delegated to `GenaSubscriptionStore`.
pub struct GenaClient {
    client: Client,
    /// TCP port the speakers' event endpoints listen on.
    speaker_port: u16,
}

impl GenaClient {
    /// Creates a new GENA client that addresses speakers on the standard port.
    pub fn new(client: Client) -> Self {
        Self::with_speaker_port(client, SONOS_PORT)
    }

    /// Creates a new GENA client that addresses speakers on `speaker_port`.
    ///
    /// Real speakers listen on [`SONOS_PORT`]; this exists so a test double
    /// bound to an ephemeral port can stand in for one.
    pub fn with_speaker_port(client: Client, speaker_port: u16) -> Self {
        Self {
            client,
            speaker_port,
        }
    }

    /// Creates the HTTP method for SUBSCRIBE requests.
    fn subscribe_method() -> Method {
        // SAFETY: "SUBSCRIBE" is a valid HTTP method name
        Method::from_bytes(b"SUBSCRIBE").expect("SUBSCRIBE is a valid method")
    }

    /// Creates the HTTP method for UNSUBSCRIBE requests.
    fn unsubscribe_method() -> Method {
        // SAFETY: "UNSUBSCRIBE" is a valid HTTP method name
        Method::from_bytes(b"UNSUBSCRIBE").expect("UNSUBSCRIBE is a valid method")
    }

    /// Extracts timeout value in seconds from a GENA response.
    ///
    /// Parses the "TIMEOUT" header which has format "Second-N" where N is seconds.
    /// Returns the default timeout if header is missing or malformed.
    fn extract_timeout_secs(response: &reqwest::Response) -> u64 {
        response
            .headers()
            .get("TIMEOUT")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Second-"))
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(GENA_SUBSCRIPTION_TIMEOUT_SECS)
    }

    /// Sends a SUBSCRIBE request to create a new subscription.
    ///
    /// # Arguments
    /// * `ip` - Speaker IP address
    /// * `service` - The UPnP service to subscribe to
    /// * `callback_url` - URL where NOTIFY events should be sent
    ///
    /// # Returns
    /// The subscription ID (SID) and timeout from the speaker's response.
    pub async fn subscribe(
        &self,
        ip: &str,
        service: SonosService,
        callback_url: &str,
    ) -> GenaResult<SubscribeResponse> {
        let url = build_sonos_url_with_port(ip, self.speaker_port, service.event_path());
        let timeout_header = format!("Second-{}", GENA_SUBSCRIPTION_TIMEOUT_SECS);

        let response = self
            .client
            .request(Self::subscribe_method(), &url)
            .header("CALLBACK", format!("<{}>", callback_url))
            .header("NT", "upnp:event")
            .header("TIMEOUT", &timeout_header)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(GenaError::SubscriptionFailed(response.status().as_u16()));
        }

        let sid = response
            .headers()
            .get("SID")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .ok_or(GenaError::MissingSid)?;

        let timeout_secs = Self::extract_timeout_secs(&response);

        Ok(SubscribeResponse { sid, timeout_secs })
    }

    /// Sends a SUBSCRIBE request to renew an existing subscription.
    ///
    /// # Arguments
    /// * `ip` - Speaker IP address
    /// * `service` - The UPnP service
    /// * `sid` - Existing subscription ID to renew
    ///
    /// # Returns
    /// The new timeout value from the speaker's response.
    pub async fn renew(&self, ip: &str, service: SonosService, sid: &str) -> GenaResult<u64> {
        let url = build_sonos_url_with_port(ip, self.speaker_port, service.event_path());
        let timeout_header = format!("Second-{}", GENA_SUBSCRIPTION_TIMEOUT_SECS);

        let response = self
            .client
            .request(Self::subscribe_method(), &url)
            .header("SID", sid)
            .header("TIMEOUT", &timeout_header)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(GenaError::RenewalFailed(response.status().as_u16()));
        }

        Ok(Self::extract_timeout_secs(&response))
    }

    /// Sends an UNSUBSCRIBE request to cancel a subscription.
    ///
    /// # Arguments
    /// * `ip` - Speaker IP address
    /// * `service` - The UPnP service
    /// * `sid` - Subscription ID to cancel
    ///
    /// # Returns
    /// `true` if the unsubscribe was successful, `false` if the request failed
    /// (but the subscription should still be removed locally).
    pub async fn unsubscribe(&self, ip: &str, service: SonosService, sid: &str) -> bool {
        let url = build_sonos_url_with_port(ip, self.speaker_port, service.event_path());

        match self
            .client
            .request(Self::unsubscribe_method(), &url)
            .header("SID", sid)
            .send()
            .await
        {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }
}
