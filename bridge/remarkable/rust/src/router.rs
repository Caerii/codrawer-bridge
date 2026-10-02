//! The stroke-only session router (router/router.go + serve.go), small enough to run on the
//! Paper Pro inside the bridge binary so the glasses app can connect to the tablet directly.
//!
//! Scope: hello, stroke_*, key, cursor, clear, doc, and shared live editing (doc_update). AI (prompt, ai_*) and the terminal
//! (term_prompt/term_answer) stay on the desktop Python router; here they are dropped, and a
//! term_* request gets a one-line `term` status so the client is not left waiting.
//!
//! Beyond the Python router:
//! - A client that joins mid-drawing gets the current page replayed (begin/pts/end per stroke).
//! - Every client has its own bounded send queue; a client that falls behind is dropped (it
//!   reconnects and gets the replay) instead of stalling the tablet's stream.
//! - The router pings clients and drops ones that stop answering.
//!
//! Shared live editing: clients keep the session document as a Yjs CRDT and send
//! `{"t":"doc_update","u":<base64>}`. The router never decodes them; it relays each one, keeps the
//! log and replays it to joiners as `{"t":"doc_update","us":[...]}`. When the log grows past
//! [`DOC_COMPACT_AT`] it asks the client that just wrote for `{"t":"doc_state","u":<full state>}`
//! and replaces the log with that state plus everything that arrived after the request.
//!
//! Serves `GET /healthz` and `GET /ws/{session}` on a plain TCP listener: the HTTP request head
//! is read here, then handed (replayed) to tungstenite for the WebSocket handshake.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{timeout, Instant};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Bytes, Message, Utf8Bytes};

/// Messages buffered per client before it counts as stalled.
pub const SEND_QUEUE: usize = 1024;
/// Server → client keepalive.
pub const PING_EVERY: Duration = Duration::from_secs(10);
/// Drop a client silent for this long.
pub const PONG_WAIT: Duration = Duration::from_secs(30);
pub const WRITE_WAIT: Duration = Duration::from_secs(5);
/// Points per replayed stroke_pts message.
pub const REPLAY_PTS: usize = 256;
pub const MAX_STROKES: usize = 4000;
/// Page memory bound; the oldest strokes go first.
pub const MAX_POINTS: usize = 400_000;
pub const MAX_MESSAGE: usize = 1 << 20;
/// doc_update log entries before asking a client for a snapshot.
pub const DOC_COMPACT_AT: usize = 256;
/// Updates per replayed doc_update message.
pub const DOC_REPLAY_N: usize = 256;
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HEADER: usize = 64 << 10;

const TERM_STATUS: &str = "no terminal on this router (tablet-local; stroke streaming only)";

pub type Logf = Arc<dyn Fn(&str) + Send + Sync>;

/// Holds the sessions. Cheap to clone (shared state).
#[derive(Clone)]
pub struct Router {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
    next_client: Arc<AtomicU64>,
    logf: Logf,
}

impl Default for Router {
    fn default() -> Self {
        Self::new()
    }
}

impl Router {
    /// Logs like Go's `log.Printf` (timestamped, stderr).
    pub fn new() -> Self {
        Self::with_logger(Arc::new(|s: &str| eprintln!("{}{}", crate::util::log_timestamp(), s)))
    }

    pub fn with_logger(logf: Logf) -> Self {
        Router { sessions: Arc::default(), next_client: Arc::new(AtomicU64::new(1)), logf }
    }

    pub fn quiet() -> Self {
        Self::with_logger(Arc::new(|_: &str| {}))
    }

    fn session(&self, id: &str) -> Arc<Mutex<Session>> {
        let mut m = self.sessions.lock().unwrap();
        m.entry(id.to_string()).or_insert_with(|| Arc::new(Mutex::new(Session::default()))).clone()
    }

    /// Accepts connections forever.
    pub async fn serve(self, listener: TcpListener) -> io::Result<()> {
        loop {
            let (stream, addr) = match listener.accept().await {
                Ok(a) => a,
                Err(e) => {
                    // EMFILE and friends: back off instead of spinning (Go's http.Server does too).
                    (self.logf)(&format!("http: Accept error: {e}; retrying in 50ms"));
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            let _ = stream.set_nodelay(true);
            let r = self.clone();
            tokio::spawn(async move { r.handle_conn(stream, addr).await });
        }
    }

    async fn handle_conn(self, mut stream: TcpStream, addr: SocketAddr) {
        let head = match timeout(HEADER_TIMEOUT, read_head(&mut stream)).await {
            Ok(Ok(h)) => h,
            _ => return,
        };
        let Some(req) = parse_head(&head) else {
            let _ = respond(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", "400 Bad Request").await;
            return;
        };
        if req.path == "/healthz" {
            let _ = respond(&mut stream, "200 OK", "application/json", r#"{"ok":true}"#).await;
            return;
        }
        let Some(rest) = req.path.strip_prefix("/ws/") else {
            let _ = respond(&mut stream, "404 Not Found", "text/plain; charset=utf-8", "404 page not found\n").await;
            return;
        };
        let id = rest.trim_matches('/').to_string();
        if id.is_empty() || id.contains('/') {
            let _ = respond(&mut stream, "404 Not Found", "text/plain; charset=utf-8", "404 page not found\n").await;
            return;
        }
        if !req.upgrade {
            let _ = respond(&mut stream, "400 Bad Request", "text/plain; charset=utf-8", "Bad Request\n").await;
            return;
        }
        let cfg = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
        let io = Prefixed { prefix: head, pos: 0, inner: stream };
        let Ok(ws) = tokio_tungstenite::accept_async_with_config(io, Some(cfg)).await else {
            return;
        };
        // Log IPv4 peers on the dual-stack socket as 1.2.3.4:port, not [::ffff:1.2.3.4]:port.
        let addr = SocketAddr::new(addr.ip().to_canonical(), addr.port());
        self.run_client(ws, id, addr.to_string()).await;
    }

    async fn run_client(self, ws: tokio_tungstenite::WebSocketStream<Prefixed>, id: String, addr: String) {
        let sess = self.session(&id);
        let cid = self.next_client.fetch_add(1, Ordering::Relaxed);

        // Register and queue hello + replay under the session lock, so no live message can slip
        // in between the replay and the first broadcast this client sees.
        let (client, rx, n) = {
            let mut s = sess.lock().unwrap();
            let replay = s.replay();
            // Deliberate deviation from Go: the queue holds the whole replay on top of the live
            // budget, so a late joiner on a busy page is not dropped as "stalled" before its
            // writer has sent anything (Go queues the replay into the same 1024 slots).
            let (tx, rx) = mpsc::channel(SEND_QUEUE + replay.len() + 1);
            let client = Arc::new(Client { addr: addr.clone(), tx: Mutex::new(Some(tx)) });
            client.queue(json_msg(&Hello { t: "hello", session: &id }));
            for m in replay {
                client.queue(m);
            }
            s.clients.insert(cid, client.clone());
            (client, rx, s.clients.len())
        };
        (self.logf)(&format!("[router] {addr} joined {id} ({n} clients)"));

        let (sink, stream) = ws.split();
        let (writer_done_tx, writer_done) = oneshot::channel::<()>();
        tokio::spawn(write_loop(sink, rx, writer_done_tx));
        read_loop(stream, &sess, cid, &client, writer_done).await;

        let n = {
            let mut s = sess.lock().unwrap();
            s.clients.remove(&cid);
            if s.compact_who == Some(cid) {
                s.compact_who = None; // ask someone else next time
            }
            s.clients.len()
        };
        client.close();
        (self.logf)(&format!("[router] {addr} left {id} ({n} clients)"));
    }
}

/// Binds `addr` the way Go's `net.Listen("tcp", addr)` does (":8577" = every interface, IPv4
/// and IPv6) and serves until the process exits.
pub async fn bind(addr: &str) -> io::Result<TcpListener> {
    if let Some(port) = addr.strip_prefix(':') {
        let port: u16 = port.parse().map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, format!("listen tcp {addr}: invalid port")))?;
        // Dual-stack first; fall back to IPv4 where IPv6 is unavailable.
        if let Ok(l) = dual_stack(port) {
            return Ok(l);
        }
        return TcpListener::bind(("0.0.0.0", port)).await;
    }
    TcpListener::bind(addr).await
}

fn dual_stack(port: u16) -> io::Result<TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    let s = Socket::new(Domain::IPV6, Type::STREAM, Some(Protocol::TCP))?;
    s.set_only_v6(false)?;
    #[cfg(unix)]
    s.set_reuse_address(true)?;
    s.bind(&SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, port)).into())?;
    s.listen(1024)?;
    s.set_nonblocking(true)?;
    TcpListener::from_std(s.into())
}

// ── HTTP head ──────────────────────────────────────────────────────────────

struct Head {
    path: String,
    upgrade: bool,
}

async fn read_head(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            return Ok(buf);
        }
        if buf.len() > MAX_HEADER {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "header too large"));
        }
    }
}

fn parse_head(head: &[u8]) -> Option<Head> {
    let end = head.windows(4).position(|w| w == b"\r\n\r\n")?;
    let text = std::str::from_utf8(&head[..end]).ok()?;
    let mut lines = text.split("\r\n");
    let mut parts = lines.next()?.split(' ');
    let (_method, target) = (parts.next()?, parts.next()?);
    let raw_path = target.split('?').next().unwrap_or("");
    let path = percent_decode(raw_path)?;
    let upgrade = lines.any(|l| {
        l.split_once(':')
            .is_some_and(|(k, v)| k.trim().eq_ignore_ascii_case("upgrade") && v.trim().eq_ignore_ascii_case("websocket"))
    });
    Some(Head { path, upgrade })
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

async fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: &str) -> io::Result<()> {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.shutdown().await
}

/// A TCP stream that first replays the request head already read from it.
pub struct Prefixed {
    prefix: Vec<u8>,
    pos: usize,
    inner: TcpStream,
}

impl AsyncRead for Prefixed {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if self.pos < self.prefix.len() {
            let n = (self.prefix.len() - self.pos).min(buf.remaining());
            let start = self.pos;
            buf.put_slice(&self.prefix[start..start + n]);
            self.pos += n;
            if self.pos == self.prefix.len() {
                self.prefix = Vec::new();
                self.pos = 0;
            }
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for Prefixed {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

// ── messages ───────────────────────────────────────────────────────────────

/// The part of a message the router looks at; the raw text is forwarded as-is.
#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(default)]
    t: String,
    #[serde(default)]
    id: String,
    #[serde(default, borrow)]
    pts: Option<Vec<&'a RawValue>>,
    #[serde(default)]
    u: String,
}

#[derive(Serialize)]
struct Hello<'a> {
    t: &'static str,
    session: &'a str,
}

#[derive(Serialize)]
struct Term {
    t: &'static str,
    kind: &'static str,
    text: &'static str,
}

#[derive(Serialize)]
struct ReplayPts<'a> {
    t: &'static str,
    id: &'a str,
    pts: &'a [Box<RawValue>],
}

#[derive(Serialize)]
struct ReplayDoc<'a> {
    t: &'static str,
    us: &'a [String],
}

#[derive(Serialize)]
struct ReplayEnd<'a> {
    t: &'static str,
    id: &'a str,
}

fn json_msg<T: Serialize>(v: &T) -> Utf8Bytes {
    Utf8Bytes::from(serde_json::to_string(v).expect("serialize"))
}

// ── session ────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Session {
    clients: HashMap<u64, Arc<Client>>,
    /// The page: strokes since the last clear, in arrival order, for replay to late joiners.
    order: VecDeque<String>,
    strokes: HashMap<String, Stroke>,
    points: usize,
    /// Shared document: Yjs updates (base64) in arrival order; survives clear (it is not ink).
    doc_log: Vec<String>,
    /// The client asked for a doc_state, if any.
    compact_who: Option<u64>,
    /// doc_log length when it was asked.
    compact_from: usize,
}

struct Stroke {
    /// The stroke_begin message as received.
    begin: Utf8Bytes,
    /// Every point, as received.
    pts: Vec<Box<RawValue>>,
    ended: bool,
}

impl Session {
    fn record(&mut self, m: &Envelope<'_>, raw: &Utf8Bytes) {
        if m.id.is_empty() {
            return;
        }
        match m.t.as_str() {
            "stroke_begin" => {
                if let Some(old) = self.strokes.get(&m.id) {
                    self.points -= old.pts.len();
                } else {
                    self.order.push_back(m.id.clone());
                }
                self.strokes.insert(m.id.clone(), Stroke { begin: raw.clone(), pts: Vec::new(), ended: false });
            }
            "stroke_pts" => {
                // Points for a stroke that began before a clear or before we started are dropped.
                let Some(st) = self.strokes.get_mut(&m.id) else { return };
                let pts = m.pts.as_deref().unwrap_or_default();
                st.pts.extend(pts.iter().map(|p| (*p).to_owned()));
                self.points += pts.len();
            }
            "stroke_end" => {
                if let Some(st) = self.strokes.get_mut(&m.id) {
                    st.ended = true;
                }
            }
            _ => {}
        }
        while (self.order.len() > MAX_STROKES || self.points > MAX_POINTS) && self.order.len() > 1 {
            let oldest = self.order.pop_front().expect("non-empty");
            if let Some(st) = self.strokes.remove(&oldest) {
                self.points -= st.pts.len();
            }
        }
    }

    fn reset(&mut self) {
        self.order.clear();
        self.strokes.clear();
        self.points = 0;
    }

    /// The page as the messages a client would have seen live.
    fn replay(&self) -> Vec<Utf8Bytes> {
        let mut out = Vec::new();
        for id in &self.order {
            let Some(st) = self.strokes.get(id) else { continue };
            out.push(st.begin.clone());
            for chunk in st.pts.chunks(REPLAY_PTS) {
                out.push(json_msg(&ReplayPts { t: "stroke_pts", id, pts: chunk }));
            }
            if st.ended {
                out.push(json_msg(&ReplayEnd { t: "stroke_end", id }));
            }
        }
        for chunk in self.doc_log.chunks(DOC_REPLAY_N) {
            out.push(json_msg(&ReplayDoc { t: "doc_update", us: chunk }));
        }
        out
    }

    fn broadcast(&self, raw: &Utf8Bytes, from: u64) {
        for (id, c) in &self.clients {
            if *id != from {
                c.queue(raw.clone()); // Utf8Bytes is refcounted: one buffer for every client
            }
        }
    }
}

// ── client ─────────────────────────────────────────────────────────────────

struct Client {
    #[allow(dead_code)]
    addr: String,
    /// `None` once closed; dropping the sender lets the writer drain and send a close frame.
    tx: Mutex<Option<mpsc::Sender<Utf8Bytes>>>,
}

impl Client {
    /// Never blocks: a client whose queue is full is closed (it will reconnect and replay).
    fn queue(&self, msg: Utf8Bytes) {
        let mut g = self.tx.lock().unwrap();
        if let Some(tx) = g.as_ref() {
            if tx.try_send(msg).is_err() {
                *g = None;
            }
        }
    }

    fn close(&self) {
        *self.tx.lock().unwrap() = None;
    }
}

type WsSink = futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<Prefixed>, Message>;
type WsStream = futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<Prefixed>>;

async fn read_loop(mut stream: WsStream, sess: &Mutex<Session>, cid: u64, client: &Client, mut writer_done: oneshot::Receiver<()>) {
    let mut deadline = Instant::now() + PONG_WAIT;
    loop {
        let next = tokio::select! {
            r = tokio::time::timeout_at(deadline, stream.next()) => r,
            _ = &mut writer_done => return, // the writer closed the connection
        };
        let msg = match next {
            Ok(Some(Ok(m))) => m,
            _ => return, // timeout, EOF or protocol error
        };
        deadline = Instant::now() + PONG_WAIT; // any traffic counts as alive
        let Message::Text(raw) = msg else { continue };
        let Ok(m) = serde_json::from_str::<Envelope<'_>>(raw.as_str()) else { continue };
        match m.t.as_str() {
            "stroke_begin" | "stroke_pts" | "stroke_end" => {
                let mut s = sess.lock().unwrap();
                s.record(&m, &raw);
                s.broadcast(&raw, cid);
            }
            "key" | "cursor" | "doc" => sess.lock().unwrap().broadcast(&raw, cid),
            "clear" => {
                let mut s = sess.lock().unwrap();
                s.reset();
                s.broadcast(&raw, cid);
            }
            "doc_update" => {
                if m.u.is_empty() {
                    continue;
                }
                let mut s = sess.lock().unwrap();
                s.doc_log.push(m.u);
                s.broadcast(&raw, cid);
                if s.doc_log.len() > DOC_COMPACT_AT && s.compact_who.is_none() {
                    s.compact_who = Some(cid);
                    s.compact_from = s.doc_log.len();
                    client.queue(Utf8Bytes::from_static(r#"{"t":"doc_compact"}"#));
                }
            }
            "doc_state" => {
                let mut s = sess.lock().unwrap();
                if !m.u.is_empty() && s.compact_who == Some(cid) {
                    let from = s.compact_from.min(s.doc_log.len());
                    let mut log = Vec::with_capacity(1 + s.doc_log.len() - from);
                    log.push(m.u);
                    log.extend(s.doc_log.drain(from..));
                    s.doc_log = log;
                    s.compact_who = None;
                }
            }
            "term_prompt" | "term_answer" => client.queue(json_msg(&Term { t: "term", kind: "status", text: TERM_STATUS })),
            // prompt, ai_* and unknown types: dropped (AI is off on this router).
            _ => {}
        }
    }
}

async fn write_loop(mut sink: WsSink, mut rx: mpsc::Receiver<Utf8Bytes>, _done: oneshot::Sender<()>) {
    // `_done` drops when this returns, which unblocks the read loop.
    let mut ping = tokio::time::interval_at(Instant::now() + PING_EVERY, PING_EVERY);
    loop {
        tokio::select! {
            m = rx.recv() => match m {
                Some(msg) => {
                    if !matches!(timeout(WRITE_WAIT, sink.send(Message::Text(msg))).await, Ok(Ok(()))) {
                        return;
                    }
                }
                None => {
                    let frame = CloseFrame { code: CloseCode::Again, reason: Utf8Bytes::from_static("behind") };
                    let _ = timeout(WRITE_WAIT, sink.send(Message::Close(Some(frame)))).await;
                    return;
                }
            },
            _ = ping.tick() => {
                if !matches!(timeout(WRITE_WAIT, sink.send(Message::Ping(Bytes::new()))).await, Ok(Ok(()))) {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_request_heads() {
        let h = parse_head(b"GET /ws/session1?x=1 HTTP/1.1\r\nHost: a\r\nUpgrade: WebSocket\r\n\r\n").unwrap();
        assert_eq!(h.path, "/ws/session1");
        assert!(h.upgrade);
        let h = parse_head(b"GET /ws/my%20session HTTP/1.1\r\n\r\n").unwrap();
        assert_eq!(h.path, "/ws/my session");
        assert!(!h.upgrade);
        assert!(parse_head(b"GET / HTTP/1.1\r\n").is_none());
    }

    #[test]
    fn page_memory_is_bounded() {
        let mut s = Session::default();
        let pts: Vec<String> = (0..1000).map(|_| "[0.5,0.5,0.5,1]".to_string()).collect();
        let pts_json = format!("[{}]", pts.join(","));
        for i in 0..(MAX_POINTS / 1000 + 5) {
            let id = format!("u_{i}");
            let begin = format!(r#"{{"t":"stroke_begin","id":"{id}"}}"#);
            let m: Envelope = serde_json::from_str(&begin).unwrap();
            s.record(&m, &Utf8Bytes::from(begin.clone()));
            let p = format!(r#"{{"t":"stroke_pts","id":"{id}","pts":{pts_json}}}"#);
            let m: Envelope = serde_json::from_str(&p).unwrap();
            s.record(&m, &Utf8Bytes::from(p.clone()));
        }
        assert!(s.points <= MAX_POINTS);
        assert_eq!(s.order.len(), MAX_POINTS / 1000);
        assert_eq!(s.order.front().unwrap(), "u_5");
    }
}
