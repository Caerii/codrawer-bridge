//! The stroke-only session router (router/router.go + serve.go), small enough to run on the
//! Paper Pro inside the bridge binary so the glasses app can connect to the tablet directly.
//!
//! Scope: hello, stroke_*, key, cursor, clear, page, doc, and shared live editing (doc_update). AI (prompt, ai_*) and the terminal
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
//! - The tablet's saved page (`{"t":"page"}`, the bridge's page watcher) is the page's base: the
//!   router keeps the latest, drops live strokes that began up to its `rev` (they are in it, or
//!   were erased), and replays it before the live strokes recorded after it (see `session`).
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
//!
//! # Module layout and data flow
//!
//! ```text
//! TCP accept ──► http (request head, /healthz, auth inputs) ──► Router::run_client
//!                                                                 │ registers in a Session,
//!                                                                 │ queues hello + replay
//!       client::read_loop ◄── frames from the peer                ▼
//!         │ parses messages::Envelope, dispatches by type ──► session::Session
//!         │                                                    (page log, doc log, members)
//!         ▼                                                         │ broadcast
//!       client::Client::queue ◄─────────────────────────────────────┘
//!         │ bounded mpsc per client
//!         ▼
//!       client::write_loop ──► frames to the peer (+ keepalive pings)
//! ```
//!
//! - `http`: the minimal HTTP layer (request head, query decoding, plain responses, listening).
//! - `messages`: the wire shapes the router reads (`messages::Envelope`) or writes itself.
//! - `session`: one session's state: members, the replayable page, the shared document.
//! - `client`: one connection: its send queue, the read loop (dispatch) and the write loop.

mod client;
mod http;
mod messages;
mod session;

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};

use client::{read_loop, write_loop, Client};
use http::{parse_head, read_head, respond, Head, Prefixed};
use messages::{json_msg, Hello};
use session::{Member, Session};

pub use http::bind;

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
/// Largest message accepted: a `page` snapshot of a dense page is a few MB (Go: 16 MB too).
pub const MAX_MESSAGE: usize = 16 << 20;
/// doc_update log entries before asking a client for a snapshot.
pub const DOC_COMPACT_AT: usize = 256;
/// Updates per replayed doc_update message.
pub const DOC_REPLAY_N: usize = 256;
/// Re-ask another writer if the asked one never answers.
pub const DOC_COMPACT_AFTER: Duration = Duration::from_secs(10);
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);

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
        let client = Arc::new(Client::new());
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
        client.attach(tx);
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

#[cfg(test)]
mod tests {
    use super::*;
    use http::parse_head;

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
}
