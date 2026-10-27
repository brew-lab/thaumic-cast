//! A fake speaker's Control API for tests: plain WebSocket over TCP on the
//! loopback address, answering each command as a script says, and the
//! quirks the real ones have (late replies, events between replies, a moved
//! group, a socket that drops).

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::Message;

use super::protocol::{Frame, SpeakerIdentity, API_KEY, INFO_PATH, SUBPROTOCOL, WS_PATH};
use super::socket::{LanConnector, LanIo};
use super::tls::get_info;

/// What the fake does with one command.
#[derive(Debug, Clone)]
pub(crate) enum Act {
    /// Answer with this success flag and body.
    Reply { success: bool, body: Value },
    /// Send this frame; `{cmdId}` is replaced with the command's.
    Raw(String),
    /// Wait before the next act (other commands are answered meanwhile).
    Delay(Duration),
    /// Close the socket.
    Close,
}

/// A successful reply with this body.
pub(crate) fn ok(body: Value) -> Act {
    Act::Reply {
        success: true,
        body,
    }
}

type Script = Arc<dyn Fn(&Frame) -> Vec<Act> + Send + Sync>;

/// One fake speaker.
pub(crate) struct FakeSpeaker {
    pub addr: SocketAddr,
    /// Sockets accepted so far.
    pub accepted: Arc<AtomicUsize>,
    /// Every command received, in order.
    pub received: Arc<Mutex<Vec<Frame>>>,
    push: broadcast::Sender<String>,
}

impl FakeSpeaker {
    /// Starts a fake that answers each command with `script`.
    pub async fn start(script: impl Fn(&Frame) -> Vec<Act> + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let script: Script = Arc::new(script);
        let accepted = Arc::new(AtomicUsize::new(0));
        let received = Arc::new(Mutex::new(Vec::new()));
        let push = broadcast::channel::<String>(64).0;
        {
            let (accepted, received, push) = (accepted.clone(), received.clone(), push.clone());
            tokio::spawn(async move {
                while let Ok((tcp, _)) = listener.accept().await {
                    accepted.fetch_add(1, Ordering::SeqCst);
                    tokio::spawn(serve(
                        tcp,
                        script.clone(),
                        received.clone(),
                        push.subscribe(),
                    ));
                }
            });
        }
        Self {
            addr,
            accepted,
            received,
            push,
        }
    }

    /// Sends an event frame on every open socket.
    pub fn push(&self, frame: String) {
        let _ = self.push.send(frame);
    }
}

async fn serve(
    tcp: TcpStream,
    script: Script,
    received: Arc<Mutex<Vec<Frame>>>,
    mut push: broadcast::Receiver<String>,
) {
    // The real speakers refuse a socket without the key and require the
    // subprotocol, which they echo.
    #[allow(clippy::result_large_err)] // the shape tungstenite's callback requires
    let check = |req: &Request, mut resp: Response| -> Result<Response, ErrorResponse> {
        let h = req.headers();
        let key = h.get("X-Sonos-Api-Key").and_then(|v| v.to_str().ok());
        let proto = h
            .get("Sec-WebSocket-Protocol")
            .and_then(|v| v.to_str().ok());
        if key != Some(API_KEY) || proto != Some(SUBPROTOCOL) {
            let mut e = ErrorResponse::new(None);
            *e.status_mut() = StatusCode::UNAUTHORIZED;
            return Err(e);
        }
        resp.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_static(SUBPROTOCOL),
        );
        Ok(resp)
    };
    let Ok(ws) = tokio_tungstenite::accept_hdr_async(tcp, check).await else {
        return;
    };
    let (mut sink, mut stream) = ws.split();
    let (out, mut out_rx) = mpsc::unbounded_channel::<Option<String>>();
    let writer = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            match m {
                Some(text) => {
                    if sink.send(Message::text(text)).await.is_err() {
                        break;
                    }
                }
                None => {
                    let _ = sink.close().await;
                    break;
                }
            }
        }
    });
    loop {
        tokio::select! {
            m = stream.next() => {
                let Some(Ok(Message::Text(text))) = m else { break };
                let Some(frame) = Frame::parse(text.as_str()) else { continue };
                received.lock().push(frame.clone());
                let acts = script(&frame);
                let out = out.clone();
                tokio::spawn(async move {
                    for act in acts {
                        match act {
                            Act::Reply { success, body } => {
                                let mut header = frame.header.clone();
                                let command = header.remove("command").unwrap_or_default();
                                header.insert("response".into(), command);
                                header.insert("success".into(), success.into());
                                let _ = out.send(Some(json!([header, body]).to_string()));
                            }
                            Act::Raw(text) => {
                                let id = frame.cmd_id().unwrap_or_default();
                                let _ = out.send(Some(text.replace("{cmdId}", id)));
                            }
                            Act::Delay(d) => tokio::time::sleep(d).await,
                            Act::Close => {
                                let _ = out.send(None);
                            }
                        }
                    }
                });
            }
            p = push.recv() => {
                let Ok(text) = p else { break };
                let _ = out.send(Some(text));
            }
        }
    }
    writer.abort();
}

/// Connects "speaker IPs" to fakes on the loopback address. An IP with no
/// fake refuses the connection.
#[derive(Default)]
pub(crate) struct FakeConnector {
    addrs: Mutex<HashMap<String, SocketAddr>>,
    /// Connection attempts per IP.
    pub attempts: Mutex<HashMap<String, usize>>,
    /// The identity each attempt expected, in order.
    pub expected: Mutex<Vec<SpeakerIdentity>>,
    /// What each IP answers when asked for its description.
    pub infos: Mutex<HashMap<String, String>>,
}

impl FakeConnector {
    pub fn add(&self, ip: &str, speaker: &FakeSpeaker) {
        self.addrs.lock().insert(ip.to_string(), speaker.addr);
    }

    pub fn attempts(&self, ip: &str) -> usize {
        self.attempts.lock().get(ip).copied().unwrap_or(0)
    }
}

#[async_trait]
impl LanConnector for FakeConnector {
    async fn connect(&self, ip: &str, expect: &SpeakerIdentity) -> io::Result<Box<dyn LanIo>> {
        *self.attempts.lock().entry(ip.to_string()).or_default() += 1;
        self.expected.lock().push(expect.clone());
        let addr = self.addrs.lock().get(ip).copied();
        match addr {
            Some(a) => Ok(Box::new(TcpStream::connect(a).await?)),
            None => Err(io::Error::new(io::ErrorKind::ConnectionRefused, "no fake")),
        }
    }

    fn url(&self, ip: &str) -> String {
        let addr = self.addrs.lock().get(ip).copied();
        match addr {
            Some(a) => format!("ws://{a}/websocket/api"),
            None => format!("ws://{ip}:1/websocket/api"),
        }
    }

    async fn local_info(&self, ip: &str, expect: &SpeakerIdentity) -> io::Result<String> {
        self.expected.lock().push(expect.clone());
        self.infos
            .lock()
            .get(ip)
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::ConnectionRefused, "no fake"))
    }
}

/// Plain TCP and HTTP to speakers that serve the Control API on `port` of
/// their own address, as the fake household in `testing::fake_sonos` does
/// (on its UPnP port). It checks no identity: it records what was expected.
pub(crate) struct PlainConnector {
    port: u16,
    http: reqwest::Client,
    /// The identity each connection or info request expected, in order.
    pub expected: Mutex<Vec<(String, SpeakerIdentity)>>,
}

impl PlainConnector {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            http: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("plain info client"),
            expected: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl LanConnector for PlainConnector {
    async fn connect(&self, ip: &str, expect: &SpeakerIdentity) -> io::Result<Box<dyn LanIo>> {
        self.expected.lock().push((ip.to_string(), expect.clone()));
        Ok(Box::new(TcpStream::connect((ip, self.port)).await?))
    }

    fn url(&self, ip: &str) -> String {
        format!("ws://{ip}:{}{WS_PATH}", self.port)
    }

    async fn local_info(&self, ip: &str, expect: &SpeakerIdentity) -> io::Result<String> {
        self.expected.lock().push((ip.to_string(), expect.clone()));
        get_info(&self.http, &format!("http://{ip}:{}{INFO_PATH}", self.port)).await
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::sonos::lan::hub::LanHub;
    use crate::sonos::lan::protocol::tests::recorded;
    use crate::sonos::lan::protocol::{code, Command, Groups, Target};
    use crate::sonos::lan::socket::{LanEvent, LanSocket};
    use crate::sonos::soap::SoapError;

    const HH: &str = "Sonos_HOUSEHOLD0000000000000000000";
    const OFFICE: &str = "192.168.1.10";
    const OFFICE_ID: &str = "RINCON_000000000A0101400";
    const PLAYBAR: &str = "192.168.1.12";

    fn status(group: &str) -> Command {
        Command::new(
            "playback:1",
            "getPlaybackStatus",
            Target::Group(group.into()),
        )
    }

    /// A hub with short timings that knows Office's player id. The Playbar's
    /// is learnt from a moved-group answer.
    fn hub(connector: Arc<FakeConnector>) -> LanHub {
        let hub = LanHub::new(connector).with_timings(
            Duration::from_millis(300),
            vec![Duration::from_millis(150), Duration::from_millis(300)],
        );
        hub.know(OFFICE, OFFICE_ID);
        hub
    }

    /// The recorded frame with the cmdId placeholder the fake fills in.
    fn recorded_reply(name: &str) -> Act {
        Act::Raw(recorded(name).replace("\"c1\"", "\"{cmdId}\""))
    }

    fn lan_code(e: &SoapError) -> &str {
        match e {
            SoapError::Lan { code, .. } => code,
            other => panic!("not a Lan error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_call_sends_the_household_and_target_and_reads_the_recorded_reply() {
        let office =
            FakeSpeaker::start(|_| vec![recorded_reply("reply_get_playback_status")]).await;
        let c = Arc::new(FakeConnector::default());
        c.add(OFFICE, &office);
        let hub = hub(c);

        let r = hub.call(OFFICE, HH, &status("RINCON_A:5")).await.unwrap();
        assert_eq!(r.ip, OFFICE);
        assert_eq!(r.frame().body["_objectType"], "playbackStatus");
        assert!(r.reply.answered_at >= r.reply.sent_at);

        let sent = office.received.lock()[0].clone();
        assert_eq!(sent.header["command"], "getPlaybackStatus");
        assert_eq!(sent.household_id(), Some(HH));
        assert_eq!(sent.group_id(), Some("RINCON_A:5"));
    }

    #[tokio::test]
    async fn replies_reach_their_own_call_when_they_come_out_of_order() {
        let office = FakeSpeaker::start(|f| {
            let slow = f.group_id() == Some("slow");
            let mut acts = Vec::new();
            if slow {
                acts.push(Act::Delay(Duration::from_millis(120)));
            }
            acts.push(ok(json!({ "which": f.group_id() })));
            acts
        })
        .await;
        let c = Arc::new(FakeConnector::default());
        c.add(OFFICE, &office);
        let hub = hub(c);

        let (slow_cmd, fast_cmd) = (status("slow"), status("fast"));
        let (slow, fast) = tokio::join!(
            hub.call(OFFICE, HH, &slow_cmd),
            hub.call(OFFICE, HH, &fast_cmd),
        );
        assert_eq!(slow.unwrap().frame().body["which"], "slow");
        assert_eq!(fast.unwrap().frame().body["which"], "fast");
        assert_eq!(
            office.accepted.load(Ordering::SeqCst),
            1,
            "one socket per speaker"
        );
    }

    #[tokio::test]
    async fn events_between_replies_go_to_subscribers_tagged_with_the_speaker() {
        let office = FakeSpeaker::start(|_| {
            vec![Act::Raw(recorded("event_session_evicted")), ok(json!({}))]
        })
        .await;
        let c = Arc::new(FakeConnector::default());
        c.add(OFFICE, &office);
        let hub = hub(c);
        let mut events = hub.subscribe();

        hub.call(OFFICE, HH, &status("g")).await.unwrap();
        match events.recv().await.unwrap() {
            LanEvent::Frame { ip, frame, .. } => {
                assert_eq!(ip, OFFICE);
                assert_eq!(frame.error_code(), Some(code::SESSION_EVICTED));
            }
            other => panic!("unexpected {other:?}"),
        }

        office.push(recorded("event_playback_status"));
        match events.recv().await.unwrap() {
            LanEvent::Frame { frame, .. } => assert_eq!(frame.name(), "playbackStatus"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn authentication_on_is_upnp_disabled_and_other_refusals_keep_their_code() {
        let office = FakeSpeaker::start(|f| match f.group_id() {
            Some("auth") => vec![recorded_reply("reply_no_permission")],
            _ => vec![Act::Reply {
                success: false,
                body: json!({ "_objectType": "globalError", "errorCode": "ERROR_INVALID_OBJECT_ID", "reason": "There is no session on this player." }),
            }],
        })
        .await;
        let c = Arc::new(FakeConnector::default());
        c.add(OFFICE, &office);
        let hub = hub(c);

        let e = hub.call(OFFICE, HH, &status("auth")).await.unwrap_err();
        assert!(matches!(e, SoapError::UpnpDisabled), "{e:?}");
        let e = hub.call(OFFICE, HH, &status("other")).await.unwrap_err();
        assert_eq!(lan_code(&e), "ERROR_INVALID_OBJECT_ID");
        assert!(!e.is_transient());
        assert!(e
            .to_string()
            .contains("There is no session on this player."));
    }

    #[tokio::test]
    async fn a_moved_group_is_followed_once_to_the_leader_it_names() {
        // Office answers as a member whose group now belongs to the Playbar.
        let office = FakeSpeaker::start(|_| vec![recorded_reply("reply_group_moved")]).await;
        let playbar =
            FakeSpeaker::start(|_| vec![recorded_reply("reply_get_playback_status")]).await;
        let c = Arc::new(FakeConnector::default());
        c.add(OFFICE, &office);
        c.add(PLAYBAR, &playbar);
        let hub = hub(c.clone());

        let r = hub.call(OFFICE, HH, &status("g")).await.unwrap();
        assert_eq!(r.ip, PLAYBAR);
        assert_eq!(playbar.received.lock().len(), 1);
        // The Playbar's socket expected the player the answer named.
        assert_eq!(
            c.expected.lock().last().map(|e| e.player_id.clone()),
            Some("RINCON_000000000C0101400".to_string())
        );

        // A leader that says it moved again is not chased further.
        let again = FakeSpeaker::start(|_| vec![recorded_reply("reply_group_moved")]).await;
        let c = Arc::new(FakeConnector::default());
        c.add(OFFICE, &office);
        c.add(PLAYBAR, &again);
        let hub = LanHub::new(c);
        hub.know(OFFICE, OFFICE_ID);
        let e = hub.call(OFFICE, HH, &status("g")).await.unwrap_err();
        assert_eq!(lan_code(&e), code::GROUP_MOVED);
        assert_eq!(again.received.lock().len(), 1);
    }

    #[tokio::test]
    async fn no_reply_times_out_as_transient_gives_the_socket_up_and_drops_the_late_reply() {
        let office = FakeSpeaker::start(|f| match f.group_id() {
            Some("late") => vec![Act::Delay(Duration::from_millis(500)), ok(json!({}))],
            _ => vec![ok(json!({ "fresh": true }))],
        })
        .await;
        let c = Arc::new(FakeConnector::default());
        c.add(OFFICE, &office);
        let hub = hub(c);
        let mut events = hub.subscribe();

        let started = Instant::now();
        let e = hub.call(OFFICE, HH, &status("late")).await.unwrap_err();
        assert_eq!(lan_code(&e), code::TIMEOUT);
        assert!(e.is_transient());
        assert!(started.elapsed() < Duration::from_millis(450));

        tokio::time::sleep(Duration::from_millis(300)).await;
        // A socket that left a call unanswered may be half-open: it is given
        // up, and the next call opens a fresh one.
        let r = hub.call(OFFICE, HH, &status("next")).await.unwrap();
        assert_eq!(r.frame().body["fresh"], true);
        assert_eq!(office.accepted.load(Ordering::SeqCst), 2);
        let mut seen = Vec::new();
        while let Ok(event) = events.try_recv() {
            seen.push(event);
        }
        assert!(
            !seen.iter().any(|e| matches!(e, LanEvent::Frame { .. })),
            "a late reply is not an event: {seen:?}"
        );
        assert!(seen
            .iter()
            .any(|e| matches!(e, LanEvent::Closed { ip } if ip == OFFICE)));
    }

    #[tokio::test]
    async fn a_dropped_socket_fails_its_call_and_the_next_call_reconnects() {
        let office = FakeSpeaker::start(|f| match f.group_id() {
            Some("drop") => vec![Act::Close],
            _ => vec![ok(json!({}))],
        })
        .await;
        let c = Arc::new(FakeConnector::default());
        c.add(OFFICE, &office);
        let hub = hub(c);
        let mut events = hub.subscribe();

        let e = hub.call(OFFICE, HH, &status("drop")).await.unwrap_err();
        assert_eq!(lan_code(&e), code::SOCKET_CLOSED);
        assert!(e.is_transient());
        assert!(matches!(events.recv().await.unwrap(), LanEvent::Closed { ip } if ip == OFFICE));

        hub.call(OFFICE, HH, &status("g")).await.unwrap();
        assert!(
            matches!(events.recv().await.unwrap(), LanEvent::Reconnected { ip } if ip == OFFICE)
        );
        assert_eq!(office.accepted.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_unreachable_speaker_is_not_dialled_again_until_the_backoff_passes() {
        let c = Arc::new(FakeConnector::default());
        let hub = hub(c.clone());

        let e = hub.call(OFFICE, HH, &status("g")).await.unwrap_err();
        assert_eq!(lan_code(&e), code::CONNECT_FAILED);
        assert!(!e.is_transient(), "retrying at once would only dial again");
        let e = hub.call(OFFICE, HH, &status("g")).await.unwrap_err();
        assert_eq!(lan_code(&e), code::CONNECT_FAILED);
        assert_eq!(c.attempts(OFFICE), 1, "second call waits out the backoff");

        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = hub.call(OFFICE, HH, &status("g")).await;
        assert_eq!(c.attempts(OFFICE), 2);

        // The second wait is longer, and a speaker that comes back resets it.
        let office = FakeSpeaker::start(|_| vec![ok(json!({}))]).await;
        c.add(OFFICE, &office);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(hub.call(OFFICE, HH, &status("g")).await.is_err());
        assert_eq!(c.attempts(OFFICE), 2);
        tokio::time::sleep(Duration::from_millis(150)).await;
        hub.call(OFFICE, HH, &status("g")).await.unwrap();
        assert_eq!(c.attempts(OFFICE), 3);
    }

    #[tokio::test]
    async fn a_socket_without_the_key_is_refused_by_the_fake_as_by_a_speaker() {
        // Guards the fake itself: the hub's own handshake must carry both
        // headers, or every other test here would fail to connect.
        let office = FakeSpeaker::start(|_| vec![ok(json!({}))]).await;
        let url = format!("ws://{}/websocket/api", office.addr);
        assert!(tokio_tungstenite::connect_async(url).await.is_err());

        let c = FakeConnector::default();
        c.add(OFFICE, &office);
        let events = broadcast::channel(4).0;
        let expect = SpeakerIdentity {
            player_id: OFFICE_ID.into(),
            household_id: None,
        };
        let sock = LanSocket::open(&c, OFFICE, &expect, events, Duration::from_secs(1))
            .await
            .unwrap();
        assert!(!sock.is_closed());
    }

    #[tokio::test]
    async fn a_group_change_is_confirmed_by_reading_the_groups_back() {
        // The member shows up in the coordinator's group on the third read.
        let reads = Arc::new(AtomicUsize::new(0));
        let office = {
            let reads = reads.clone();
            FakeSpeaker::start(move |_| {
                let n = reads.fetch_add(1, Ordering::SeqCst);
                let members = if n >= 2 {
                    json!(["RINCON_A", "RINCON_B"])
                } else {
                    json!(["RINCON_A"])
                };
                vec![ok(json!({
                    "_objectType": "groups",
                    "groups": [{ "id": "RINCON_A:9", "name": "Office", "coordinatorId": "RINCON_A", "playerIds": members }],
                    "players": [],
                }))]
            })
            .await
        };
        let c = Arc::new(FakeConnector::default());
        c.add(OFFICE, &office);
        let hub = hub(c);
        let joined = |g: &Groups| {
            g.group_of("RINCON_A")
                .is_some_and(|x| x.player_ids.iter().any(|p| p == "RINCON_B"))
        };

        let g = hub
            .wait_for_groups(OFFICE, HH, Duration::from_secs(2), joined)
            .await
            .unwrap();
        assert!(joined(&g));
        assert_eq!(reads.load(Ordering::SeqCst), 3);

        let never = |_: &Groups| false;
        let e = hub
            .wait_for_groups(OFFICE, HH, Duration::from_millis(250), never)
            .await
            .unwrap_err();
        assert_eq!(lan_code(&e), code::TIMEOUT);
    }

    #[tokio::test]
    async fn forgetting_a_speaker_closes_its_socket() {
        let office = FakeSpeaker::start(|_| vec![ok(json!({}))]).await;
        let c = Arc::new(FakeConnector::default());
        c.add(OFFICE, &office);
        let hub = hub(c);
        let mut events = hub.subscribe();

        hub.call(OFFICE, HH, &status("g")).await.unwrap();
        hub.forget(OFFICE).await;
        assert!(matches!(
            events.recv().await.unwrap(),
            LanEvent::Closed { .. }
        ));
        hub.call(OFFICE, HH, &status("g")).await.unwrap();
        assert_eq!(office.accepted.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_socket_opens_only_to_a_known_player_and_expects_it_with_the_household() {
        let office = FakeSpeaker::start(|_| vec![ok(json!({}))]).await;
        let c = Arc::new(FakeConnector::default());
        c.add(OFFICE, &office);
        c.add(PLAYBAR, &office);
        let hub = hub(c.clone());

        let e = hub.call(PLAYBAR, HH, &status("g")).await.unwrap_err();
        assert_eq!(lan_code(&e), code::CONNECT_FAILED);
        assert_eq!(c.attempts(PLAYBAR), 0, "never dialled");

        hub.call(OFFICE, HH, &status("g")).await.unwrap();
        assert_eq!(
            c.expected.lock().clone(),
            vec![SpeakerIdentity {
                player_id: OFFICE_ID.into(),
                household_id: Some(HH.into()),
            }]
        );
    }

    #[tokio::test]
    async fn another_player_at_a_known_address_gets_a_new_socket() {
        let office = FakeSpeaker::start(|_| vec![ok(json!({}))]).await;
        let c = Arc::new(FakeConnector::default());
        c.add(OFFICE, &office);
        let hub = hub(c.clone());

        hub.call(OFFICE, HH, &status("g")).await.unwrap();
        hub.know(OFFICE, OFFICE_ID);
        hub.call(OFFICE, HH, &status("g")).await.unwrap();
        assert_eq!(c.attempts(OFFICE), 1, "same player, same socket");

        hub.know(OFFICE, "RINCON_000000000B0101400");
        hub.call(OFFICE, HH, &status("g")).await.unwrap();
        assert_eq!(c.attempts(OFFICE), 2);
        assert_eq!(
            c.expected.lock().last().map(|e| e.player_id.clone()),
            Some("RINCON_000000000B0101400".to_string())
        );
    }
}
