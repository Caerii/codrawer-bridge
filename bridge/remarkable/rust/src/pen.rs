//! Turns raw evdev pen events into codrawer stroke messages (`docs/protocol.md`); a port of the Go
//! package `bridge/remarkable/native/pen`.
//!
//! Pure logic with no device or socket access, so it is unit-tested on any OS. The bridge runs one
//! [`Machine`] for the life of the process and feeds it every event, whatever the state of the
//! network: contact state can never be lost to a stalled socket (a dropped pen-up used to leave the
//! pen "down", so hovering drew ink). Messages go to the emit callback; when it refuses one (the
//! outbox is full because the link is down), the rest of that stroke is skipped as a whole rather
//! than event by event, so receivers never see a stroke with holes or a merged one.
//!
//! The evdev keys tell the eraser end from the tip, but not the tool picked in xochitl's toolbar:
//! that comes from [`Config::tool`] ([`crate::toolhint`]), when xochitl reports it.

use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::util::push_rounded;

// Linux input constants this module interprets.
pub const EV_SYN: u16 = 0x00;
pub const EV_KEY: u16 = 0x01;
pub const EV_ABS: u16 = 0x03;

pub const SYN_REPORT: u16 = 0x00;
pub const SYN_DROPPED: u16 = 0x03;

pub const BTN_TOUCH: u16 = 0x14A;
pub const BTN_TOOL_PEN: u16 = 0x140;
pub const BTN_TOOL_RUBBER: u16 = 0x141;

pub const ABS_X: u16 = 0x00;
pub const ABS_Y: u16 = 0x01;
pub const ABS_PRESSURE: u16 = 0x18;
pub const ABS_DISTANCE: u16 = 0x19;

/// One `input_event`, with its kernel timestamp in Unix milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Event {
    pub etype: u16,
    pub code: u16,
    pub value: i32,
    pub time_ms: i64,
}

/// The device's axis ranges (EVIOCGABS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ranges {
    pub x_min: i32,
    pub x_max: i32,
    pub y_min: i32,
    pub y_max: i32,
    pub p_min: i32,
    pub p_max: i32,
}

impl Default for Ranges {
    /// The fallback when an ioctl fails (same as Go).
    fn default() -> Self {
        Ranges { x_min: 0, x_max: 1, y_min: 0, y_max: 1, p_min: 0, p_max: 4096 }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Config {
    /// Brush hint for pen strokes ("pen"); the rubber end is "eraser".
    pub brush: String,
    /// Optional color hint.
    pub color: String,
    /// auto|btn|pressure|distance|tool
    pub touch_mode: String,
    pub pressure_threshold: f64,
    pub distance_threshold: i64,
    /// Batch window after the first point of a stroke.
    pub flush_every: Duration,
    /// Flush early at this many points (0 → 64).
    pub max_batch: usize,
    /// Paces `cursor` messages while the pen hovers in range without touching (a pointer for
    /// viewers to follow); zero disables them.
    pub hover_every: Duration,
    /// If set, reports the tool xochitl's toolbar has selected for the tip ("eraser", "pen", …,
    /// or "" when unknown; [`crate::toolhint`]). It is asked at each pen-down with the tip and on
    /// hover samples. "eraser" makes a tip stroke an eraser stroke, the same as the eraser end.
    pub tool: Option<Tool>,
}

/// A shared source of the toolbar's tool word (Go: `func() string`). The pen machine is its only
/// caller, so the lock is never contended; it is there so that [`Config`] stays `Clone`.
#[derive(Clone)]
pub struct Tool(Arc<Mutex<dyn FnMut() -> String + Send>>);

impl Tool {
    pub fn new(f: impl FnMut() -> String + Send + 'static) -> Self {
        Tool(Arc::new(Mutex::new(f)))
    }

    /// The tool word now ("" when unknown).
    pub fn get(&self) -> String {
        let mut f = self.0.lock().unwrap_or_else(|e| e.into_inner());
        f()
    }
}

impl std::fmt::Debug for Tool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Tool(..)")
    }
}

/// A moment on both clocks: monotonic for batching, wall for ids and fallback timestamps
/// (Go's `time.Time` carries both).
#[derive(Debug, Clone, Copy)]
pub struct Stamp {
    pub mono: Instant,
    pub unix_nanos: i64,
}

impl Stamp {
    pub fn now() -> Self {
        let unix_nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as i64).unwrap_or(0);
        Stamp { mono: Instant::now(), unix_nanos }
    }

    pub fn unix_ms(&self) -> i64 {
        self.unix_nanos.div_euclid(1_000_000)
    }
}

pub type Emit = Box<dyn FnMut(String) -> bool + Send>;

/// The pen state machine. Not shared between threads.
pub struct Machine {
    cfg: Config,
    rng: Ranges,
    mode: String,
    /// Delivers one encoded message; false means it could not be queued.
    emit: Emit,
    /// If set, called at pen-down (true) and pen-up (false).
    pub on_stroke: Option<Box<dyn FnMut(bool) + Send>>,
    /// The clock for batching and fallback timestamps (tests replace it).
    pub now: Box<dyn FnMut() -> Stamp + Send>,

    x: i32,
    y: i32,
    p: i32,
    d: i32,
    has_x: bool,
    has_y: bool,
    btn_touch: bool,
    tool_pen: bool,
    tool_rubber: bool,
    touching: bool,
    /// The current stroke's messages are being skipped.
    lost: bool,
    id: String,
    brush: String,
    /// Encoded points of the pending batch, comma separated.
    batch: String,
    batch_n: usize,
    /// `None` = the first point goes out at once (Go's zero `time.Time`).
    last_flush: Option<Instant>,
    last: Option<(f64, f64)>,
    strokes: i64,
    lost_strokes: i64,
    /// A cursor was sent and no "gone" since.
    hovering: bool,
    /// `None` = no cursor sent yet (Go's zero `time.Time`: always due).
    last_hover: Option<Instant>,
    hover_x: f64,
    hover_y: f64,
}

impl Machine {
    pub fn new(mut cfg: Config, rng: Ranges, emit: Emit) -> Self {
        let mut mode = cfg.touch_mode.trim().to_lowercase();
        if mode.is_empty() {
            mode = "auto".into();
        }
        if cfg.max_batch == 0 {
            cfg.max_batch = 64;
        }
        let brush = cfg.brush.clone();
        Machine {
            cfg,
            rng,
            mode,
            emit,
            on_stroke: None,
            now: Box::new(Stamp::now),
            x: 0,
            y: 0,
            p: 0,
            d: 0,
            has_x: false,
            has_y: false,
            btn_touch: false,
            tool_pen: false,
            tool_rubber: false,
            touching: false,
            lost: false,
            id: String::new(),
            brush,
            batch: String::new(),
            batch_n: 0,
            last_flush: None,
            last: None,
            strokes: 0,
            lost_strokes: 0,
            hovering: false,
            last_hover: None,
            hover_x: 0.0,
            hover_y: 0.0,
        }
    }

    pub fn touching(&self) -> bool {
        self.touching
    }
    pub fn strokes(&self) -> i64 {
        self.strokes
    }
    pub fn lost_strokes(&self) -> i64 {
        self.lost_strokes
    }

    /// When the pending batch's window closes, if points are waiting.
    pub fn pending(&mut self) -> Option<Instant> {
        if self.batch_n == 0 {
            return None;
        }
        Some(match self.last_flush {
            Some(t) => t + self.cfg.flush_every,
            None => (self.now)().mono, // never flushed in this stroke: due at once
        })
    }

    /// Sends the pending batch if its window has closed (or `force`).
    pub fn flush(&mut self, force: bool) {
        if self.batch_n == 0 {
            return;
        }
        let now = (self.now)();
        if !force && self.batch_n < self.cfg.max_batch {
            if let Some(t) = self.last_flush {
                if now.mono.saturating_duration_since(t) < self.cfg.flush_every {
                    return;
                }
            }
        }
        let mut msg = String::with_capacity(self.batch.len() + 64);
        msg.push_str(r#"{"t":"stroke_pts","id":""#);
        msg.push_str(&self.id);
        msg.push_str(r#"","pts":["#);
        msg.push_str(&self.batch);
        msg.push_str("]}");
        self.batch.clear();
        self.batch_n = 0;
        self.last_flush = Some(now.mono);
        self.send(msg);
    }

    fn send(&mut self, msg: String) {
        if self.lost {
            return;
        }
        if !(self.emit)(msg) {
            self.lost = true; // skip the rest of this stroke; the router ends it if we drop off
            self.lost_strokes += 1;
        }
    }

    /// Sends the pen's position while it is in range but not touching, paced by `hover_every` and
    /// only when it moved, and one `{"gone":true}` when it leaves range. Cursor messages are
    /// ephemeral: a refused one is simply dropped and never affects stroke delivery.
    fn hover(&mut self, now: Stamp, ts_ms: i64) {
        if self.cfg.hover_every.is_zero() {
            return;
        }
        if !(self.tool_pen || self.tool_rubber) {
            if self.hovering {
                self.hovering = false;
                let _ = (self.emit)(r#"{"t":"cursor","who":"pen","gone":true}"#.to_string());
            }
            return;
        }
        if !self.has_x || !self.has_y {
            return;
        }
        if let Some(t) = self.last_hover {
            if now.mono.saturating_duration_since(t) < self.cfg.hover_every {
                return;
            }
        }
        let x = norm(self.x, self.rng.x_min, self.rng.x_max);
        let y = norm(self.y, self.rng.y_min, self.rng.y_max);
        if self.hovering && (x - self.hover_x).abs() < 0.002 && (y - self.hover_y).abs() < 0.002 {
            return; // still: nothing new to show
        }
        self.last_hover = Some(now.mono);
        (self.hover_x, self.hover_y, self.hovering) = (x, y, true);
        let mut msg = String::with_capacity(96);
        msg.push_str(r#"{"t":"cursor","who":"pen","x":"#);
        push_rounded(&mut msg, x, 4);
        msg.push_str(r#","y":"#);
        push_rounded(&mut msg, y, 4);
        let eraser = self.tool_rubber || self.toolbar_eraser();
        msg.push_str(if eraser { r#","tool":"eraser""# } else { r#","tool":"pen""# });
        let _ = write!(msg, r#","ts":{ts_ms}}}"#);
        let _ = (self.emit)(msg);
    }

    /// Whether xochitl's toolbar has the Eraser selected, so that the tip erases. Unknown (no
    /// `tool`, or it returns "") is false: the stroke stays ink, as before.
    fn toolbar_eraser(&self) -> bool {
        self.cfg.tool.as_ref().is_some_and(|t| t.get() == "eraser")
    }

    /// Consumes one event and emits whatever messages it completes.
    pub fn handle(&mut self, ev: Event) {
        match ev.etype {
            EV_ABS => match ev.code {
                ABS_X => (self.x, self.has_x) = (ev.value, true),
                ABS_Y => (self.y, self.has_y) = (ev.value, true),
                ABS_PRESSURE => self.p = ev.value,
                ABS_DISTANCE => self.d = ev.value,
                _ => {}
            },
            EV_KEY => match ev.code {
                BTN_TOUCH => self.btn_touch = ev.value != 0,
                BTN_TOOL_PEN => self.tool_pen = ev.value != 0,
                BTN_TOOL_RUBBER => self.tool_rubber = ev.value != 0,
                _ => {}
            },
            EV_SYN if ev.code == SYN_REPORT => self.report(ev.time_ms),
            _ => {}
        }
    }

    fn down(&self) -> bool {
        let mut mode = self.mode.as_str();
        if mode == "auto" {
            // prefer BTN_TOUCH when it is set, else the pressure threshold
            if self.btn_touch {
                return true;
            }
            mode = "pressure";
        }
        match mode {
            "pressure" => norm(self.p, self.rng.p_min, self.rng.p_max) > self.cfg.pressure_threshold,
            "distance" => (self.d as i64) <= self.cfg.distance_threshold,
            "tool" => self.tool_pen || self.tool_rubber,
            _ => self.btn_touch, // btn
        }
    }

    /// Handles one SYN_REPORT: contact transitions, then one coherent point.
    fn report(&mut self, ts_ms: i64) {
        let now = (self.now)();
        // Kernel timestamps keep stroke velocity true even when events queue up; fall back to the
        // wall clock if the device clock is clearly off (not set yet at boot).
        let ts_ms = if ts_ms <= 0 || (ts_ms - now.unix_ms()).abs() > 10 * 60 * 1000 { now.unix_ms() } else { ts_ms };
        let down = self.down();
        if down && !self.touching {
            self.touching = true;
            self.lost = false;
            self.last = None;
            self.batch.clear();
            self.batch_n = 0;
            self.last_flush = None; // the first point goes out at once
            // the eraser end wins; otherwise xochitl's toolbar Eraser makes the tip erase too
            let toolbar = !self.tool_rubber && self.toolbar_eraser();
            self.brush = if self.tool_rubber || toolbar { "eraser".into() } else { self.cfg.brush.clone() };
            self.id = format!("u_{:x}", now.unix_nanos);
            let mut msg = format!(r#"{{"t":"stroke_begin","id":"{}","layer":"user","brush":"#, self.id);
            msg.push_str(&json_string(&self.brush));
            if toolbar {
                // receivers treat it as any eraser (brush); `tool` says it is xochitl's toolbar Eraser
                msg.push_str(r#","tool":"eraser""#);
            }
            if !self.cfg.color.is_empty() {
                msg.push_str(r#","color":"#);
                msg.push_str(&json_string(&self.cfg.color));
            }
            let _ = write!(msg, r#","ts":{ts_ms}}}"#);
            if let Some(f) = self.on_stroke.as_mut() {
                f(true);
            }
            self.send(msg);
        } else if !down && self.touching {
            self.flush(true);
            let msg = format!(r#"{{"t":"stroke_end","id":"{}","ts":{ts_ms}}}"#, self.id);
            // The end goes out even after a skipped stroke: if it gets through, receivers close
            // the stroke now instead of when the router notices we left.
            self.lost = false;
            self.send(msg);
            self.touching = false;
            self.strokes += 1;
            if let Some(f) = self.on_stroke.as_mut() {
                f(false);
            }
            return;
        }
        if !self.touching {
            self.hover(now, ts_ms);
            return;
        }
        if !self.has_x || !self.has_y {
            return;
        }
        let x = norm(self.x, self.rng.x_min, self.rng.x_max);
        let y = norm(self.y, self.rng.y_min, self.rng.y_max);
        if let Some((lx, ly)) = self.last {
            let (dx, dy) = (x - lx, y - ly);
            if dx * dx + dy * dy < 1e-8 {
                return; // sub-pixel jitter
            }
        }
        self.last = Some((x, y));
        if self.batch_n > 0 {
            self.batch.push(',');
        }
        // 4 decimals ≈ 0.2 px on the 2160-px axis; about half the bytes of full float output.
        self.batch.push('[');
        push_rounded(&mut self.batch, x, 4);
        self.batch.push(',');
        push_rounded(&mut self.batch, y, 4);
        self.batch.push(',');
        push_rounded(&mut self.batch, norm(self.p, self.rng.p_min, self.rng.p_max), 3);
        let _ = write!(self.batch, ",{ts_ms}]");
        self.batch_n += 1;
        self.flush(false);
    }
}

fn norm(v: i32, lo: i32, hi: i32) -> f64 {
    if hi <= lo {
        return 0.0;
    }
    ((v as f64 - lo as f64) / (hi as f64 - lo as f64)).clamp(0.0, 1.0)
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).expect("serialize str")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::sync::{Arc, Mutex};

    struct Rig {
        m: Machine,
        now: Arc<Mutex<Stamp>>,
        out: Arc<Mutex<Vec<Value>>>,
        refuse: Arc<Mutex<bool>>,
        ts: i64,
    }

    fn new_rig() -> Rig {
        let start = Stamp { mono: Instant::now(), unix_nanos: 1_790_000_000_000 * 1_000_000 };
        let now = Arc::new(Mutex::new(start));
        let out = Arc::new(Mutex::new(Vec::new()));
        let refuse = Arc::new(Mutex::new(false));
        let (o, r) = (out.clone(), refuse.clone());
        let mut m = Machine::new(
            Config {
                brush: "pen".into(),
                touch_mode: "auto".into(),
                pressure_threshold: 0.02,
                flush_every: Duration::from_millis(16),
                max_batch: 64,
                hover_every: Duration::from_millis(33),
                ..Default::default()
            },
            Ranges { x_min: 0, x_max: 10000, y_min: 0, y_max: 10000, p_min: 0, p_max: 4096 },
            Box::new(move |b: String| {
                if *r.lock().unwrap() {
                    return false;
                }
                let v: Value = serde_json::from_str(&b).unwrap_or_else(|e| panic!("emitted invalid JSON {b}: {e}"));
                o.lock().unwrap().push(v);
                true
            }),
        );
        let n = now.clone();
        m.now = Box::new(move || *n.lock().unwrap());
        Rig { m, now, out, refuse, ts: 1_790_000_000_000 }
    }

    impl Rig {
        fn ev(&mut self, etype: u16, code: u16, value: i32) {
            let ts = self.ts;
            self.m.handle(Event { etype, code, value, time_ms: ts });
        }
        fn syn(&mut self) {
            self.ev(EV_SYN, SYN_REPORT, 0);
        }
        fn advance(&mut self, ms: u64) {
            let mut n = self.now.lock().unwrap();
            n.mono += Duration::from_millis(ms);
            n.unix_nanos += ms as i64 * 1_000_000;
            self.ts += ms as i64;
        }
        /// One pen sample: down with pressure, at (x, y) device units.
        fn point(&mut self, x: i32, y: i32) {
            self.ev(EV_KEY, BTN_TOUCH, 1);
            self.ev(EV_ABS, ABS_X, x);
            self.ev(EV_ABS, ABS_Y, y);
            self.ev(EV_ABS, ABS_PRESSURE, 2048);
            self.syn();
        }
        fn up(&mut self) {
            self.ev(EV_KEY, BTN_TOUCH, 0);
            self.ev(EV_ABS, ABS_PRESSURE, 0);
            self.syn();
        }
        fn out(&self) -> Vec<Value> {
            self.out.lock().unwrap().clone()
        }
        fn types(&self) -> Vec<String> {
            self.out().iter().map(|m| m["t"].as_str().unwrap().to_string()).collect()
        }
        fn set_refuse(&self, v: bool) {
            *self.refuse.lock().unwrap() = v;
        }
    }

    #[test]
    fn first_point_goes_out_immediately_then_batches() {
        let mut r = new_rig();
        r.point(1000, 2000);
        assert_eq!(r.types(), ["stroke_begin", "stroke_pts"], "first point not immediate");
        for i in 0..3 {
            // inside the 16 ms window: held
            r.advance(4);
            r.point(1010 + i * 10, 2000);
        }
        assert_eq!(r.out().len(), 2, "batched points leaked early: {:?}", r.types());
        assert!(r.m.pending().is_some());
        r.advance(5); // window closed
        r.point(1100, 2000);
        let out = r.out();
        let last = out.last().unwrap();
        assert!(last["t"] == "stroke_pts" && last["pts"].as_array().unwrap().len() == 4, "batch: {last}");
        let pt = &last["pts"][0];
        assert!(pt[0] == 0.101 && pt[1] == 0.2 && pt[2] == 0.5, "point encoding: {pt}");
        assert!(r.m.pending().is_none());
    }

    #[test]
    fn pen_up_flushes_and_ends() {
        let mut r = new_rig();
        r.point(1000, 1000);
        r.advance(2);
        r.point(1200, 1000); // pending in the batch
        r.up();
        assert_eq!(r.types(), ["stroke_begin", "stroke_pts", "stroke_pts", "stroke_end"]);
        assert!(!r.m.touching() && r.m.strokes() == 1, "state after up: touching={} strokes={}", r.m.touching(), r.m.strokes());
        // Hovering after the pen-up must not draw.
        r.ev(EV_ABS, ABS_X, 5000);
        r.ev(EV_ABS, ABS_Y, 5000);
        r.syn();
        assert_eq!(r.out().len(), 4, "hover drew: {:?}", r.types());
    }

    #[test]
    fn refused_outbox_skips_the_rest_of_the_stroke() {
        let mut r = new_rig();
        r.point(1000, 1000);
        r.set_refuse(true); // link down: outbox full
        for i in 0..5 {
            r.advance(20);
            r.point(1100 + i * 100, 1000);
        }
        r.set_refuse(false); // link back mid-stroke: the remainder stays skipped, no holes
        r.advance(20);
        r.point(2000, 1000);
        r.up();
        let got = r.types();
        assert!(got.len() == 3 && got[2] == "stroke_end", "want begin, first pts, end; got {got:?}");
        assert_eq!(r.m.lost_strokes(), 1);
        // The next stroke is whole again.
        r.advance(20);
        r.point(3000, 3000);
        let out = r.out();
        assert_eq!(out[out.len() - 2]["t"], "stroke_begin", "next stroke: {:?}", r.types());
    }

    #[test]
    fn kernel_timestamp_is_used() {
        let mut r = new_rig();
        r.ts -= 250; // events that waited 250 ms in a queue keep their real time
        r.point(1000, 1000);
        let out = r.out();
        assert_eq!(out[1]["pts"][0][3].as_i64(), Some(r.ts), "want kernel ts");
        assert_eq!(out[0]["ts"].as_i64(), Some(r.ts));
    }

    #[test]
    fn rubber_end_is_eraser() {
        let mut r = new_rig();
        r.ev(EV_KEY, BTN_TOOL_RUBBER, 1);
        r.point(1000, 1000);
        assert_eq!(r.out()[0]["brush"], "eraser");
    }

    #[test]
    fn hover_sends_paced_cursor_and_gone() {
        let mut r = new_rig();
        r.ev(EV_KEY, BTN_TOOL_PEN, 1); // in range, not touching
        for i in 0..10 {
            r.ev(EV_ABS, ABS_X, 1000 + i * 100);
            r.ev(EV_ABS, ABS_Y, 2000);
            r.syn();
            r.advance(10); // 100 Hz of reports; cursor at most every 33 ms
        }
        let n = r.out().len();
        assert!((2..=4).contains(&n), "want ~3 paced cursors, got {n}: {:?}", r.types());
        for m in r.out() {
            assert!(m["t"] == "cursor" && m["who"] == "pen" && m["tool"] == "pen", "cursor: {m}");
        }
        // touching suppresses the cursor; the stroke flows as usual
        r.point(3000, 3000);
        let out = r.out();
        assert_eq!(out[out.len() - 2]["t"], "stroke_begin", "stroke after hover: {:?}", r.types());
        r.up();
        // leaving range sends one gone
        r.ev(EV_KEY, BTN_TOOL_PEN, 0);
        r.syn();
        let out = r.out();
        let last = out.last().unwrap();
        assert!(last["t"] == "cursor" && last["gone"] == true, "want gone, got {last}");
    }

    #[test]
    fn toolbar_eraser_makes_tip_strokes_erasers() {
        let mut r = new_rig();
        let tool = Arc::new(Mutex::new("eraser".to_string()));
        let t = tool.clone();
        r.m.cfg.tool = Some(Tool::new(move || t.lock().unwrap().clone()));
        r.ev(EV_KEY, BTN_TOOL_PEN, 1);
        r.point(1000, 1000);
        let out = r.out();
        assert!(out[0]["t"] == "stroke_begin" && out[0]["brush"] == "eraser" && out[0]["tool"] == "eraser", "toolbar eraser: {}", out[0]);
        r.up();
        // back to a pen in the toolbar: ink again
        *tool.lock().unwrap() = "pen".into();
        let n = r.out().len();
        r.advance(50);
        r.point(2000, 2000);
        let out = r.out();
        assert!(out[n]["brush"] == "pen" && out[n].get("tool").is_none(), "toolbar pen: {}", out[n]);
    }

    #[test]
    fn unknown_tool_keeps_ink() {
        for tool in ["", "erase_area", "highlighter"] {
            let mut r = new_rig();
            r.m.cfg.tool = Some(Tool::new(move || tool.to_string()));
            r.point(1000, 1000);
            let out = r.out();
            assert!(out[0]["brush"] == "pen" && out[0].get("tool").is_none(), "tool {tool:?}: {}", out[0]);
        }
    }

    #[test]
    fn rubber_end_stays_eraser_whatever_the_toolbar() {
        let mut r = new_rig();
        r.m.cfg.tool = Some(Tool::new(|| "pen".to_string()));
        r.ev(EV_KEY, BTN_TOOL_RUBBER, 1);
        r.point(1000, 1000);
        let out = r.out();
        assert!(out[0]["brush"] == "eraser" && out[0].get("tool").is_none(), "eraser end: {}", out[0]);
    }

    #[test]
    fn hover_shows_toolbar_eraser() {
        let mut r = new_rig();
        r.m.cfg.tool = Some(Tool::new(|| "eraser".to_string()));
        r.ev(EV_KEY, BTN_TOOL_PEN, 1);
        r.ev(EV_ABS, ABS_X, 1000);
        r.ev(EV_ABS, ABS_Y, 1000);
        r.syn();
        let out = r.out();
        assert!(out.len() == 1 && out[0]["t"] == "cursor" && out[0]["tool"] == "eraser", "hover: {out:?}");
    }

    // Beyond the Go tests.

    /// The exact bytes of a toolbar-eraser hover and stroke, as Go's encoder writes them (checked
    /// against a Go build of package pen fed the same trace, 2026-10-05).
    #[test]
    fn toolbar_eraser_bytes_match_go() {
        let mut r = new_rig();
        let raw = Arc::new(Mutex::new(Vec::<String>::new()));
        let rw = raw.clone();
        r.m.emit = Box::new(move |b| {
            rw.lock().unwrap().push(b);
            true
        });
        r.m.cfg.color = "#00ff88".into();
        r.m.cfg.tool = Some(Tool::new(|| "eraser".to_string()));
        r.ev(EV_KEY, BTN_TOOL_PEN, 1);
        r.ev(EV_ABS, ABS_X, 2500);
        r.ev(EV_ABS, ABS_Y, 5000);
        r.syn();
        r.advance(40);
        r.point(1234, 5678);
        r.advance(20);
        r.point(1300, 5700);
        r.up();
        let (ts, id) = (r.ts, format!("u_{:x}", 1_790_000_000_000i64 * 1_000_000 + 40_000_000));
        let t0 = ts - 60;
        assert_eq!(
            raw.lock().unwrap().clone(),
            [
                format!(r#"{{"t":"cursor","who":"pen","x":0.25,"y":0.5,"tool":"eraser","ts":{t0}}}"#),
                format!(r##"{{"t":"stroke_begin","id":"{id}","layer":"user","brush":"eraser","tool":"eraser","color":"#00ff88","ts":{}}}"##, t0 + 40),
                format!(r#"{{"t":"stroke_pts","id":"{id}","pts":[[0.1234,0.5678,0.5,{}]]}}"#, t0 + 40),
                format!(r#"{{"t":"stroke_pts","id":"{id}","pts":[[0.13,0.57,0.5,{ts}]]}}"#),
                format!(r#"{{"t":"stroke_end","id":"{id}","ts":{ts}}}"#),
            ]
        );
    }

    #[test]
    fn hover_details() {
        let mut r = new_rig();
        let raw = Arc::new(Mutex::new(Vec::<String>::new()));
        let (rw, rf) = (raw.clone(), r.refuse.clone());
        r.m.emit = Box::new(move |b| {
            if *rf.lock().unwrap() {
                return false;
            }
            rw.lock().unwrap().push(b);
            true
        });
        // the rubber end hovering is an eraser cursor; exact bytes match Go's encoding
        r.ev(EV_KEY, BTN_TOOL_RUBBER, 1);
        r.ev(EV_ABS, ABS_X, 2500);
        r.ev(EV_ABS, ABS_Y, 5000);
        r.syn();
        let ts = r.ts;
        assert_eq!(raw.lock().unwrap().clone(), [format!(r#"{{"t":"cursor","who":"pen","x":0.25,"y":0.5,"tool":"eraser","ts":{ts}}}"#)]);
        // still (moved < 0.002): nothing new even after the pacing window
        r.advance(50);
        r.ev(EV_ABS, ABS_X, 2510);
        r.syn();
        assert_eq!(raw.lock().unwrap().len(), 1);
        // a refused cursor is dropped and never counts as a lost stroke
        r.set_refuse(true);
        r.advance(50);
        r.ev(EV_ABS, ABS_X, 4000);
        r.syn();
        assert_eq!(r.m.lost_strokes(), 0);
        r.set_refuse(false);
        r.ev(EV_KEY, BTN_TOOL_RUBBER, 0);
        r.syn();
        r.syn(); // only one gone
        let got = raw.lock().unwrap().clone();
        assert_eq!(got.last().unwrap(), r#"{"t":"cursor","who":"pen","gone":true}"#);
        assert_eq!(got.iter().filter(|m| m.contains("gone")).count(), 1);
        // hover_every = 0 disables cursors entirely
        let n = Arc::new(Mutex::new(0));
        let n2 = n.clone();
        let mut m = Machine::new(Config { brush: "pen".into(), ..Default::default() }, Ranges::default(), Box::new(move |_| {
            *n2.lock().unwrap() += 1;
            true
        }));
        for (t, c, v) in [(EV_KEY, BTN_TOOL_PEN, 1), (EV_ABS, ABS_X, 1), (EV_ABS, ABS_Y, 1), (EV_SYN, SYN_REPORT, 0), (EV_KEY, BTN_TOOL_PEN, 0), (EV_SYN, SYN_REPORT, 0)] {
            m.handle(Event { etype: t, code: c, value: v, time_ms: 0 });
        }
        assert_eq!(*n.lock().unwrap(), 0);
    }

    #[test]
    fn skewed_kernel_clock_falls_back_to_wall_clock() {
        let mut r = new_rig();
        let wall = r.ts;
        r.ts = 1000; // device clock not set yet at boot
        r.point(1000, 1000);
        assert_eq!(r.out()[1]["pts"][0][3].as_i64(), Some(wall));
    }

    #[test]
    fn number_encoding_matches_go() {
        let mut s = String::new();
        for (v, n) in [(0.0, 4), (1.0, 4), (0.12345, 4), (0.5, 3), (0.10000001, 4), (0.00004, 4)] {
            push_rounded(&mut s, v, n);
            s.push(' ');
        }
        assert_eq!(s, "0 1 0.1235 0.5 0.1 0 ");
    }

    #[test]
    fn modes_and_max_batch() {
        let emitted = Arc::new(Mutex::new(Vec::<String>::new()));
        let e = emitted.clone();
        let cfg = Config { brush: "pen".into(), touch_mode: " Pressure ".into(), pressure_threshold: 0.02, flush_every: Duration::from_secs(10), max_batch: 2, ..Default::default() };
        let mut m = Machine::new(cfg, Ranges { x_min: 0, x_max: 1000, y_min: 0, y_max: 1000, p_min: 0, p_max: 4096 }, Box::new(move |s| {
            e.lock().unwrap().push(s);
            true
        }));
        let ev = |etype, code, value| Event { etype, code, value, time_ms: 0 };
        m.handle(ev(EV_ABS, ABS_PRESSURE, 40)); // below threshold
        m.handle(ev(EV_ABS, ABS_X, 1));
        m.handle(ev(EV_ABS, ABS_Y, 1));
        m.handle(ev(EV_SYN, SYN_REPORT, 0));
        assert!(emitted.lock().unwrap().is_empty());
        m.handle(ev(EV_ABS, ABS_PRESSURE, 200));
        m.handle(ev(EV_SYN, SYN_REPORT, 0)); // begin + first point at once
        for x in [10, 20] {
            m.handle(ev(EV_ABS, ABS_X, x));
            m.handle(ev(EV_SYN, SYN_REPORT, 0));
        }
        let got = emitted.lock().unwrap().clone();
        assert_eq!(got.len(), 3, "{got:?}"); // the second batch flushed at max_batch
        assert!(got[0].contains(r#""brush":"pen""#) && !got[0].contains("color"));
        assert!(got[2].starts_with(r#"{"t":"stroke_pts""#) && got[2].contains("[0.01,") && got[2].contains("[0.02,"));
    }
}
