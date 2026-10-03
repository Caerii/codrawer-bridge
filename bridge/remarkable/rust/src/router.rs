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
//! - The router pings clients and drops ones that stop answering. Besides WebSocket pings it
//!   sends `{"t":"ping"}`, which browsers can see, so the glasses app can detect a half-open
//!   socket on its side. hello carries `"replay":true|false`.
//! - A replay is built outside the session lock; live messages for that client are held until
//!   its replay is queued, so a big page never freezes the stream for everyone else.
//! - A pen source can join with `?replay=0` (the bridge does). When a client leaves mid-stroke
//!   its open strokes are ended for everyone.
//!
//! Shared live editing: clients keep the session document as a Yjs CRDT and send
//! `{"t":"doc_update","u":<base64>}`. The router never decodes them; it relays each one, keeps the
//! log and replays it to joiners as `{"t":"doc_update","us":[...]}`. When the log grows past
//! [`DOC_COMPACT_AT`] it asks the client that just wrote for `{"t":"doc_state","u":<full state>}`
//! and replaces the log with that state plus everything that arrived after the request.
//!
//! Pairing code: with a token set ([`Router::with_token`], env `ROUTER_TOKEN`), every client that is
//! not on this machine must present it as `?token=` (browsers cannot set WebSocket headers) or
//! `Authorization: Bearer`. The pen bridge talks over loopback and is exempt. A wrong or missing
//! code gets `{"t":"error","code":"unauthorized",…}` and close code 4401, so an app can ask for it.
//!
//! Serves `GET /healthz` and `GET /ws/{session}` on a plain TCP listener: the HTTP request head
//! is read here, then handed (replayed) to tungstenite for the WebSocket handshake.

use std::collections::{BTreeMap, HashMap, VecDeque};
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
/// Page memory bound (~90 B/point, ~14 MB); the oldest strokes go first.
pub const MAX_POINTS: usize = 150_000;
/// One stroke never holds more for replay (a pen resting on the glass); live relay is not capped.
pub const MAX_STROKE_POINTS: usize = 20_000;
pub const MAX_MESSAGE: usize = 1 << 20;
/// doc_update log entries before asking a client for a snapshot.
pub const DOC_COMPACT_AT: usize = 256;
/// Updates per replayed doc_update message.
pub const DOC_REPLAY_N: usize = 256;
/// Re-ask another writer if the asked one never answers.
pub const DOC_COMPACT_AFTER: Duration = Duration::from_secs(10);
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HEADER: usize = 64 << 10;

const TERM_STATUS: &str = "no terminal on this router (tablet-local; stroke streaming only)";

pub type Logf = Arc<dyn Fn(&str) + Send + Sync>;
/// Decides whether a peer is on this machine (exempt from the pairing code).
pub type LocalCheck = Arc<dyn Fn(&SocketAddr) -> bool + Send + Sync>;

/// What boot.sh derived for this boot, by hello key → environment variable (serve.go).
pub const HOST_INFO_ENV: [(&str, &str); 4] =
    [("os", "CODRAWER_OS"), ("osTested", "CODRAWER_OS_TESTED"), ("version", "CODRAWER_VERSION"), ("osChangedFrom", "CODRAWER_OS_CHANGED")];

/// Holds the sessions. Cheap to clone (shared state).
#[derive(Clone)]
pub struct Router {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
    next_client: Arc<AtomicU64>,
    logf: Logf,
    /// Describes the host (the tablet's OS and codrawer versions); sent in hello as `"tablet"`
    /// so clients can say "tablet updated" or show versions. Empty: not sent.
    info: Arc<BTreeMap<String, String>>,
    /// The pairing code required from clients off this machine; empty: none required.
    token: Arc<str>,
    is_local: LocalCheck,
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
        Router {
            sessions: Arc::default(),
            next_client: Arc::new(AtomicU64::new(1)),
            logf,
            info: Arc::default(),
            token: "".into(),
            is_local: Arc::new(|a: &SocketAddr| a.ip().to_canonical().is_loopback()),
        }
    }

    /// Host info sent in hello as `"tablet"` (see [`host_info`]). Set before serving.
    pub fn with_info(mut self, info: BTreeMap<String, String>) -> Self {
        self.info = Arc::new(info);
        self
    }

    /// The pairing code clients off this machine must present (empty: none). Set before serving.
    pub fn with_token(mut self, token: &str) -> Self {
        self.token = token.into();
        self
    }

    /// Replaces the "is this peer on this machine" check (loopback by default); tests use it to
    /// pose as a remote client, as Go's test rewrites `RemoteAddr`.
    pub fn with_local_check(mut self, f: LocalCheck) -> Self {
        self.is_local = f;
        self
    }

    /// Whether a request from `addr` may join (Go: `authorized`).
    fn authorized(&self, addr: &SocketAddr, req: &Head) -> bool {
        if self.token.is_empty() || (self.is_local)(addr) {
            return true;
        }
        let mut got = req.token.as_str();
        if got.is_empty() {
            if let Some(b) = req.authorization.strip_prefix("Bearer ") {
                got = b;
            }
        }
        constant_time_eq(got.as_bytes(), self.token.as_bytes())
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
        let Ok(mut ws) = tokio_tungstenite::accept_async_with_config(io, Some(cfg)).await else {
            return;
        };
        // Log IPv4 peers on the dual-stack socket as 1.2.3.4:port, not [::ffff:1.2.3.4]:port.
        let addr = SocketAddr::new(addr.ip().to_canonical(), addr.port());
        if !self.authorized(&addr, &req) {
            let _ = timeout(WRITE_WAIT, ws.send(Message::Text(Utf8Bytes::from_static(UNAUTHORIZED)))).await;
            let frame = CloseFrame { code: CloseCode::from(4401), reason: Utf8Bytes::from_static("unauthorized") };
            let _ = timeout(WRITE_WAIT, ws.send(Message::Close(Some(frame)))).await;
            (self.logf)(&format!("[router] {addr} refused: missing or wrong pairing code"));
            // Give the client a moment to answer the close, so the TCP close never races (and
            // resets) the frames it has not read yet.
            let _ = timeout(Duration::from_secs(2), async { while let Some(Ok(_)) = ws.next().await {} }).await;
            return;
        }
        self.run_client(ws, id, addr.to_string(), req.replay).await;
    }

    async fn run_client(self, ws: tokio_tungstenite::WebSocketStream<Prefixed>, id: String, addr: String, want_replay: bool) {
        let sess = self.session(&id);
        let cid = self.next_client.fetch_add(1, Ordering::Relaxed);

        // Register under the lock with a snapshot of the page; broadcasts to this client are held
        // (Member::held) until the replay built from the snapshot is queued, so ordering is exact
        // without serializing the page while everyone else waits on the lock.
        let client = Arc::new(Client { addr: addr.clone(), tx: Mutex::new(None) });
        let (snap, n) = {
            let mut s = sess.lock().unwrap();
            let snap = want_replay.then(|| s.snapshot());
            s.clients.insert(cid, Member { client: client.clone(), held: Some(Vec::new()) });
            (snap, s.clients.len())
        };
        let replay = snap.map(|s| s.messages()).unwrap_or_default();
        // The queue holds the whole replay plus the usual headroom: a big page must not count as a
        // stalled client.
        let (tx, rx) = mpsc::channel(SEND_QUEUE + replay.len() + 1);
        *client.tx.lock().unwrap() = Some(tx);
        let tablet = (!self.info.is_empty()).then_some(&*self.info);
        client.queue(json_msg(&Hello { t: "hello", session: &id, replay: want_replay, tablet }));
        let replayed = replay.len();
        for m in replay {
            client.queue(m);
        }
        {
            let mut s = sess.lock().unwrap();
            if let Some(held) = s.clients.get_mut(&cid).and_then(|m| m.held.take()) {
                for m in held {
                    client.queue(m);
                }
            }
        }
        (self.logf)(&format!("[router] {addr} joined {id} ({n} clients, replayed {replayed} messages)"));

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
            s.end_strokes_of(cid);
            s.clients.len()
        };
        client.close();
        (self.logf)(&format!("[router] {addr} left {id} ({n} clients)"));
    }
}

/// The hello `"tablet"` info from `get` (an env lookup): every [`HOST_INFO_ENV`] variable that is
/// set and not empty, under its hello key.
pub fn host_info(get: impl Fn(&str) -> Option<String>) -> BTreeMap<String, String> {
    HOST_INFO_ENV
        .iter()
        .filter_map(|(key, env)| get(env).filter(|v| !v.is_empty()).map(|v| (key.to_string(), v)))
        .collect()
}

/// Go's `subtle.ConstantTimeCompare(a, b) == 1`: unequal lengths fail at once (the length is not
/// secret), equal lengths take the same time whatever the bytes.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

const UNAUTHORIZED: &str = r#"{"t":"error","code":"unauthorized","text":"pairing code required"}"#;

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
    /// False when the query says `replay=0` (a pen source).
    replay: bool,
    /// The `token` query value (first, decoded; empty if absent).
    token: String,
    /// The first `Authorization` header's value, trimmed (empty if absent).
    authorization: String,
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
    let (raw_path, query) = target.split_once('?').unwrap_or((target, ""));
    let path = percent_decode(raw_path)?;
    let (mut upgrade, mut authorization) = (false, None);
    for (k, v) in lines.filter_map(|l| l.split_once(':')) {
        let (k, v) = (k.trim(), v.trim());
        if k.eq_ignore_ascii_case("upgrade") && v.eq_ignore_ascii_case("websocket") {
            upgrade = true;
        }
        if k.eq_ignore_ascii_case("authorization") && authorization.is_none() {
            authorization = Some(v.to_string());
        }
    }
    let replay = query_get(query, "replay").as_deref() != Some("0");
    let token = query_get(query, "token").unwrap_or_default();
    Some(Head { path, upgrade, replay, token, authorization: authorization.unwrap_or_default() })
}

/// The first value of `key` in a query string, decoded like Go's `url.Values.Get` (`+` is a
/// space; pairs that fail to decode are skipped).
fn query_get(query: &str, key: &str) -> Option<String> {
    let dec = |s: &str| percent_decode(&s.replace('+', " "));
    query.split('&').filter(|p| !p.is_empty()).find_map(|p| {
        let (k, v) = p.split_once('=').unwrap_or((p, ""));
        (dec(k)? == key).then(|| dec(v)).flatten()
    })
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
    replay: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tablet: Option<&'a BTreeMap<String, String>>,
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
    us: &'a [&'a str],
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
    clients: HashMap<u64, Member>,
    /// The page: strokes since the last clear, in arrival order, for replay to late joiners.
    order: VecDeque<String>,
    strokes: HashMap<String, Stroke>,
    points: usize,
    /// Shared document: Yjs updates (base64) in arrival order; survives clear (it is not ink).
    doc_log: Vec<Arc<str>>,
    /// The client asked for a doc_state, if any.
    compact_who: Option<u64>,
    /// doc_log length when it was asked.
    compact_from: usize,
    /// When it was asked.
    compact_asked: Option<Instant>,
}

/// A client as the session sees it.
struct Member {
    client: Arc<Client>,
    /// `Some` while the client's replay is being queued: broadcasts wait here, in order.
    held: Option<Vec<Utf8Bytes>>,
}

/// Points per block: one replayed stroke_pts message.
type Block = Arc<Vec<Box<RawValue>>>;

struct Stroke {
    /// The stroke_begin message as received.
    begin: Utf8Bytes,
    /// Every point as received (up to [`MAX_STROKE_POINTS`]), in blocks of [`REPLAY_PTS`]. A
    /// snapshot shares the blocks; only a shared, still-filling last block is copied on write.
    blocks: Vec<Block>,
    n_pts: usize,
    ended: bool,
    /// Who is drawing it (ended for everyone if they leave mid-stroke).
    owner: u64,
}

/// The page at one instant, cheap to take under the lock: blocks are shared, not copied.
struct PageSnapshot {
    strokes: Vec<StrokeSnap>,
    doc: Vec<Arc<str>>,
}

struct StrokeSnap {
    id: String,
    begin: Utf8Bytes,
    blocks: Vec<Block>,
    ended: bool,
}

impl PageSnapshot {
    /// The page as the messages a client would have seen live.
    fn messages(&self) -> Vec<Utf8Bytes> {
        let mut out = Vec::new();
        for st in &self.strokes {
            out.push(st.begin.clone());
            for b in &st.blocks {
                out.push(json_msg(&ReplayPts { t: "stroke_pts", id: &st.id, pts: b }));
            }
            if st.ended {
                out.push(json_msg(&ReplayEnd { t: "stroke_end", id: &st.id }));
            }
        }
        for chunk in self.doc.chunks(DOC_REPLAY_N) {
            let us: Vec<&str> = chunk.iter().map(|u| &**u).collect();
            out.push(json_msg(&ReplayDoc { t: "doc_update", us: &us }));
        }
        out
    }
}

impl Session {
    fn record(&mut self, m: &Envelope<'_>, raw: &Utf8Bytes, from: u64) {
        if m.id.is_empty() {
            return;
        }
        match m.t.as_str() {
            "stroke_begin" => {
                if let Some(old) = self.strokes.get(&m.id) {
                    self.points -= old.n_pts;
                } else {
                    self.order.push_back(m.id.clone());
                }
                let st = Stroke { begin: raw.clone(), blocks: Vec::new(), n_pts: 0, ended: false, owner: from };
                self.strokes.insert(m.id.clone(), st);
            }
            "stroke_pts" => {
                // Points for a stroke that began before a clear or before we started are dropped.
                let Some(st) = self.strokes.get_mut(&m.id) else { return };
                let pts = m.pts.as_deref().unwrap_or_default();
                // Still relayed live; only the replay copy is capped.
                let add = &pts[..pts.len().min(MAX_STROKE_POINTS.saturating_sub(st.n_pts))];
                for p in add {
                    match st.blocks.last_mut() {
                        Some(b) if b.len() < REPLAY_PTS => Arc::make_mut(b).push((*p).to_owned()),
                        _ => {
                            let mut b = Vec::with_capacity(REPLAY_PTS.min(add.len()).max(16));
                            b.push((*p).to_owned());
                            st.blocks.push(Arc::new(b));
                        }
                    }
                }
                st.n_pts += add.len();
                self.points += add.len();
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
                self.points -= st.n_pts;
            }
        }
    }

    fn reset(&mut self) {
        self.order.clear();
        self.strokes.clear();
        self.points = 0;
    }

    /// The page now, for a replay built after the lock is released.
    fn snapshot(&self) -> PageSnapshot {
        let strokes = self
            .order
            .iter()
            .filter_map(|id| {
                let st = self.strokes.get(id)?;
                Some(StrokeSnap { id: id.clone(), begin: st.begin.clone(), blocks: st.blocks.clone(), ended: st.ended })
            })
            .collect();
        PageSnapshot { strokes, doc: self.doc_log.clone() }
    }

    fn broadcast(&mut self, raw: &Utf8Bytes, from: u64) {
        for (id, m) in &mut self.clients {
            if *id == from {
                continue;
            }
            // Utf8Bytes is refcounted: one buffer for every client
            match &mut m.held {
                Some(held) => held.push(raw.clone()), // flushed once its replay is queued
                None => m.client.queue(raw.clone()),
            }
        }
    }

    /// Strokes `cid` was drawing will never get their stroke_end: end them for everyone.
    fn end_strokes_of(&mut self, cid: u64) {
        let open: Vec<String> = self
            .order
            .iter()
            .filter(|id| self.strokes.get(*id).is_some_and(|st| st.owner == cid && !st.ended))
            .cloned()
            .collect();
        for id in open {
            if let Some(st) = self.strokes.get_mut(&id) {
                st.ended = true;
            }
            self.broadcast(&json_msg(&ReplayEnd { t: "stroke_end", id: &id }), cid);
        }
    }

    /// Logs and relays one doc_update from `from`. Returns true when `from` should be asked for
    /// a doc_state: the log is long and nobody was asked, or the asked client never answered.
    fn doc_update(&mut self, u: Arc<str>, raw: &Utf8Bytes, from: u64, now: Instant) -> bool {
        self.doc_log.push(u);
        self.broadcast(raw, from);
        let stale = self.compact_who.is_some() && self.compact_asked.is_some_and(|t| now.saturating_duration_since(t) > DOC_COMPACT_AFTER);
        if self.doc_log.len() > DOC_COMPACT_AT && (self.compact_who.is_none() || stale) {
            // ask the client that just wrote: it is alive and holds the whole document
            self.compact_who = Some(from);
            self.compact_from = self.doc_log.len();
            self.compact_asked = Some(now);
            return true;
        }
        false
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
                s.record(&m, &raw, cid);
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
                if s.doc_update(m.u.into(), &raw, cid, Instant::now()) {
                    client.queue(Utf8Bytes::from_static(r#"{"t":"doc_compact"}"#));
                }
            }
            "doc_state" => {
                let mut s = sess.lock().unwrap();
                if !m.u.is_empty() && s.compact_who == Some(cid) {
                    let from = s.compact_from.min(s.doc_log.len());
                    let mut log = Vec::with_capacity(1 + s.doc_log.len() - from);
                    log.push(m.u.into());
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
                // browsers never surface protocol pings; this one lets the app see a live link
                let ping_msg = Message::Text(Utf8Bytes::from_static(r#"{"t":"ping"}"#));
                if !matches!(timeout(WRITE_WAIT, sink.send(ping_msg)).await, Ok(Ok(()))) {
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
    fn replay_query_matches_go_values_get() {
        let replay = |target: &str| parse_head(format!("GET {target} HTTP/1.1\r\n\r\n").as_bytes()).unwrap().replay;
        assert!(replay("/ws/s1"));
        assert!(!replay("/ws/s1?replay=0"));
        assert!(!replay("/ws/s1?a=1&replay=%30"));
        assert!(replay("/ws/s1?replay=1"));
        assert!(replay("/ws/s1?replay="));
        assert!(!replay("/ws/s1?replay=0&replay=1")); // the first value wins
        assert!(replay("/ws/s1?replays=0"));
    }

    #[test]
    fn parses_pairing_code_from_query_and_header() {
        let h = parse_head(b"GET /ws/s1?replay=0&token=K7Q2%2DM9TX HTTP/1.1\r\nauthorization:  Bearer abc \r\nAuthorization: Bearer second\r\n\r\n").unwrap();
        assert_eq!(h.token, "K7Q2-M9TX");
        assert_eq!(h.authorization, "Bearer abc");
        let h = parse_head(b"GET /ws/s1 HTTP/1.1\r\n\r\n").unwrap();
        assert!(h.token.is_empty() && h.authorization.is_empty());
    }

    #[test]
    fn authorized_like_go() {
        let remote: SocketAddr = "192.168.50.165:50000".parse().unwrap();
        let local: SocketAddr = "[::ffff:127.0.0.1]:50000".parse().unwrap();
        let head = |target: &str, auth: &str| {
            parse_head(format!("GET {target} HTTP/1.1\r\nAuthorization: {auth}\r\n\r\n").as_bytes()).unwrap()
        };
        let open = Router::quiet();
        assert!(open.authorized(&remote, &head("/ws/s1", "")));
        let r = Router::quiet().with_token("K7Q2-M9TX");
        assert!(!r.authorized(&remote, &head("/ws/s1", "")));
        assert!(!r.authorized(&remote, &head("/ws/s1?token=nope", "Bearer K7Q2-M9TX"))); // the query wins when set
        assert!(r.authorized(&remote, &head("/ws/s1?token=K7Q2-M9TX", "")));
        assert!(r.authorized(&remote, &head("/ws/s1?token=", "Bearer K7Q2-M9TX")));
        assert!(!r.authorized(&remote, &head("/ws/s1", "bearer K7Q2-M9TX"))); // Go's prefix is case-sensitive
        assert!(!r.authorized(&remote, &head("/ws/s1", "Bearer K7Q2-M9T")));
        assert!(r.authorized(&local, &head("/ws/s1", ""))); // IPv4-mapped loopback counts
        assert!(r.authorized(&"[::1]:1".parse().unwrap(), &head("/ws/s1", "")));
        assert!(constant_time_eq(b"", b"") && !constant_time_eq(b"a", b"ab") && !constant_time_eq(b"ab", b"ac"));
    }

    #[test]
    fn host_info_reads_only_set_variables() {
        let env: HashMap<&str, &str> = [("CODRAWER_OS", "6.1.0"), ("CODRAWER_VERSION", "v8"), ("CODRAWER_OS_CHANGED", "")].into();
        let info = host_info(|k| env.get(k).map(|v| v.to_string()));
        assert_eq!(info.into_iter().collect::<Vec<_>>(), [("os".to_string(), "6.1.0".to_string()), ("version".into(), "v8".into())]);
    }

    fn rec(s: &mut Session, msg: &str, from: u64) {
        let m: Envelope = serde_json::from_str(msg).unwrap();
        s.record(&m, &Utf8Bytes::from(msg.to_string()), from);
    }

    fn pts_msg(id: &str, n: usize) -> String {
        format!(r#"{{"t":"stroke_pts","id":"{id}","pts":[{}]}}"#, vec!["[0.5,0.5,0.5,1]"; n].join(","))
    }

    #[test]
    fn one_stroke_is_capped_for_replay() {
        let mut s = Session::default();
        rec(&mut s, r#"{"t":"stroke_begin","id":"u_1"}"#, 1);
        for _ in 0..(MAX_STROKE_POINTS / 1000 + 5) {
            rec(&mut s, &pts_msg("u_1", 1000), 1);
        }
        assert_eq!(s.points, MAX_STROKE_POINTS);
        let st = &s.strokes["u_1"];
        assert_eq!(st.n_pts, MAX_STROKE_POINTS);
        assert_eq!(st.blocks.iter().map(|b| b.len()).sum::<usize>(), MAX_STROKE_POINTS);
        assert!(st.blocks.iter().all(|b| b.len() <= REPLAY_PTS));
    }

    #[test]
    fn snapshot_is_not_changed_by_later_points() {
        let mut s = Session::default();
        rec(&mut s, r#"{"t":"stroke_begin","id":"u_1"}"#, 1);
        rec(&mut s, &pts_msg("u_1", 300), 1); // a full block and a partial one
        let snap = s.snapshot();
        rec(&mut s, &pts_msg("u_1", 10), 1);
        rec(&mut s, r#"{"t":"stroke_end","id":"u_1"}"#, 1);
        let msgs: Vec<serde_json::Value> = snap.messages().iter().map(|m| serde_json::from_str(m.as_str()).unwrap()).collect();
        let n: Vec<usize> = msgs.iter().filter(|m| m["t"] == "stroke_pts").map(|m| m["pts"].as_array().unwrap().len()).collect();
        assert_eq!(n, [256, 44]);
        assert_eq!(msgs.len(), 3, "the snapshot was taken before stroke_end");
        let now: usize = s.snapshot().strokes[0].blocks.iter().map(|b| b.len()).sum();
        assert_eq!(now, 310);
    }

    #[test]
    fn leaving_owner_ends_only_its_open_strokes() {
        let mut s = Session::default();
        rec(&mut s, r#"{"t":"stroke_begin","id":"a"}"#, 1);
        rec(&mut s, r#"{"t":"stroke_begin","id":"b"}"#, 1);
        rec(&mut s, r#"{"t":"stroke_end","id":"b"}"#, 1);
        rec(&mut s, r#"{"t":"stroke_begin","id":"c"}"#, 2);
        s.end_strokes_of(1);
        assert!(s.strokes["a"].ended && s.strokes["b"].ended && !s.strokes["c"].ended);
    }

    #[test]
    fn doc_compaction_re_asks_after_silence() {
        let mut s = Session::default();
        let raw = Utf8Bytes::from_static(r#"{"t":"doc_update","u":"A"}"#);
        let t0 = Instant::now();
        let mut asked = Vec::new();
        for _ in 0..DOC_COMPACT_AT + 1 {
            if s.doc_update("A".into(), &raw, 1, t0) {
                asked.push(1);
            }
        }
        assert_eq!(asked, [1]);
        assert!(!s.doc_update("A".into(), &raw, 2, t0 + Duration::from_secs(5)), "asked again too soon");
        assert!(s.doc_update("A".into(), &raw, 2, t0 + DOC_COMPACT_AFTER + Duration::from_secs(1)), "never re-asked");
        assert_eq!(s.compact_who, Some(2));
        assert_eq!(s.compact_from, s.doc_log.len());
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
            s.record(&m, &Utf8Bytes::from(begin.clone()), 1);
            let p = format!(r#"{{"t":"stroke_pts","id":"{id}","pts":{pts_json}}}"#);
            let m: Envelope = serde_json::from_str(&p).unwrap();
            s.record(&m, &Utf8Bytes::from(p.clone()), 1);
        }
        assert!(s.points <= MAX_POINTS);
        assert_eq!(s.order.len(), MAX_POINTS / 1000);
        assert_eq!(s.order.front().unwrap(), "u_5");
    }
}
