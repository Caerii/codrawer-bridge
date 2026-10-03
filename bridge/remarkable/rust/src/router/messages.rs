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
