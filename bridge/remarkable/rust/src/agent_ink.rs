//! Agent ink as native xochitl strokes, and the dock's actions; a port of the Go package
//! `bridge/remarkable/native/agentink` and of `agent_ink.go`.
//!
//! # The problem
//!
//! An agent draws by sending `stroke_begin`/`stroke_pts`/`stroke_end` on `layer:"ai"`
//! (docs/protocol.md). Viewers show that ink; the tablet did not, because xochitl draws only what
//! its own pen produced. The codrawer-layer XOVI extension commits strokes into xochitl's scene
//! through xochitl's own pen-commit path (`SceneController.addDrawingLine`; Probe 1 in
//! docs/investigations/native-multiplayer-layer.md: it renders, saves into the notebook and
//! undoes) and listens on a Unix socket, `/run/codrawer/ink.sock`. This module is the bridge's
//! half: it follows the router's ai-layer strokes and, when one ends, sends one line for it. The
//! extension answers `ok <id> <n>` or `err <id> <reason>`, and sends `dock_action` lines from the
//! buttons it injects into xochitl, which the bridge completes with the document id and passes to
//! the router.
//!
//! # Governance (ADR 003)
//!
//! - Only `layer:"ai"` strokes are forwarded; user and peer ink never are. The extension writes
//!   them only to its own layer, "codrawer: agent", and only on the page on screen.
//! - Size caps: at most `max_open` strokes in progress, `max_points` points per stroke (a stroke
//!   over it is dropped whole), points on or near the page.
//! - A rate cap: a token bucket of `burst` strokes refilled at `per_second` strokes per second.
//!
//! # Coordinates
//!
//! Protocol points are normalised to the page (`x = (x_rm + w/2)/w`, `y = y_rm/h`); the extension
//! wants page units (x centred), so `x_rm = x·w − w/2`, `y_rm = y·h`, with `w`, `h` from the
//! latest `page` snapshot (1620 × 2160 by default). Each point's width is 2 × thickness px.
//!
//! The socket line is built by hand, byte for byte as Go builds it (shortest numbers, the same
//! string escapes), so both engines send the same bytes.

use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::value::RawValue;

/// Defaults for the caps (Go: `agentink.Default*`).
pub const DEFAULT_MAX_OPEN: usize = 32;
pub const DEFAULT_MAX_POINTS: usize = 4000;
pub const DEFAULT_BURST: f64 = 40.0;
pub const DEFAULT_PER_SECOND: f64 = 15.0;
/// Agent ink's colour when a stroke names none: a clear blue, distinct from the user's black.
pub const DEFAULT_ARGB: u32 = 0xff1f_6fe0;

/// What the conversion needs from the latest `page` snapshot.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Page {
    pub doc: String,
    pub page: String,
    /// Page units; 0 means 1620 × 2160.
    pub w: f64,
    pub h: f64,
}

/// One stroke for the extension: tool word, ARGB as 8 hex digits, xochitl thickness, and points
/// `[x, y, pressure 0..1, width px]` in page units.
#[derive(Debug, Clone, PartialEq)]
pub struct LineStroke {
    pub tool: String,
    pub argb: String,
    pub thickness: f64,
    pub pts: Vec<[f64; 4]>,
}

struct Open {
    brush: String,
    color: String,
    size: f64,
    pts: Vec<Vec<f64>>,
    too_many: bool,
}

#[derive(Deserialize)]
struct Msg<'a> {
    #[serde(default)]
    t: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    layer: String,
    #[serde(default)]
    brush: String,
    #[serde(default)]
    tool: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    size: f64,
    #[serde(default, borrow)]
    pts: Vec<&'a RawValue>,
}

/// Follows ai-layer strokes (Go: `agentink.Forwarder`).
pub struct Forwarder {
    pub max_open: usize,
    pub max_points: usize,
    pub burst: f64,
    pub per_second: f64,
    open: std::collections::HashMap<String, Open>,
    tokens: f64,
    refill: Option<Instant>,
    pub sent: u64,
    pub dropped_rate: u64,
    pub dropped_size: u64,
    pub dropped_no_page: u64,
}

impl Default for Forwarder {
    fn default() -> Self {
        Forwarder {
            max_open: DEFAULT_MAX_OPEN,
            max_points: DEFAULT_MAX_POINTS,
            burst: DEFAULT_BURST,
            per_second: DEFAULT_PER_SECOND,
            open: Default::default(),
            tokens: 0.0,
            refill: None,
            sent: 0,
            dropped_rate: 0,
            dropped_size: 0,
            dropped_no_page: 0,
        }
    }
}

impl Forwarder {
    /// Follows one router message at `now`; returns the socket line to send if a stroke ended,
    /// or why a finished stroke was not sent.
    pub fn handle(
        &mut self,
        raw: &str,
        page: &Page,
        now: Instant,
    ) -> (Option<String>, Option<String>) {
        let Ok(m) = serde_json::from_str::<Msg<'_>>(raw) else {
            return (None, None);
        };
        if m.id.is_empty() {
            return (None, None);
        }
        match m.t.as_str() {
            "stroke_begin" => {
                if m.layer != "ai" {
                    return (None, None);
                }
                if self.open.len() >= self.max_open {
                    return (None, Some("too many open ai strokes".into()));
                }
                let brush = if m.tool.is_empty() { m.brush } else { m.tool };
                self.open.insert(
                    m.id,
                    Open {
                        brush,
                        color: m.color,
                        size: m.size,
                        pts: Vec::new(),
                        too_many: false,
                    },
                );
            }
            "stroke_pts" => {
                let max = self.max_points;
                let Some(s) = self.open.get_mut(&m.id) else {
                    return (None, None);
                };
                if s.too_many {
                    return (None, None);
                }
                for rp in m.pts {
                    let Ok(p) = serde_json::from_str::<Vec<f64>>(rp.get()) else {
                        continue;
                    };
                    if p.len() < 2 {
                        continue;
                    }
                    if s.pts.len() >= max {
                        s.too_many = true;
                        s.pts.clear();
                        break;
                    }
                    s.pts.push(p);
                }
            }
            "stroke_end" => {
                let Some(s) = self.open.remove(&m.id) else {
                    return (None, None);
                };
                if s.too_many {
                    self.dropped_size += 1;
                    return (
                        None,
                        Some(format!("stroke {} over {} points", m.id, self.max_points)),
                    );
                }
                if s.pts.is_empty() {
                    return (None, None);
                }
                if page.page.is_empty() {
                    self.dropped_no_page += 1;
                    return (None, Some("no open page known yet".into()));
                }
                let ls = match convert(&s.brush, &s.color, s.size, &s.pts, page) {
                    Ok(ls) => ls,
                    Err(why) => {
                        self.dropped_size += 1;
                        return (None, Some(format!("stroke {}: {why}", m.id)));
                    }
                };
                if !self.take(now) {
                    self.dropped_rate += 1;
                    return (None, Some("over the agent ink rate cap".into()));
                }
                self.sent += 1;
                return (Some(encode(&m.id, &page.page, &ls)), None);
            }
            _ => {}
        }
        (None, None)
    }

    /// Spends one token of the rate cap.
    fn take(&mut self, now: Instant) -> bool {
        match self.refill {
            None => self.tokens = self.burst,
            Some(t) => {
                let dt = now.saturating_duration_since(t).as_secs_f64();
                self.tokens = (self.tokens + dt * self.per_second).min(self.burst);
            }
        }
        self.refill = Some(now);
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

/// Maps one stroke to page units; refuses points off the page by more than half a page.
pub fn convert(
    brush: &str,
    color: &str,
    size: f64,
    pts: &[Vec<f64>],
    page: &Page,
) -> Result<LineStroke, String> {
    let (w, h) = if page.w <= 0.0 || page.h <= 0.0 {
        (1620.0, 2160.0)
    } else {
        (page.w, page.h)
    };
    let thickness = if size <= 0.0 { 2.0 } else { size }.clamp(1.0, 5.0);
    let width = 2.0 * thickness;
    let mut out = LineStroke {
        tool: tool_word(brush).into(),
        argb: format!("{:08x}", parse_argb(color)),
        thickness,
        pts: Vec::new(),
    };
    for p in pts {
        let (x, y) = (p[0], p[1]);
        if x.is_nan() || y.is_nan() || !(-0.5..=1.5).contains(&x) || !(-0.5..=1.5).contains(&y) {
            return Err(format!("point ({}, {}) is off the page", go_g(x), go_g(y)));
        }
        let pr = match p.get(2) {
            Some(&v) if (0.0..=1.0).contains(&v) => v,
            _ => 0.6,
        };
        out.pts.push([
            round(x * w - w / 2.0, 100.0),
            round(y * h, 100.0),
            round(pr, 1000.0),
            width,
        ]);
    }
    Ok(out)
}

/// A protocol brush or tool as a tool the extension accepts; everything else is the fineliner.
pub fn tool_word(brush: &str) -> &'static str {
    match brush.to_lowercase().as_str() {
        "ballpoint" | "pen" => "ballpoint",
        "pencil" => "pencil",
        "mechanical" => "mechanical",
        "sharp_pencil" => "sharp_pencil",
        "marker" => "marker",
        "calligraphy" => "calligraphy",
        "brush" => "brush",
        "paintbrush" => "paintbrush",
        _ => "fineliner",
    }
}

/// `#rrggbb` / `#rrggbbaa` as 0xAARRGGBB; anything else, or a colour too light for paper, is
/// [`DEFAULT_ARGB`]; a near-transparent alpha becomes opaque.
pub fn parse_argb(c: &str) -> u32 {
    let c = c.trim();
    let c = c.strip_prefix('#').unwrap_or(c);
    if c.len() != 6 && c.len() != 8 {
        return DEFAULT_ARGB;
    }
    let Ok(v) = u32::from_str_radix(c, 16) else {
        return DEFAULT_ARGB;
    };
    let (r, g, b, mut a) = if c.len() == 6 {
        ((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff, 0xff)
    } else {
        (
            (v >> 24) & 0xff,
            (v >> 16) & 0xff,
            (v >> 8) & 0xff,
            v & 0xff,
        )
    };
    if r > 0xe0 && g > 0xe0 && b > 0xe0 {
        return DEFAULT_ARGB;
    }
    if a < 0x40 {
        a = 0xff;
    }
    a << 24 | r << 16 | g << 8 | b
}

/// Reads doc, page and size from a `page` message.
pub fn page_of(raw: &str) -> Page {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct P {
        doc: String,
        page: String,
        w: f64,
        h: f64,
    }
    let p: P = serde_json::from_str(raw).unwrap_or_default();
    Page {
        doc: p.doc,
        page: p.page,
        w: p.w,
        h: p.h,
    }
}

/// Completes an action line from the extension for the router (Go: `agentink.DockAction`):
/// it must be an object with t "dock_action" and an id of 1..64 bytes; the open document's id is
/// added when the extension's page is the page the bridge knows, and `ts` (ms) is set.
pub fn dock_action(line: &str, page: &Page, now_ms: i64) -> Option<String> {
    let mut m: serde_json::Map<String, serde_json::Value> = serde_json::from_str(line).ok()?;
    if m.get("t").and_then(|v| v.as_str()) != Some("dock_action") {
        return None;
    }
    let id = m.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty() || id.len() > 64 {
        return None;
    }
    let same_page = m
        .get("page")
        .and_then(|v| v.as_str())
        .is_some_and(|p| !p.is_empty() && p == page.page);
    if same_page && !page.doc.is_empty() {
        m.insert("doc".into(), page.doc.clone().into());
    }
    m.insert("ts".into(), now_ms.into());
    serde_json::to_string(&m).ok()
}

/// One socket line (no newline), byte-identical to Go's `agentink.Encode`.
pub fn encode(id: &str, page: &str, ls: &LineStroke) -> String {
    let mut b = String::with_capacity(96 + ls.pts.len() * 32);
    b.push_str(r#"{"id":"#);
    push_string(&mut b, id);
    b.push_str(r#","page":"#);
    push_string(&mut b, page);
    b.push_str(r#","layer":"agent","strokes":[{"tool":"#);
    push_string(&mut b, &ls.tool);
    b.push_str(r#","argb":"#);
    push_string(&mut b, &ls.argb);
    b.push_str(r#","thickness":"#);
    b.push_str(&num(ls.thickness));
    b.push_str(r#","pts":["#);
    for (i, p) in ls.pts.iter().enumerate() {
        if i > 0 {
            b.push(',');
        }
        b.push('[');
        for (j, v) in p.iter().enumerate() {
            if j > 0 {
                b.push(',');
            }
            b.push_str(&num(*v));
        }
        b.push(']');
    }
    b.push_str("]}]}");
    b
}

/// Go's `strconv.FormatFloat(v, 'f', -1, 64)`: shortest round-trip digits, no exponent. Rust's
/// `Display` for f64 is the same for finite values; -0 prints as "-0" in both.
fn num(v: f64) -> String {
    format!("{v}")
}

/// Go's `%g` for the error text (shortest; only used in messages).
fn go_g(v: f64) -> String {
    format!("{v}")
}

fn push_string(b: &mut String, s: &str) {
    b.push('"');
    for c in s.chars() {
        match c {
            '"' | '\\' => {
                b.push('\\');
                b.push(c);
            }
            c if (c as u32) < 0x20 => b.push_str(&format!("\\u{:04x}", c as u32)),
            c => b.push(c),
        }
    }
    b.push('"');
}

fn round(v: f64, scale: f64) -> f64 {
    (v * scale).round() / scale
}

/// How long to wait before the next connect attempt (1 s doubling to 30 s), as in Go.
pub fn next_backoff(d: Duration) -> Duration {
    (d * 2).min(Duration::from_secs(30))
}

// ── text into the focused text box ─────────────────────────────────────────────────────────
//
// The extension greets with `hello codrawer-layer ink text_insert text_read`; from then on
// `/term` replies go into the focused text box as `{"op":"text_insert","id":"tN","text":…}`,
// inserted the way an input method commits text, which the uinput keyboard cannot match (it drops
// the first characters after an Enter and has no ^ [ ] { } \ ` ~). An `err tN …` answer sends that
// text to the uinput typer instead (Go: `inkLink`).

/// What the rest of the bridge sees of the connection: whether text insertion is on offer, and a
/// way to ask for it.
/// The uinput typer, for text the extension refused.
pub type Fallback = Box<dyn Fn(String) + Send>;

pub struct Link {
    /// Forward ai strokes now (NATIVE_AGENT_INK, then the dock's toggle).
    agent_on: std::sync::atomic::AtomicBool,
    /// Nudges the writer to send the status line again.
    status_tx: tokio::sync::mpsc::Sender<()>,
    text_ok: std::sync::atomic::AtomicBool,
    text_tx: tokio::sync::mpsc::Sender<String>,
    fallback: std::sync::Mutex<Option<Fallback>>,
}

/// Keeps the dock's agent ink choice across restarts ("1" or "0"); it then overrides
/// NATIVE_AGENT_INK (Go: `agentInkStateFile`).
pub const AGENT_INK_STATE_FILE: &str = "/home/root/codrawer/state/native_agent_ink";

/// The dock's last choice in `path` if one was kept, else `env`.
pub fn initial_agent_ink(path: &str, env: bool) -> bool {
    match std::fs::read_to_string(path) {
        Ok(s) => s.trim() == "1",
        Err(_) => env,
    }
}

/// What the dock shows for "codrawer status" (Go: `statusLine`).
pub fn status_line(engine: &str, agent_on: bool) -> String {
    format!("status codrawer {engine} bridge: connected, agent ink {}", if agent_on { "on" } else { "off" })
}

impl Link {
    /// Flips native agent ink, keeps the choice in `state_file`, asks for a new status line.
    pub fn toggle_agent_ink(&self, state_file: &str) -> bool {
        use std::sync::atomic::Ordering;
        let on = !self.agent_on.load(Ordering::SeqCst);
        self.agent_on.store(on, Ordering::SeqCst);
        if let Err(e) = std::fs::write(state_file, if on { "1\n" } else { "0\n" }) {
            println!("[ink] could not keep the agent ink choice: {e}");
        }
        let _ = self.status_tx.try_send(());
        on
    }

    pub fn agent_on(&self) -> bool {
        self.agent_on.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Queues `s` for the focused text box; false when the extension cannot take it now.
    pub fn insert_text(&self, s: &str) -> bool {
        self.text_ok.load(std::sync::atomic::Ordering::SeqCst)
            && self.text_tx.try_send(s.to_string()).is_ok()
    }

    /// Where refused text goes (the uinput typer).
    pub fn set_fallback(&self, f: Fallback) {
        *self.fallback.lock().unwrap() = Some(f);
    }

    #[cfg_attr(not(unix), allow(dead_code))]
    fn fall_back(&self, s: String) {
        if let Some(f) = self.fallback.lock().unwrap().as_ref() {
            f(s);
        }
    }
}

/// The socket line for one insert.
pub fn text_op(id: &str, text: &str) -> String {
    serde_json::json!({"op": "text_insert", "id": id, "text": text}).to_string()
}

/// What one line from the extension means for text insertion.
#[derive(Debug, PartialEq)]
pub enum TextReply<'a> {
    /// `hello …`: whether it offers text_insert.
    Hello(bool),
    /// `ok tN …` / `text tN …` (done) or `err tN …` (refused): the id, and whether refused.
    Answer(&'a str, bool),
    Other,
}

pub fn text_reply(line: &str) -> TextReply<'_> {
    let mut f = line.split_whitespace();
    match (f.next(), f.next()) {
        (Some("hello"), _) => TextReply::Hello(line.contains(" text_insert")),
        (Some(k @ ("ok" | "err" | "text")), Some(id)) if id.starts_with('t') => {
            TextReply::Answer(id, k == "err")
        }
        _ => TextReply::Other,
    }
}

// ── the socket loop (Unix only) ─────────────────────────────────────────────────────────────

/// What [`start`] hands the bridge.
pub struct Started {
    /// The hook for router messages (`None` when agent ink is off).
    pub hook: Option<crate::ws_client::OnMessage>,
    /// Dock actions for the router.
    pub actions: tokio::sync::mpsc::Receiver<String>,
    /// Text insertion.
    pub link: std::sync::Arc<Link>,
}

/// Starts the socket loop (agent_ink.go); `None` when the socket is off.
#[cfg(unix)]
pub fn start(
    cfg: &crate::flags::Config,
    pages: Option<crate::page_watch::PageFeed>,
) -> Option<Started> {
    use tokio::sync::mpsc;
    let path = cfg.ink_socket.trim().to_string();
    if path.is_empty() || path.eq_ignore_ascii_case("off") {
        return None;
    }
    let (act_tx, act_rx) = mpsc::channel::<String>(64);
    let (msg_tx, msg_rx) = mpsc::channel::<String>(1024);
    let (text_tx, text_rx) = mpsc::channel::<String>(256);
    let (status_tx, status_rx) = mpsc::channel::<()>(1);
    let on = initial_agent_ink(AGENT_INK_STATE_FILE, cfg.native_agent_ink);
    let link = std::sync::Arc::new(Link {
        agent_on: on.into(),
        status_tx,
        text_ok: false.into(),
        text_tx,
        fallback: std::sync::Mutex::new(None),
    });
    let l = link.clone();
    let hook: Option<crate::ws_client::OnMessage> = Some(std::sync::Arc::new(move |data: &str| {
        // only stroke messages, and only while agent ink is on; the forwarder checks the layer
        if l.agent_on() && data.contains("\"stroke_") {
            let _ = msg_tx.try_send(data.to_string()); // far behind: dropped, never blocks the reader
        }
    }));
    println!("[ink] socket {path}, native agent ink {on}");
    tokio::spawn(forever(
        path,
        msg_rx,
        text_rx,
        status_rx,
        act_tx,
        link.clone(),
        pages,
        cfg.debug,
    ));
    Some(Started {
        hook,
        actions: act_rx,
        link,
    })
}

#[cfg(unix)]
fn current_page(pages: &Option<crate::page_watch::PageFeed>) -> Page {
    pages
        .as_ref()
        .and_then(|rx| rx.borrow().as_deref().map(page_of))
        .unwrap_or_default()
}

/// One receiver per source the socket writer serves; they are the loop's inputs, not settings.
#[cfg(unix)]
#[allow(clippy::too_many_arguments)]
async fn forever(
    path: String,
    mut msgs: tokio::sync::mpsc::Receiver<String>,
    mut texts: tokio::sync::mpsc::Receiver<String>,
    mut status: tokio::sync::mpsc::Receiver<()>,
    actions: tokio::sync::mpsc::Sender<String>,
    link: std::sync::Arc<Link>,
    pages: Option<crate::page_watch::PageFeed>,
    debug: bool,
) {
    use std::sync::atomic::Ordering;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut fwd = Forwarder::default();
    let mut backoff = Duration::from_secs(1);
    let mut logged = false;
    let mut msgs_open = true;
    let mut seq: u64 = 0;
    let mut pending: std::collections::HashMap<String, String> = Default::default();
    loop {
        let conn = match tokio::net::UnixStream::connect(&path).await {
            Ok(c) => c,
            Err(e) => {
                if !logged || debug {
                    println!("[ink] {path} not available ({e}); retrying up to every 30 s");
                    logged = true;
                }
                tokio::time::sleep(backoff).await;
                backoff = next_backoff(backoff);
                continue;
            }
        };
        println!("[ink] connected to {path}");
        backoff = Duration::from_secs(1);
        logged = false;
        let (rd, mut wr) = conn.into_split();
        let mut lines = BufReader::new(rd).lines();
        let first = status_line("rust", link.agent_on()) + "\n";
        if !matches!(tokio::time::timeout(Duration::from_secs(2), wr.write_all(first.as_bytes())).await, Ok(Ok(()))) {
            println!("[ink] write failed");
            continue;
        }
        loop {
            let out: Option<String> = tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(l)) => {
                        match text_reply(&l) {
                            TextReply::Hello(on) => {
                                link.text_ok.store(on, Ordering::SeqCst);
                                println!("[ink] extension: {l} (text insertion {on})");
                            }
                            TextReply::Answer(id, refused) => match pending.remove(id) {
                                Some(text) if refused => {
                                    println!("[ink] text insert refused ({l}); typing it instead");
                                    link.fall_back(text);
                                }
                                _ if debug || l.starts_with("text") => println!("[ink] extension: {l}"),
                                _ => {}
                            },
                            TextReply::Other if l.starts_with('{') => {
                                let now_ms = crate::util::now_nanos() / 1_000_000;
                                match dock_action(&l, &current_page(&pages), now_ms as i64) {
                                    Some(out) => {
                                        println!("[ink] action {out}");
                                        if l.contains("\"id\":\"agent_ink\"") {
                                            println!("[ink] native agent ink now {} (dock)", link.toggle_agent_ink(AGENT_INK_STATE_FILE));
                                        }
                                        if actions.try_send(out).is_err() {
                                            println!("[ink] action dropped: router link backed up");
                                        }
                                    }
                                    None => println!("[ink] refused action {l:?}"),
                                }
                            }
                            TextReply::Other => {
                                if l.starts_with("err") || debug {
                                    println!("[ink] extension: {l}");
                                }
                            }
                        }
                        None
                    }
                    _ => break,
                },
                _ = status.recv() => Some(status_line("rust", link.agent_on())),
                t = texts.recv() => match t {
                    Some(text) => {
                        seq += 1;
                        let id = format!("t{seq}");
                        let line = text_op(&id, &text);
                        pending.insert(id, text);
                        Some(line)
                    }
                    None => None,
                },
                m = msgs.recv(), if msgs_open => match m {
                    Some(_) if !link.agent_on() => None, // switched off while it waited
                    Some(m) => {
                        let (line, why) = fwd.handle(&m, &current_page(&pages), Instant::now());
                        if let Some(why) = why {
                            println!("[ink] not sent: {why}");
                        }
                        line
                    }
                    None => {
                        msgs_open = false;
                        None
                    }
                },
            };
            if let Some(mut line) = out {
                line.push('\n');
                let w = tokio::time::timeout(Duration::from_secs(2), wr.write_all(line.as_bytes()))
                    .await;
                if !matches!(w, Ok(Ok(()))) {
                    println!("[ink] write failed");
                    break;
                }
            }
        }
        link.text_ok.store(false, Ordering::SeqCst);
        for (_, text) in pending.drain() {
            link.fall_back(text); // asked but never answered: type it
        }
        println!(
            "[ink] disconnected (sent {}, dropped rate {} size {} no-page {})",
            fwd.sent, fwd.dropped_rate, fwd.dropped_size, fwd.dropped_no_page
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page() -> Page {
        Page {
            doc: "doc-1".into(),
            page: "ae4d6014-80e8-41c8-bb8a-e4686393a249".into(),
            w: 1620.0,
            h: 2160.0,
        }
    }

    fn feed(
        f: &mut Forwarder,
        p: &Page,
        now: Instant,
        msgs: &[&str],
    ) -> (Vec<String>, Vec<String>) {
        let (mut lines, mut whys) = (vec![], vec![]);
        for m in msgs {
            let (l, w) = f.handle(m, p, now);
            lines.extend(l);
            whys.extend(w);
        }
        (lines, whys)
    }

    /// Go: `TestAiStrokeBecomesOneLineInPageCoordinates`, the same bytes.
    #[test]
    fn ai_stroke_becomes_one_line_in_page_coordinates() {
        let mut f = Forwarder::default();
        let (lines, whys) = feed(
            &mut f,
            &page(),
            Instant::now(),
            &[
                r##"{"t":"stroke_begin","id":"a1","layer":"ai","brush":"pen","color":"#d03030"}"##,
                r#"{"t":"stroke_pts","id":"a1","pts":[[0.5,0.25,0.5,1730000000000],[0.75,0.5]]}"#,
                r#"{"t":"stroke_end","id":"a1"}"#,
            ],
        );
        assert!(whys.is_empty(), "{whys:?}");
        assert_eq!(
            lines,
            vec![
                r#"{"id":"a1","page":"ae4d6014-80e8-41c8-bb8a-e4686393a249","layer":"agent","strokes":[{"tool":"ballpoint","argb":"ffd03030","thickness":2,"pts":[[0,540,0.5,4],[405,1080,0.6,4]]}]}"#
            ]
        );
    }

    #[test]
    fn only_the_ai_layer_is_forwarded() {
        let mut f = Forwarder::default();
        for layer in ["user", "peer", ""] {
            let begin = format!(r#"{{"t":"stroke_begin","id":"u1","layer":"{layer}"}}"#);
            let (lines, _) = feed(
                &mut f,
                &page(),
                Instant::now(),
                &[
                    &begin,
                    r#"{"t":"stroke_pts","id":"u1","pts":[[0.5,0.5,0.5]]}"#,
                    r#"{"t":"stroke_end","id":"u1"}"#,
                ],
            );
            assert!(lines.is_empty(), "layer {layer:?} forwarded");
        }
    }

    #[test]
    fn size_caps_drop_whole_strokes() {
        let mut f = Forwarder {
            max_points: 3,
            ..Forwarder::default()
        };
        let (_, whys) = feed(
            &mut f,
            &page(),
            Instant::now(),
            &[
                r#"{"t":"stroke_begin","id":"big","layer":"ai"}"#,
                r#"{"t":"stroke_pts","id":"big","pts":[[0.1,0.1],[0.2,0.2],[0.3,0.3],[0.4,0.4]]}"#,
                r#"{"t":"stroke_end","id":"big"}"#,
            ],
        );
        assert_eq!((f.dropped_size, whys.len()), (1, 1));
        let (_, whys) = feed(
            &mut f,
            &page(),
            Instant::now(),
            &[
                r#"{"t":"stroke_begin","id":"off","layer":"ai"}"#,
                r#"{"t":"stroke_pts","id":"off","pts":[[0.5,3.0]]}"#,
                r#"{"t":"stroke_end","id":"off"}"#,
            ],
        );
        assert!(
            whys.len() == 1 && whys[0].contains("off the page"),
            "{whys:?}"
        );
        let mut g = Forwarder {
            max_open: 1,
            ..Forwarder::default()
        };
        let (_, whys) = feed(
            &mut g,
            &page(),
            Instant::now(),
            &[
                r#"{"t":"stroke_begin","id":"x","layer":"ai"}"#,
                r#"{"t":"stroke_begin","id":"y","layer":"ai"}"#,
            ],
        );
        assert_eq!(whys.len(), 1);
    }

    #[test]
    fn rate_cap() {
        let mut f = Forwarder {
            burst: 2.0,
            per_second: 1.0,
            ..Forwarder::default()
        };
        let t0 = Instant::now();
        let one = |f: &mut Forwarder, id: &str, now: Instant| {
            let b = format!(r#"{{"t":"stroke_begin","id":"{id}","layer":"ai"}}"#);
            let p = format!(r#"{{"t":"stroke_pts","id":"{id}","pts":[[0.5,0.5]]}}"#);
            let e = format!(r#"{{"t":"stroke_end","id":"{id}"}}"#);
            feed(f, &page(), now, &[&b, &p, &e]).0.len()
        };
        assert_eq!(one(&mut f, "a", t0), 1);
        assert_eq!(one(&mut f, "b", t0), 1);
        assert_eq!(one(&mut f, "c", t0), 0);
        assert_eq!(f.dropped_rate, 1);
        assert_eq!(one(&mut f, "d", t0 + Duration::from_millis(1100)), 1);
    }

    #[test]
    fn no_page_no_ink() {
        let mut f = Forwarder::default();
        let (lines, whys) = feed(
            &mut f,
            &Page::default(),
            Instant::now(),
            &[
                r#"{"t":"stroke_begin","id":"a","layer":"ai"}"#,
                r#"{"t":"stroke_pts","id":"a","pts":[[0.5,0.5]]}"#,
                r#"{"t":"stroke_end","id":"a"}"#,
            ],
        );
        assert!(lines.is_empty() && whys.len() == 1 && f.dropped_no_page == 1);
    }

    #[test]
    fn parse_argb_and_tool_word() {
        for (input, want) in [
            ("#d03030", 0xffd03030),
            ("#11223380", 0x80112233),
            ("#ffffff", DEFAULT_ARGB),
            ("", DEFAULT_ARGB),
            ("red", DEFAULT_ARGB),
            ("#1122330a", 0xff112233),
        ] {
            assert_eq!(parse_argb(input), want, "parse_argb({input:?})");
        }
        for (input, want) in [
            ("pen", "ballpoint"),
            ("ghost", "fineliner"),
            ("eraser", "fineliner"),
            ("highlighter", "fineliner"),
            ("Calligraphy", "calligraphy"),
            ("", "fineliner"),
        ] {
            assert_eq!(tool_word(input), want, "tool_word({input:?})");
        }
    }

    /// Go: `TestEncodeEscapesStrings`, the same bytes.
    #[test]
    fn encode_escapes_strings() {
        let ls = LineStroke {
            tool: "fineliner".into(),
            argb: "ff000000".into(),
            thickness: 1.5,
            pts: vec![[-810.0, 0.25, 1.0, 3.0]],
        };
        assert_eq!(
            encode("a\"b\\c\n", "p", &ls),
            r#"{"id":"a\"b\\c\u000a","page":"p","layer":"agent","strokes":[{"tool":"fineliner","argb":"ff000000","thickness":1.5,"pts":[[-810,0.25,1,3]]}]}"#
        );
    }

    #[test]
    fn dock_action_gets_the_doc() {
        let p = page();
        let out = dock_action(r#"{"t":"dock_action","id":"ask_page","page":"ae4d6014-80e8-41c8-bb8a-e4686393a249","source":"dock"}"#, &p, 5).unwrap();
        assert!(
            out.contains(r#""doc":"doc-1""#) && out.contains(r#""ts":5"#),
            "{out}"
        );
        assert_eq!(dock_action(r#"{"t":"stroke_begin","id":"x"}"#, &p, 5), None);
        let other = dock_action(r#"{"t":"dock_action","id":"x","page":"other"}"#, &p, 5).unwrap();
        assert!(!other.contains(r#""doc""#), "{other}");
    }

    #[test]
    fn text_ops_and_replies() {
        assert_eq!(
            text_op("t1", "a [b] {c} ^ ~\n"),
            r#"{"id":"t1","op":"text_insert","text":"a [b] {c} ^ ~\n"}"#
        );
        assert_eq!(
            text_reply("hello codrawer-layer ink text_insert text_read"),
            TextReply::Hello(true)
        );
        assert_eq!(
            text_reply("hello codrawer-layer ink"),
            TextReply::Hello(false)
        );
        assert_eq!(
            text_reply("err t3 no focused item"),
            TextReply::Answer("t3", true)
        );
        assert_eq!(
            text_reply("ok t3 text_insert 4 via=im"),
            TextReply::Answer("t3", false)
        );
        assert_eq!(text_reply("ok a1 1"), TextReply::Other);
    }

    #[test]
    fn agent_ink_choice_and_status() {
        let dir = std::env::temp_dir().join(format!("codrawer-agentink-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("native_agent_ink").to_string_lossy().into_owned();
        let _ = std::fs::remove_file(&f);
        assert!(!initial_agent_ink(&f, false) && initial_agent_ink(&f, true), "no file: the env decides");
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let (text_tx, _text_rx) = tokio::sync::mpsc::channel(1);
        let link = Link { agent_on: false.into(), status_tx: tx, text_ok: false.into(), text_tx, fallback: std::sync::Mutex::new(None) };
        assert!(link.toggle_agent_ink(&f));
        assert!(rx.try_recv().is_ok(), "a new status line was asked for");
        assert!(initial_agent_ink(&f, false), "the choice was kept");
        assert_eq!(status_line("go", true), "status codrawer go bridge: connected, agent ink on");
    }

    #[test]
    fn page_of_reads_the_header() {
        let p = page_of(r#"{"t":"page","doc":"d","page":"p","w":1620,"h":2160,"strokes":[]}"#);
        assert_eq!(
            p,
            Page {
                doc: "d".into(),
                page: "p".into(),
                w: 1620.0,
                h: 2160.0
            }
        );
    }
}
