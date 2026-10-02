//! Bridge run loop (bridge.go).
//!
//! - The pen reader thread owns the pen device for the life of the process and parses
//!   `input_event`s into a channel (reopening the device on error).
//! - The keyboard reader thread does the same for a keyboard, producing `key` messages.
//! - The typer thread owns the virtual keyboard and types `term` replies into the tablet.
//! - [`run_bridge_forever`] connects the WebSocket, runs [`run_once`] until the socket dies, and
//!   reconnects with backoff. `run_once` selects on pen events, key messages, socket errors and a
//!   flush timer, so a dead socket is noticed even while the pen is idle.

use std::time::Duration;

use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::flags::Config;
use crate::input::{AbsRanges, RawEvent};
use crate::keymap::OutKey;
use crate::stroke::{StrokeMachine, StrokeSettings};
use crate::util::{go_duration, now_nanos};
use crate::ws_client::{self, OnMessage, WsConn};

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

/// Settings for the stroke machine from the config.
pub fn stroke_settings(cfg: &Config) -> StrokeSettings {
    StrokeSettings {
        brush: cfg.brush.clone(),
        color: cfg.color.clone(),
        touch_mode: cfg.touch_mode.clone(),
        pressure_threshold: cfg.pressure_threshold,
        distance_threshold: cfg.distance_threshold,
        max_batch_points: cfg.max_batch_points.max(0) as usize,
        flush_every: flush_every(cfg),
        dump_events: cfg.dump_events,
    }
}

fn flush_every(cfg: &Config) -> Duration {
    Duration::from_secs(1) / cfg.batch_hz.clamp(1, u32::MAX as i64) as u32
}

/// Event sources that outlive a single connection.
pub struct Sources {
    pub ev_rx: mpsc::Receiver<RawEvent>,
    pub key_rx: Option<mpsc::Receiver<OutKey>>,
    pub rng: AbsRanges,
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

    // The pen reader owns the device for the whole process; run_once consumes its events.
    let (ev_tx, ev_rx) = mpsc::channel(4096);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    {
        let (path, no_grab) = (path.clone(), cfg.no_grab);
        std::thread::Builder::new()
            .name("pen".into())
            .spawn(move || linux::pen_reader_forever(&path, no_grab, ev_tx, ready_tx))
            .map_err(|e| e.to_string())?;
    }
    let rng = ready_rx.await.map_err(|_| "pen reader exited".to_string())?;

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

    run_connections(cfg, Sources { ev_rx, key_rx, rng }, on_message).await
}

/// The reconnect loop. Never returns on its own.
pub async fn run_connections(cfg: Config, mut src: Sources, on_message: Option<OnMessage>) -> Result<(), String> {
    let ping_every = Duration::from_secs_f64(cfg.ping_seconds.max(1.0));
    let pong_wait = Duration::from_secs_f64(cfg.pong_timeout_seconds.max(2.0));
    let base_delay = Duration::from_millis(500);
    let max_delay = Duration::from_secs(5);
    let mut reconnect_delay = base_delay;
    let mut strokes_sent: u64 = 0;

    loop {
        let (ws, mut err_rx) = match ws_client::dial(&cfg.ws_url, ping_every, pong_wait, on_message.clone()).await {
            Ok(c) => c,
            Err(e) => {
                let jitter = Duration::from_nanos((now_nanos() % 250_000_000) as u64);
                println!("[bridge] ws connect error: {e}; retrying in {}", go_duration(reconnect_delay + jitter));
                tokio::time::sleep(reconnect_delay + jitter).await;
                reconnect_delay = reconnect_delay.mul_f64(1.7).min(max_delay);
                continue;
            }
        };
        println!("[bridge] connected ws={}", cfg.ws_url);
        reconnect_delay = base_delay;

        let err = run_once(&cfg, &mut src, &ws, &mut err_rx, &mut strokes_sent).await;
        ws.close();
        println!(
            "[bridge] disconnected; strokes_sent={strokes_sent}; reconnecting in {} (err={err})",
            go_duration(reconnect_delay)
        );
        tokio::time::sleep(reconnect_delay).await;
    }
}

async fn recv_opt<T>(rx: &mut Option<mpsc::Receiver<T>>) -> Option<T> {
    match rx {
        Some(r) => r.recv().await,
        None => std::future::pending().await,
    }
}

/// Runs one connection until the socket fails; returns the error.
pub async fn run_once(
    cfg: &Config,
    src: &mut Sources,
    ws: &WsConn,
    err_rx: &mut mpsc::Receiver<String>,
    strokes_sent: &mut u64,
) -> String {
    let settings = stroke_settings(cfg);
    let flush = settings.flush_every;
    let mut m = StrokeMachine::new(settings, src.rng, std::time::Instant::now());
    let mut debug_tick = Instant::now();
    let mut tick = tokio::time::interval(flush);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            e = err_rx.recv() => {
                // ping/pong/close/write failure: bail so the outer loop reconnects
                return e.unwrap_or_else(|| "connection closed".into());
            }
            ev = src.ev_rx.recv() => {
                let Some(ev) = ev else { return "pen reader stopped".into() };
                let before = m.strokes_ended;
                for msg in m.handle(ev, std::time::Instant::now()) {
                    let _ = ws.write_text(msg).await; // errors surface on err_rx
                }
                *strokes_sent += m.strokes_ended - before;
            }
            k = recv_opt(&mut src.key_rx) => {
                if let Some(k) = k {
                    let msg = serde_json::to_string(&k).expect("serialize");
                    if let Err(e) = ws.write_text(msg).await {
                        return e;
                    }
                }
            }
            _ = tick.tick() => {}
        }

        // Flush on timer even if SYN_REPORT is sparse.
        if let Some(msg) = m.tick(std::time::Instant::now()) {
            if let Err(e) = ws.write_text(msg).await {
                return e;
            }
        }

        if cfg.debug && debug_tick.elapsed() > Duration::from_secs(2) {
            debug_tick = Instant::now();
            println!("[bridge] stats touching={} strokes={} brush={}", m.touching, strokes_sent, m.cur_brush);
        }
        // If input goes quiet, print a hint in debug mode.
        if cfg.debug && m.last_any_event.elapsed() > Duration::from_secs(5) {
            println!("[bridge] note: no pen events for 5s (fine if idle; else try -list-devices or -input /dev/input/eventX)");
            m.last_any_event = std::time::Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
