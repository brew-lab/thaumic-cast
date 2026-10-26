//! One WebSocket to one speaker's Control API.
//!
//! A reader task routes each reply to the call waiting on its `cmdId` and
//! sends everything else out as a [`LanEvent`]. Calls never retry and never
//! reconnect: the hub decides that. When the socket ends, every waiting call
//! fails with `LAN_SOCKET_CLOSED` and a [`LanEvent::Closed`] goes out.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use super::protocol::{
    code, transport_error, Command, Frame, SpeakerIdentity, API_KEY, SUBPROTOCOL,
};
use crate::sonos::soap::SoapError;

/// A byte stream a socket runs over.
pub trait LanIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> LanIo for T {}

/// Opens the byte stream to a speaker and names the URL its WebSocket
/// handshake asks for. Production goes over TLS to port 1443; tests use plain
/// TCP to a fake speaker.
#[async_trait]
pub trait LanConnector: Send + Sync {
    /// Opens the stream to the speaker at `ip`, which must prove to be
    /// `expect`.
    async fn connect(&self, ip: &str, expect: &SpeakerIdentity) -> io::Result<Box<dyn LanIo>>;

    /// The URL for the WebSocket handshake to the speaker at `ip`.
    fn url(&self, ip: &str) -> String;
}

/// Something a speaker sent that was not a reply to a call, or a change in a
/// socket's state.
#[derive(Debug, Clone)]
pub enum LanEvent {
    /// An event frame (`playbackStatus`, `sessionError`, `groups`, ...).
    Frame {
        /// The speaker it came from.
        ip: String,
        /// When it arrived.
        at: Instant,
        /// The frame.
        frame: Arc<Frame>,
    },
    /// The socket to `ip` ended. Subscriptions on it are gone.
    Closed {
        /// The speaker.
        ip: String,
    },
    /// The hub opened a new socket to `ip` after one had closed, so
    /// subscriptions must be made again.
    Reconnected {
        /// The speaker.
        ip: String,
    },
}

/// A reply, with the bracket around it that the speaker monitor needs.
#[derive(Debug, Clone)]
pub struct Reply {
    /// The reply frame, success or not.
    pub frame: Frame,
    /// Just before the command was handed to the socket.
    pub sent_at: Instant,
    /// When the reply was read.
    pub answered_at: Instant,
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<(Frame, Instant)>>>>;

/// An open socket to one speaker.
pub struct LanSocket {
    ip: String,
    out: mpsc::UnboundedSender<Message>,
    pending: Pending,
    closed: Arc<AtomicBool>,
    next_id: AtomicU64,
}

impl LanSocket {
    /// Opens the socket: the connector's stream, then the WebSocket
    /// handshake with the API key and subprotocol, all within `timeout`.
    pub async fn open(
        connector: &dyn LanConnector,
        ip: &str,
        expect: &SpeakerIdentity,
        events: broadcast::Sender<LanEvent>,
        timeout: Duration,
    ) -> Result<Self, SoapError> {
        let fail = |what: String| transport_error(code::CONNECT_FAILED, format!("{ip}: {what}"));
        let mut request = connector
            .url(ip)
            .into_client_request()
            .map_err(|e| fail(e.to_string()))?;
        let headers = request.headers_mut();
        headers.insert("X-Sonos-Api-Key", HeaderValue::from_static(API_KEY));
        headers.insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_static(SUBPROTOCOL),
        );
        let open = async {
            let io = connector
                .connect(ip, expect)
                .await
                .map_err(|e| fail(e.to_string()))?;
            tokio_tungstenite::client_async(request, io)
                .await
                .map_err(|e| fail(e.to_string()))
        };
        let (ws, _response) = tokio::time::timeout(timeout, open)
            .await
            .map_err(|_| fail(format!("no handshake in {} ms", timeout.as_millis())))??;
        let (mut sink, mut stream) = ws.split();

        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        tokio::spawn(async move {
            while let Some(m) = out_rx.recv().await {
                let closing = matches!(m, Message::Close(_));
                if sink.send(m).await.is_err() || closing {
                    break;
                }
            }
        });

        let pending: Pending = Arc::default();
        let closed = Arc::new(AtomicBool::new(false));
        {
            let (ip, pending, closed) = (ip.to_string(), pending.clone(), closed.clone());
            tokio::spawn(async move {
                while let Some(Ok(m)) = stream.next().await {
                    let text = match &m {
                        Message::Text(t) => t.as_str(),
                        Message::Close(_) => break,
                        _ => continue,
                    };
                    let at = Instant::now();
                    let Some(frame) = Frame::parse(text) else {
                        log::debug!("[Lan] {ip}: ignoring a frame that is not [header, body]");
                        continue;
                    };
                    if let Some(id) = frame.cmd_id() {
                        match pending.lock().remove(id) {
                            Some(waiter) => {
                                let _ = waiter.send((frame, at));
                            }
                            None => log::debug!("[Lan] {ip}: late reply {id} dropped"),
                        }
                        continue;
                    }
                    let _ = events.send(LanEvent::Frame {
                        ip: ip.clone(),
                        at,
                        frame: Arc::new(frame),
                    });
                }
                closed.store(true, Ordering::SeqCst);
                // Dropping the senders wakes every waiting call.
                pending.lock().clear();
                log::info!("[Lan] {ip}: socket closed");
                let _ = events.send(LanEvent::Closed { ip });
            });
        }

        Ok(Self {
            ip: ip.to_string(),
            out,
            pending,
            closed,
            next_id: AtomicU64::new(1),
        })
    }

    /// The speaker this socket goes to.
    #[must_use]
    pub fn ip(&self) -> &str {
        &self.ip
    }

    /// Whether the socket has ended.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Sends a command and waits up to `timeout` for its reply. A reply that
    /// reports failure is still `Ok` here; only a missing reply is an error.
    pub async fn call(
        &self,
        household_id: &str,
        cmd: &Command,
        timeout: Duration,
    ) -> Result<Reply, SoapError> {
        if self.is_closed() {
            return Err(transport_error(
                code::SOCKET_CLOSED,
                format!("{}: socket is closed", self.ip),
            ));
        }
        let id = format!("t{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id.clone(), tx);
        let sent_at = Instant::now();
        if self
            .out
            .send(Message::text(cmd.to_frame(household_id, &id)))
            .is_err()
        {
            self.pending.lock().remove(&id);
            return Err(transport_error(
                code::SOCKET_CLOSED,
                format!("{}: socket is closed", self.ip),
            ));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok((frame, answered_at))) => Ok(Reply {
                frame,
                sent_at,
                answered_at,
            }),
            Ok(Err(_)) => Err(transport_error(
                code::SOCKET_CLOSED,
                format!("{}: socket closed during {}", self.ip, cmd.key()),
            )),
            Err(_) => {
                self.pending.lock().remove(&id);
                Err(transport_error(
                    code::TIMEOUT,
                    format!(
                        "{}: no reply to {} in {} ms",
                        self.ip,
                        cmd.key(),
                        timeout.as_millis()
                    ),
                ))
            }
        }
    }

    /// Closes the socket. Waiting calls fail as closed.
    pub fn close(&self) {
        let _ = self.out.send(Message::Close(None));
    }
}

impl Drop for LanSocket {
    /// Closes the socket; the reader ends when the speaker closes its side,
    /// which sends [`LanEvent::Closed`] as usual.
    fn drop(&mut self) {
        self.close();
    }
}
