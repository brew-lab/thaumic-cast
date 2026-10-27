//! How the household is controlled: UPnP on port 1400, or the local Control
//! API on port 1443 when the household has UPnP switched off.
//!
//! UPnP stays the main route. [`RoutedClient`] implements the speaker traits
//! and sends each call to the route the household is on. The route is one
//! value for the household ([`HouseholdRoute`]), and the topology refresh is
//! its only writer ([`RoutedClient::refresh_zone_groups`]): it tries UPnP
//! first on every refresh, and moves to port 1443 only when port 1400 refuses
//! because UPnP is off. While any cast on port 1443 is live, the route holds
//! there even if UPnP comes back on, so a cast is never split across routes.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::RwLock;

use crate::error::{DiscoveryResult, SoapResult};
use crate::sonos::discovery::Speaker;
use crate::sonos::lan::protocol::{code, transport_error};
use crate::sonos::lan::LanClient;
use crate::sonos::soap::SoapError;
use crate::sonos::traits::{
    NextItem, SonosClient, SonosDiscovery, SonosPlayback, SonosTopology, SonosVolumeControl,
};
use crate::sonos::types::{PositionInfo, TransportState, ZoneGroupSnapshot};
use crate::stream::{AudioCodec, AudioFormat, StreamMetadata};

/// How the household is controlled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Route {
    /// UPnP on port 1400: the main route, and where every household starts.
    #[default]
    Upnp,
    /// The local Control API on port 1443: UPnP is off.
    Lan,
    /// Neither: UPnP is off and port 1443 refused too (Authentication on,
    /// or the port unreachable). Calls go to UPnP and are refused there, so
    /// the user sees the notice to switch UPnP on.
    None,
}

/// The household's route, shared by everything that has to know it.
#[derive(Debug, Default)]
pub struct HouseholdRoute {
    route: RwLock<Route>,
    /// Casts live on port 1443 (see [`HouseholdRoute::hold`]).
    live: AtomicUsize,
}

impl HouseholdRoute {
    /// The route now.
    #[must_use]
    pub fn get(&self) -> Route {
        *self.route.read()
    }

    /// Whether the household is controlled over port 1443, so has no GENA.
    #[must_use]
    pub fn is_lan(&self) -> bool {
        self.get() == Route::Lan
    }

    /// Holds the route on port 1443 for as long as the returned guard
    /// lives: for a cast live there.
    #[must_use]
    pub fn hold(self: &Arc<Self>) -> LanHold {
        self.live.fetch_add(1, Ordering::SeqCst);
        LanHold(Arc::clone(self))
    }

    /// Whether a cast on port 1443 is live.
    #[must_use]
    pub fn is_held(&self) -> bool {
        self.live.load(Ordering::SeqCst) > 0
    }

    /// Sets the route and returns the one before. Only the topology refresh
    /// sets it ([`RoutedClient::refresh_zone_groups`]); tests set it to
    /// stand in for one.
    pub(crate) fn set(&self, route: Route) -> Route {
        std::mem::replace(&mut *self.route.write(), route)
    }
}

/// Keeps the household on port 1443 while it lives (see
/// [`HouseholdRoute::hold`]).
#[derive(Debug)]
pub struct LanHold(Arc<HouseholdRoute>);

impl Drop for LanHold {
    fn drop(&mut self) {
        self.0.live.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The speaker traits, each call sent to the household's route.
pub struct RoutedClient {
    upnp: Arc<dyn SonosClient>,
    lan: Arc<LanClient>,
    route: Arc<HouseholdRoute>,
}

impl RoutedClient {
    /// Routes between `upnp` and `lan` by `route`.
    #[must_use]
    pub fn new(
        upnp: Arc<dyn SonosClient>,
        lan: Arc<LanClient>,
        route: Arc<HouseholdRoute>,
    ) -> Self {
        Self { upnp, lan, route }
    }

    /// The household's route.
    #[must_use]
    pub fn route(&self) -> &Arc<HouseholdRoute> {
        &self.route
    }

    /// The UPnP client, for a call to make on that route: refused while the
    /// household is on port 1443, where the call is not carried out yet.
    fn upnp(&self, what: &str) -> SoapResult<&dyn SonosClient> {
        if self.route.is_lan() {
            return Err(transport_error(
                code::UNSUPPORTED,
                format!("{what} is not carried out on port 1443"),
            ));
        }
        Ok(self.upnp.as_ref())
    }

    /// Moves the route to `to`, saying so when it changes.
    fn move_to(&self, to: Route, why: &str) {
        let from = self.route.set(to);
        if from == to {
            return;
        }
        match to {
            Route::Lan => log::info!(
                "[Route] UPnP is switched off for this Sonos household; controlling it through \
                 the local Control API on port 1443"
            ),
            Route::Upnp => log::info!("[Route] Controlling the household through UPnP again"),
            Route::None => log::warn!(
                "[Route] UPnP is switched off and port 1443 cannot control the household \
                 either: {why}"
            ),
        }
    }

    /// The groups over port 1443, moving the route by the outcome. A missing
    /// reply leaves the route as it is; a refusal ends it, and the household
    /// is learnt afresh on the next refresh. Either way the caller sees UPnP
    /// switched off, the fix for both.
    async fn refresh_over_lan(&self, ip: &str, uuid: &str) -> SoapResult<ZoneGroupSnapshot> {
        match self.lan.zone_groups(ip, uuid).await {
            Ok(snapshot) => {
                self.move_to(Route::Lan, "");
                Ok(snapshot)
            }
            Err(e) if e.is_transient() => Err(e),
            Err(e) => {
                self.lan.forget_household();
                self.move_to(Route::None, &e.to_string());
                Err(SoapError::UpnpDisabled)
            }
        }
    }
}

#[async_trait]
impl SonosTopology for RoutedClient {
    async fn get_zone_group_state(&self, ip: &str) -> SoapResult<ZoneGroupSnapshot> {
        if !self.route.is_lan() {
            return self.upnp.get_zone_group_state(ip).await;
        }
        let uuid = self.lan.hub().player_at(ip).ok_or_else(|| {
            transport_error(code::CONNECT_FAILED, format!("no player known at {ip}"))
        })?;
        self.lan.zone_groups(ip, &uuid).await
    }

    async fn refresh_zone_groups(&self, ip: &str, uuid: &str) -> SoapResult<ZoneGroupSnapshot> {
        // A cast live on port 1443 keeps the household there, whatever
        // port 1400 would say now.
        if self.route.is_lan() && self.route.is_held() {
            return self.refresh_over_lan(ip, uuid).await;
        }
        match self.upnp.get_zone_group_state(ip).await {
            Ok(snapshot) => {
                self.move_to(Route::Upnp, "");
                Ok(snapshot)
            }
            Err(SoapError::UpnpDisabled) => self.refresh_over_lan(ip, uuid).await,
            Err(e) => Err(e),
        }
    }

    async fn read_transport_state(&self, ip: &str) -> Option<TransportState> {
        if self.route.is_lan() {
            return None;
        }
        self.upnp.read_transport_state(ip).await
    }
}

#[async_trait]
impl SonosDiscovery for RoutedClient {
    async fn discover_speakers(&self) -> DiscoveryResult<Vec<Speaker>> {
        self.upnp.discover_speakers().await
    }
}

#[async_trait]
impl SonosPlayback for RoutedClient {
    async fn play_uri(
        &self,
        ip: &str,
        uri: &str,
        codec: AudioCodec,
        audio_format: &AudioFormat,
        metadata: Option<&StreamMetadata>,
        artwork_url: &str,
    ) -> SoapResult<()> {
        self.upnp("play_uri")?
            .play_uri(ip, uri, codec, audio_format, metadata, artwork_url)
            .await
    }

    async fn set_next_uri(&self, ip: &str, item: &NextItem<'_>) -> SoapResult<()> {
        self.upnp("set_next_uri")?.set_next_uri(ip, item).await
    }

    async fn play(&self, ip: &str) -> SoapResult<()> {
        self.upnp("play")?.play(ip).await
    }

    async fn stop(&self, ip: &str) -> SoapResult<()> {
        self.upnp("stop")?.stop(ip).await
    }

    async fn switch_to_queue(&self, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
        self.upnp("switch_to_queue")?
            .switch_to_queue(ip, coordinator_uuid)
            .await
    }

    async fn get_position_info(&self, ip: &str) -> SoapResult<PositionInfo> {
        self.upnp("get_position_info")?.get_position_info(ip).await
    }

    async fn get_transport_info(&self, ip: &str) -> SoapResult<TransportState> {
        self.upnp("get_transport_info")?
            .get_transport_info(ip)
            .await
    }

    async fn join_group(&self, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
        self.upnp("join_group")?
            .join_group(ip, coordinator_uuid)
            .await
    }

    async fn leave_group(&self, ip: &str) -> SoapResult<()> {
        self.upnp("leave_group")?.leave_group(ip).await
    }

    async fn rejoin_group(&self, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
        self.upnp("rejoin_group")?
            .rejoin_group(ip, coordinator_uuid)
            .await
    }
}

#[async_trait]
impl SonosVolumeControl for RoutedClient {
    async fn get_group_volume(&self, coordinator_ip: &str) -> SoapResult<u8> {
        self.upnp("get_group_volume")?
            .get_group_volume(coordinator_ip)
            .await
    }

    async fn set_group_volume(&self, coordinator_ip: &str, volume: u8) -> SoapResult<()> {
        self.upnp("set_group_volume")?
            .set_group_volume(coordinator_ip, volume)
            .await
    }

    async fn get_group_mute(&self, coordinator_ip: &str) -> SoapResult<bool> {
        self.upnp("get_group_mute")?
            .get_group_mute(coordinator_ip)
            .await
    }

    async fn set_group_mute(&self, coordinator_ip: &str, mute: bool) -> SoapResult<()> {
        self.upnp("set_group_mute")?
            .set_group_mute(coordinator_ip, mute)
            .await
    }

    async fn get_speaker_volume(&self, speaker_ip: &str) -> SoapResult<u8> {
        self.upnp("get_speaker_volume")?
            .get_speaker_volume(speaker_ip)
            .await
    }

    async fn set_speaker_volume(&self, speaker_ip: &str, volume: u8) -> SoapResult<()> {
        self.upnp("set_speaker_volume")?
            .set_speaker_volume(speaker_ip, volume)
            .await
    }

    async fn get_speaker_output_fixed(&self, speaker_ip: &str) -> SoapResult<bool> {
        self.upnp("get_speaker_output_fixed")?
            .get_speaker_output_fixed(speaker_ip)
            .await
    }

    async fn get_speaker_mute(&self, speaker_ip: &str) -> SoapResult<bool> {
        self.upnp("get_speaker_mute")?
            .get_speaker_mute(speaker_ip)
            .await
    }

    async fn set_speaker_mute(&self, speaker_ip: &str, mute: bool) -> SoapResult<()> {
        self.upnp("set_speaker_mute")?
            .set_speaker_mute(speaker_ip, mute)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_household_starts_on_upnp_and_a_hold_lasts_as_long_as_its_guard() {
        let route = Arc::new(HouseholdRoute::default());
        assert_eq!(route.get(), Route::Upnp);
        assert!(!route.is_lan());
        assert!(!route.is_held());

        assert_eq!(route.set(Route::Lan), Route::Upnp);
        assert!(route.is_lan());
        let first = route.hold();
        let second = route.hold();
        drop(first);
        assert!(route.is_held());
        drop(second);
        assert!(!route.is_held());
    }
}
