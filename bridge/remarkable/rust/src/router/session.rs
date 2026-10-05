//! One session's state, always used under the session's mutex.
//!
//! A session holds its members (connected clients and whether their replay is still being
//! queued), the replayable page and the shared document's update log. [`Session::snapshot`]
//! copies what a joiner needs cheaply under the lock; [`PageSnapshot::messages`] turns it into
//! replay messages after the lock is released.
//!
//! The replayable page has two parts. Its **base** is the tablet's latest saved page, a `page`
//! snapshot from the bridge's page watcher (docs/protocol.md, `page`; ADR 008): xochitl's own
//! file, so erases, undo and exact tools are already applied. On top of it is the **live log**:
//! strokes relayed since, which no saved file holds yet. A new `page` covers every stroke that
//! began up to its `rev`, so those strokes leave the log ([`Session::set_page`]); a joiner is
//! replayed the base first, then the log. `clear` drops both.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use serde_json::value::RawValue;
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::Utf8Bytes;

use super::client::Client;
use super::messages::{json_msg, Envelope, ReplayDoc, ReplayEnd, ReplayPts};
use super::{DOC_COMPACT_AFTER, DOC_COMPACT_AT, DOC_REPLAY_N, MAX_POINTS, MAX_STROKES, MAX_STROKE_POINTS, REPLAY_PTS};

/// A session: who is connected, the page and the shared document.
#[derive(Default)]
pub(super) struct Session {
    pub(super) clients: HashMap<u64, Member>,
    /// The page's base: the latest `page` message as received (`None` before one, or after a
    /// `clear`). Shared, never modified once stored.
    pub(super) page: Option<Utf8Bytes>,
    /// `"doc/page"` of the latest snapshot (empty before the first).
    pub(super) page_key: String,
    /// The live log: strokes since the base (or the last clear), in arrival order.
    pub(super) order: VecDeque<String>,
    pub(super) strokes: HashMap<String, Stroke>,
    pub(super) points: usize,
    /// Shared document: Yjs updates (base64) in arrival order; survives clear (it is not ink).
    pub(super) doc_log: Vec<Arc<str>>,
    /// The client asked for a doc_state, if any.
    pub(super) compact_who: Option<u64>,
    /// doc_log length when it was asked.
    pub(super) compact_from: usize,
    /// When it was asked.
    pub(super) compact_asked: Option<Instant>,
}

/// A client as the session sees it.
pub(super) struct Member {
    pub(super) client: Arc<Client>,
    /// `Some` while the client's replay is being queued: broadcasts wait here, in order.
    pub(super) held: Option<Vec<Utf8Bytes>>,
}

/// Points per block: one replayed stroke_pts message.
pub(super) type Block = Arc<Vec<Box<RawValue>>>;

/// A recorded stroke: everything needed to replay it as the messages it arrived as.
pub(super) struct Stroke {
    /// The stroke_begin's `ts` (Unix ms; 0 when it had none, so a `page` always covers it).
    pub(super) ts: i64,
    /// The stroke_begin's `layer`: empty or `"user"` is the tablet's own ink.
    pub(super) layer: String,
    /// The stroke_begin message as received.
    pub(super) begin: Utf8Bytes,
    /// Every point as received (up to [`MAX_STROKE_POINTS`]), in blocks of [`REPLAY_PTS`]. A
    /// snapshot shares the blocks; only a shared, still-filling last block is copied on write.
    pub(super) blocks: Vec<Block>,
    /// Points recorded (the sum of the blocks' lengths).
    pub(super) n_pts: usize,
    /// Its stroke_end arrived (or its owner left).
    pub(super) ended: bool,
    /// Who is drawing it (ended for everyone if they leave mid-stroke).
    pub(super) owner: u64,
}

impl Stroke {
    /// Whether this is the tablet user's own ink (and so part of the tablet's saved page), as
    /// opposed to another participant's (`peer`) or the AI's.
    pub(super) fn is_tablet_ink(&self) -> bool {
        self.layer.is_empty() || self.layer == "user"
    }
}

/// The page at one instant, cheap to take under the lock: blocks are shared, not copied.
pub(super) struct PageSnapshot {
    /// The base (`page` message), replayed first.
    pub(super) page: Option<Utf8Bytes>,
    pub(super) strokes: Vec<StrokeSnap>,
    pub(super) doc: Vec<Arc<str>>,
}

/// One stroke of a [`PageSnapshot`].
pub(super) struct StrokeSnap {
    pub(super) id: String,
    pub(super) begin: Utf8Bytes,
    pub(super) blocks: Vec<Block>,
    pub(super) ended: bool,
}

impl PageSnapshot {
    /// The page as the messages a client would have seen live.
    pub(super) fn messages(&self) -> Vec<Utf8Bytes> {
        let mut out = Vec::new();
        if let Some(page) = &self.page {
            out.push(page.clone()); // the base first, then the ink drawn since
        }
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
    // ── the page log ───────────────────────────────────────────────────────
    //
    // Live strokes are recorded as they are relayed, so a joiner can be replayed the page.
    // Memory is bounded (MAX_STROKES, MAX_POINTS: the oldest strokes go first, but the newest
    // always stays), and one stroke keeps at most MAX_STROKE_POINTS for replay.

    /// Records a `stroke_begin`, `stroke_pts` or `stroke_end` from client `from` for replay.
    /// Messages without an id are relayed but not recorded.
    pub(super) fn record(&mut self, m: &Envelope<'_>, raw: &Utf8Bytes, from: u64) {
        if m.id.is_empty() {
            return;
        }
        match m.t.as_str() {
            "stroke_begin" => self.begin_stroke(&m.id, m.ts.unwrap_or(0), &m.layer, raw, from),
            "stroke_pts" => self.append_points(&m.id, m.pts.as_deref().unwrap_or_default()),
            "stroke_end" => {
                if let Some(st) = self.strokes.get_mut(&m.id) {
                    st.ended = true;
                }
            }
            _ => {}
        }
        self.drop_oldest_over_bounds();
    }

    /// Starts (or restarts, replacing its points) the stroke `id`, begun at `ts` (Unix ms), on
    /// `layer` (see [`Stroke::layer`]).
    fn begin_stroke(&mut self, id: &str, ts: i64, layer: &str, raw: &Utf8Bytes, from: u64) {
        if let Some(old) = self.strokes.get(id) {
            self.points -= old.n_pts;
        } else {
            self.order.push_back(id.to_string());
        }
        let st = Stroke { ts, layer: layer.to_string(), begin: raw.clone(), blocks: Vec::new(), n_pts: 0, ended: false, owner: from };
        self.strokes.insert(id.to_string(), st);
    }

    /// Adds points to the stroke `id`, up to its replay cap. Points for a stroke that began
    /// before a clear (or before this router started) are not recorded; they are still relayed.
    fn append_points(&mut self, id: &str, pts: &[&RawValue]) {
        let Some(st) = self.strokes.get_mut(id) else { return };
        let room = MAX_STROKE_POINTS.saturating_sub(st.n_pts);
        let add = &pts[..pts.len().min(room)];
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

    /// Enforces the page's memory bounds, oldest stroke first, never dropping the last one.
    fn drop_oldest_over_bounds(&mut self) {
        while (self.order.len() > MAX_STROKES || self.points > MAX_POINTS) && self.order.len() > 1 {
            let oldest = self.order.pop_front().expect("non-empty");
            if let Some(st) = self.strokes.remove(&oldest) {
                self.points -= st.n_pts;
            }
        }
    }

    /// A `clear`: forgets the base and every recorded stroke. The shared document stays.
    pub(super) fn clear(&mut self) {
        self.page = None;
        self.order.clear();
        self.strokes.clear();
        self.points = 0;
    }

    // ── the page's base ────────────────────────────────────────────────────

    /// Makes a `page` snapshot the page's new base. The snapshot already holds every stroke the
    /// tablet saved up to `rev` (erased ones are simply absent), so the live log keeps only
    /// strokes that began after `rev`: ink drawn since the save, not in any file yet. A page
    /// turn works the same way: the watcher's `rev` is then the time of the turn, so ink from
    /// the previous page leaves the log too. Other participants' and the AI's strokes are in no
    /// tablet file, so a snapshot never covers them: they stay while the page stays, and leave
    /// when the tablet turns to another page or document (`key` = `"doc/page"`), or they would
    /// be replayed onto the new page (Go: `setPageLocked`).
    pub(super) fn set_page(&mut self, rev: i64, key: &str, raw: &Utf8Bytes) {
        self.page = Some(raw.clone());
        let turned = !self.page_key.is_empty() && self.page_key != key;
        self.page_key = key.to_string();
        let mut kept = VecDeque::with_capacity(self.order.len());
        for id in self.order.drain(..) {
            let covered = match self.strokes.get(&id) {
                Some(st) => if st.is_tablet_ink() { st.ts <= rev } else { turned },
                None => true,
            };
            if !covered {
                kept.push_back(id);
            } else if let Some(st) = self.strokes.remove(&id) {
                self.points -= st.n_pts;
            }
        }
        self.order = kept;
    }

    /// The page now, for a replay built after the lock is released.
    pub(super) fn snapshot(&self) -> PageSnapshot {
        let strokes = self
            .order
            .iter()
            .filter_map(|id| {
                let st = self.strokes.get(id)?;
                Some(StrokeSnap { id: id.clone(), begin: st.begin.clone(), blocks: st.blocks.clone(), ended: st.ended })
            })
            .collect();
        PageSnapshot { page: self.page.clone(), strokes, doc: self.doc_log.clone() }
    }

    /// Queues `raw` for every member but `from`; a member whose replay is still being queued
    /// holds it until then, so it sees messages in order.
    pub(super) fn broadcast(&mut self, raw: &Utf8Bytes, from: u64) {
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
    pub(super) fn end_strokes_of(&mut self, cid: u64) {
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
    pub(super) fn doc_update(&mut self, u: Arc<str>, raw: &Utf8Bytes, from: u64, now: Instant) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

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

    #[test]
    fn a_page_keeps_only_strokes_begun_after_its_rev() {
        let mut s = Session::default();
        rec(&mut s, r#"{"t":"stroke_begin","id":"old","ts":1000}"#, 1);
        rec(&mut s, &pts_msg("old", 10), 1);
        rec(&mut s, r#"{"t":"stroke_begin","id":"at_rev","ts":2000}"#, 1);
        rec(&mut s, r#"{"t":"stroke_begin","id":"no_ts"}"#, 1);
        rec(&mut s, r#"{"t":"stroke_begin","id":"new","ts":3000}"#, 1);
        rec(&mut s, &pts_msg("new", 4), 1);
        s.set_page(2000, "/", &Utf8Bytes::from_static(r#"{"t":"page","rev":2000}"#));
        assert_eq!(s.order, ["new"]);
        assert_eq!(s.points, 4, "the dropped strokes' points were not released");

        let msgs = s.snapshot().messages();
        assert_eq!(msgs[0].as_str(), r#"{"t":"page","rev":2000}"#, "the base is replayed first");
        assert_eq!(msgs.len(), 3, "page, then new's begin and points");

        s.clear();
        assert!(s.page.is_none() && s.order.is_empty() && s.points == 0);
        assert!(s.snapshot().messages().is_empty());
    }

    #[test]
    fn a_fractional_ts_fails_the_envelope_like_go() {
        assert!(serde_json::from_str::<Envelope>(r#"{"t":"stroke_begin","id":"a","ts":1.5}"#).is_err());
        assert!(serde_json::from_str::<Envelope>(r#"{"t":"stroke_begin","id":"a","ts":null}"#).is_ok());
    }
}
