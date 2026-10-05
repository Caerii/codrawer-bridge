//! Which document and page are open in xochitl, found from its data directory alone.
//!
//! - The open document is the one whose `<doc>.content` was written last: xochitl rewrites it
//!   on every page turn (within 1–2 s).
//! - The open page is `cPages.lastOpened.value` in that file; else `.metadata`'s
//!   `lastOpenedPage` as an index into the page list; else the most recently written `.rm` in
//!   the document's folder (a guess, re-evaluated on every poll).

use std::fs;
use std::io;
use std::path::Path;
use std::time::SystemTime;

use serde::Deserialize;

use super::PollError;

/// The open document and page.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Location {
    /// The document's uuid.
    pub doc: String,
    /// The page's uuid ("" when unknown).
    pub page: String,
    /// The document's `visibleName` from `.metadata`, when readable.
    pub title: String,
    /// When `<doc>.content` was written (the page turn was saved).
    pub content_mtime: Option<SystemTime>,
}

/// Finds the open document and its open page.
pub fn locate(dir: &Path) -> Result<Location, PollError> {
    let mut loc = newest_content(dir)?;
    let open = open_page(dir, &loc.doc);
    (loc.page, loc.title) = (open.page, open.title);
    Ok(loc)
}

/// The document whose `.content` was written last (page and title not filled in).
pub(super) fn newest_content(dir: &Path) -> Result<Location, PollError> {
    let entries = fs::read_dir(dir).map_err(|e| PollError::io("open", dir, e))?;
    let mut best = Location::default();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(doc) = name.strip_suffix(".content") else { continue };
        let Some(mtime) = file_mtime(&entry) else { continue };
        let newer = match best.content_mtime {
            None => true,
            Some(t) => mtime > t,
        };
        if newer {
            best = Location { doc: doc.to_string(), content_mtime: Some(mtime), ..Location::default() };
        }
    }
    if best.doc.is_empty() {
        return Err(PollError::NoDocument);
    }
    Ok(best)
}

/// A regular file's modification time (`None` for directories and unreadable entries).
fn file_mtime(entry: &fs::DirEntry) -> Option<SystemTime> {
    let meta = entry.metadata().ok()?;
    if meta.is_dir() {
        return None;
    }
    meta.modified().ok()
}

/// The part of `<doc>.content` this module reads. Current firmware writes
/// `cPages.lastOpened.value` (the open page) and `cPages.pages[].id`; older files have a plain
/// `pages` list. Every field is optional, as a missing or `null` field is to Go's decoder.
#[derive(Deserialize, Default)]
struct Content {
    #[serde(default, rename = "cPages")]
    c_pages: Option<CPages>,
    #[serde(default)]
    pages: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
struct CPages {
    #[serde(default, rename = "lastOpened")]
    last_opened: Option<LastOpened>,
    #[serde(default)]
    pages: Option<Vec<CPage>>,
}

#[derive(Deserialize, Default)]
struct LastOpened {
    #[serde(default)]
    value: Option<String>,
}

#[derive(Deserialize, Default)]
struct CPage {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    deleted: Option<Deleted>,
}

#[derive(Deserialize, Default)]
struct Deleted {
    #[serde(default)]
    value: Option<i64>,
}

/// The part of `<doc>.metadata` this module reads. `deleted` and `parent` are not used, but a
/// file where they have the wrong type is rejected as a whole, as by Go's decoder.
#[derive(Deserialize, Default)]
#[allow(dead_code)]
struct Metadata {
    #[serde(default, rename = "visibleName")]
    visible_name: Option<String>,
    #[serde(default, rename = "lastOpenedPage")]
    last_opened_page: Option<i64>,
    #[serde(default)]
    deleted: Option<bool>,
    #[serde(default)]
    parent: Option<String>,
}

/// Reads and decodes a JSON file; `None` when it is missing or not the expected shape.
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// What [`open_page`] found.
pub(super) struct OpenPage {
    pub(super) page: String,
    pub(super) title: String,
    /// The page is the newest-`.rm` guess.
    pub(super) guessed: bool,
}

/// The open page and title of `doc`.
pub(super) fn open_page(dir: &Path, doc: &str) -> OpenPage {
    let content: Content = read_json(&dir.join(format!("{doc}.content"))).unwrap_or_default();
    let mut page = content.last_opened_page().unwrap_or_default();
    let pages = content.page_list();

    let metadata: Metadata = read_json(&dir.join(format!("{doc}.metadata"))).unwrap_or_default();
    let title = metadata.visible_name.unwrap_or_default();
    if page.is_empty() {
        if let Some(by_index) = page_at(&pages, metadata.last_opened_page) {
            page = by_index.to_string();
        }
    }

    let mut guessed = false;
    if page.is_empty() {
        page = newest_rm(&dir.join(doc)).unwrap_or_default();
        guessed = true;
    }
    OpenPage { page, title, guessed }
}

/// The page at `.metadata`'s `lastOpenedPage` index, if that index is in range.
fn page_at(pages: &[String], index: Option<i64>) -> Option<&str> {
    let index = usize::try_from(index?).ok()?;
    pages.get(index).map(String::as_str)
}

impl Content {
    fn last_opened_page(&self) -> Option<String> {
        self.c_pages.as_ref()?.last_opened.as_ref()?.value.clone()
    }

    /// The pages that are not deleted, in order; the legacy list when there are none.
    fn page_list(&self) -> Vec<String> {
        let mut out = Vec::new();
        let c_pages = self.c_pages.as_ref().and_then(|c| c.pages.as_ref());
        for p in c_pages.into_iter().flatten() {
            let deleted = p.deleted.as_ref().and_then(|d| d.value).unwrap_or(0) != 0;
            if !deleted {
                out.push(p.id.clone().unwrap_or_default());
            }
        }
        if out.is_empty() {
            out = self.pages.clone().unwrap_or_default();
        }
        out
    }
}

/// The page (file stem) of the most recently written `.rm` in a document's folder.
fn newest_rm(folder: &Path) -> Option<String> {
    let mut best: Option<(SystemTime, String)> = None;
    for entry in fs::read_dir(folder).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(page) = name.strip_suffix(".rm") else { continue };
        let Some(mtime) = file_mtime(&entry) else { continue };
        let newer = match &best {
            None => true,
            Some((t, _)) => mtime > *t,
        };
        if newer {
            best = Some((mtime, page.to_string()));
        }
    }
    best.map(|(_, page)| page)
}

/// Like `os.Stat` for the page file: `Ok(None)` when it does not exist.
pub(super) fn stat_file(path: &Path) -> Result<Option<(SystemTime, u64)>, PollError> {
    match fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta.modified().map_err(|e| PollError::io("stat", path, e))?;
            Ok(Some((mtime, meta.len())))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(PollError::io("stat", path, e)),
    }
}
