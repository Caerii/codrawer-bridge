//! Wire shapes (docs/protocol.md) the router reads or writes itself.
//!
//! The router never re-encodes what clients send: it parses an [`Envelope`] (the few fields it
//! routes on) and forwards the raw text. The other structs are messages the router authors:
//! hello, a terminal status, and the replay messages built from a session snapshot.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tokio_tungstenite::tungstenite::Utf8Bytes;

/// The part of a message the router looks at; the raw text is forwarded as-is.
#[derive(Deserialize)]
pub(super) struct Envelope<'a> {
    #[serde(default)]
    pub(super) t: String,
    #[serde(default)]
    pub(super) id: String,
    #[serde(default, borrow)]
    pub(super) pts: Option<Vec<&'a RawValue>>,
    #[serde(default)]
    pub(super) u: String,
    /// `stroke_begin`: when the stroke started (Unix ms, the drawing device's clock).
    /// A non-integer value fails the whole parse and the message is dropped, as in Go.
    #[serde(default)]
    pub(super) ts: Option<i64>,
    /// `page`: the snapshot holds everything drawn up to this time (Unix ms, the tablet's
    /// clock, the same clock as the tablet's `stroke_begin.ts`).
    #[serde(default)]
    pub(super) rev: Option<i64>,
    /// `stroke_begin`: whose ink it is — `"user"` (or absent) for the tablet's own pen,
    /// `"peer"` for another participant, `"ai"` for agent ink. Only the tablet's own ink is
    /// ever in its saved page, so only that is covered by a `page` snapshot.
    #[serde(default)]
    pub(super) layer: String,
    /// `page`: the open document's id.
    #[serde(default)]
    pub(super) doc: String,
    /// `page`: the open page's id.
    #[serde(default)]
    pub(super) page: String,
    /// `stroke_delete`: the strokes to remove.
    #[serde(default)]
    pub(super) ids: Vec<String>,
    /// `typer_config`: present on the bridge's acknowledgement (`true` when it took effect),
    /// absent on a client's request.
    #[serde(default)]
    pub(super) ok: Option<bool>,
    /// `dock_entries`: whose entries these are.
    #[serde(default)]
    pub(super) owner: String,
    /// `dock_entries`: the list, kept raw (an empty one withdraws the owner's entries).
    #[serde(default, borrow)]
    pub(super) entries: Option<Vec<&'a RawValue>>,
}

/// `dock_entries` with an empty list: an owner's entries withdrawn for a client that left.
#[derive(Serialize)]
pub(super) struct DockWithdraw<'a> {
    pub(super) t: &'static str,
    pub(super) owner: &'a str,
    pub(super) entries: [u8; 0],
}

/// A `stroke_delete` re-encoded with only the ids the router accepted, when it refused or did
/// not know some of those asked for.
#[derive(Serialize)]
pub(super) struct StrokeDelete<'a> {
    pub(super) t: &'static str,
    pub(super) ids: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) ts: Option<i64>,
}

/// `hello`, the first message on every connection.
#[derive(Serialize)]
pub(super) struct Hello<'a> {
    pub(super) t: &'static str,
    pub(super) session: &'a str,
    pub(super) replay: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) tablet: Option<&'a BTreeMap<String, String>>,
}

/// A one-line `term` status: this router has no terminal.
#[derive(Serialize)]
pub(super) struct Term {
    pub(super) t: &'static str,
    pub(super) kind: &'static str,
    pub(super) text: &'static str,
}

/// One replayed chunk of a stroke's points.
#[derive(Serialize)]
pub(super) struct ReplayPts<'a> {
    pub(super) t: &'static str,
    pub(super) id: &'a str,
    pub(super) pts: &'a [Box<RawValue>],
}

/// One replayed chunk of the shared document's update log.
#[derive(Serialize)]
pub(super) struct ReplayDoc<'a> {
    pub(super) t: &'static str,
    pub(super) us: &'a [&'a str],
}

/// A `stroke_end` the router authors (replayed, or for a client that left mid-stroke).
#[derive(Serialize)]
pub(super) struct ReplayEnd<'a> {
    pub(super) t: &'static str,
    pub(super) id: &'a str,
}

/// Encodes a router-authored message as a text frame payload.
pub(super) fn json_msg<T: Serialize>(v: &T) -> Utf8Bytes {
    Utf8Bytes::from(serde_json::to_string(v).expect("serialize"))
}
