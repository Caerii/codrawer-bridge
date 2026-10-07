//! Agents' dock entries into `/run/codrawer/dock.json` for the tablet's dock (Go: dockfile/ and
//! dock_link.go; the same file, rules and limits).
//!
//! # The problem
//!
//! The dock that codrawer-layer injects into xochitl's toolbar lists its rows from
//! `/run/codrawer/dock.json`, re-read whenever the file changes. Agents announce the rows they
//! answer with `dock_entries` (docs/protocol.md):
//! `{"t":"dock_entries","owner":"agentd","entries":[{"id","label","badge"?,"hint"?,"kind"?},…]}`,
//! on joining and in answer to `dock_query`; a tap reaches them as `dock_action` with the row's id.
//! This module keeps each owner's latest list and writes them all into the file.
//!
//! # The file
//!
//! `{"entries":[…], "owners":{"agentd":[…], …}}`. `entries`, when present, is the user's own list
//! (it replaces the dock's built-in rows) and is kept as it is; only `owners` is written here. The
//! extension shows the base rows, then each owner's in name order.
//!
//! # Rules
//!
//! - An owner's list replaces its previous one whole; an empty list removes the owner.
//! - The router withdraws an agent's entries when that agent leaves (router/mod.rs); the bridge
//!   forgets every owner when its own connection drops ([`DockFile::reset`]) and asks again with
//!   `dock_query` on the next one ([`DOCK_QUERY`]), so the dock only offers what a connected
//!   agent answers.
//! - Bounded and cleaned: at most 16 owners of up to 32 characters, 12 entries each; ids up to
//!   48 characters, labels 80, hints 160, kind 24; badge a string (up to 24) or a bool. Other
//!   fields are dropped; a malformed message changes nothing.
//! - Writes are atomic (a temporary file renamed over the old one).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Map, Value};

pub const DEFAULT_PATH: &str = "/run/codrawer/dock.json";
/// Sent first on every connection: the agents announce their entries again.
pub const DOCK_QUERY: &str = r#"{"t":"dock_query"}"#;

pub const MAX_OWNERS: usize = 16;
pub const MAX_ENTRIES: usize = 12;
const MAX_OWNER: usize = 32;
const MAX_ID: usize = 48;
const MAX_LABEL: usize = 80;
const MAX_HINT: usize = 160;
const MAX_BADGE: usize = 24;
const MAX_KIND: usize = 24;

/// The dock file and the owners' lists behind it.
pub struct DockFile {
    path: PathBuf,
    owners: Mutex<BTreeMap<String, Vec<Value>>>,
}

impl DockFile {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        DockFile { path: path.into(), owners: Mutex::new(BTreeMap::new()) }
    }

    /// The file for this tablet: `DOCK_JSON` or the default, `None` when it is "off" or its
    /// directory is missing (not a tablet).
    pub fn from_env() -> Option<Self> {
        let p = std::env::var("DOCK_JSON").unwrap_or_default();
        let p = if p.trim().is_empty() { DEFAULT_PATH.to_string() } else { p.trim().to_string() };
        if p.eq_ignore_ascii_case("off") {
            return None;
        }
        let dir = Path::new(&p).parent().map(Path::to_path_buf).unwrap_or_default();
        if !dir.is_dir() {
            println!("[dock] {}: no such directory; agents' dock entries off", dir.display());
            return None;
        }
        println!("[dock] agents' dock entries into {p}");
        Some(DockFile::new(p))
    }

    /// Applies a router message: a valid `dock_entries` replaces (or, empty, removes) its owner's
    /// list and rewrites the file. `Ok(true)` when the file changed; `Err` for a refused or
    /// unwritable one; other messages are `Ok(false)`.
    pub fn handle(&self, raw: &str) -> Result<bool, String> {
        if !raw.contains("\"dock_entries\"") {
            return Ok(false);
        }
        let Ok(Value::Object(m)) = serde_json::from_str::<Value>(raw) else { return Ok(false) };
        if m.get("t").and_then(Value::as_str) != Some("dock_entries") {
            return Ok(false);
        }
        let owner = m.get("owner").and_then(Value::as_str).map(|s| clean(s, MAX_OWNER)).unwrap_or_default();
        if owner.is_empty() {
            return Err(format!("dock_entries: bad owner {:?}", m.get("owner")));
        }
        let Some(list) = m.get("entries").and_then(Value::as_array) else {
            return Err(format!("dock_entries: {owner}: entries is not a list"));
        };
        let entries: Vec<Value> = list.iter().filter_map(clean_entry).take(MAX_ENTRIES).collect();
        let mut owners = self.owners.lock().unwrap();
        if entries.is_empty() {
            if owners.remove(&owner).is_none() {
                return Ok(false);
            }
        } else {
            if !owners.contains_key(&owner) && owners.len() >= MAX_OWNERS {
                return Err(format!("dock_entries: more than {MAX_OWNERS} owners; {owner:?} refused"));
            }
            owners.insert(owner, entries);
        }
        self.write(&owners).map(|_| true)
    }

    /// Forgets every owner (the router connection dropped), rewriting the file if any were there.
    pub fn reset(&self) -> Result<(), String> {
        let mut owners = self.owners.lock().unwrap();
        if owners.is_empty() {
            return Ok(());
        }
        owners.clear();
        self.write(&owners)
    }

    /// The owners' names in order.
    pub fn owners(&self) -> Vec<String> {
        self.owners.lock().unwrap().keys().cloned().collect()
    }

    fn write(&self, owners: &BTreeMap<String, Vec<Value>>) -> Result<(), String> {
        let old = std::fs::read(&self.path).unwrap_or_default();
        let data = merge(&old, owners);
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

/// The dock file for `existing` (the current bytes, possibly empty or not JSON) with `owners`
/// replaced: every other top-level key is kept. Pure.
pub fn merge(existing: &[u8], owners: &BTreeMap<String, Vec<Value>>) -> Vec<u8> {
    let mut top = match serde_json::from_slice::<Value>(existing) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    };
    if owners.is_empty() {
        top.remove("owners");
    } else {
        let o: Map<String, Value> = owners.iter().map(|(k, v)| (k.clone(), Value::Array(v.clone()))).collect();
        top.insert("owners".into(), Value::Object(o));
    }
    let mut out = serde_json::to_vec(&Value::Object(top)).unwrap_or_else(|_| b"{}".to_vec());
    out.push(b'\n');
    out
}

/// One entry with its known fields within bounds, or `None` without a usable id and label.
fn clean_entry(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let field = |k: &str, max: usize| o.get(k).and_then(Value::as_str).map(|s| clean(s, max)).unwrap_or_default();
    let (id, label) = (field("id", MAX_ID), field("label", MAX_LABEL));
    if id.is_empty() || label.is_empty() {
        return None;
    }
    let mut e = Map::new();
    e.insert("id".into(), Value::String(id));
    e.insert("label".into(), Value::String(label));
    match o.get("badge") {
        Some(Value::Bool(b)) => {
            e.insert("badge".into(), Value::Bool(*b));
        }
        Some(Value::String(s)) if !clean(s, MAX_BADGE).is_empty() => {
            e.insert("badge".into(), Value::String(clean(s, MAX_BADGE)));
        }
        _ => {}
    }
    for (k, max) in [("hint", MAX_HINT), ("kind", MAX_KIND)] {
        let s = field(k, max);
        if !s.is_empty() {
            e.insert(k.into(), Value::String(s));
        }
    }
    Some(Value::Object(e))
}

/// Trimmed, without control characters, at most `max` characters.
fn clean(s: &str, max: usize) -> String {
    s.trim().chars().filter(|c| !c.is_control()).take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("codrawer-dock-{}-{name}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d.join("dock.json")
    }

    fn read(p: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
    }

    /// Go: TestOwnersLifecycleKeepsUserEntries.
    #[test]
    fn owners_lifecycle_keeps_user_entries() {
        let p = tmp("life");
        std::fs::write(&p, r#"{"entries":[{"id":"typer_fast","label":"Reply typing: fast"}]}"#).unwrap();
        let f = DockFile::new(&p);
        let r = f.handle(r#"{"t":"dock_entries","owner":"agentd","entries":[
            {"id":"agentd_memory","label":"Memory: page thread","badge":"on","extra":1},
            {"id":"agentd_forget","label":"Forget this page's thread"}]}"#);
        assert_eq!(r, Ok(true));
        let m = read(&p);
        assert!(m.get("entries").is_some(), "the user's entries were dropped");
        let ag = m["owners"]["agentd"].as_array().unwrap();
        assert_eq!(ag.len(), 2);
        assert_eq!(ag[0]["badge"], "on");
        assert!(ag[0].get("extra").is_none());
        f.handle(r#"{"t":"dock_entries","owner":"agentd","entries":[{"id":"agentd_memory","label":"Memory: off","badge":false}]}"#).unwrap();
        let ag = read(&p)["owners"]["agentd"].clone();
        assert_eq!(ag.as_array().unwrap().len(), 1);
        assert_eq!(ag[0]["label"], "Memory: off");
        assert_eq!(ag[0]["badge"], false);
        assert_eq!(f.handle(r#"{"t":"dock_entries","owner":"agentd","entries":[]}"#), Ok(true));
        let m = read(&p);
        assert!(m.get("owners").is_none() && m.get("entries").is_some(), "{m}");
    }

    /// Go: TestResetForgetsEveryOwner.
    #[test]
    fn reset_forgets_every_owner() {
        let p = tmp("reset");
        let f = DockFile::new(&p);
        f.handle(r#"{"t":"dock_entries","owner":"agentd","entries":[{"id":"a","label":"A"}]}"#).unwrap();
        f.handle(r#"{"t":"dock_entries","owner":"primer","entries":[{"id":"b","label":"B"}]}"#).unwrap();
        assert_eq!(f.owners(), vec!["agentd", "primer"]);
        f.reset().unwrap();
        assert!(read(&p).get("owners").is_none() && f.owners().is_empty());
    }

    /// Go: TestRefusesAndBounds.
    #[test]
    fn refuses_and_bounds() {
        let p = tmp("bounds");
        let _ = std::fs::remove_file(&p);
        let f = DockFile::new(&p);
        for bad in [
            r#"{"t":"dock_entries","owner":"","entries":[{"id":"a","label":"A"}]}"#,
            r#"{"t":"dock_entries","owner":"x","entries":[{"id":"","label":"A"},{"label":"no id"},{"id":"no label"}]}"#,
            r#"{"t":"dock_entries","owner":"x","entries":"nope"}"#,
            r#"not json "dock_entries""#,
        ] {
            assert_ne!(f.handle(bad), Ok(true), "accepted {bad}");
        }
        assert!(!p.exists(), "nothing valid came, nothing should be written");
        assert_eq!(f.handle(r#"{"t":"dock_action","id":"a"}"#), Ok(false));
        let entries: Vec<String> = (0..20)
            .map(|i| format!(r#"{{"id":"e{i}","label":"{}\u0007","badge":{{"x":1}}}}"#, "L".repeat(200)))
            .collect();
        f.handle(&format!(r#"{{"t":"dock_entries","owner":"agentd","entries":[{}]}}"#, entries.join(","))).unwrap();
        let ag = read(&p)["owners"]["agentd"].as_array().unwrap().clone();
        assert_eq!(ag.len(), MAX_ENTRIES);
        let l = ag[0]["label"].as_str().unwrap();
        assert!(l.chars().count() == MAX_LABEL && !l.contains('\u{7}'));
        assert!(ag[0].get("badge").is_none());
        for i in 0..MAX_OWNERS + 2 {
            let _ = f.handle(&format!(r#"{{"t":"dock_entries","owner":"o{i}","entries":[{{"id":"a","label":"A"}}]}}"#));
        }
        assert_eq!(f.owners().len(), MAX_OWNERS);
    }

    /// Go: TestMergeKeepsOtherKeysAndSurvivesGarbage.
    #[test]
    fn merge_keeps_other_keys_and_survives_garbage() {
        let mut owners = BTreeMap::new();
        owners.insert("z".to_string(), vec![serde_json::json!({"id":"a","label":"A"})]);
        owners.insert("b".to_string(), vec![serde_json::json!({"id":"c","label":"C","badge":true})]);
        let s = String::from_utf8(merge(br#"{"entries":[1],"note":"x"}"#, &owners)).unwrap();
        assert!(s.contains(r#""note":"x""#) && s.contains(r#""entries":[1]"#) && s.find(r#""b""#) < s.find(r#""z""#), "{s}");
        assert_eq!(merge(b"garbage", &BTreeMap::new()), b"{}\n");
    }
}
