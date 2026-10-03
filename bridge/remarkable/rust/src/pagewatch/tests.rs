//! Ports of `pagewatch_test.go`: a fake xochitl directory with controlled mtimes.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::*;
use crate::rmlines::tests::fixture;
use crate::rmlines::HEADER;
use crate::util::unix_millis;

/// A fresh directory under the system temp dir, removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let name = format!("codrawer-pagewatch-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed));
        let dir = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Writes a file (creating its folder) and sets its mtime.
fn write(path: &Path, data: &[u8], mtime: SystemTime) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, data).unwrap();
    let f = fs::File::options().write(true).open(path).unwrap();
    f.set_modified(mtime).unwrap();
}

/// A current-firmware `.content`: the open page and the page list.
fn content_json(open: &str, pages: &[&str]) -> Vec<u8> {
    let pages: Vec<serde_json::Value> = pages.iter().map(|p| serde_json::json!({ "id": p })).collect();
    let c = serde_json::json!({
        "cPages": { "lastOpened": { "timestamp": "1:2", "value": open }, "pages": pages },
        "fileType": "notebook",
    });
    serde_json::to_vec(&c).unwrap()
}

/// 2026-10-02 12:00:00 UTC.
fn t0() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_790_942_400)
}

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

#[derive(Deserialize, Debug)]
struct PageMsg {
    t: String,
    doc: String,
    page: String,
    #[serde(default)]
    title: String,
    rev: i64,
    w: u32,
    h: u32,
    strokes: Vec<StrokeMsg>,
}

#[derive(Deserialize, Debug)]
struct StrokeMsg {
    tool: String,
    color: u32,
    rgba: String,
    size: f64,
    #[serde(default)]
    layer: String,
    pts: Vec<Vec<f64>>,
}

fn decode(msg: &str) -> PageMsg {
    serde_json::from_str(msg).unwrap_or_else(|e| panic!("bad JSON: {e}\n{}", &msg[..msg.len().min(300)]))
}

fn must_poll(w: &mut Watcher) -> PageMsg {
    match w.poll() {
        Ok(Some(msg)) => decode(&msg),
        other => panic!("poll: {other:?}"),
    }
}

#[test]
fn watcher_publishes_writes_and_page_turns() {
    let tmp = TempDir::new();
    let dir = tmp.path();
    let (doc, p1, p2) = ("doc-a", "page-1", "page-2");
    let rm1 = dir.join(doc).join(format!("{p1}.rm"));
    write(&dir.join("doc-old.content"), &content_json("x", &[]), t0() - secs(3600));
    write(&dir.join(format!("{doc}.metadata")), br#"{"visibleName":"Sketches","lastOpenedPage":0}"#, t0());
    write(&dir.join(format!("{doc}.content")), &content_json(p1, &[p1, p2]), t0());
    write(&rm1, &fixture("paperpro_calligraphy.rm"), t0() + secs(5));

    let mut w = Watcher::new(dir);
    let m = must_poll(&mut w);
    assert!(m.t == "page" && m.doc == doc && m.page == p1 && m.title == "Sketches" && m.strokes.len() == 45, "first page: {m:?}");
    assert_eq!((m.rev, m.w, m.h), (unix_millis(t0() + secs(5)), 1620, 2160));
    let s = &m.strokes[0];
    assert!(s.tool == "calligraphy" && s.color == 0 && s.rgba == "#000000ff" && s.size == 2.0 && !s.layer.is_empty() && !s.pts.is_empty(), "stroke {s:?}");
    for st in &m.strokes {
        for p in &st.pts {
            let in_range = p.len() == 4
                && (0.0..=1.0).contains(&p[0])
                && (0.0..=1.0).contains(&p[1])
                && (0.0..=1.0).contains(&p[2])
                && p[3] > 0.0
                && p[3] <= 0.03;
            assert!(in_range, "point {p:?} out of range");
        }
    }

    assert!(matches!(w.poll(), Ok(None)), "nothing changed");

    // xochitl rewrites the page (an erase): a new snapshot, rev = the new mtime
    write(&rm1, &fixture("More_color_highlight_shader_v3.15.4.2.rm"), t0() + secs(20));
    let m = must_poll(&mut w);
    assert_eq!((m.page.as_str(), m.rev, m.strokes.len()), (p1, unix_millis(t0() + secs(20)), 23));
    let tools: Vec<&str> = m.strokes.iter().map(|s| s.tool.as_str()).collect();
    for want in ["highlighter", "shader", "ballpoint"] {
        assert!(tools.contains(&want), "tools {tools:?}");
    }
    for s in m.strokes.iter().filter(|s| s.tool == "shader") {
        assert!(!s.rgba.ends_with("ff"), "shader alpha lost: {}", s.rgba);
    }

    // a half-written file is not published; the next poll retries
    let full = fixture("paperpro_calligraphy.rm");
    write(&rm1, &full[..full.len() / 2], t0() + secs(30));
    assert!(matches!(w.poll(), Err(PollError::Parse(_))), "truncated file published");
    write(&rm1, &full, t0() + secs(31));
    assert_eq!(must_poll(&mut w).strokes.len(), 45, "retry after a partial write did not publish");

    // page turn to a blank page: empty snapshot, rev = when the turn was saved
    write(&dir.join(format!("{doc}.content")), &content_json(p2, &[p1, p2]), t0() + secs(40));
    let m = must_poll(&mut w);
    assert!(m.page == p2 && m.strokes.is_empty() && m.rev == unix_millis(t0() + secs(40)), "turn: {m:?}");

    // back to page 1, whose file is older than the turn: rev is the turn, not the old file
    write(&dir.join(format!("{doc}.content")), &content_json(p1, &[p1, p2]), t0() + secs(50));
    let m = must_poll(&mut w);
    assert_eq!((m.page.as_str(), m.strokes.len(), m.rev), (p1, 45, unix_millis(t0() + secs(50))));

    // another document opened (its .content is now the newest)
    write(&dir.join("doc-b.content"), &content_json("pb", &["pb"]), t0() + secs(60));
    let m = must_poll(&mut w);
    assert!(m.doc == "doc-b" && m.page == "pb" && m.strokes.is_empty(), "doc switch: {m:?}");
}

#[test]
fn locate_fallbacks() {
    let tmp = TempDir::new();
    let dir = tmp.path();
    // legacy content (a plain page list) + metadata index
    write(&dir.join("d1.content"), br#"{"pages":["a","b","c"]}"#, t0());
    write(&dir.join("d1.metadata"), br#"{"visibleName":"Old","lastOpenedPage":2}"#, t0());
    let loc = locate(dir).unwrap();
    assert_eq!((loc.doc.as_str(), loc.page.as_str(), loc.title.as_str()), ("d1", "c", "Old"));

    // nothing usable in .content: the most recently written .rm
    write(&dir.join("d2.content"), b"{}", t0() + secs(60));
    write(&dir.join("d2").join("p-old.rm"), HEADER.as_bytes(), t0());
    write(&dir.join("d2").join("p-new.rm"), HEADER.as_bytes(), t0() + secs(1));
    let loc = locate(dir).unwrap();
    assert_eq!((loc.doc.as_str(), loc.page.as_str()), ("d2", "p-new"));

    let empty = TempDir::new();
    assert!(matches!(locate(empty.path()), Err(PollError::NoDocument)), "empty dir: want an error");
}

#[test]
fn deleted_pages_and_out_of_range_indexes() {
    let tmp = TempDir::new();
    let dir = tmp.path();
    let content = br#"{"cPages":{"pages":[{"id":"gone","deleted":{"value":1}},{"id":"kept"}]}}"#;
    write(&dir.join("d.content"), content, t0());
    write(&dir.join("d.metadata"), br#"{"lastOpenedPage":0,"deleted":false,"parent":null}"#, t0());
    assert_eq!(locate(dir).unwrap().page, "kept", "a deleted page counted in the index");

    write(&dir.join("d.metadata"), br#"{"lastOpenedPage":5}"#, t0());
    write(&dir.join("d").join("only.rm"), HEADER.as_bytes(), t0());
    assert_eq!(locate(dir).unwrap().page, "only", "an out-of-range index did not fall back");
}

#[test]
fn a_guessed_page_is_re_evaluated_and_a_missing_file_is_a_blank_page() {
    let tmp = TempDir::new();
    let dir = tmp.path();
    write(&dir.join("d.content"), b"{}", t0());
    write(&dir.join("d").join("p1.rm"), HEADER.as_bytes(), t0());
    let mut w = Watcher::new(dir);
    assert_eq!(must_poll(&mut w).page, "p1");
    // a newer .rm in the same document: the guess moves without any .content write
    write(&dir.join("d").join("p2.rm"), HEADER.as_bytes(), t0() + secs(10));
    let m = must_poll(&mut w);
    assert_eq!((m.page.as_str(), m.rev), ("p2", unix_millis(t0() + secs(10))));

    // a page with no file yet: an empty snapshot whose rev is the turn
    write(&dir.join("e.content"), &content_json("fresh", &["fresh"]), t0() + secs(20));
    let m = must_poll(&mut w);
    assert!(m.page == "fresh" && m.strokes.is_empty() && m.rev == unix_millis(t0() + secs(20)), "{m:?}");
    assert!(matches!(w.poll(), Ok(None)), "a missing file republished");
}
