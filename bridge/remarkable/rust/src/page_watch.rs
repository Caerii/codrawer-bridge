//! The page watcher's place in the bridge (page_watch.go): xochitl's saved page is the source
//! of truth. A thread reads xochitl's files read-only ([`crate::pagewatch::Watcher`]) for the life
//! of the process and publishes each new `page` snapshot on a [`PageFeed`]. The connection loop
//! (`bridge::write_outbox`) sends the latest snapshot on every new socket, then each new one, so
//! a restarted router learns the page again.
//!
//! ```text
//! "page" thread: inotify event (or timer) ──► Watcher::poll ──► watch channel (latest only) ──► write_outbox
//! ```
//!
//! # When to look
//!
//! The thread sleeps until xochitl writes ([`Notify`]: inotify on the data directory and on the
//! open document's folder) and polls only then, so an idle tablet costs it nothing. The former
//! 1 s poll woke the SoC every second and listed the whole data directory (a stat per entry) each
//! time; it was most of the bridge's idle CPU (docs/investigations/idle-cost.md). The
//! `-page-poll-ms` timer is still used in three cases ([`next_deadline`]):
//!
//! - inotify is unavailable or broke ([`Poll`]): the old behaviour, a poll every interval;
//! - a poll failed (a `.rm` mid-write, no document yet): retry after the interval, as before;
//! - otherwise a slow safety poll ([`SAFETY_POLL`]), in case an event was missed.
//!
//! Which events count ([`Notify::relevant`]): in the data directory, a `<doc>.content` or
//! `<doc>.metadata` written, renamed or removed, or a folder created or removed (a document); in
//! the open document's folder, a `.rm` written, renamed or removed. xochitl's other writes
//! (thumbnails, `.local`, `.pagedata`) do not wake the poll. After the open document changes, the
//! thread watches the new document's folder and polls once more at once, since a write may have
//! landed before the watch began.
//!
//! Gating ([`page_watch_enabled`]): `PAGE_WATCH` / `-page-watch` `on` or `off` decide; `auto`
//! (the default) runs it only on an OS version boot.sh lists as tested (`CODRAWER_OS_TESTED=1`
//! from /run/codrawer/env), since the file layout is xochitl's private format.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use crate::flags::Config;
use crate::inotify::{self, Inotify};
use crate::pagewatch::Watcher;
use crate::util::go_duration;

/// The latest `page` message (`None` until the first one). Each connection holds a receiver.
pub type PageFeed = watch::Receiver<Option<String>>;

/// Whether the watcher runs: `on`/`1`/`true`/`yes` and `off`/`0`/`false`/`no` decide (any case,
/// surrounding space ignored); anything else is `auto`, which follows `CODRAWER_OS_TESTED`.
pub fn page_watch_enabled(mode: &str, os_tested: &str) -> bool {
    match mode.trim().to_lowercase().as_str() {
        "on" | "1" | "true" | "yes" => true,
        "off" | "0" | "false" | "no" => false,
        _ => os_tested.trim() == "1",
    }
}

/// How often to poll for a `-page-poll-ms` value (at least 100 ms).
pub fn poll_every(page_poll_ms: i64) -> Duration {
    Duration::from_millis(page_poll_ms.max(100) as u64)
}

/// Starts the watcher thread when the config and environment allow it; logs either way.
pub fn start_if_enabled(cfg: &Config) -> Result<Option<PageFeed>, String> {
    let os_tested = std::env::var("CODRAWER_OS_TESTED").unwrap_or_default();
    if !page_watch_enabled(&cfg.page_watch, &os_tested) {
        println!("[page] watcher off (PAGE_WATCH={}, CODRAWER_OS_TESTED={os_tested:?})", cfg.page_watch);
        return Ok(None);
    }
    let (tx, rx) = watch::channel(None);
    let (dir, every, debug) = (cfg.xochitl_dir.clone(), poll_every(cfg.page_poll_ms), cfg.debug);
    std::thread::Builder::new()
        .name("page".into())
        .spawn(move || {
            let wake: Box<dyn Wake> = match Notify::new(Path::new(&dir)) {
                Ok(n) => {
                    println!("[page] watching {dir} with inotify, retries every {} (read-only)", go_duration(every));
                    Box::new(n)
                }
                Err(e) => {
                    println!("[page] inotify unavailable ({e}); watching {dir} every {} (read-only)", go_duration(every));
                    Box::new(Poll)
                }
            };
            let mut l = PageLoop::new(Watcher::new(&dir), &dir, every, wake, tx, debug);
            loop {
                let deadline = l.turn();
                l.wake.wait(deadline);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Some(rx))
}

/// With inotify working, the longest the thread sleeps without an event: a net for a missed
/// event, at one wakeup a minute.
pub const SAFETY_POLL: Duration = Duration::from_secs(60);

/// When the thread polls next if no change arrives first: after `every` when only polling finds
/// changes or the last poll must be retried, else after [`SAFETY_POLL`].
pub fn next_deadline(now: Instant, reports_changes: bool, retry: bool, every: Duration) -> Instant {
    if !reports_changes || retry {
        now + every
    } else {
        now + SAFETY_POLL
    }
}

// ── what the thread sleeps on ──────────────────────────────────────────────

/// What the page thread sleeps on between polls.
pub trait Wake: Send {
    /// Whether changes are reported as they happen (inotify) rather than found by polling.
    fn reports_changes(&self) -> bool;
    /// Follows the open document's folder (`None`: no document yet). Returns true when a new
    /// watch began, since a write may have landed before it: the caller then polls at once.
    fn follow(&mut self, doc_dir: Option<&Path>) -> bool;
    /// Sleeps until a relevant change or `deadline`. Returns whether a change woke it.
    fn wait(&mut self, deadline: Instant) -> bool;
}

/// The fallback: no events, a sleep until the deadline.
pub struct Poll;

impl Wake for Poll {
    fn reports_changes(&self) -> bool {
        false
    }
    fn follow(&mut self, _doc_dir: Option<&Path>) -> bool {
        false
    }
    fn wait(&mut self, deadline: Instant) -> bool {
        sleep_until(deadline);
        false
    }
}

fn sleep_until(deadline: Instant) {
    std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
}

/// inotify on xochitl's data directory and on the open document's folder.
pub struct Notify {
    ino: Inotify,
    dir_wd: i32,
    /// The followed document folder and its watch.
    doc: Option<(PathBuf, i32)>,
    /// inotify failed or the data directory went away: behave like [`Poll`] from now on.
    broken: bool,
}

impl Notify {
    /// Watches `dir` (xochitl's data directory). Fails when inotify is unavailable or `dir`
    /// cannot be watched (missing); the caller then polls.
    pub fn new(dir: &Path) -> std::io::Result<Self> {
        let ino = Inotify::new()?;
        let mask = inotify::DIR_CHANGES | inotify::IN_ONLYDIR | inotify::IN_DELETE_SELF | inotify::IN_MOVE_SELF;
        let dir_wd = ino.add(dir, mask)?;
        Ok(Notify { ino, dir_wd, doc: None, broken: false })
    }

    /// Whether `ev` may change what the watcher publishes (see the module docs). Also keeps the
    /// watch bookkeeping: a removed document folder is forgotten, a removed data directory turns
    /// this into polling.
    pub fn relevant(&mut self, ev: &inotify::Event) -> bool {
        if ev.mask & inotify::IN_Q_OVERFLOW != 0 {
            return true; // events were lost: look
        }
        if ev.wd == self.dir_wd {
            if ev.mask & (inotify::IN_IGNORED | inotify::IN_DELETE_SELF | inotify::IN_MOVE_SELF) != 0 {
                self.broken = true; // the directory itself is gone: no more events will come
                return true;
            }
            return ev.mask & inotify::IN_ISDIR != 0 || ev.name.ends_with(".content") || ev.name.ends_with(".metadata");
        }
        if let Some((_, wd)) = &self.doc {
            if ev.wd == *wd {
                if ev.mask & inotify::IN_IGNORED != 0 {
                    self.doc = None; // the folder went away; follow() watches it again if it returns
                    return true;
                }
                return ev.name.ends_with(".rm");
            }
        }
        false // from a watch already removed
    }
}

impl Wake for Notify {
    fn reports_changes(&self) -> bool {
        !self.broken
    }

    fn follow(&mut self, doc_dir: Option<&Path>) -> bool {
        if self.broken || self.doc.as_ref().map(|(p, _)| p.as_path()) == doc_dir {
            return false;
        }
        if let Some((_, wd)) = self.doc.take() {
            self.ino.remove(wd);
        }
        let Some(path) = doc_dir else { return false };
        // A folder that does not exist yet is fine: its creation wakes the data-directory watch,
        // and the next turn tries again.
        match self.ino.add(path, inotify::DIR_CHANGES | inotify::IN_ONLYDIR) {
            Ok(wd) => {
                self.doc = Some((path.to_path_buf(), wd));
                true
            }
            Err(_) => false,
        }
    }

    fn wait(&mut self, deadline: Instant) -> bool {
        loop {
            if self.broken {
                sleep_until(deadline);
                return false;
            }
            match self.ino.wait(Some(deadline)) {
                Err(e) => {
                    println!("[page] inotify failed ({e}); polling from now on");
                    self.broken = true;
                }
                Ok(evs) if evs.is_empty() => return false, // the deadline passed
                Ok(evs) => {
                    // every event goes through relevant(), so its bookkeeping stays exact
                    if evs.iter().fold(false, |woke, ev| self.relevant(ev) | woke) {
                        return true;
                    }
                }
            }
        }
    }
}

// ── the loop ───────────────────────────────────────────────────────────────

/// The page thread's state: the watcher, what it sleeps on, and where snapshots go.
pub struct PageLoop {
    pub watcher: Watcher,
    pub wake: Box<dyn Wake>,
    dir: PathBuf,
    every: Duration,
    feed: watch::Sender<Option<String>>,
    debug: bool,
    last_err: String,
}

impl PageLoop {
    pub fn new(watcher: Watcher, dir: &str, every: Duration, wake: Box<dyn Wake>, feed: watch::Sender<Option<String>>, debug: bool) -> Self {
        PageLoop { watcher, wake, dir: PathBuf::from(dir), every, feed, debug, last_err: String::new() }
    }

    /// Polls once, publishes a new snapshot, follows the open document, and returns when to
    /// poll next if no change arrives first.
    pub fn turn(&mut self) -> Instant {
        let retry = match self.watcher.poll() {
            Err(e) => {
                // a file mid-write or no document yet: say it once, retry quietly
                let e = e.to_string();
                if e != self.last_err || self.debug {
                    println!("[page] {e} (retrying)");
                    self.last_err = e;
                }
                true
            }
            Ok(None) => {
                self.last_err.clear();
                false
            }
            Ok(Some(msg)) => {
                self.last_err.clear();
                println!("[page] {} ({} bytes)", page_summary(&msg), msg.len());
                self.feed.send_replace(Some(msg));
                false
            }
        };
        let doc_dir = self.watcher.located_doc().map(|d| self.dir.join(d));
        let now = Instant::now();
        if self.wake.follow(doc_dir.as_deref()) {
            return now;
        }
        next_deadline(now, self.wake.reports_changes(), retry, self.every)
    }
}

/// A short log line for a page message: everything before the stroke data.
pub fn page_summary(msg: &str) -> String {
    match msg.find(r#","strokes":"#) {
        Some(i) if i > 0 => format!("{}}}", &msg[..i]),
        _ => msg.to_string(),
    }
}

/// `-page-dump`: the `page` message for the open document and page, or why there is none.
pub fn dump(dir: &str) -> Result<String, String> {
    match Watcher::new(dir).poll() {
        Ok(Some(msg)) => Ok(msg),
        Ok(None) => Err("<nil>".into()), // Go prints the nil error the same way
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gating_follows_the_mode_then_the_tested_os() {
        assert!(page_watch_enabled("on", ""));
        assert!(page_watch_enabled(" YES ", "0"));
        assert!(!page_watch_enabled("off", "1"));
        assert!(!page_watch_enabled("0", "1"));
        assert!(page_watch_enabled("auto", "1"));
        assert!(page_watch_enabled("", " 1 "));
        assert!(!page_watch_enabled("auto", ""));
        assert!(!page_watch_enabled("whatever", "0"));
    }

    #[test]
    fn summary_drops_the_strokes() {
        let msg = r#"{"t":"page","doc":"d","page":"p","rev":1,"w":1620,"h":2160,"strokes":[{"id":"1:1"}]}"#;
        assert_eq!(page_summary(msg), r#"{"t":"page","doc":"d","page":"p","rev":1,"w":1620,"h":2160}"#);
        assert_eq!(page_summary("x"), "x");
    }

    #[test]
    fn poll_interval_has_a_floor() {
        assert_eq!(poll_every(1000), Duration::from_secs(1));
        assert_eq!(poll_every(5), Duration::from_millis(100));
        assert_eq!(poll_every(-1), Duration::from_millis(100));
    }

    #[test]
    fn dump_reports_a_missing_directory() {
        let err = dump("/definitely/not/a/xochitl/dir").unwrap_err();
        assert!(err.starts_with("open "), "{err}");
    }

    // ── when the thread polls ──────────────────────────────────────────────

    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    /// A fresh empty directory, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!("codrawer-pagethread-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A scripted [`Wake`]: records the folders it is asked to follow.
    struct FakeWake {
        reports: bool,
        new_watch: bool,
        followed: Arc<Mutex<Vec<Option<PathBuf>>>>,
    }

    impl Wake for FakeWake {
        fn reports_changes(&self) -> bool {
            self.reports
        }
        fn follow(&mut self, doc_dir: Option<&Path>) -> bool {
            self.followed.lock().unwrap().push(doc_dir.map(Path::to_path_buf));
            self.new_watch
        }
        fn wait(&mut self, _deadline: Instant) -> bool {
            unreachable!("turn() never waits")
        }
    }

    fn page_loop(dir: &Path, reports: bool, new_watch: bool) -> (PageLoop, PageFeed, Arc<Mutex<Vec<Option<PathBuf>>>>) {
        let followed = Arc::new(Mutex::new(Vec::new()));
        let wake = FakeWake { reports, new_watch, followed: followed.clone() };
        let (tx, rx) = watch::channel(None);
        let d = dir.to_str().unwrap();
        (PageLoop::new(Watcher::new(d), d, Duration::from_secs(1), Box::new(wake), tx, false), rx, followed)
    }

    /// `deadline - now` within a little scheduling slack of `want`.
    fn about(deadline: Instant, before: Instant, want: Duration) -> bool {
        let got = deadline.saturating_duration_since(before);
        got >= want && got < want + Duration::from_secs(1)
    }

    #[test]
    fn deadlines_follow_the_wake_source() {
        let (now, every) = (Instant::now(), Duration::from_secs(1));
        assert_eq!(next_deadline(now, false, false, every), now + every, "polling: every interval");
        assert_eq!(next_deadline(now, false, true, every), now + every);
        assert_eq!(next_deadline(now, true, true, every), now + every, "inotify, but a poll to retry");
        assert_eq!(next_deadline(now, true, false, every), now + SAFETY_POLL, "inotify: rest");
    }

    #[test]
    fn without_inotify_the_loop_polls_every_interval() {
        let tmp = TempDir::new();
        std::fs::write(tmp.0.join("d.content"), r#"{"cPages":{"lastOpened":{"value":"p"}}}"#).unwrap();
        let (mut l, feed, followed) = page_loop(&tmp.0, false, false);
        let t = Instant::now();
        assert!(about(l.turn(), t, Duration::from_secs(1)));
        assert!(feed.borrow().as_deref().is_some_and(|m| m.contains(r#""page":"p""#)), "published: {:?}", feed.borrow());
        assert_eq!(*followed.lock().unwrap(), [Some(tmp.0.join("d"))], "follows the located document");
        let t = Instant::now();
        assert!(about(l.turn(), t, Duration::from_secs(1)), "nothing changed: still every interval");
    }

    #[test]
    fn with_inotify_the_loop_rests_unless_it_must_retry() {
        let tmp = TempDir::new();
        let (mut l, feed, followed) = page_loop(&tmp.0, true, false);
        let t = Instant::now();
        assert!(about(l.turn(), t, Duration::from_secs(1)), "no document yet: retry after the interval");
        assert_eq!(*followed.lock().unwrap(), [None]);

        std::fs::write(tmp.0.join("d.content"), r#"{"cPages":{"lastOpened":{"value":"p"}}}"#).unwrap();
        let t = Instant::now();
        assert!(about(l.turn(), t, SAFETY_POLL), "published: rest until an event");
        assert!(feed.borrow().is_some());

        // a half-written page file is retried on the interval, events or not
        std::fs::create_dir_all(tmp.0.join("d")).unwrap();
        let full = crate::rmlines::tests::fixture("paperpro_calligraphy.rm");
        std::fs::write(tmp.0.join("d").join("p.rm"), &full[..full.len() / 2]).unwrap();
        let t = Instant::now();
        assert!(about(l.turn(), t, Duration::from_secs(1)), "parse error: retry");
    }

    #[test]
    fn a_new_watch_means_poll_again_at_once() {
        let tmp = TempDir::new();
        std::fs::write(tmp.0.join("d.content"), "{}").unwrap();
        let (mut l, _feed, _) = page_loop(&tmp.0, true, true);
        assert!(l.turn() <= Instant::now(), "a write may have landed before the watch began");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn notify_wakes_on_page_files_only() {
        let tmp = TempDir::new();
        let dir = tmp.0.clone();
        let soon = || Instant::now() + Duration::from_millis(150);
        let later = || Instant::now() + Duration::from_secs(5);
        assert!(Notify::new(&dir.join("missing")).is_err(), "a missing directory falls back to polling");
        let mut n = Notify::new(&dir).unwrap();
        assert!(n.reports_changes());

        std::fs::write(dir.join("d.pagedata"), "x").unwrap();
        assert!(!n.wait(soon()), "xochitl's other files do not wake the poll");
        std::fs::write(dir.join("d.content"), "{}").unwrap();
        assert!(n.wait(later()), ".content written");
        // atomic save: written elsewhere, renamed into place
        std::fs::write(dir.join("tmp-file"), "{}").unwrap();
        std::fs::rename(dir.join("tmp-file"), dir.join("d.metadata")).unwrap();
        assert!(n.wait(later()), ".metadata renamed into place");

        let doc = dir.join("d");
        assert!(!n.follow(Some(&doc)), "the folder does not exist yet");
        std::fs::create_dir(&doc).unwrap();
        assert!(n.wait(later()), "a document folder was created");
        assert!(n.follow(Some(&doc)), "now it is watched");
        assert!(!n.follow(Some(&doc)), "already watched");
        std::fs::write(doc.join("p.rm"), "x").unwrap();
        assert!(n.wait(later()), ".rm written in the open document");
        std::fs::create_dir(doc.join("thumbnails")).unwrap();
        std::fs::write(doc.join("p-metadata.json"), "{}").unwrap();
        assert!(!n.wait(soon()), "other files in the document folder do not wake the poll");

        // the folder goes away: forgotten, so a later follow watches it again
        std::fs::remove_dir_all(&doc).unwrap();
        assert!(n.wait(later()));
        while n.wait(soon()) {}
        assert!(n.doc.is_none(), "the removed folder's watch was dropped");
        assert!(n.reports_changes());
    }
}
