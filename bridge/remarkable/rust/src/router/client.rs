//! One connection: its bounded send queue ([`Client`]), the read loop that dispatches incoming
//! messages to the session, and the write loop that drains the queue and keeps the link alive.

use std::sync::Mutex;

use futures_util::stream::StreamExt;
use futures_util::SinkExt;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{timeout, Instant};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::{Bytes, Message, Utf8Bytes};

use super::http::Prefixed;
use super::messages::{json_msg, Envelope, StrokeDelete, Term};
use super::session::Session;
use super::{PING_EVERY, PONG_WAIT, TERM_STATUS, WRITE_WAIT};

/// A connected client as seen by the sessions: a send queue that never blocks the sender.
pub(super) struct Client {
    /// `None` until attached and once closed; dropping the sender lets the writer drain and send
    /// a close frame.
    tx: Mutex<Option<mpsc::Sender<Utf8Bytes>>>,
}

impl Client {
    /// A client with no queue yet: messages queued before [`Client::attach`] are dropped, which
    /// is why a joining member starts out `held` (see `session::Member`).
    pub(super) fn new() -> Self {
        Client { tx: Mutex::new(None) }
    }

    /// Gives the client its send queue (sized once the replay length is known).
    pub(super) fn attach(&self, tx: mpsc::Sender<Utf8Bytes>) {
        *self.tx.lock().unwrap() = Some(tx);
    }

    /// Never blocks: a client whose queue is full is closed (it will reconnect and replay).
    pub(super) fn queue(&self, msg: Utf8Bytes) {
        let mut g = self.tx.lock().unwrap();
        if let Some(tx) = g.as_ref() {
            if tx.try_send(msg).is_err() {
                *g = None;
            }
        }
    }

    /// Drops the queue; the write loop then sends a close frame and exits.
    pub(super) fn close(&self) {
        *self.tx.lock().unwrap() = None;
    }
}

type WsSink = futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<Prefixed>, Message>;
type WsStream = futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<Prefixed>>;

/// Reads the client's messages and applies each to the session until the client goes silent
/// for [`PONG_WAIT`], disconnects, errs, or its writer gives up. Any frame counts as alive.
pub(super) async fn read_loop(mut stream: WsStream, sess: &Mutex<Session>, cid: u64, client: &Client, mut writer_done: oneshot::Receiver<()>) {
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
            "stroke_delete" => {
                let mut s = sess.lock().unwrap();
                let gone = s.delete_strokes(&m.ids, cid);
                if !gone.is_empty() && gone.len() == m.ids.len() {
                    s.broadcast(&raw, cid); // every id stood: forward as sent, extra fields intact
                } else if !gone.is_empty() {
                    s.broadcast(&json_msg(&StrokeDelete { t: "stroke_delete", ids: &gone, ts: m.ts }), cid);
                }
            }
            "key" | "cursor" | "doc" | "dock_action" | "typer_note" => sess.lock().unwrap().broadcast(&raw, cid),
            "typer_config" => {
                // The bridge's acknowledgement is its current speed: kept for joiners.
                let mut s = sess.lock().unwrap();
                if m.ok == Some(true) {
                    s.typer = Some(raw.clone());
                }
                s.broadcast(&raw, cid);
            }
            "clear" => {
                let mut s = sess.lock().unwrap();
                s.clear();
                s.broadcast(&raw, cid);
            }
            "page" => {
                // The tablet's saved page becomes the base, then goes to everyone else.
                let mut s = sess.lock().unwrap();
                s.set_page(m.rev.unwrap_or(0), &format!("{}/{}", m.doc, m.page), &raw);
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

/// Sends queued messages (each within [`WRITE_WAIT`]) and, every [`PING_EVERY`], a WebSocket
/// ping plus a `{"t":"ping"}` text message. When the queue is dropped (the client was closed
/// or fell behind) it sends a close frame and returns.
pub(super) async fn write_loop(mut sink: WsSink, mut rx: mpsc::Receiver<Utf8Bytes>, _done: oneshot::Sender<()>) {
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
