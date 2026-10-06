//! Makes the tablet the source of truth for the page: finds the document and page open in
//! xochitl, reads that page's saved `.rm` file ([`crate::rmlines`]) and turns it into a `page`
//! message (docs/protocol.md) whenever the file is rewritten or the page changes. Port of the Go
//! package `bridge/remarkable/native/pagewatch`.
//!
//! ```text
//! xochitl dir ──► locate (newest <doc>.content → open page) ──┐
//!                                                             ▼
//!                              Watcher::poll: changed? ──► rmlines::parse ──► message ──► `page` JSON
//! ```
//!
//! - `locate`: which document and page are open.
//! - `watcher`: the polling state machine (what was published, when to publish again, `rev`).
//! - `message`: the `page` JSON, byte-compatible with the Go bridge.
//!
//! It only ever reads xochitl's data directory. A poll lists the directory (a stat per entry)
//! and parses a page only when something changed. xochitl writes a page's `.rm` ~6–10 s after
//! the user pauses or when leaving the page, and the open page shows in `<doc>.content` within
//! ~1–2 s of a turn (docs/investigations/xochitl-pen-data.md). When to poll is the bridge side's
//! business ([`crate::page_watch`]: thread, feed, gating): on inotify events, since a timed poll
//! of a directory with thousands of entries was the bridge's largest idle cost.

mod locate;
mod message;
mod watcher;

use std::fmt;
use std::io;
use std::path::Path;

pub use locate::{locate, Location};
pub use message::{message, DEFAULT_H, DEFAULT_W};
pub use watcher::Watcher;

/// xochitl's data directory on the tablet.
pub const DEFAULT_DIR: &str = "/home/root/.local/share/remarkable/xochitl";

/// Why a poll found nothing to publish yet. All of these are retried on the next poll.
#[derive(Debug)]
pub enum PollError {
    /// No `<doc>.content` in the directory (no document opened yet).
    NoDocument,
    /// A file or directory could not be read.
    Io { op: &'static str, path: String, err: io::Error },
    /// The page file did not parse (most likely xochitl is writing it).
    Parse(crate::rmlines::Error),
}

impl PollError {
    fn io(op: &'static str, path: &Path, err: io::Error) -> Self {
        PollError::Io { op, path: path.display().to_string(), err }
    }
}

impl fmt::Display for PollError {
    /// Worded like the Go errors the bridge logs (`fs.ErrNotExist`, `*fs.PathError`).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PollError::NoDocument => f.write_str("file does not exist"),
            PollError::Io { op, path, err } => write!(f, "{op} {path}: {err}"),
            PollError::Parse(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for PollError {}

#[cfg(test)]
mod tests;
