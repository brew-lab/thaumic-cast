//! TCP and TLS to a speaker's port 1443, with the speaker's certificate
//! checked for identity.
//!
//! The speakers' certificates are issued by "Sonos Device Authentication Root
//! CA", which Sonos does not publish, so the chain cannot be verified. The
//! check is instead that the certificate is a Sonos device certificate, in
//! date, for the player we meant to reach: its subject alternative names
//! carry `urn:sonos:udn:<player id>` and `urn:sonos:hhid:<household>`. The
//! handshake signature is verified against it as usual. That stops a socket
//! reaching the wrong speaker or a stray device; it does not stop an active
//! attacker on the LAN, who can already drive port 1400, which is plain HTTP
//! (owner decision, 2026-10-26).

use std::io;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio::net::TcpStream;
use x509_parser::prelude::{FromDer, GeneralName, X509Certificate};
use x509_parser::time::ASN1Time;

use super::protocol::{websocket_url, SpeakerIdentity, API_KEY, INFO_PATH, PORT};
use super::socket::{LanConnector, LanIo};

/// The issuer every Sonos device certificate names.
pub const SONOS_DEVICE_CA: &str = "Sonos Device Authentication Root CA";

/// TCP and TLS to port 1443.
pub struct TlsConnector {
    provider: Arc<CryptoProvider>,
    port: u16,
    connect_timeout: Duration,
}

impl TlsConnector {
    /// A connector that gives up on TCP and TLS after `connect_timeout`.
    #[must_use]
    pub fn new(connect_timeout: Duration) -> Self {
        Self {
            provider: Arc::new(rustls::crypto::aws_lc_rs::default_provider()),
            port: PORT,
            connect_timeout,
        }
    }

    #[cfg(test)]
    fn on_port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }

    fn config(&self, expect: &SpeakerIdentity) -> ClientConfig {
        ClientConfig::builder_with_provider(self.provider.clone())
            .with_safe_default_protocol_versions()
            .expect("aws-lc-rs supports the default protocol versions")
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(SpeakerCert {
                provider: self.provider.clone(),
                expect: expect.clone(),
            }))
            .with_no_client_auth()
    }
}

#[async_trait]
impl LanConnector for TlsConnector {
    async fn connect(&self, ip: &str, expect: &SpeakerIdentity) -> io::Result<Box<dyn LanIo>> {
        let name = ServerName::try_from(ip.to_string())
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        let tls = tokio_rustls::TlsConnector::from(Arc::new(self.config(expect)));
        let open = async {
            let tcp = TcpStream::connect((ip, self.port)).await?;
            tcp.set_nodelay(true)?;
            tls.connect(name, tcp).await
        };
        let stream = tokio::time::timeout(self.connect_timeout, open)
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "TCP or TLS timed out"))??;
        Ok(Box::new(stream))
    }

    fn url(&self, ip: &str) -> String {
        websocket_url(ip)
    }

    async fn local_info(&self, ip: &str, expect: &SpeakerIdentity) -> io::Result<String> {
        let client = reqwest::Client::builder()
            .tls_backend_preconfigured(self.config(expect))
            .timeout(self.connect_timeout)
            .no_proxy()
            .build()
            .map_err(io::Error::other)?;
        get_info(&client, &format!("https://{ip}:{}{INFO_PATH}", self.port)).await
    }
}

/// `GET`s a player's description from `url` with the key, and returns the
/// body of a successful answer.
pub(crate) async fn get_info(client: &reqwest::Client, url: &str) -> io::Result<String> {
    let response = client
        .get(url)
        .header("X-Sonos-Api-Key", API_KEY)
        .send()
        .await
        .map_err(io::Error::other)?;
    let status = response.status();
    if !status.is_success() {
        return Err(io::Error::other(format!("player info answered {status}")));
    }
    response.text().await.map_err(io::Error::other)
}

/// Checks that a certificate is a Sonos device certificate for `expect`.
#[derive(Debug)]
struct SpeakerCert {
    provider: Arc<CryptoProvider>,
    expect: SpeakerIdentity,
}

/// Why a certificate is not the expected speaker's, or `None` if it is.
fn identity_problem(
    der: &[u8],
    expect: &SpeakerIdentity,
    now_secs: i64,
) -> Option<CertificateError> {
    let Ok((_, cert)) = X509Certificate::from_der(der) else {
        return Some(CertificateError::BadEncoding);
    };
    let issuer_cn = cert
        .issuer()
        .iter_common_name()
        .next()
        .and_then(|cn| cn.as_str().ok());
    if issuer_cn != Some(SONOS_DEVICE_CA) {
        return Some(CertificateError::UnknownIssuer);
    }
    match ASN1Time::from_timestamp(now_secs) {
        Ok(now) if cert.validity().is_valid_at(now) => {}
        Ok(_) => return Some(CertificateError::Expired),
        Err(_) => return Some(CertificateError::BadEncoding),
    }
    let uris: Vec<&str> = match cert.subject_alternative_name() {
        Ok(Some(san)) => san
            .value
            .general_names
            .iter()
            .filter_map(|n| match n {
                GeneralName::URI(u) => Some(*u),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let has = |urn: String| uris.iter().any(|u| *u == urn);
    if !has(format!("urn:sonos:udn:{}", expect.player_id)) {
        return Some(CertificateError::NotValidForName);
    }
    // The certificate carries the household id up to its first dot
    // (`Sonos_AbC…` for `Sonos_AbC….XyZ…`), as recorded on firmware 86.10.
    if let Some(hh) = &expect.household_id {
        let base = hh.split('.').next().unwrap_or(hh);
        if !has(format!("urn:sonos:hhid:{base}")) {
            return Some(CertificateError::NotValidForName);
        }
    }
    None
}

impl ServerCertVerifier for SpeakerCert {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let now_secs = i64::try_from(now.as_secs()).unwrap_or(i64::MAX);
        match identity_problem(end_entity, &self.expect, now_secs) {
            None => Ok(ServerCertVerified::assertion()),
            Some(problem) => {
                log::warn!(
                    "[Lan] certificate is not {}'s: {problem:?}",
                    self.expect.player_id
                );
                Err(rustls::Error::InvalidCertificate(problem))
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use rcgen::{
        BasicConstraints, CertificateParams, CertifiedIssuer, DnType, IsCa, KeyPair, SanType,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    const PLAYER: &str = "RINCON_000000000A0101400";
    /// A household id as the API gives it; certificates carry the part
    /// before the dot.
    const HH: &str = "Sonos_HOUSEHOLD0000000000000000000.SUFFIX000000000000000";

    /// Unix times for the date checks: the certificates below run from
    /// 2025 to 2030.
    const IN_DATE: i64 = 1_793_059_200; // 2026-10-27
    const BEFORE: i64 = 1_704_067_200; // 2024-01-01
    const AFTER: i64 = 1_924_992_000; // 2031-01-01

    /// A device certificate shaped like the speakers' (issuer, SAN URIs and
    /// DNS names as on firmware 86.10), from a CA named `issuer`, valid from
    /// 2025 to the start of `until_year`.
    fn device_cert(issuer: &str, player: &str, hh: &str, until_year: i32) -> (Vec<u8>, KeyPair) {
        let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca.distinguished_name.push(DnType::CommonName, issuer);
        ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let ca = CertifiedIssuer::self_signed(ca, KeyPair::generate().unwrap()).unwrap();

        let mut leaf =
            CertificateParams::new(vec!["sonos-000000000A01.local".to_string()]).unwrap();
        leaf.distinguished_name
            .push(DnType::CommonName, "000000000A01");
        leaf.not_before = rcgen::date_time_ymd(2025, 1, 1);
        leaf.not_after = rcgen::date_time_ymd(until_year, 1, 1);
        for urn in [
            format!("urn:sonos:hhid:{}", hh.split('.').next().unwrap()),
            format!("urn:sonos:udn:{player}"),
        ] {
            leaf.subject_alt_names
                .push(SanType::URI(urn.try_into().unwrap()));
        }
        let key = KeyPair::generate().unwrap();
        let cert = leaf.signed_by(&key, &ca).unwrap();
        (cert.der().to_vec(), key)
    }

    fn expect(player: &str, hh: Option<&str>) -> SpeakerIdentity {
        SpeakerIdentity {
            player_id: player.into(),
            household_id: hh.map(str::to_string),
        }
    }

    #[test]
    fn a_device_certificate_for_the_expected_player_and_household_passes() {
        let (der, _) = device_cert(SONOS_DEVICE_CA, PLAYER, HH, 2030);
        assert_eq!(
            identity_problem(&der, &expect(PLAYER, Some(HH)), IN_DATE),
            None
        );
        // Before the household is known, the player alone decides.
        assert_eq!(identity_problem(&der, &expect(PLAYER, None), IN_DATE), None);
    }

    #[test]
    fn another_player_household_issuer_or_date_is_refused() {
        let (der, _) = device_cert(SONOS_DEVICE_CA, PLAYER, HH, 2030);
        assert_eq!(
            identity_problem(&der, &expect("RINCON_000000000B0101400", Some(HH)), IN_DATE),
            Some(CertificateError::NotValidForName)
        );
        assert_eq!(
            identity_problem(&der, &expect(PLAYER, Some("Sonos_OTHER")), IN_DATE),
            Some(CertificateError::NotValidForName)
        );
        assert_eq!(
            identity_problem(
                &der,
                &expect(PLAYER, Some("Sonos_HOUSEHOLD000000000000000000")),
                IN_DATE
            ),
            Some(CertificateError::NotValidForName),
            "a prefix of the household is not the household"
        );
        // A prefix of the expected id is not the expected id.
        assert_eq!(
            identity_problem(&der, &expect("RINCON_000000000A01", None), IN_DATE),
            Some(CertificateError::NotValidForName)
        );
        let (other_ca, _) = device_cert("Some Other CA", PLAYER, HH, 2030);
        assert_eq!(
            identity_problem(&other_ca, &expect(PLAYER, Some(HH)), IN_DATE),
            Some(CertificateError::UnknownIssuer)
        );
        for out_of_date in [BEFORE, AFTER] {
            assert_eq!(
                identity_problem(&der, &expect(PLAYER, Some(HH)), out_of_date),
                Some(CertificateError::Expired)
            );
        }
        assert_eq!(
            identity_problem(b"not a certificate", &expect(PLAYER, None), IN_DATE),
            Some(CertificateError::BadEncoding)
        );
    }

    /// One TLS server on the loopback address presenting `cert`; it echoes a
    /// byte so the client can tell the handshake finished.
    async fn tls_server(der: Vec<u8>, key: KeyPair) -> u16 {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let key = rustls::pki_types::PrivateKeyDer::try_from(key.serialize_der()).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS12])
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![CertificateDer::from(der)], key)
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                if let Ok(mut s) = acceptor.accept(tcp).await {
                    let mut b = [0u8; 1];
                    if s.read_exact(&mut b).await.is_ok() {
                        let _ = s.write_all(&b).await;
                    }
                }
            }
        });
        port
    }

    #[tokio::test]
    async fn the_connector_completes_tls_1_2_only_with_the_expected_speaker() {
        let (der, key) = device_cert(SONOS_DEVICE_CA, PLAYER, HH, 4000);
        let port = tls_server(der, key).await;
        let c = TlsConnector::new(Duration::from_secs(2)).on_port(port);

        let mut s = c
            .connect("127.0.0.1", &expect(PLAYER, Some(HH)))
            .await
            .unwrap();
        s.write_all(b"x").await.unwrap();
        let mut b = [0u8; 1];
        s.read_exact(&mut b).await.unwrap();
        assert_eq!(&b, b"x");

        let err = c
            .connect("127.0.0.1", &expect("RINCON_000000000B0101400", Some(HH)))
            .await
            .err()
            .expect("another player's certificate is refused");
        assert!(err.to_string().contains("NotValidForName"), "{err}");
    }

    #[tokio::test]
    async fn a_refused_port_fails_fast_and_a_name_must_be_an_address() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let c = TlsConnector::new(Duration::from_secs(2)).on_port(port);
        let started = std::time::Instant::now();
        let err = c
            .connect("127.0.0.1", &expect(PLAYER, None))
            .await
            .err()
            .unwrap();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionRefused, "{err}");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            c.connect("not an ip", &expect(PLAYER, None))
                .await
                .err()
                .map(|e| e.kind()),
            Some(io::ErrorKind::InvalidInput)
        );
    }
}

/// Read-only checks against a real speaker, run by hand:
/// `THAUMIC_LAN_IP=… THAUMIC_LAN_PLAYER=RINCON_… THAUMIC_LAN_HH=Sonos_… cargo test -p thaumic-core --lib lan::tls::hardware -- --ignored`
#[cfg(test)]
mod hardware {
    use std::sync::Arc;
    use std::time::Duration;

    use super::TlsConnector;
    use crate::sonos::lan::hub::LanHub;
    use crate::sonos::lan::protocol::{code, LocalInfo, SpeakerIdentity};
    use crate::sonos::lan::socket::LanConnector;
    use crate::sonos::soap::SoapError;

    fn env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("set {name}"))
    }

    #[tokio::test]
    #[ignore = "needs a speaker on the LAN"]
    async fn a_real_speaker_answers_get_groups_and_refuses_to_be_another_player() {
        let (ip, player, hh) = (
            env("THAUMIC_LAN_IP"),
            env("THAUMIC_LAN_PLAYER"),
            env("THAUMIC_LAN_HH"),
        );
        let hub = LanHub::new(Arc::new(TlsConnector::new(Duration::from_secs(5))));
        hub.know(&ip, &player);
        let groups = hub.groups(&ip, &hh).await.expect("getGroups");
        assert!(groups.group_of(&player).is_some(), "{groups:?}");
        println!(
            "{} groups, {} players",
            groups.groups.len(),
            groups.players.len()
        );

        let hub = LanHub::new(Arc::new(TlsConnector::new(Duration::from_secs(5))));
        hub.know(&ip, "RINCON_000000000000001400");
        match hub.groups(&ip, &hh).await {
            Err(SoapError::Lan { code: c, message }) => {
                assert_eq!(c, code::CONNECT_FAILED);
                println!("refused as expected: {message}");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    #[ignore = "needs a speaker on the LAN"]
    async fn a_real_speaker_describes_itself_only_as_itself() {
        let (ip, player, hh) = (
            env("THAUMIC_LAN_IP"),
            env("THAUMIC_LAN_PLAYER"),
            env("THAUMIC_LAN_HH"),
        );
        let tls = TlsConnector::new(Duration::from_secs(5));
        let mut expect = SpeakerIdentity {
            player_id: player.clone(),
            household_id: None,
        };
        let text = tls.local_info(&ip, &expect).await.expect("player info");
        println!("{text}");
        let info = LocalInfo::parse(&text).expect("info parses");
        assert_eq!(
            (info.player_id.as_str(), info.household_id.as_str()),
            (player.as_str(), hh.as_str())
        );

        expect.player_id = "RINCON_000000000000001400".into();
        let refused = tls
            .local_info(&ip, &expect)
            .await
            .expect_err("another player");
        println!("refused as expected: {refused}");
    }
}
