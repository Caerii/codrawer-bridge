//! One session's state, always used under the session's mutex.
//!
//! A session holds its members (connected clients and whether their replay is still being
//! queued), the replayable page (strokes since the last `clear`, bounded in memory) and the
//! shared document's update log. [`Session::snapshot`] copies what a joiner needs cheaply under
//! the lock; [`PageSnapshot::messages`] turns it into replay messages after the lock is released.

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
    /// The page: strokes since the last clear, in arrival order, for replay to late joiners.
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

pub(super) struct Stroke {
    /// The stroke_begin message as received.
    pub(super) begin: Utf8Bytes,
    /// Every point as received (up to [`MAX_STROKE_POINTS`]), in blocks of [`REPLAY_PTS`]. A
    /// snapshot shares the blocks; only a shared, still-filling last block is copied on write.
    pub(super) blocks: Vec<Block>,
    pub(super) n_pts: usize,
    pub(super) ended: bool,
    /// Who is drawing it (ended for everyone if they leave mid-stroke).
    pub(super) owner: u64,
}

/// The page at one instant, cheap to take under the lock: blocks are shared, not copied.
pub(super) struct PageSnapshot {
    pub(super) strokes: Vec<StrokeSnap>,
    pub(super) doc: Vec<Arc<str>>,
}

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
    pub(super) fn record(&mut self, m: &Envelope<'_>, raw: &Utf8Bytes, from: u64) {
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

    pub(super) fn reset(&mut self) {
        self.order.clear();
        self.strokes.clear();
        self.points = 0;
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
        PageSnapshot { strokes, doc: self.doc_log.clone() }
    }

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
}
