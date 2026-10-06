//! Bridge run loop (bridge.go).
//!
//! One direction of data, no shared mutable state between stages:
//! - The pen reader thread (`linux::pen_reader_forever`) owns the pen device for the life of the
//!   process and parses `input_event`s (with kernel timestamps) into a channel, reopening the
//!   device on error. After a kernel SYN_DROPPED it resynchronises contact and position from the
//!   device state.
//! - [`pen_machine_forever`]: one [`pen::Machine`] for the life of the process. It always drains
//!   the pen events, so contact state is never lost while the network is down, and turns them into
//!   encoded messages on the outbox. A full outbox skips whole strokes, never single events.
//! - The keyboard reader thread does the same for a keyboard, producing `key` messages.
//! - The typer thread owns the virtual keyboard and types `term` replies into the tablet.
//! - The page thread ([`crate::page_watch`]) publishes xochitl's saved page as `page` snapshots
//!   (read-only); the latest one is sent on every connection.
//! - [`run_connections`] dials the router and writes the outbox (and keys) until the socket dies,
//!   then reconnects. It also notices a suspend/resume and reconnects at once instead of writing
//!   into a socket that died while the tablet slept.
//!
//! Nothing here wakes on a timer while the tablet is idle: the batch timer is armed only while
//! points wait, the suspend check runs at each write rather than every second, and the only
//! periodic work left on a connection is its keepalive ping (`-ping-seconds`, 10 s).
//! docs/investigations/idle-cost.md has the measurements.

use std::time::{Duration, SystemTime};

use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::flags::Config;
use crate::input::{AbsRanges, RawEvent};
use crate::keymap::OutKey;
use crate::page_watch::PageFeed;
use crate::pen;
use crate::util::{go_duration, now_nanos};
use crate::ws_client::{self, OnMessage, WsConn};

/// Bounds what is held while the link is down: about 30 s of continuous drawing at 60 batches/s.
/// Older ink is delivered first when the link returns.
pub const OUTBOX_SIZE: usize = 2048;

/// The subset of a `term` broadcast the typer cares about.
#[derive(Deserialize)]
struct TermMsg {
    #[serde(default)]
    t: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    text: String,
}

/// What the typer should type for a router message, if anything. Text arrives as coalesced
/// chunks; notes get their own line; the prompt echo (`> …`) is skipped because the user typed it.
pub fn typed_reply(data: &str) -> Option<String> {
    let m: TermMsg = serde_json::from_str(data).ok()?;
    if m.t != "term" {
        return None;
    }
    match m.kind.as_str() {
        "text" => Some(m.text),
        "note" if m.text.starts_with("> ") => None,
        "note" | "permission" | "question" => Some(format!("\n{}\n", m.text)),
        _ => None,
    }
}

/// The pen machine's settings from the config.
pub fn pen_config(cfg: &Config) -> pen::Config {
    pen::Config {
        brush: cfg.brush.clone(),
        color: cfg.color.clone(),
        touch_mode: cfg.touch_mode.clone(),
        pressure_threshold: cfg.pressure_threshold,
        distance_threshold: cfg.distance_threshold,
        flush_every: Duration::from_secs(1) / cfg.batch_hz.clamp(1, u32::MAX as i64) as u32,
        max_batch: cfg.max_batch_points.max(0) as usize,
        hover_every: hover_every(cfg.hover_hz),
        tool: tool_of(&cfg.tool_file),
    }
}

/// Follows xochitl's selected tool in `path` ([`crate::toolhint`]), or `None` for "off" or "".
/// The file exists only while the codrawer-layer extension runs inside xochitl.
pub fn tool_of(path: &str) -> Option<pen::Tool> {
    if path.is_empty() || path == "off" {
        return None;
    }
    let mut f = crate::toolhint::File::new(path);
    Some(pen::Tool::new(move || f.tool().to_string()))
}

/// The cursor pacing for `hover_hz` messages per second; zero (off) when `hz <= 0`.
pub fn hover_every(hz: i64) -> Duration {
    if hz <= 0 {
        return Duration::ZERO;
    }
    Duration::from_secs(1) / hz.min(u32::MAX as i64) as u32
}

/// Marks the bridge as a pen source: a replaying router then skips the page replay, which the
/// bridge has no use for. Routers that do not replay ignore it. `replay=0` is added only when the
/// URL has no non-empty `replay` parameter (Go: `q.Get("replay") == ""`).
pub fn source_url(raw: &str) -> String {
    let (base, frag) = match raw.find('#') {
        Some(i) => raw.split_at(i),
        None => (raw, ""),
    };
    let (path, query) = match base.find('?') {
        Some(i) => (&base[..i], &base[i + 1..]),
        None => (base, ""),
    };
    fn is_replay(p: &str) -> bool {
        p.split('=').next() == Some("replay")
    }
    let params: Vec<&str> = query.split('&').filter(|p| !p.is_empty()).collect();
    // Go's Get returns the first value; a non-empty one is left alone.
    if let Some(p) = params.iter().find(|p| is_replay(p)) {
        if !p.split_once('=').map(|(_, v)| v).unwrap_or("").is_empty() {
            return raw.to_string();
        }
    }
    let mut kept: Vec<&str> = params.into_iter().filter(|p| !is_replay(p)).collect();
    kept.push("replay=0");
    format!("{path}?{}{frag}", kept.join("&"))
}

/// Event sources that outlive a single connection.
pub struct Sources {
    /// Encoded stroke messages from the pen machine.
    pub out_rx: mpsc::Receiver<String>,
    pub key_rx: Option<mpsc::Receiver<OutKey>>,
    /// The latest `page` snapshot, when the page watcher runs.
    pub pages: Option<PageFeed>,
    /// A message taken from the outbox or the keyboard but not written, because the tablet had
    /// just resumed and the socket was presumed dead: the next connection writes it first.
    pub held: Option<String>,
}

#[cfg(not(target_os = "linux"))]
pub async fn run_bridge_forever(cfg: Config) -> Result<(), String> {
    if cfg.list_devices {
        for d in crate::devices::list_proc_input_devices() {
            println!("name={:?} handlers=[{}]", d.name, d.handlers.join(" "));
        }
        return Ok(());
    }
    Err("the pen bridge needs Linux input devices; on this OS run -router-only -serve :8577".into())
}

#[cfg(target_os = "linux")]
pub async fn run_bridge_forever(cfg: Config) -> Result<(), String> {
    use crate::linux;

    if cfg.list_devices {
        for d in crate::devices::list_proc_input_devices() {
            println!("name={:?} handlers=[{}]", d.name, d.handlers.join(" "));
        }
        return Ok(());
    }

    let probe = Duration::from_secs_f64(cfg.probe_seconds.max(0.1));
    let (explicit, debug) = (cfg.input_device.clone(), cfg.debug);
    let path = tokio::task::spawn_blocking(move || linux::auto_detect_active_device(&explicit, debug, probe))
        .await
        .map_err(|e| e.to_string())??;
    println!("[bridge] using input device: {path}");

    // The pen reader owns the device for the whole process; the pen machine consumes its events.
    let (ev_tx, ev_rx) = mpsc::channel(4096);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    {
        let (path, no_grab, dump) = (path.clone(), cfg.no_grab, cfg.dump_events);
        std::thread::Builder::new()
            .name("pen".into())
            .spawn(move || linux::pen_reader_forever(&path, no_grab, dump, ev_tx, ready_tx))
            .map_err(|e| e.to_string())?;
    }
    let rng = ready_rx.await.map_err(|_| "pen reader exited".to_string())?;

    let (out_tx, out_rx) = mpsc::channel(OUTBOX_SIZE);
    tokio::spawn(pen_machine_forever(pen_config(&cfg), rng, ev_rx, out_tx, debug, Some(Box::new(|_| linux::hold_awake()))));

    // Keyboard messages flow through this channel regardless of socket state.
    let key_rx = if cfg.keyboard.trim().to_lowercase() != "off" {
        let (tx, rx) = mpsc::channel(256);
        let (kb, grab) = (cfg.keyboard.clone(), cfg.keyboard_grab);
        std::thread::Builder::new()
            .name("keyboard".into())
            .spawn(move || linux::run_keyboard_forever(&kb, grab, debug, tx))
            .map_err(|e| e.to_string())?;
        Some(rx)
    } else {
        None
    };

    // xochitl's saved page as `page` snapshots, when enabled for this OS (logs either way).
    let pages = crate::page_watch::start_if_enabled(&cfg)?;

    // Terminal replies typed into the tablet (uinput).
    let on_message: Option<OnMessage> = if cfg.type_replies {
        let (tx, rx) = std::sync::mpsc::sync_channel::<String>(1024);
        let per_char = Duration::from_millis(cfg.type_char_ms.max(1) as u64);
        std::thread::Builder::new()
            .name("typer".into())
            .spawn(move || linux::typer_forever(rx, per_char, debug))
            .map_err(|e| e.to_string())?;
        Some(std::sync::Arc::new(move |data: &str| {
            if let Some(s) = typed_reply(data) {
                let _ = tx.try_send(s);
            }
        }))
    } else {
        None
    };

    run_connections(cfg, Sources { out_rx, key_rx, pages, held: None }, on_message).await
}

/// Runs the stroke state machine for the life of the process: drains pen events into encoded
/// messages on `out_tx`. Returns only when the pen reader goes away.
pub async fn pen_machine_forever(
    cfg: pen::Config,
    rng: AbsRanges,
    mut ev_rx: mpsc::Receiver<RawEvent>,
    out_tx: mpsc::Sender<String>,
    debug: bool,
    on_stroke: Option<Box<dyn FnMut(bool) + Send>>,
) {
    let tx = out_tx.clone();
    let mut m = pen::Machine::new(cfg, rng, Box::new(move |msg| tx.try_send(msg).is_ok()));
    m.on_stroke = on_stroke;
    let mut due: Option<Instant> = None; // the batch timer, armed only while points wait
    let mut debug_tick = Instant::now();
    loop {
        tokio::select! {
            ev = ev_rx.recv() => match ev {
                Some(ev) => m.handle(ev),
                None => return,
            },
            _ = tokio::time::sleep_until(due.unwrap_or_else(Instant::now)), if due.is_some() => {
                due = None;
                m.flush(false);
            }
        }
        // Arm the batch timer only while points are waiting: no wakeups while the pen is idle.
        if due.is_none() {
            due = m.pending().map(Instant::from_std);
        }
        if debug && debug_tick.elapsed() > Duration::from_secs(2) {
            debug_tick = Instant::now();
            println!(
                "[bridge] stats touching={} strokes={} skipped={} outbox={}",
                m.touching(),
                m.strokes(),
                m.lost_strokes(),
                out_tx.max_capacity() - out_tx.capacity()
            );
        }
    }
}

/// The reconnect loop. Never returns on its own.
pub async fn run_connections(cfg: Config, mut src: Sources, on_message: Option<OnMessage>) -> Result<(), String> {
    let ping_every = Duration::from_secs_f64(cfg.ping_seconds.max(1.0));
    let pong_wait = Duration::from_secs_f64(cfg.pong_timeout_seconds.max(2.0));
    let ws_url = source_url(&cfg.ws_url);
    let base_delay = Duration::from_millis(500);
    let max_delay = Duration::from_secs(5);
    let mut reconnect_delay = base_delay;

    loop {
        let (ws, mut err_rx) = match ws_client::dial(&ws_url, ping_every, pong_wait, on_message.clone()).await {
            Ok(c) => c,
            Err(e) => {
                let jitter = Duration::from_nanos((now_nanos() % 250_000_000) as u64);
                println!("[bridge] ws connect error: {e}; retrying in {}", go_duration(reconnect_delay + jitter));
                tokio::time::sleep(reconnect_delay + jitter).await;
                reconnect_delay = reconnect_delay.mul_f64(1.7).min(max_delay);
                continue;
            }
        };
        println!("[bridge] connected ws={ws_url}");
        reconnect_delay = base_delay;

        let err = write_outbox(&mut src, &ws, &mut err_rx).await;
        ws.close();
        println!("[bridge] disconnected; reconnecting in {} (err={err})", go_duration(reconnect_delay));
        tokio::time::sleep(reconnect_delay).await;
    }
}

async fn recv_opt<T>(rx: &mut Option<mpsc::Receiver<T>>) -> Option<T> {
    match rx {
        Some(r) => r.recv().await,
        None => std::future::pending().await,
    }
}

/// Waits for a page snapshot this connection has not sent yet. Snapshots published while the
/// socket was busy collapse into the latest (the watch channel keeps only one). Never resolves
/// without a feed, or once the watcher thread is gone.
async fn next_page(pages: &mut Option<PageFeed>) -> String {
    let Some(rx) = pages else { return std::future::pending().await };
    loop {
        if rx.changed().await.is_err() {
            return std::future::pending().await;
        }
        if let Some(page) = rx.borrow_and_update().clone() {
            return page;
        }
    }
}

/// How long the system slept between two clock readings: wall time that passed beyond the
/// monotonic time (which stops during suspend). `None` if the wall clock went backwards.
pub fn suspend_gap(wall_elapsed: Option<Duration>, mono_elapsed: Duration) -> Option<Duration> {
    wall_elapsed?.checked_sub(mono_elapsed)
}

/// Notices that the tablet slept: the wall clock ran more than 2 s ahead of the monotonic clock
/// (which stops in suspend) since the last look. Looking costs two clock reads, so it is done
/// at each write instead of on a timer: an idle bridge does not wake to check, and a write is
/// exactly when a socket that died in suspend would swallow ink.
pub struct SuspendCheck {
    wall: SystemTime,
    mono: std::time::Instant,
}

impl SuspendCheck {
    pub fn new() -> Self {
        SuspendCheck { wall: SystemTime::now(), mono: std::time::Instant::now() }
    }

    /// `Some(reason)` when the tablet slept since the last call (or since `new`).
    pub fn resumed(&mut self) -> Option<String> {
        self.resumed_at(SystemTime::now(), std::time::Instant::now())
    }

    /// [`SuspendCheck::resumed`] with the clocks given (tests).
    pub fn resumed_at(&mut self, wall: SystemTime, mono: std::time::Instant) -> Option<String> {
        let gap = suspend_gap(wall.duration_since(self.wall).ok(), mono.duration_since(self.mono));
        (self.wall, self.mono) = (wall, mono);
        let gap = gap.filter(|g| *g > Duration::from_secs(2))?;
        let rounded = Duration::from_secs((gap.as_millis() as u64 + 500) / 1000);
        Some(format!("resumed after ~{} asleep", go_duration(rounded)))
    }
}

impl Default for SuspendCheck {
    fn default() -> Self {
        Self::new()
    }
}

/// Writes one message unless the tablet has just resumed; then the message is held for the next
/// connection (in `held`) and the reason returned, so the caller reconnects first.
async fn write_checked(ws: &WsConn, msg: String, check: &mut SuspendCheck, held: &mut Option<String>) -> Result<(), String> {
    if let Some(why) = check.resumed() {
        *held = Some(msg);
        return Err(why);
    }
    // On failure the message is lost with the socket; the router ends the stroke.
    ws.write_text(msg).await
}

/// Writes queued messages (and keys) until the socket fails; returns the error. A tablet that was
/// suspended ([`SuspendCheck`]) has its socket presumed dead (its timers did not run while
/// asleep): the message is held and the caller reconnects immediately.
pub async fn write_outbox(src: &mut Sources, ws: &WsConn, err_rx: &mut mpsc::Receiver<String>) -> String {
    let mut check = SuspendCheck::new();
    // A new socket may lead to a new router (restarted, or the desktop instead of the tablet's
    // own): it gets the latest page snapshot first, as Go's pumpPages does.
    if let Some(pages) = &mut src.pages {
        pages.mark_changed();
    }
    if let Some(msg) = src.held.take() {
        if let Err(e) = write_checked(ws, msg, &mut check, &mut src.held).await {
            return e;
        }
    }
    loop {
        let r = tokio::select! {
            e = err_rx.recv() => {
                // ping/pong/close/write failure: bail so the outer loop reconnects
                return e.unwrap_or_else(|| "connection closed".into());
            }
            msg = src.out_rx.recv() => {
                let Some(msg) = msg else { return "pen machine stopped".into() };
                write_checked(ws, msg, &mut check, &mut src.held).await
            }
            k = recv_opt(&mut src.key_rx) => match k {
                Some(k) => write_checked(ws, serde_json::to_string(&k).expect("serialize"), &mut check, &mut src.held).await,
                None => Ok(()),
            },
            page = next_page(&mut src.pages) => {
                // not held: every new connection sends the latest page anyway
                let mut dropped = None;
                write_checked(ws, page, &mut check, &mut dropped).await
            }
        };
        if let Err(e) = r {
            return e;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::*;

    #[test]
    fn typer_filters_term_messages() {
        assert_eq!(typed_reply(r#"{"t":"term","kind":"text","text":"hi"}"#).as_deref(), Some("hi"));
        assert_eq!(typed_reply(r#"{"t":"term","kind":"note","text":"> echo"}"#), None);
        assert_eq!(typed_reply(r#"{"t":"term","kind":"note","text":"done"}"#).as_deref(), Some("\ndone\n"));
        assert_eq!(typed_reply(r#"{"t":"term","kind":"permission","text":"y?"}"#).as_deref(), Some("\ny?\n"));
        assert_eq!(typed_reply(r#"{"t":"term","kind":"status","text":"x"}"#), None);
        assert_eq!(typed_reply(r#"{"t":"stroke_end","id":"u_1"}"#), None);
        assert_eq!(typed_reply("not json"), None);
    }

    #[test]
    fn source_url_adds_replay_0_only_if_absent() {
        assert_eq!(source_url("ws://h:8577/ws/session1"), "ws://h:8577/ws/session1?replay=0");
        assert_eq!(source_url("ws://h/ws/s?a=1"), "ws://h/ws/s?a=1&replay=0");
        assert_eq!(source_url("ws://h/ws/s?replay=1"), "ws://h/ws/s?replay=1");
        assert_eq!(source_url("ws://h/ws/s?a=1&replay=0"), "ws://h/ws/s?a=1&replay=0");
        assert_eq!(source_url("ws://h/ws/s?replay=&a=1"), "ws://h/ws/s?a=1&replay=0");
        assert_eq!(source_url("ws://h/ws/s?replays=1"), "ws://h/ws/s?replays=1&replay=0");
    }

    #[test]
    fn suspend_is_wall_time_beyond_monotonic() {
        let s = Duration::from_secs;
        assert_eq!(suspend_gap(Some(s(31)), s(1)), Some(s(30)));
        assert_eq!(suspend_gap(Some(s(1)), s(1)), Some(s(0)));
        assert_eq!(suspend_gap(None, s(1)), None); // wall clock stepped back
        assert_eq!(suspend_gap(Some(s(0)), s(1)), None);
    }

    /// The check runs at writes, however far apart: only a wall clock that ran ahead of the
    /// monotonic one counts, never the time between writes itself.
    #[test]
    fn suspend_check_compares_the_clocks_between_writes() {
        let s = Duration::from_secs;
        let mut c = SuspendCheck::new();
        let (w0, m0) = (c.wall, c.mono);
        assert_eq!(c.resumed_at(w0 + s(600), m0 + s(600)), None, "ten idle minutes awake");
        assert_eq!(c.resumed_at(w0 + s(602), m0 + s(601)), None, "within 2 s of drift");
        assert_eq!(c.resumed_at(w0 + s(700), m0 + s(611)).as_deref(), Some("resumed after ~1m28s asleep"), "98 s of wall time in 10 s awake");
        assert_eq!(c.resumed_at(w0 + s(701), m0 + s(612)), None, "reported once");
        assert_eq!(c.resumed_at(w0, m0 + s(613)), None, "a wall clock stepped back is no suspend");
    }

    type ServerWs = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    /// Accepts the bridge's next connection (within 10 s).
    async fn accept_ws(listener: &tokio::net::TcpListener) -> ServerWs {
        let accept = async {
            let (stream, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(stream).await.unwrap()
        };
        tokio::time::timeout(Duration::from_secs(10), accept).await.expect("the bridge did not connect")
    }

    /// The next text message on a connection (within 10 s).
    async fn next_text(ws: &mut ServerWs) -> String {
        use futures_util::StreamExt;
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(10), ws.next()).await.expect("timeout");
            if let tokio_tungstenite::tungstenite::Message::Text(t) = msg.expect("closed").expect("ws error") {
                return t.to_string();
            }
        }
    }

    /// Go's pumpPages: the latest snapshot goes out on every new connection, then each new one.
    #[tokio::test]
    async fn the_latest_page_is_sent_on_every_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut cfg = Config::from_env();
        cfg.ws_url = format!("ws://{}/ws/s1", listener.local_addr().unwrap());
        let (_out_tx, out_rx) = mpsc::channel(8);
        let (page_tx, page_rx) = tokio::sync::watch::channel(Some(r#"{"t":"page","rev":1}"#.to_string()));
        let src = Sources { out_rx, key_rx: None, pages: Some(page_rx), held: None };
        tokio::spawn(run_connections(cfg, src, None));

        let mut first = accept_ws(&listener).await;
        assert_eq!(next_text(&mut first).await, r#"{"t":"page","rev":1}"#);
        drop(first); // the router goes away; the bridge reconnects and resends the page
        let mut second = accept_ws(&listener).await;
        assert_eq!(next_text(&mut second).await, r#"{"t":"page","rev":1}"#);

        // a new snapshot reaches the live connection
        page_tx.send_replace(Some(r#"{"t":"page","rev":2}"#.to_string()));
        assert_eq!(next_text(&mut second).await, r#"{"t":"page","rev":2}"#);
    }

    fn cfg() -> pen::Config {
        pen::Config {
            brush: "pen".into(),
            touch_mode: "auto".into(),
            pressure_threshold: 0.02,
            flush_every: Duration::from_millis(150),
            max_batch: 64,
            ..Default::default()
        }
    }

    fn point(x: i32) -> [RawEvent; 5] {
        let e = |etype, code, value| RawEvent { etype, code, value, time_ms: 0 };
        [e(EV_KEY, BTN_TOUCH, 1), e(EV_ABS, ABS_X, x), e(EV_ABS, ABS_Y, 500), e(EV_ABS, ABS_PRESSURE, 2048), e(EV_SYN, SYN_REPORT, 0)]
    }

    #[tokio::test]
    async fn machine_task_flushes_on_its_timer_and_survives_a_full_outbox() {
        let rng = AbsRanges { x_min: 0, x_max: 1000, y_min: 0, y_max: 1000, p_min: 0, p_max: 4096 };
        let (ev_tx, ev_rx) = mpsc::channel(64);
        let (out_tx, mut out_rx) = mpsc::channel(3); // a tiny outbox
        tokio::spawn(pen_machine_forever(cfg(), rng, ev_rx, out_tx, false, None));
        for x in [100, 110] {
            for e in point(x) {
                ev_tx.send(e).await.unwrap();
            }
        }
        // begin, the first point at once, then the held point once the timer fires
        let t = |s: String| serde_json::from_str::<serde_json::Value>(&s).unwrap()["t"].as_str().unwrap().to_string();
        let next = |rx: &mut mpsc::Receiver<String>| {
            let m = rx.try_recv();
            m.ok().map(t)
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(next(&mut out_rx).as_deref(), Some("stroke_begin"));
        assert_eq!(next(&mut out_rx).as_deref(), Some("stroke_pts"));
        assert_eq!(next(&mut out_rx), None, "held point leaked before the window closed");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(next(&mut out_rx).as_deref(), Some("stroke_pts"));

        // Nobody drains (link down): the machine keeps consuming events and the pen-up still
        // registers, so hovering afterwards does not draw.
        for i in 0..50 {
            for e in point(200 + i * 10) {
                ev_tx.send(e).await.unwrap();
            }
        }
        let up = [RawEvent { etype: EV_KEY, code: BTN_TOUCH, value: 0, time_ms: 0 }, RawEvent { etype: EV_ABS, code: ABS_PRESSURE, value: 0, time_ms: 0 }, RawEvent { etype: EV_SYN, code: SYN_REPORT, value: 0, time_ms: 0 }];
        for e in up {
            ev_tx.send(e).await.unwrap();
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        while out_rx.try_recv().is_ok() {}
        let hover = |x| [RawEvent { etype: EV_ABS, code: ABS_X, value: x, time_ms: 0 }, RawEvent { etype: EV_SYN, code: SYN_REPORT, value: 0, time_ms: 0 }];
        for e in hover(900) {
            ev_tx.send(e).await.unwrap();
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(next(&mut out_rx), None, "hover drew after a pen-up during an outage");
    }
}
