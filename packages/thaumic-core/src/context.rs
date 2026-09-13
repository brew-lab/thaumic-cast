//! Network configuration context for the streaming server.
//!
//! This module provides [`NetworkContext`] which bundles network configuration
//! used across services. It supports both explicit configuration (for server
//! deployment) and auto-detection (for desktop app).

use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;

use local_ip_address::list_afinet_netifas;
use parking_lot::RwLock;
use tokio::sync::Notify;

use crate::sonos::discovery::types::is_virtual_interface;

/// Network configuration shared across services.
///
/// Bundles server address and local IP information that multiple services need
/// for constructing callback URLs and stream endpoints.
///
/// # Modes
///
/// - **Explicit**: Server deployment where bind address and advertise IP are
///   specified in configuration. Use [`NetworkContext::explicit`].
/// - **Auto-detect**: Desktop app where the local IP is detected automatically.
///   Use [`NetworkContext::auto_detect`].
#[derive(Clone)]
pub struct NetworkContext {
    /// Server port (initially 0 if auto-assigned, set when server starts).
    pub port: Arc<RwLock<u16>>,
    /// Notifier signaled when port is assigned.
    pub port_notify: Arc<Notify>,
    /// IP address that Sonos speakers can reach us at.
    pub local_ip: Arc<RwLock<String>>,
    /// IP detector for checking network changes (auto-detect mode only).
    ip_detector: Option<Arc<dyn IpDetector>>,
}

impl NetworkContext {
    /// Creates a `NetworkContext` with explicit configuration.
    ///
    /// Use this for server deployment where the bind address and advertise IP
    /// are known ahead of time from configuration.
    ///
    /// # Arguments
    ///
    /// * `bind_port` - Port to bind the server to (0 for auto-assign).
    /// * `advertise_ip` - IP address that Sonos speakers can reach us at.
    #[must_use]
    pub fn explicit(bind_port: u16, advertise_ip: IpAddr) -> Self {
        Self {
            port: Arc::new(RwLock::new(bind_port)),
            port_notify: Arc::new(Notify::new()),
            local_ip: Arc::new(RwLock::new(advertise_ip.to_string())),
            ip_detector: None,
        }
    }

    /// Creates a `NetworkContext` with auto-detection.
    ///
    /// Use this for desktop app where the local IP should be detected
    /// automatically and may change during runtime.
    ///
    /// # Arguments
    ///
    /// * `preferred_port` - Preferred port (0 for auto-assign).
    /// * `ip_detector` - Detector for finding local IP address.
    ///
    /// # Errors
    ///
    /// Returns an error if the initial IP detection fails.
    pub fn auto_detect(
        preferred_port: u16,
        ip_detector: Arc<dyn IpDetector>,
    ) -> Result<Self, NetworkError> {
        // Nothing has been discovered at bootstrap, so there are no speaker
        // addresses to weigh; the topology monitor supplies them from then on.
        let local_ip = ip_detector.detect(&[])?;
        Ok(Self {
            port: Arc::new(RwLock::new(preferred_port)),
            port_notify: Arc::new(Notify::new()),
            local_ip: Arc::new(RwLock::new(local_ip)),
            ip_detector: Some(ip_detector),
        })
    }

    /// Like [`NetworkContext::auto_detect`], but falls back to the address the
    /// platform's `local_ip()` reports (the default route's on Linux and Windows,
    /// the first non-loopback interface's on macOS) when detection finds nothing
    /// usable.
    ///
    /// For the desktop launch path ONLY. Detection is deliberately strict so the
    /// topology monitor can tell "no usable address" from a genuine network
    /// change mid-session, but at launch a host whose only address sits on a
    /// name-filtered adapter would otherwise fail to start. A Windows machine
    /// whose LAN address lives on `vEthernet (External Switch)` under Hyper-V is
    /// the common case, and it works today with manually added speakers.
    ///
    /// The headless server must NOT use this: it calls [`Self::auto_detect`] and
    /// tells the user to set an explicit advertise address, which is better
    /// guidance than starting on an address speakers may not reach.
    ///
    /// # Errors
    ///
    /// Returns the detection error when the default route is unusable too.
    pub fn auto_detect_with_route_fallback(
        preferred_port: u16,
        ip_detector: Arc<dyn IpDetector>,
    ) -> Result<Self, NetworkError> {
        match Self::auto_detect(preferred_port, Arc::clone(&ip_detector)) {
            Ok(ctx) => Ok(ctx),
            Err(e) => {
                let fallback = match local_ip_address::local_ip() {
                    Ok(IpAddr::V4(v4)) if is_usable_advertise_address(v4) => v4,
                    _ => return Err(e),
                };
                log::warn!(
                    "[Network] {}; falling back to the platform's default address {}. Speakers may \
                     not be able to reach this machine - set an explicit advertise address if \
                     streaming does not work.",
                    e,
                    fallback
                );
                Ok(Self {
                    port: Arc::new(RwLock::new(preferred_port)),
                    port_notify: Arc::new(Notify::new()),
                    local_ip: Arc::new(RwLock::new(fallback.to_string())),
                    ip_detector: Some(ip_detector),
                })
            }
        }
    }

    /// Creates a `NetworkContext` for testing with a fixed IP.
    #[cfg(test)]
    pub fn for_test() -> Self {
        Self::explicit(0, IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)))
    }

    /// Detects the current local IP address using the configured detector.
    ///
    /// Only available if created with [`NetworkContext::auto_detect`].
    /// Returns an error if no detector is configured.
    ///
    /// # Arguments
    ///
    /// * `known_speaker_ips` - Speaker addresses the caller already knows about.
    ///   They are passed in rather than looked up here so that this module keeps
    ///   knowing nothing about Sonos state; pass an empty slice when none are
    ///   known.
    pub fn detect_ip(&self, known_speaker_ips: &[Ipv4Addr]) -> Result<String, NetworkError> {
        match &self.ip_detector {
            Some(detector) => detector.detect(known_speaker_ips),
            None => Err(NetworkError::NoDetector),
        }
    }

    /// Returns the current port value.
    #[must_use]
    pub fn get_port(&self) -> u16 {
        *self.port.read()
    }

    /// Returns the current local IP.
    #[must_use]
    pub fn get_local_ip(&self) -> String {
        self.local_ip.read().clone()
    }

    /// Sets the port and notifies waiters.
    pub fn set_port(&self, port: u16) {
        *self.port.write() = port;
        self.port_notify.notify_waiters();
    }

    /// Updates the local IP address.
    pub fn set_local_ip(&self, ip: String) {
        *self.local_ip.write() = ip;
    }

    /// Returns a `UrlBuilder` for the current network configuration.
    #[must_use]
    pub fn url_builder(&self) -> UrlBuilder {
        UrlBuilder::new(self.get_local_ip(), self.get_port())
    }

    /// Returns the GENA callback URL for receiving Sonos event notifications.
    #[must_use]
    pub fn gena_callback_url(&self) -> String {
        self.url_builder().gena_callback_url()
    }

    /// Returns the stream URL for a given stream ID.
    #[must_use]
    pub fn stream_url(&self, stream_id: &str) -> String {
        self.url_builder().stream_url(stream_id)
    }
}

/// Trait for detecting the local IP address.
///
/// Different environments may need different detection strategies.
/// This trait allows injecting the appropriate detector.
pub trait IpDetector: Send + Sync {
    /// Detects the local IP address.
    ///
    /// `known_speaker_ips` are the speaker addresses the caller already knows
    /// about, which an implementation may use to choose between several of our
    /// own addresses. It is empty when nothing has been discovered yet.
    fn detect(&self, known_speaker_ips: &[Ipv4Addr]) -> Result<String, NetworkError>;
}

/// Default IP detector using the system's network interfaces.
#[derive(Debug, Clone, Default)]
pub struct LocalIpDetector;

impl LocalIpDetector {
    /// Creates a new `LocalIpDetector`.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Creates a new `LocalIpDetector` wrapped in an Arc.
    #[must_use]
    pub fn arc() -> Arc<dyn IpDetector> {
        Arc::new(Self::new())
    }
}

/// Sort rank for a candidate address: lower wins.
///
/// The three RFC 1918 blocks are not interchangeable in practice, so they are
/// ranked against each other rather than lumped together and left to numeric
/// order. LANs with speakers on them are overwhelmingly 192.168.0.0/16, while
/// container, VM and cluster bridges (`cni0`, `flannel.1`, `lxcbr0`, `podman0`)
/// sit in 10.0.0.0/8 and carry numerically *lower* addresses — so a plain
/// numeric order would advertise a pod network to the speakers on any machine
/// that runs containers. Anything routable but not private (CGNAT, public)
/// ranks last: a speaker can almost never reach it.
fn address_rank(ip: Ipv4Addr) -> u8 {
    match ip.octets() {
        [192, 168, ..] => 0,
        [172, second, ..] if (16..=31).contains(&second) => 1,
        [10, ..] => 2,
        _ => 3,
    }
}

/// Whether an address is one a speaker could ever be told to connect to.
///
/// Loopback, link-local (a DHCP-less interface still coming up), multicast,
/// broadcast and `0.0.0.0` are all addresses that would make every URL we hand
/// a speaker — GENA callback, stream, artwork — unreachable.
fn is_usable_advertise_address(ip: Ipv4Addr) -> bool {
    !ip.is_loopback()
        && !ip.is_link_local()
        && !ip.is_multicast()
        && !ip.is_broadcast()
        && !ip.is_unspecified()
}

/// Whether `candidate` sits in the same /24 as a speaker we already know about.
///
/// /24 is an assumption, but the right one to make here: it is the default for
/// every consumer LAN a Sonos system lives on, and being wrong only costs us the
/// preference — the block ranking and the numeric tie-break still decide.
fn shares_subnet_with_speaker(candidate: Ipv4Addr, known_speaker_ips: &[Ipv4Addr]) -> bool {
    let prefix = &candidate.octets()[..3];
    known_speaker_ips
        .iter()
        .any(|speaker| &speaker.octets()[..3] == prefix)
}

/// Picks the address to advertise to Sonos speakers from a list of interfaces.
///
/// Candidates are the IPv4 addresses of interfaces that
/// [`is_virtual_interface`] does not reject — the same filter SSDP discovery
/// applies — minus loopback, link-local, multicast, broadcast and unspecified
/// addresses. One exception to the name filter: an address in the same /24 as
/// a speaker we know about is a candidate whatever its interface is called.
/// The speakers are reachable there, which is the whole question the name was
/// standing in for; the name filter exists to keep tunnels and container
/// bridges out, and no speaker has ever been found on one of those. This is
/// what keeps a host whose only LAN address sits on a filtered adapter — a
/// Windows machine under Hyper-V, whose LAN lives on `vEthernet (External
/// Switch)` — on that address when a VPN comes up: the tunnel adapter carries
/// a generic friendly name the filter does not catch, and without the
/// exception it would be the only candidate.
///
/// The name filter is only as good as the names. Linux and macOS report
/// kernel names (`tun0`, `utun3`, `docker0`); Windows reports adapter
/// friendly names, which for most VPN clients are generic ("Ethernet 2"), so
/// there the filter is largely inert and the speaker-subnet key is what keeps
/// the tunnel out once a speaker has been discovered.
///
/// # Ordering rule
///
/// Candidates are sorted on four keys, in order; the first one wins.
///
/// 1. An address whose /24 already contains a speaker we know about. This is the
///    only signal here that tells a real network apart from a virtual one by
///    what is actually *on* it, and it is the one that settles the case nothing
///    else can: a bridge that shares an RFC 1918 block with the LAN, such as a
///    macOS virtualisation bridge on 192.168.64.1 next to speakers on
///    192.168.86.x, where the bridge is the numerically lower of the two.
///    Speakers are only ever discovered over interfaces this same filter
///    accepts, so this cannot point at a tunnel.
/// 2. The address the platform's `local_ip()` reports, as long as it survives
///    the candidate filter: the default route's address on Linux and Windows,
///    the first non-loopback interface on macOS. That is the address the
///    machine reaches the rest of the world on, and on every machine without a
///    tunnel it is the LAN address the speakers know. Honouring it means this detector never second-guesses a
///    working setup — including multi-homed ones (docked laptop, host-only
///    adapter, container bridge) where the kernel's own choice is better
///    informed than any ranking we could invent.
/// 3. The RFC 1918 block ([`address_rank`]: 192.168/16 first, then 172.16/12,
///    then 10/8, then anything else routable). This is what decides at first
///    launch, when no speaker has been discovered yet and the default route
///    points through an interface the filter rejects — the full-tunnel VPN case.
/// 4. The numeric value of the address, lowest first.
///
/// The numeric tie-break is what makes the whole ordering deterministic.
/// Interface enumeration order is not guaranteed to be stable between calls, and
/// a detected address that flipped between two equally valid LAN addresses would
/// make the topology monitor tear down and rebuild every GENA subscription on
/// every refresh.
fn select_advertise_address(
    interfaces: Vec<(String, IpAddr)>,
    default_route: Option<IpAddr>,
    known_speaker_ips: &[Ipv4Addr],
) -> Option<Ipv4Addr> {
    let routed = match default_route {
        Some(IpAddr::V4(v4)) => Some(v4),
        _ => None,
    };

    interfaces
        .into_iter()
        .filter_map(|(name, addr)| match addr {
            IpAddr::V4(v4) => Some((name, v4)),
            IpAddr::V6(_) => None,
        })
        .filter(|(name, v4)| {
            !is_virtual_interface(name) || shares_subnet_with_speaker(*v4, known_speaker_ips)
        })
        .map(|(_, v4)| v4)
        .filter(|v4| is_usable_advertise_address(*v4))
        .min_by_key(|v4| {
            (
                u8::from(!shares_subnet_with_speaker(*v4, known_speaker_ips)),
                u8::from(Some(*v4) != routed),
                address_rank(*v4),
                u32::from(*v4),
            )
        })
}

impl IpDetector for LocalIpDetector {
    /// Returns the LAN address Sonos speakers should be told to reach us on.
    ///
    /// Enumerates interfaces and applies [`select_advertise_address`], which
    /// prefers the subnet the known speakers are on, then the default route's
    /// own address unless that address sits on an interface
    /// [`is_virtual_interface`] rejects. On a full-tunnel VPN the default route
    /// points at the tunnel, and every URL built from it (GENA callback, stream,
    /// artwork) would name an address no speaker can reach — while SSDP
    /// discovery, which skips the same virtual interfaces, keeps finding the
    /// speakers on the real LAN.
    ///
    /// # Errors
    ///
    /// Returns [`NetworkError::Detection`] when this machine has no address a
    /// speaker could reach: every interface is virtual, or none has come up yet.
    /// Failing is the point — the caller that matters is the topology monitor,
    /// which keeps the address it is already advertising when detection fails.
    /// Returning loopback, or the tunnel address the filter just rejected, would
    /// be indistinguishable from a genuine network change, so a momentary
    /// link-down would re-advertise mDNS on an unusable address and rebuild
    /// every GENA subscription against a callback no speaker can answer.
    fn detect(&self, known_speaker_ips: &[Ipv4Addr]) -> Result<String, NetworkError> {
        let default_route = match local_ip_address::local_ip() {
            Ok(ip) => Some(ip),
            Err(e) => {
                log::debug!("[Network] No default route address available: {}", e);
                None
            }
        };

        let interfaces = match list_afinet_netifas() {
            Ok(interfaces) => interfaces,
            Err(e) => {
                // Without an interface list there is nothing to tell a tunnel
                // from a LAN with, so the default route is all we have.
                log::warn!(
                    "[Network] Could not enumerate network interfaces ({}); falling back to the default route",
                    e
                );
                return match default_route {
                    Some(IpAddr::V4(v4)) if is_usable_advertise_address(v4) => Ok(v4.to_string()),
                    _ => Err(NetworkError::Detection(format!(
                        "could not enumerate network interfaces: {}",
                        e
                    ))),
                };
            }
        };

        select_advertise_address(interfaces, default_route, known_speaker_ips)
            .map(|ip| ip.to_string())
            .ok_or_else(|| {
                NetworkError::Detection("no usable address on a non-virtual interface".to_string())
            })
    }
}

/// Errors that can occur during network operations.
#[derive(Debug, thiserror::Error)]
pub enum NetworkError {
    /// Could not detect local IP address.
    #[error("Failed to detect local IP: {0}")]
    Detection(String),

    /// No IP detector configured (explicit mode).
    #[error("No IP detector configured (using explicit mode)")]
    NoDetector,
}

/// Builder for constructing URLs for the streaming server.
pub struct UrlBuilder {
    ip: String,
    port: u16,
}

impl UrlBuilder {
    /// Creates a new `UrlBuilder` for the given server address.
    pub fn new(ip: impl Into<String>, port: u16) -> Self {
        Self {
            ip: ip.into(),
            port,
        }
    }

    /// Returns the base URL for the server (e.g., `http://192.168.1.100:8080`).
    #[must_use]
    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.ip, self.port)
    }

    /// Returns the stream URL for a given stream ID.
    ///
    /// Returns the base URL without codec extension. The caller (build_sonos_stream_uri)
    /// will append the appropriate extension (.wav, .flac) based on codec.
    #[must_use]
    pub fn stream_url(&self, stream_id: &str) -> String {
        format!("{}/stream/{}/live", self.base_url(), stream_id)
    }

    /// Returns the GENA callback URL for receiving Sonos notifications.
    #[must_use]
    pub fn gena_callback_url(&self) -> String {
        format!("{}/sonos/gena", self.base_url())
    }

    /// Returns the artwork URL for Sonos metadata display.
    #[must_use]
    pub fn artwork_url(&self) -> String {
        format!("{}/artwork.jpg", self.base_url())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockIpDetector {
        ip: String,
    }

    impl IpDetector for MockIpDetector {
        fn detect(&self, _known_speaker_ips: &[Ipv4Addr]) -> Result<String, NetworkError> {
            Ok(self.ip.clone())
        }
    }

    #[test]
    fn explicit_context_uses_provided_ip() {
        let ctx = NetworkContext::explicit(8080, IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100)));
        assert_eq!(ctx.get_local_ip(), "192.168.1.100");
        assert_eq!(ctx.get_port(), 8080);
    }

    #[test]
    fn auto_detect_context_uses_detector() {
        let detector = Arc::new(MockIpDetector {
            ip: "10.0.0.5".to_string(),
        });
        let ctx = NetworkContext::auto_detect(0, detector).unwrap();
        assert_eq!(ctx.get_local_ip(), "10.0.0.5");
    }

    #[test]
    fn explicit_context_detect_ip_returns_error() {
        let ctx = NetworkContext::explicit(8080, IpAddr::V4(Ipv4Addr::new(192, 168, 1, 100)));
        assert!(matches!(ctx.detect_ip(&[]), Err(NetworkError::NoDetector)));
    }

    /// Builds an interface list in the shape `list_afinet_netifas` returns.
    fn ifaces(entries: &[(&str, &str)]) -> Vec<(String, IpAddr)> {
        entries
            .iter()
            .map(|(name, ip)| ((*name).to_string(), ip.parse::<IpAddr>().unwrap()))
            .collect()
    }

    /// Parses a default-route address the way `local_ip()` would report it.
    fn route(ip: &str) -> Option<IpAddr> {
        Some(ip.parse().unwrap())
    }

    #[test]
    fn detector_keeps_the_default_route_when_it_is_a_real_interface() {
        // A split-tunnel VPN, or simply a multi-homed machine: the kernel is
        // already using the LAN interface, so we must not second-guess it even
        // though the tunnel address sorts lower.
        let interfaces = ifaces(&[("wlan0", "192.168.1.42"), ("tun0", "10.8.0.2")]);

        assert_eq!(
            select_advertise_address(interfaces, route("192.168.1.42"), &[]),
            Some(Ipv4Addr::new(192, 168, 1, 42))
        );
    }

    #[test]
    fn a_filtered_adapter_on_the_speakers_subnet_beats_an_unfiltered_tunnel() {
        // Windows under Hyper-V: the only LAN address sits on the external
        // switch, whose name the filter rejects, and a VPN client's adapter
        // carries a generic friendly name the filter does not catch. Once a
        // speaker is known on the switch's subnet, that subnet decides - the
        // tunnel must not become the only candidate, or a VPN connect would
        // move the advertised address onto it.
        let interfaces = ifaces(&[
            ("vEthernet (External Switch)", "192.168.1.50"),
            ("Ethernet 2", "10.8.0.2"),
        ]);
        let speakers = [Ipv4Addr::new(192, 168, 1, 71)];

        assert_eq!(
            select_advertise_address(interfaces.clone(), route("10.8.0.2"), &speakers),
            Some(Ipv4Addr::new(192, 168, 1, 50))
        );

        // Without a known speaker the exception does not apply: the name filter
        // stands, and the tunnel is the only candidate left.
        assert_eq!(
            select_advertise_address(interfaces, route("10.8.0.2"), &[]),
            Some(Ipv4Addr::new(10, 8, 0, 2))
        );
    }

    #[test]
    fn detector_keeps_the_default_route_over_a_lower_host_only_adapter() {
        // bridge100 / VirtualBox host-only adapters carry perfectly private
        // addresses that sort below the real LAN; the default route settles it.
        let interfaces = ifaces(&[
            ("bridge100", "192.168.64.1"),
            ("en0", "192.168.86.31"),
            ("cni0", "10.244.0.1"),
        ]);

        assert_eq!(
            select_advertise_address(interfaces, route("192.168.86.31"), &[]),
            Some(Ipv4Addr::new(192, 168, 86, 31))
        );
    }

    #[test]
    fn detector_skips_virtual_interfaces() {
        // A full-tunnel VPN: the tunnel address is the one the default route
        // points at, and it is the one we must not pick.
        let interfaces = ifaces(&[
            ("tun0", "10.8.0.2"),
            ("lo", "127.0.0.1"),
            ("docker0", "172.17.0.1"),
            ("wlan0", "192.168.1.42"),
        ]);

        assert_eq!(
            select_advertise_address(interfaces, route("10.8.0.2"), &[]),
            Some(Ipv4Addr::new(192, 168, 1, 42))
        );
    }

    #[test]
    fn detector_ranks_candidates_when_the_default_route_is_unusable() {
        let interfaces = ifaces(&[
            ("eth0", "192.168.1.50"),
            ("eth1", "192.168.4.10"),
            ("wlan0", "10.0.0.7"),
        ]);

        // No default route at all, and a default route on an address that is not
        // one of ours, both fall through to the ranking. 192.168/16 outranks
        // 10/8 even though 10.0.0.7 is numerically lower.
        assert_eq!(
            select_advertise_address(interfaces.clone(), None, &[]),
            Some(Ipv4Addr::new(192, 168, 1, 50))
        );
        assert_eq!(
            select_advertise_address(interfaces, route("172.20.5.5"), &[]),
            Some(Ipv4Addr::new(192, 168, 1, 50))
        );
    }

    #[test]
    fn detector_does_not_advertise_a_container_bridge_to_the_speakers() {
        // Full-tunnel WireGuard on a machine that also runs containers: the
        // default route is rejected, so the ranking decides, and the pod-network
        // bridge is numerically lower than the LAN address.
        let interfaces = ifaces(&[
            ("cni0", "10.244.0.1"),
            ("eth0", "192.168.86.31"),
            ("wg0", "10.8.0.2"),
        ]);

        assert_eq!(
            select_advertise_address(interfaces, route("10.8.0.2"), &[]),
            Some(Ipv4Addr::new(192, 168, 86, 31))
        );
    }

    #[test]
    fn detector_prefers_a_corporate_lan_over_a_container_bridge() {
        // Same shape one block up: 172.16/12 is a LAN range, 10/8 is where the
        // bridges live, so the block ranking has to separate them too.
        let interfaces = ifaces(&[("flannel.1", "10.244.0.1"), ("eth0", "172.20.1.5")]);

        assert_eq!(
            select_advertise_address(interfaces, None, &[]),
            Some(Ipv4Addr::new(172, 20, 1, 5))
        );
    }

    #[test]
    fn detector_ignores_an_ipv6_default_route() {
        let interfaces = ifaces(&[("eth0", "192.168.1.50"), ("eth1", "10.0.0.7")]);

        assert_eq!(
            select_advertise_address(interfaces, route("fe80::1"), &[]),
            Some(Ipv4Addr::new(192, 168, 1, 50))
        );
    }

    /// The macOS case that nothing but the speakers can settle: a virtualisation
    /// bridge sharing the 192.168/16 block with the real LAN, and lower in it.
    fn bridge_and_lan() -> Vec<(String, IpAddr)> {
        ifaces(&[
            ("bridge100", "192.168.64.1"),
            ("en0", "192.168.86.31"),
            ("utun3", "10.8.0.2"),
        ])
    }

    #[test]
    fn detector_prefers_the_subnet_the_speakers_are_on() {
        // A full-tunnel VPN, so the default route is rejected and the block
        // ranking cannot separate the bridge from the LAN - both are 192.168/16
        // and the bridge is numerically lower. The speakers decide.
        let speakers = [
            Ipv4Addr::new(192, 168, 86, 40),
            Ipv4Addr::new(192, 168, 86, 41),
        ];

        assert_eq!(
            select_advertise_address(bridge_and_lan(), route("10.8.0.2"), &speakers),
            Some(Ipv4Addr::new(192, 168, 86, 31))
        );
    }

    #[test]
    fn detector_falls_back_to_block_ranking_with_no_known_speakers() {
        // First launch: nothing has been discovered, so the only thing left is
        // the block ranking and its numeric tie-break. The bridge wins here, and
        // the first successful discovery is what corrects it.
        assert_eq!(
            select_advertise_address(bridge_and_lan(), route("10.8.0.2"), &[]),
            Some(Ipv4Addr::new(192, 168, 64, 1))
        );
    }

    #[test]
    fn detector_ignores_speakers_on_a_subnet_we_do_not_have() {
        // Stale topology from another network: no candidate matches, so the
        // ranking decides exactly as if we knew nothing.
        let speakers = [Ipv4Addr::new(10, 1, 2, 3)];

        assert_eq!(
            select_advertise_address(bridge_and_lan(), route("10.8.0.2"), &speakers),
            Some(Ipv4Addr::new(192, 168, 64, 1))
        );
    }

    #[test]
    fn detector_prefers_the_speakers_subnet_over_the_default_route() {
        // Docked laptop: the default route leaves over Ethernet, but the
        // speakers are only reachable over Wi-Fi, and a callback URL they cannot
        // reach is worse than one the internet cannot.
        let interfaces = ifaces(&[("eth0", "192.168.1.20"), ("wlan0", "192.168.86.31")]);
        let speakers = [Ipv4Addr::new(192, 168, 86, 40)];

        assert_eq!(
            select_advertise_address(interfaces, route("192.168.1.20"), &speakers),
            Some(Ipv4Addr::new(192, 168, 86, 31))
        );
    }

    #[test]
    fn detector_is_stable_with_known_speakers_regardless_of_enumeration_order() {
        // Two addresses on the speakers' own /24: the numeric tie-break still
        // has to settle it, or the advertised address would flap between calls
        // and tear every GENA subscription down on every refresh.
        let speakers = [Ipv4Addr::new(192, 168, 86, 40)];
        let forwards = ifaces(&[
            ("en0", "192.168.86.31"),
            ("en1", "192.168.86.12"),
            ("bridge100", "192.168.64.1"),
        ]);
        let mut backwards = forwards.clone();
        backwards.reverse();

        assert_eq!(
            select_advertise_address(forwards, None, &speakers),
            Some(Ipv4Addr::new(192, 168, 86, 12))
        );
        assert_eq!(
            select_advertise_address(backwards, None, &speakers),
            Some(Ipv4Addr::new(192, 168, 86, 12))
        );
    }

    #[test]
    fn detector_is_stable_regardless_of_enumeration_order() {
        let forwards = ifaces(&[
            ("eth0", "192.168.1.50"),
            ("eth1", "192.168.4.10"),
            ("wlan0", "10.0.0.7"),
        ]);
        let mut backwards = forwards.clone();
        backwards.reverse();

        // Lowest address of the best-ranked block wins, whichever order the OS
        // reports the interfaces in.
        assert_eq!(
            select_advertise_address(forwards, None, &[]),
            Some(Ipv4Addr::new(192, 168, 1, 50))
        );
        assert_eq!(
            select_advertise_address(backwards, None, &[]),
            Some(Ipv4Addr::new(192, 168, 1, 50))
        );
    }

    #[test]
    fn detector_keeps_a_windows_lan_adapter_named_like_loopback() {
        // "Local Area Connection" is still the Ethernet adapter's friendly name
        // on Windows machines upgraded in place, and Windows is where interface
        // enumeration reports friendly names. Classifying it as loopback would
        // leave only the VMware host-only network to advertise.
        let interfaces = ifaces(&[
            ("Local Area Connection", "192.168.1.50"),
            ("VMware Network Adapter VMnet1", "192.168.126.1"),
        ]);

        assert_eq!(
            select_advertise_address(interfaces, route("192.168.1.50"), &[]),
            Some(Ipv4Addr::new(192, 168, 1, 50))
        );
    }

    #[test]
    fn detector_prefers_private_addresses_over_routable_ones() {
        let interfaces = ifaces(&[("eth0", "203.0.113.9"), ("eth1", "192.168.1.200")]);

        assert_eq!(
            select_advertise_address(interfaces, None, &[]),
            Some(Ipv4Addr::new(192, 168, 1, 200))
        );
    }

    #[test]
    fn detector_ignores_loopback_link_local_and_ipv6() {
        let interfaces = ifaces(&[
            ("eth0", "169.254.11.22"),
            ("eth1", "0.0.0.0"),
            ("eth2", "fe80::1"),
            ("eth3", "192.168.9.9"),
        ]);

        // Even when the default route names one of them, it is not a candidate.
        assert_eq!(
            select_advertise_address(interfaces, route("169.254.11.22"), &[]),
            Some(Ipv4Addr::new(192, 168, 9, 9))
        );
    }

    #[test]
    fn detector_selection_is_empty_when_only_virtual_interfaces_exist() {
        // Nothing usable, and detect() reports that as an error rather than
        // handing back the tunnel address the filter has just rejected: the
        // topology monitor must keep the address it is already advertising.
        assert_eq!(
            select_advertise_address(
                ifaces(&[("tun0", "10.8.0.2"), ("lo", "127.0.0.1")]),
                route("10.8.0.2"),
                &[]
            ),
            None
        );
        assert_eq!(select_advertise_address(Vec::new(), None, &[]), None);
    }

    #[test]
    fn an_address_no_speaker_could_reach_is_never_advertised() {
        // The candidate filter and the no-interface-list fallback share this
        // predicate, so a link-local address on a NIC that is still coming up,
        // or a loopback default route, can never be adopted.
        assert!(!is_usable_advertise_address(Ipv4Addr::new(127, 0, 0, 1)));
        assert!(!is_usable_advertise_address(Ipv4Addr::new(
            169, 254, 11, 22
        )));
        assert!(!is_usable_advertise_address(Ipv4Addr::UNSPECIFIED));
        assert!(!is_usable_advertise_address(Ipv4Addr::BROADCAST));
        assert!(is_usable_advertise_address(Ipv4Addr::new(192, 168, 1, 50)));
    }

    #[test]
    fn url_builder_generates_correct_urls() {
        let builder = UrlBuilder::new("192.168.1.100", 8080);
        assert_eq!(builder.base_url(), "http://192.168.1.100:8080");
        assert_eq!(
            builder.stream_url("abc123"),
            "http://192.168.1.100:8080/stream/abc123/live"
        );
        assert_eq!(
            builder.gena_callback_url(),
            "http://192.168.1.100:8080/sonos/gena"
        );
    }
}
