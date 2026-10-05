//! WebSocket client for the bridge (ws_client.go):
//! - TCP keepalive (15 s) and a 10 s connect + handshake timeout
//! - an aggressive ping ticker
//! - a pong watchdog: the read deadline only moves forward when a pong arrives
//! - a background reader that processes control frames and hands text frames to `on_message`
//!
//! Errors from the reader, the pinger or a failed write land on the error channel returned by
//! [`dial`]; the bridge's run loop selects on it and reconnects.
//!
//! `ws://` only: the tablet talks to its own router or the desktop on the LAN (Go's client would
//! also accept `wss://`).

use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{SplitSink, StreamExt};
use futures_util::SinkExt;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Instant};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Bytes, Message};
use tokio_tungstenite::WebSocketStream;

const WRITE_WAIT: Duration = Duration::from_secs(5);
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
const KEEPALIVE: Duration = Duration::from_secs(15);

type Sink = SplitSink<WebSocketStream<TcpStream>, Message>;
pub type OnMessage = Arc<dyn Fn(&str) + Send + Sync>;

pub struct WsConn {
    sink: Arc<Mutex<Sink>>,
    err_tx: mpsc::Sender<String>,
    tasks: Vec<JoinHandle<()>>,
}

fn send_err(tx: &mpsc::Sender<String>, e: impl ToString) {
    let _ = tx.try_send(e.to_string()); // first error wins, like Go's buffered errC
}

/// Splits `ws://host[:port]/path` into the TCP address to dial.
fn tcp_addr(url: &str) -> Result<(String, u16), String> {
    let uri: tokio_tungstenite::tungstenite::http::Uri = url.parse().map_err(|e| format!("parse {url:?}: {e}"))?;
    match uri.scheme_str() {
        Some("ws") => {}
        Some("wss") => return Err("wss:// is not supported by the Rust bridge (use ws://)".into()),
        other => return Err(format!("malformed ws or wss URL (scheme {other:?})")),
    }
    let host = uri.host().ok_or("malformed ws or wss URL (no host)")?;
    let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    Ok((host, uri.port_u16().unwrap_or(80)))
}

pub async fn dial(
    url: &str,
    ping_every: Duration,
    pong_wait: Duration,
    on_message: Option<OnMessage>,
) -> Result<(WsConn, mpsc::Receiver<String>), String> {
    let (host, port) = tcp_addr(url)?;
    let stream = timeout(DIAL_TIMEOUT, TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| format!("dial tcp {host}:{port}: i/o timeout"))?
        .map_err(|e| format!("dial tcp {host}:{port}: {e}"))?;
    let ka = socket2::TcpKeepalive::new().with_time(KEEPALIVE).with_interval(KEEPALIVE);
    let _ = socket2::SockRef::from(&stream).set_tcp_keepalive(&ka);
    let _ = stream.set_nodelay(true);

    let cfg = WebSocketConfig::default().max_message_size(Some(1 << 20));
    let (ws, _resp) = timeout(DIAL_TIMEOUT, tokio_tungstenite::client_async_with_config(url, stream, Some(cfg)))
        .await
        .map_err(|_| "websocket: handshake timeout".to_string())?
        .map_err(|e| format!("websocket: {e}"))?;

    let (sink, mut stream) = ws.split();
    let sink = Arc::new(Mutex::new(sink));
    let (err_tx, err_rx) = mpsc::channel(1);

    // Reader: keeps control frames flowing; the deadline only moves when a pong arrives.
    let reader = {
        let err_tx = err_tx.clone();
        tokio::spawn(async move {
            let mut deadline = Instant::now() + pong_wait;
            loop {
                match tokio::time::timeout_at(deadline, stream.next()).await {
                    Err(_) => return send_err(&err_tx, "read: i/o timeout (no pong)"),
                    Ok(None) => return send_err(&err_tx, "websocket: connection closed"),
                    Ok(Some(Err(e))) => return send_err(&err_tx, e),
                    Ok(Some(Ok(Message::Pong(_)))) => deadline = Instant::now() + pong_wait,
                    Ok(Some(Ok(Message::Text(t)))) => {
                        if let Some(cb) = &on_message {
                            cb(t.as_str());
                        }
                    }
                    Ok(Some(Ok(Message::Close(f)))) => {
                        return send_err(&err_tx, format!("websocket: close {}", f.map(|f| f.code.to_string()).unwrap_or_default()))
                    }
                    Ok(Some(Ok(_))) => {}
                }
            }
        })
    };

    // Pinger.
    let pinger = {
        let err_tx = err_tx.clone();
        let sink = sink.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval_at(Instant::now() + ping_every, ping_every);
            loop {
                t.tick().await;
                let mut s = sink.lock().await;
                match timeout(WRITE_WAIT, s.send(Message::Ping(Bytes::from_static(b"ping")))).await {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => return send_err(&err_tx, e),
                    Err(_) => return send_err(&err_tx, "write: i/o timeout"),
                }
            }
        })
    };

    Ok((WsConn { sink, err_tx, tasks: vec![reader, pinger] }, err_rx))
}

impl WsConn {
    /// Sends one text frame (5 s write deadline). A failure is also reported on the error channel.
    pub async fn write_text(&self, msg: String) -> Result<(), String> {
        let mut s = self.sink.lock().await;
        let r = match timeout(WRITE_WAIT, s.send(Message::text(msg))).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err("write: i/o timeout".to_string()),
        };
        if let Err(e) = &r {
            send_err(&self.err_tx, e);
        }
        r
    }

    /// Stops the reader and pinger and drops the socket (no close handshake, like Go's Close).
    pub fn close(self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

impl Drop for WsConn {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}
