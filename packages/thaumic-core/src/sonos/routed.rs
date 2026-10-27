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
//!
//! A call about a speaker with a live cast on port 1443 goes there whatever
//! the route: with Authentication switched on mid-cast the route is lost, and
//! the cast must still be stopped where it was started. A call refused on
//! port 1400 because UPnP is off asks for a topology refresh, so a household
//! whose UPnP is switched off mid-cast moves at once; whoever watches the
//! route ([`HouseholdRoute::watch`]) then moves its casts across.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::{watch, Notify};

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
#[derive(Debug)]
pub struct HouseholdRoute {
    route: watch::Sender<Route>,
    /// Casts live on port 1443 (see [`HouseholdRoute::hold`]).
    live: AtomicUsize,
}

impl Default for HouseholdRoute {
    fn default() -> Self {
        Self {
            route: watch::Sender::new(Route::default()),
            live: AtomicUsize::new(0),
        }
    }
}

impl HouseholdRoute {
    /// The route now.
    #[must_use]
    pub fn get(&self) -> Route {
        *self.route.borrow()
    }

    /// Follows the route as it changes.
    #[must_use]
    pub fn watch(&self) -> watch::Receiver<Route> {
        self.route.subscribe()
    }

    /// Whether the household is controlled over port 1443, so has no GENA.
    #[must_use]
    pub fn is_lan(&self) -> bool {
        self.get() == Route::Lan
    }

    /// Whether GENA can work: only on UPnP. Off it (on port 1443, or with
    /// no route at all) every subscription would be refused.
    #[must_use]
    pub fn has_gena(&self) -> bool {
        self.get() == Route::Upnp
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
        self.route.send_replace(route)
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
    /// Asks the topology monitor for a refresh.
    refresh: Option<Arc<Notify>>,
}

impl RoutedClient {
    /// Routes between `upnp` and `lan` by `route`.
    #[must_use]
    pub fn new(
        upnp: Arc<dyn SonosClient>,
        lan: Arc<LanClient>,
        route: Arc<HouseholdRoute>,
    ) -> Self {
        Self {
            upnp,
            lan,
            route,
            refresh: None,
        }
    }

    /// Asks for a topology refresh through `refresh` whenever port 1400
    /// refuses a call because UPnP is off.
    #[must_use]
    pub fn with_refresh(mut self, refresh: Arc<Notify>) -> Self {
        self.refresh = Some(refresh);
        self
    }

    /// Whether a call about the speaker at `ip` goes to port 1443: the
    /// household is there, or a cast on `ip` was started there.
    fn on_lan(&self, ip: &str) -> bool {
        self.route.is_lan() || self.lan.has_cast(ip)
    }

    /// Notes a call's outcome on port 1400: a refusal because UPnP is off
    /// asks for a refresh, which finds the household on port 1443.
    fn noted<T>(&self, result: SoapResult<T>) -> SoapResult<T> {
        if matches!(result, Err(SoapError::UpnpDisabled)) {
            if let Some(refresh) = &self.refresh {
                refresh.notify_one();
            }
        }
        result
    }

    /// The household's route.
    #[must_use]
    pub fn route(&self) -> &Arc<HouseholdRoute> {
        &self.route
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

/// Sends a call about the speaker at its first argument to port 1443 when
/// it goes there ([`RoutedClient::on_lan`]), and to UPnP otherwise.
macro_rules! routed {
    ($self:ident.$method:ident($ip:expr $(, $arg:expr)*)) => {
        if $self.on_lan($ip) {
            $self.lan.$method($ip $(, $arg)*).await
        } else {
            $self.noted($self.upnp.$method($ip $(, $arg)*).await)
        }
    };
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
        routed!(self.play_uri(ip, uri, codec, audio_format, metadata, artwork_url))
    }

    async fn set_next_uri(&self, ip: &str, item: &NextItem<'_>) -> SoapResult<()> {
        routed!(self.set_next_uri(ip, item))
    }

    async fn play(&self, ip: &str) -> SoapResult<()> {
        routed!(self.play(ip))
    }

    async fn stop(&self, ip: &str) -> SoapResult<()> {
        routed!(self.stop(ip))
    }

    async fn switch_to_queue(&self, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
        // Off UPnP it follows a stop that already forgot the cast, and port
        // 1400 would only refuse it.
        if self.route.get() != Route::Upnp {
            return self.lan.switch_to_queue(ip, coordinator_uuid).await;
        }
        routed!(self.switch_to_queue(ip, coordinator_uuid))
    }

    async fn get_position_info(&self, ip: &str) -> SoapResult<PositionInfo> {
        routed!(self.get_position_info(ip))
    }

    async fn get_transport_info(&self, ip: &str) -> SoapResult<TransportState> {
        routed!(self.get_transport_info(ip))
    }

    async fn join_group(&self, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
        routed!(self.join_group(ip, coordinator_uuid))
    }

    async fn leave_group(&self, ip: &str) -> SoapResult<()> {
        routed!(self.leave_group(ip))
    }

    async fn rejoin_group(&self, ip: &str, coordinator_uuid: &str) -> SoapResult<()> {
        routed!(self.rejoin_group(ip, coordinator_uuid))
    }
}

#[async_trait]
impl SonosVolumeControl for RoutedClient {
    async fn get_group_volume(&self, coordinator_ip: &str) -> SoapResult<u8> {
        routed!(self.get_group_volume(coordinator_ip))
    }

    async fn set_group_volume(&self, coordinator_ip: &str, volume: u8) -> SoapResult<()> {
        routed!(self.set_group_volume(coordinator_ip, volume))
    }

    async fn get_group_mute(&self, coordinator_ip: &str) -> SoapResult<bool> {
        routed!(self.get_group_mute(coordinator_ip))
    }

    async fn set_group_mute(&self, coordinator_ip: &str, mute: bool) -> SoapResult<()> {
        routed!(self.set_group_mute(coordinator_ip, mute))
    }

    async fn get_speaker_volume(&self, speaker_ip: &str) -> SoapResult<u8> {
        routed!(self.get_speaker_volume(speaker_ip))
    }

    async fn set_speaker_volume(&self, speaker_ip: &str, volume: u8) -> SoapResult<()> {
        routed!(self.set_speaker_volume(speaker_ip, volume))
    }

    async fn get_speaker_output_fixed(&self, speaker_ip: &str) -> SoapResult<bool> {
        routed!(self.get_speaker_output_fixed(speaker_ip))
    }

    async fn get_speaker_mute(&self, speaker_ip: &str) -> SoapResult<bool> {
        routed!(self.get_speaker_mute(speaker_ip))
    }

    async fn set_speaker_mute(&self, speaker_ip: &str, mute: bool) -> SoapResult<()> {
        routed!(self.set_speaker_mute(speaker_ip, mute))
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
