//! The pen stroke state machine (bridge.go `runOnce`'s `handle` and `sendPts`).
//!
//! Pure: it takes input events plus the current time and returns the JSON messages to send, so
//! the contact logic is tested on any host. The run loop in `bridge` owns the socket.

use std::time::{Duration, Instant};

use serde::Serialize;

use crate::input::*;
use crate::util::{norm, now_ms, now_nanos};

#[derive(Serialize)]
struct OutStrokeBegin<'a> {
    t: &'static str,
    id: &'a str,
    layer: &'static str,
    brush: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    color: &'a str,
    ts: i64,
}

/// A point is `[x, y, pressure, ts_ms]`; the timestamp is written as an integer like Go does.
type Point = (f64, f64, f64, i64);

#[derive(Serialize)]
struct OutStrokePts<'a> {
    t: &'static str,
    id: &'a str,
    pts: &'a [Point],
}

#[derive(Serialize)]
struct OutStrokeEnd<'a> {
    t: &'static str,
    id: &'a str,
    ts: i64,
}

/// Settings the state machine needs (a subset of `flags::Config`).
#[derive(Debug, Clone)]
pub struct StrokeSettings {
    pub brush: String,
    pub color: String,
    pub touch_mode: String,
    pub pressure_threshold: f64,
    pub distance_threshold: i64,
    pub max_batch_points: usize,
    pub flush_every: Duration,
    pub dump_events: bool,
}

pub struct StrokeMachine {
    s: StrokeSettings,
    rng: AbsRanges,

    x_raw: i32,
    y_raw: i32,
    p_raw: i32,
    d_raw: i32,
    has_x: bool,
    has_y: bool,

    btn_touch_down: bool,
    tool_pen_down: bool,
    tool_rubber_down: bool,
    pub cur_brush: String,

    pub touching: bool,
    stroke_id: String,
    batch: Vec<Point>,
    last_flush: Instant,
    pub last_any_event: Instant,

    last_norm: Option<(f64, f64)>,
    /// Strokes completed by this machine (Go keeps the count across reconnects; so does `bridge`).
    pub strokes_ended: u64,
}

impl StrokeMachine {
    pub fn new(mut s: StrokeSettings, rng: AbsRanges, now: Instant) -> Self {
        s.touch_mode = s.touch_mode.trim().to_lowercase();
        if s.touch_mode.is_empty() {
            s.touch_mode = "auto".into();
        }
        let brush = s.brush.clone();
        StrokeMachine {
            s,
            rng,
            x_raw: 0,
            y_raw: 0,
            p_raw: 0,
            d_raw: 0,
            has_x: false,
            has_y: false,
            btn_touch_down: false,
            tool_pen_down: false,
            tool_rubber_down: false,
            cur_brush: brush,
            touching: false,
            stroke_id: String::new(),
            batch: Vec::new(),
            last_flush: now,
            last_any_event: now,
            last_norm: None,
            strokes_ended: 0,
        }
    }

    fn pts_msg(&mut self, force: bool, now: Instant) -> Option<String> {
        if self.stroke_id.is_empty() || self.batch.is_empty() {
            return None;
        }
        if !force
            && now.duration_since(self.last_flush) < self.s.flush_every
            && self.batch.len() < self.s.max_batch_points
        {
            return None;
        }
        let msg = serde_json::to_string(&OutStrokePts { t: "stroke_pts", id: &self.stroke_id, pts: &self.batch })
            .expect("serialize");
        self.batch.clear();
        self.last_flush = now;
        Some(msg)
    }

    /// The timer path: flush a pending batch once `flush_every` has passed, even if SYN_REPORTs
    /// are sparse.
    pub fn tick(&mut self, now: Instant) -> Option<String> {
        if !self.stroke_id.is_empty() && !self.batch.is_empty() && now.duration_since(self.last_flush) >= self.s.flush_every {
            return self.pts_msg(true, now);
        }
        None
    }

    /// Feeds one input event; returns the messages to send, in order.
    pub fn handle(&mut self, ev: RawEvent, now: Instant) -> Vec<String> {
        let mut out = Vec::new();
        self.last_any_event = now;
        if self.s.dump_events {
            println!("[ev] type={} code={} value={}", ev.etype, ev.code, ev.value);
        }
        match ev.etype {
            EV_ABS => match ev.code {
                ABS_X => {
                    self.x_raw = ev.value;
                    self.has_x = true;
                }
                ABS_Y => {
                    self.y_raw = ev.value;
                    self.has_y = true;
                }
                ABS_PRESSURE => self.p_raw = ev.value,
                ABS_DISTANCE => self.d_raw = ev.value,
                _ => {}
            },
            EV_KEY => {
                match ev.code {
                    BTN_TOUCH => self.btn_touch_down = ev.value != 0,
                    BTN_TOOL_PEN => self.tool_pen_down = ev.value != 0,
                    BTN_TOOL_RUBBER => self.tool_rubber_down = ev.value != 0,
                    _ => {}
                }
                self.cur_brush = if self.tool_rubber_down { "eraser".into() } else { self.s.brush.clone() };
            }
            EV_SYN if ev.code == SYN_REPORT => self.on_syn(now, &mut out),
            _ => {}
        }
        out
    }

    fn on_syn(&mut self, now: Instant, out: &mut Vec<String>) {
        let r = self.rng;
        // Auto: BTN_TOUCH when it is down, else a pressure threshold.
        let mode = match self.s.touch_mode.as_str() {
            "auto" if self.btn_touch_down => "btn",
            "auto" => "pressure",
            m => m,
        };
        let down = match mode {
            "btn" => self.btn_touch_down,
            "pressure" => norm(self.p_raw, r.p_min, r.p_max) > self.s.pressure_threshold,
            "distance" => (self.d_raw as i64) <= self.s.distance_threshold,
            "tool" => self.tool_pen_down || self.tool_rubber_down,
            _ => self.btn_touch_down,
        };

        if down && !self.touching {
            self.touching = true;
            self.stroke_id = format!("u_{:x}", now_nanos());
            self.batch.clear();
            self.last_norm = None;
            self.last_flush = now;
            out.push(
                serde_json::to_string(&OutStrokeBegin {
                    t: "stroke_begin",
                    id: &self.stroke_id,
                    layer: "user",
                    brush: &self.cur_brush,
                    color: &self.s.color,
                    ts: now_ms(),
                })
                .expect("serialize"),
            );
        } else if !down && self.touching {
            self.touching = false;
            out.extend(self.pts_msg(true, now));
            out.push(
                serde_json::to_string(&OutStrokeEnd { t: "stroke_end", id: &self.stroke_id, ts: now_ms() })
                    .expect("serialize"),
            );
            self.strokes_ended += 1;
            self.stroke_id.clear();
            return;
        }

        // One coherent point per SYN_REPORT (prevents X/Y desync artifacts).
        if self.touching && !self.stroke_id.is_empty() && self.has_x && self.has_y {
            let x = norm(self.x_raw, r.x_min, r.x_max);
            let y = norm(self.y_raw, r.y_min, r.y_max);
            let p = norm(self.p_raw, r.p_min, r.p_max);
            if let Some((lx, ly)) = self.last_norm {
                let (dx, dy) = (x - lx, y - ly);
                if dx * dx + dy * dy < 1e-8 {
                    return; // micro-jitter
                }
            }
            self.last_norm = Some((x, y));
            self.batch.push((x, y, p, now_ms()));
            out.extend(self.pts_msg(false, now));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(mode: &str) -> StrokeSettings {
        StrokeSettings {
            brush: "pen".into(),
            color: String::new(),
            touch_mode: mode.into(),
            pressure_threshold: 0.02,
            distance_threshold: 0,
            max_batch_points: 3,
            flush_every: Duration::from_millis(16),
            dump_events: false,
        }
    }

    fn rng() -> AbsRanges {
        AbsRanges { x_min: 0, x_max: 1000, y_min: 0, y_max: 1000, p_min: 0, p_max: 4096 }
    }

    fn ev(etype: u16, code: u16, value: i32) -> RawEvent {
        RawEvent { etype, code, value }
    }

    fn feed(m: &mut StrokeMachine, evs: &[RawEvent], now: Instant) -> Vec<serde_json::Value> {
        evs.iter()
            .flat_map(|e| m.handle(*e, now))
            .map(|s| serde_json::from_str(&s).unwrap())
            .collect()
    }

    #[test]
    fn btn_touch_stroke_begin_points_end() {
        let t0 = Instant::now();
        let mut m = StrokeMachine::new(settings("auto"), rng(), t0);
        let msgs = feed(
            &mut m,
            &[ev(EV_ABS, ABS_X, 500), ev(EV_ABS, ABS_Y, 250), ev(EV_ABS, ABS_PRESSURE, 2048), ev(EV_KEY, BTN_TOUCH, 1), ev(EV_SYN, SYN_REPORT, 0)],
            t0,
        );
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["t"], "stroke_begin");
        assert_eq!(msgs[0]["brush"], "pen");
        assert_eq!(msgs[0]["layer"], "user");
        assert!(msgs[0].get("color").is_none());
        let id = msgs[0]["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("u_"));

        // More points; the third reaches max_batch_points and flushes.
        let mut sent = feed(&mut m, &[ev(EV_ABS, ABS_X, 510), ev(EV_SYN, SYN_REPORT, 0), ev(EV_ABS, ABS_X, 520), ev(EV_SYN, SYN_REPORT, 0)], t0);
        assert_eq!(sent.len(), 1);
        let pts = sent.remove(0);
        assert_eq!(pts["t"], "stroke_pts");
        assert_eq!(pts["id"], id.as_str());
        let arr = pts["pts"].as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0][0], 0.5);
        assert_eq!(arr[0][1], 0.25);
        assert_eq!(arr[0][2], 0.5);
        assert!(arr[0][3].is_i64());

        // Jitter is dropped; lift ends the stroke.
        assert!(feed(&mut m, &[ev(EV_SYN, SYN_REPORT, 0)], t0).is_empty());
        let end = feed(&mut m, &[ev(EV_ABS, ABS_X, 530), ev(EV_SYN, SYN_REPORT, 0), ev(EV_KEY, BTN_TOUCH, 0), ev(EV_ABS, ABS_PRESSURE, 0), ev(EV_SYN, SYN_REPORT, 0)], t0);
        let kinds: Vec<_> = end.iter().map(|m| m["t"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["stroke_pts", "stroke_end"]);
        assert_eq!(m.strokes_ended, 1);
    }

    #[test]
    fn eraser_and_timer_flush() {
        let t0 = Instant::now();
        let mut m = StrokeMachine::new(settings("tool"), rng(), t0);
        let msgs = feed(&mut m, &[ev(EV_KEY, BTN_TOOL_RUBBER, 1), ev(EV_ABS, ABS_X, 1), ev(EV_ABS, ABS_Y, 1), ev(EV_SYN, SYN_REPORT, 0)], t0);
        assert_eq!(msgs[0]["brush"], "eraser");
        assert!(m.tick(t0 + Duration::from_millis(5)).is_none());
        let flushed = m.tick(t0 + Duration::from_millis(20)).unwrap();
        assert!(flushed.contains("\"stroke_pts\""));
        assert!(m.tick(t0 + Duration::from_millis(40)).is_none());
    }

    #[test]
    fn pressure_threshold_mode() {
        let t0 = Instant::now();
        let mut m = StrokeMachine::new(settings(" Pressure "), rng(), t0);
        assert!(feed(&mut m, &[ev(EV_ABS, ABS_PRESSURE, 40), ev(EV_SYN, SYN_REPORT, 0)], t0).is_empty());
        let msgs = feed(&mut m, &[ev(EV_ABS, ABS_PRESSURE, 200), ev(EV_SYN, SYN_REPORT, 0)], t0);
        assert_eq!(msgs[0]["t"], "stroke_begin");
    }
}
