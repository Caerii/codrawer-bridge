//! The polling state machine: remembers what was last published and decides, on each poll,
//! whether the open page changed or its `.rm` was rewritten. When to poll is the page thread's
//! business ([`crate::page_watch`]): on an inotify event, or on a timer where inotify is missing.

use std::path::PathBuf;
use std::time::SystemTime;

use super::locate::{newest_content, open_page, stat_file};
use super::{message, Location, PollError};
use crate::rmlines;
use crate::util::unix_millis;

/// Watches xochitl's data directory. Call [`Watcher::poll`] whenever something may have changed.
#[derive(Debug, Default)]
pub struct Watcher {
    dir: PathBuf,
    /// The location last published.
    loc: Location,
    /// `loc.page` came from the newest-`.rm` guess: re-evaluated on every poll.
    guessed: bool,
    /// The published page file's mtime and size (`None`: it did not exist).
    rm_stat: Option<(SystemTime, u64)>,
    /// The published snapshot's rev.
    rev: i64,
    /// Something was published.
    started: bool,
    /// The document the last poll found open, published or not ("" before one is found).
    located: String,
}

impl Watcher {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Watcher { dir: dir.into(), ..Watcher::default() }
    }

    /// Returns a new `page` message when the open page changed or its `.rm` was rewritten,
    /// otherwise `Ok(None)`. A file that cannot be parsed yet (being written) is an error and
    /// leaves the state alone, so the next poll retries.
    ///
    /// `rev` is the time (Unix ms on the tablet's clock, the clock of stroke timestamps) up to
    /// which the snapshot is authoritative: the `.rm` mtime for a rewrite of the same page; for
    /// a page change the later of that and the `.content` write that recorded the turn, so ink
    /// drawn on the previous page before the turn is not carried over.
    pub fn poll(&mut self) -> Result<Option<String>, PollError> {
        let loc = self.current_location()?;
        if loc.page.is_empty() {
            return Ok(None);
        }
        let page_changed = !self.started || loc.doc != self.loc.doc || loc.page != self.loc.page;
        let rm_path = self.dir.join(&loc.doc).join(format!("{}.rm", loc.page));
        let rm_stat = stat_file(&rm_path)?;
        if !page_changed && rm_stat == self.rm_stat {
            // Nothing to publish; keep the title and .content time current.
            self.loc.title = loc.title;
            self.loc.content_mtime = loc.content_mtime;
            return Ok(None);
        }

        let page = match rm_stat {
            Some(_) => {
                let data = std::fs::read(&rm_path).map_err(|e| PollError::io("open", &rm_path, e))?;
                Some(rmlines::parse(&data).map_err(PollError::Parse)?) // most likely mid-write
            }
            None => None,
        };
        let rev = self.next_rev(&loc, rm_stat, page_changed);
        let msg = message(&loc, rev, page.as_ref());
        self.loc = loc;
        self.rm_stat = rm_stat;
        self.rev = rev;
        self.started = true;
        Ok(Some(msg))
    }

    /// The document the last poll found open (its `.content` is the newest), even if nothing
    /// was published for it yet; `None` before any document was found. The page thread watches
    /// this document's folder for `.rm` writes.
    pub fn located_doc(&self) -> Option<&str> {
        (!self.located.is_empty()).then_some(self.located.as_str())
    }

    /// The open document, and its page and title. `.content` and `.metadata` are re-read only
    /// when the document's `.content` was rewritten (or the page is a guess).
    fn current_location(&mut self) -> Result<Location, PollError> {
        let mut loc = newest_content(&self.dir)?;
        self.located.clone_from(&loc.doc);
        let unchanged = self.started && loc.doc == self.loc.doc && loc.content_mtime == self.loc.content_mtime;
        if unchanged && !self.guessed {
            loc.page = self.loc.page.clone();
            loc.title = self.loc.title.clone();
        } else {
            let open = open_page(&self.dir, &loc.doc);
            (loc.page, loc.title, self.guessed) = (open.page, open.title, open.guessed);
        }
        Ok(loc)
    }

    /// The rev of a snapshot about to be published (see [`Watcher::poll`]).
    fn next_rev(&self, loc: &Location, rm_stat: Option<(SystemTime, u64)>, page_changed: bool) -> i64 {
        let mut rev = rm_stat.map_or(0, |(mtime, _)| unix_millis(mtime));
        if page_changed {
            let turned_at = loc.content_mtime.map_or(i64::MIN, unix_millis);
            rev = rev.max(turned_at);
        } else if rev < self.rev {
            rev = self.rev; // never go backwards on one page (clock step, restored file)
        }
        rev
    }
}
