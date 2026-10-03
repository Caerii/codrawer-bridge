//! The page watcher's place in the bridge (page_watch.go): xochitl's saved page is the source
//! of truth. A thread polls xochitl's files read-only ([`crate::pagewatch::Watcher`]) for the life
//! of the process and publishes each new `page` snapshot on a [`PageFeed`]. The connection loop
//! (`bridge::write_outbox`) sends the latest snapshot on every new socket, then each new one, so
//! a restarted router learns the page again.
//!
//! ```text
//! "page" thread: Watcher::poll every PAGE_POLL_MS ──► watch channel (latest only) ──► write_outbox
//! ```
//!
//! Gating ([`page_watch_enabled`]): `PAGE_WATCH` / `-page-watch` `on` or `off` decide; `auto`
//! (the default) runs it only on an OS version boot.sh lists as tested (`CODRAWER_OS_TESTED=1`
//! from /run/codrawer/env), since the file layout is xochitl's private format.

use std::time::Duration;

use tokio::sync::watch;

use crate::flags::Config;
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
        .spawn(move || run_page_watch(Watcher::new(&dir), &dir, every, tx, debug))
        .map_err(|e| e.to_string())?;
    Ok(Some(rx))
}

/// Polls for the life of the process. The first poll runs at once.
fn run_page_watch(mut watcher: Watcher, dir: &str, every: Duration, feed: watch::Sender<Option<String>>, debug: bool) {
    println!("[page] watching {dir} every {} (read-only)", go_duration(every));
    let mut last_err = String::new();
    loop {
        match watcher.poll() {
            Err(e) => {
                // a file mid-write or no document yet: say it once, retry quietly
                let e = e.to_string();
                if e != last_err || debug {
                    println!("[page] {e} (retrying)");
                    last_err = e;
                }
            }
            Ok(None) => last_err.clear(),
            Ok(Some(msg)) => {
                last_err.clear();
                println!("[page] {} ({} bytes)", page_summary(&msg), msg.len());
                feed.send_replace(Some(msg));
            }
        }
        std::thread::sleep(every);
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
}
