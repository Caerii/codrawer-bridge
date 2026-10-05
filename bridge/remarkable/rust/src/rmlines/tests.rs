//! Whole-file tests: the Go package's fixtures (`bridge/remarkable/native/rmlines/testdata`,
//! read in place so both ports test the same bytes), the rmscene cross-check, synthetic files
//! for skipping rules, and a robustness sweep over truncations and bit flips.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use serde::Deserialize;

use super::*;

/// The Go package's fixture directory, shared by both ports.
pub(crate) fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../native/rmlines/testdata")
}

pub(crate) fn fixture(name: &str) -> Vec<u8> {
    let path = fixture_dir().join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn parse_fixture(name: &str) -> Page {
    parse(&fixture(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

// ── the rmscene cross-check ─────────────────────────────────────────────────

/// One file as Python rmscene parsed it (`testdata/rmscene_dump.py` → `rmscene.json`).
#[derive(Deserialize)]
struct Reference {
    #[serde(default)]
    lines: Vec<RefLine>,
    #[serde(default)]
    deleted: Vec<String>,
    #[serde(default)]
    order: Vec<(String, String)>,
    #[serde(default)]
    paper: Option<Vec<u32>>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize)]
struct RefLine {
    id: String,
    tool: u32,
    color: u32,
    rgba: Option<Vec<u8>>,
    thick: f64,
    n: usize,
    p0: Vec<f64>,
    #[serde(rename = "pN")]
    pn: Vec<f64>,
    wsum: f64,
    psum: f64,
}

fn point_fields(p: &Point) -> [f64; 6] {
    [p.x, p.y, p.speed, p.direction, p.width, p.pressure].map(f64::from)
}

fn near(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() <= 1e-3)
}

/// Compares one line with rmscene's; returns what differs.
fn line_differences(l: &Line, w: &RefLine) -> Vec<String> {
    let mut diffs = Vec::new();
    if l.tool != w.tool || l.color != w.color || l.thickness_scale != w.thick || l.points.len() != w.n {
        diffs.push(format!(
            "tool {}/{} color {}/{} thick {}/{} n {}/{}",
            l.tool, w.tool, l.color, w.color, l.thickness_scale, w.thick, l.points.len(), w.n
        ));
    }
    let rgba = l.color_rgba.map(|c| vec![c.r, c.g, c.b, c.a]);
    if rgba != w.rgba {
        diffs.push(format!("rgba {rgba:?}, rmscene {:?}", w.rgba));
    }
    if let (Some(first), Some(last)) = (l.points.first(), l.points.last()) {
        if !near(&point_fields(first), &w.p0) || !near(&point_fields(last), &w.pn) {
            diffs.push(format!("points {first:?}..{last:?}, rmscene {:?}..{:?}", w.p0, w.pn));
        }
    }
    let width_sum: f64 = l.points.iter().map(|p| f64::from(p.width)).sum();
    let pressure_sum: f64 = l.points.iter().map(|p| f64::from(p.pressure)).sum();
    if (width_sum - w.wsum).abs() > 0.5 || (pressure_sum - w.psum).abs() > 0.5 {
        diffs.push(format!("width sum {width_sum}/{} pressure sum {pressure_sum}/{}", w.wsum, w.psum));
    }
    diffs
}

/// Compares a parsed file with rmscene's reading of it; returns what differs.
fn page_differences(page: &Page, want: &Reference) -> Vec<String> {
    let mut diffs = Vec::new();
    if page.skipped != 0 {
        diffs.push(format!("{} blocks skipped", page.skipped));
    }
    let by_id: HashMap<String, &Line> = page.lines().map(|l| (l.id.to_string(), l)).collect();
    if by_id.len() != want.lines.len() {
        diffs.push(format!("lines: got {}, rmscene {}", by_id.len(), want.lines.len()));
    }
    for w in &want.lines {
        match by_id.get(&w.id) {
            None => diffs.push(format!("line {} missing", w.id)),
            Some(l) => diffs.extend(line_differences(l, w).into_iter().map(|d| format!("line {}: {d}", w.id))),
        }
    }

    let mut got_deleted: Vec<String> = page.deleted.iter().map(CrdtId::to_string).collect();
    let mut want_deleted = want.deleted.clone();
    got_deleted.sort();
    want_deleted.sort();
    if got_deleted != want_deleted {
        diffs.push(format!("deleted: got {got_deleted:?}, rmscene {want_deleted:?}"));
    }

    // drawing order and layer, exactly as rmscene's tree walk
    let order: Vec<(String, String)> = page.lines().map(|l| (l.id.to_string(), l.layer.to_string())).collect();
    if order != want.order {
        diffs.push(format!("order: got {order:?}, rmscene {:?}", want.order));
    }

    if let Some([w, h]) = want.paper.as_deref() {
        if (page.paper_w, page.paper_h) != (*w, *h) {
            diffs.push(format!("paper {}x{}, rmscene {w}x{h}", page.paper_w, page.paper_h));
        }
    }
    diffs
}

/// Parses every fixture and compares stroke for stroke with rmscene: ids, layer, tool, colour,
/// explicit RGBA, thickness, point count, first/last point (all six fields), sums of width and
/// pressure, tombstones, drawing order and paper size. (Go: `TestMatchesRmscene`.)
#[test]
fn matches_rmscene() {
    let refs: BTreeMap<String, Reference> =
        serde_json::from_slice(&fixture("rmscene.json")).expect("rmscene.json");
    assert!(refs.len() >= 8, "only {} reference files", refs.len());
    let mut failures = Vec::new();
    for (name, want) in &refs {
        if let Some(e) = &want.error {
            println!("{name}: skipped, rmscene failed: {e}");
            continue;
        }
        for d in page_differences(&parse_fixture(name), want) {
            failures.push(format!("{name}: {d}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// ── individual fixtures ─────────────────────────────────────────────────────

/// The page copied from the Paper Pro (Codex 6.0.105): 45 calligraphy strokes in black at size
/// 2, x centred −586…606, y 143…1673, per-point width 8…42 (docs/investigations/xochitl-pen-data.md).
#[test]
fn paper_pro_calligraphy_page() {
    let page = parse_fixture("paperpro_calligraphy.rm");
    assert_eq!(page.lines().count(), 45);
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    let (mut min_w, mut max_w) = (f32::MAX, f32::MIN);
    for l in page.lines() {
        assert!(
            tool_name(l.tool) == "calligraphy" && l.color == COLOR_BLACK && l.thickness_scale == 2.0,
            "stroke {}: tool {} color {} size {}",
            l.id,
            l.tool,
            l.color,
            l.thickness_scale
        );
        for p in &l.points {
            (min_x, max_x) = (min_x.min(p.x), max_x.max(p.x));
            (min_y, max_y) = (min_y.min(p.y), max_y.max(p.y));
            (min_w, max_w) = (min_w.min(p.width), max_w.max(p.width));
        }
    }
    let in_range = min_x >= -600.0 && max_x <= 620.0 && min_y >= 130.0 && max_y <= 1690.0 && min_w >= 8.0 && max_w <= 42.0;
    assert!(in_range, "x {min_x}..{max_x} y {min_y}..{max_y} width {min_w}..{max_w}");
    assert_eq!((page.paper_w, page.paper_h), (1620, 2160));
}

/// Paper Pro inks: colour ids 9–13, highlighter and shader carrying their colour in color_rgba.
#[test]
fn paper_pro_colours() {
    let page = parse_fixture("More_color_highlight_shader_v3.15.4.2.rm");
    let tools: Vec<&str> = page.lines().map(|l| tool_name(l.tool)).collect();
    for want in ["ballpoint", "highlighter", "shader"] {
        assert!(tools.contains(&want), "no {want} in {tools:?}");
    }
    let shader = page.lines().find(|l| l.tool == TOOL_SHADER).expect("a shader stroke");
    assert_eq!(shader.color, COLOR_HIGHLIGHT);
    assert!(shader.color_rgba.is_some_and(|c| c.a != 255), "shader {shader:?}");
    let highlighter = page.lines().find(|l| l.tool == TOOL_HIGHLIGHTER_2).expect("a highlighter stroke");
    assert!(highlighter.color_rgba.is_some(), "highlighter {highlighter:?}");
    let plain = Line { color: COLOR_BLUE, ..Line::default() };
    assert_eq!(plain.rgba(), palette_rgba(COLOR_BLUE), "palette fallback");
    assert!(!page.deleted.is_empty(), "expected tombstones (erased strokes) in this fixture");
}

#[test]
fn layers_have_labels() {
    let page = parse_fixture("Normal_A_stroke_2_layers_v3.3.2.rm");
    assert!(page.layers.len() >= 2, "layers {}", page.layers.len());
    for l in &page.layers {
        assert!(!l.label.is_empty(), "layer {} has no label", l.id);
    }
}

#[test]
fn bad_input() {
    assert_eq!(parse(b"not a file"), Err(Error::Header));
    let data = fixture("paperpro_calligraphy.rm");
    // a file cut mid-write must be an error, never a page with strokes missing
    for n in [HEADER.len() + 3, data.len() / 2, data.len() - 1] {
        assert_eq!(parse(&data[..n]), Err(Error::Truncated), "cut at {n}");
    }
    let empty = parse(HEADER.as_bytes()).expect("an empty page");
    assert_eq!(empty.lines().count(), 0);
}

// ── synthetic files: what is skipped and what is kept ───────────────────────

/// Builds tagged values and blocks the way xochitl writes them.
#[derive(Default)]
struct Bytes(Vec<u8>);

impl Bytes {
    fn varuint(mut self, mut v: u64) -> Self {
        loop {
            let byte = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                self.0.push(byte);
                return self;
            }
            self.0.push(byte | 0x80);
        }
    }
    fn raw(mut self, b: &[u8]) -> Self {
        self.0.extend_from_slice(b);
        self
    }
    fn tag(self, index: u64, typ: u8) -> Self {
        self.varuint(index << 4 | u64::from(typ))
    }
    fn id(self, index: u64, id: CrdtId) -> Self {
        self.tag(index, 0xF).raw(&[id.author]).varuint(id.counter)
    }
    fn int(self, index: u64, v: u32) -> Self {
        self.tag(index, 0x4).raw(&v.to_le_bytes())
    }
    fn float(self, index: u64, v: f32) -> Self {
        self.tag(index, 0x4).raw(&v.to_le_bytes())
    }
    fn double(self, index: u64, v: f64) -> Self {
        self.tag(index, 0x8).raw(&v.to_le_bytes())
    }
    fn sub(self, index: u64, body: Bytes) -> Self {
        self.tag(index, 0xC).raw(&(body.0.len() as u32).to_le_bytes()).raw(&body.0)
    }
    fn block(self, block_type: u8, version: u8, body: Bytes) -> Self {
        self.raw(&(body.0.len() as u32).to_le_bytes()).raw(&[0, version, version, block_type]).raw(&body.0)
    }
}

fn id(author: u8, counter: u64) -> CrdtId {
    CrdtId { author, counter }
}

const LAYER: CrdtId = CrdtId { author: 0, counter: 11 };

/// A file with one layer (0:11) and the given extra blocks; the last argument is appended to
/// every block body (fields from a newer firmware).
fn page_with(extra: impl FnOnce(Bytes) -> Bytes, trailing: &[u8]) -> Vec<u8> {
    let zero = CrdtId::default();
    let file = Bytes::default()
        .raw(HEADER.as_bytes())
        .block(0x01, 1, Bytes::default().id(1, LAYER).raw(trailing))
        .block(0x04, 1, Bytes::default().id(1, ROOT_ID).id(2, id(0, 12)).id(3, zero).id(4, zero).int(5, 0).sub(6, Bytes::default().raw(&[2]).id(2, LAYER)).raw(trailing));
    extra(file).0
}

fn line_block(file: Bytes, me: CrdtId, left: CrdtId, trailing: &[u8]) -> Bytes {
    let mut point = Vec::new();
    point.extend_from_slice(&10f32.to_le_bytes());
    point.extend_from_slice(&20f32.to_le_bytes());
    point.extend_from_slice(&[4, 0, 16, 0, 128, 200]);
    let value = Bytes::default()
        .raw(&[3])
        .int(1, TOOL_FINELINER_2)
        .int(2, COLOR_RED)
        .double(3, 2.0)
        .float(4, 0.0)
        .sub(5, Bytes::default().raw(&point))
        .id(6, id(0, 0))
        .raw(trailing);
    let body = Bytes::default().id(1, LAYER).id(2, me).id(3, left).id(4, CrdtId::default()).int(5, 0).sub(6, value).raw(trailing);
    file.block(0x05, 2, body)
}

#[test]
fn synthetic_page_reads_back() {
    let data = page_with(|f| line_block(line_block(f, id(1, 20), CrdtId::default(), &[]), id(1, 21), id(1, 20), &[]), &[]);
    let page = parse(&data).unwrap();
    assert_eq!(page.skipped, 0);
    assert_eq!(page.layers.len(), 1);
    let ids: Vec<String> = page.lines().map(|l| l.id.to_string()).collect();
    assert_eq!(ids, ["1:20", "1:21"]);
    let l = page.lines().next().unwrap();
    assert_eq!((l.tool, l.color, l.thickness_scale, l.layer), (TOOL_FINELINER_2, COLOR_RED, 2.0, LAYER));
    assert_eq!(l.points, [Point { x: 10.0, y: 20.0, speed: 4.0, width: 16.0, direction: 128.0, pressure: 200.0 }]);
}

#[test]
fn newer_trailing_fields_are_skipped_not_fatal() {
    let newer = [0x9F, 0x01, 0xEE, 0xEE]; // an unknown tag and bytes
    let data = page_with(|f| line_block(f, id(1, 20), CrdtId::default(), &newer), &newer);
    let page = parse(&data).unwrap();
    assert_eq!(page.skipped, 0);
    assert_eq!(page.lines().count(), 1);
}

#[test]
fn unknown_and_malformed_blocks_are_skipped_by_length() {
    let data = page_with(
        |f| {
            let f = f.block(0x7E, 1, Bytes::default().raw(&[1, 2, 3, 4, 5]));
            let f = f.block(0x05, 2, Bytes::default().raw(&[0xFF, 0xFF])); // a line block that is not one
            line_block(f, id(1, 20), CrdtId::default(), &[])
        },
        &[],
    );
    let page = parse(&data).unwrap();
    assert_eq!(page.skipped, 2);
    assert_eq!(page.lines().count(), 1);
}

#[test]
fn erased_strokes_are_reported_not_drawn() {
    let zero = CrdtId::default();
    let data = page_with(
        |f| {
            let f = line_block(f, id(1, 20), zero, &[]);
            // 1:21 stored without a value (deleted length 1), 1:22 a tombstone block
            let f = f.block(0x05, 2, Bytes::default().id(1, LAYER).id(2, id(1, 21)).id(3, id(1, 20)).id(4, zero).int(5, 1));
            f.block(0x08, 1, Bytes::default().id(1, LAYER).id(2, id(1, 22)).id(3, id(1, 21)).id(4, zero).int(5, 1))
        },
        &[],
    );
    let page = parse(&data).unwrap();
    assert_eq!(page.lines().count(), 1);
    assert_eq!(page.deleted, [id(1, 21), id(1, 22)]);
}

// ── robustness ──────────────────────────────────────────────────────────────

/// xorshift64*: deterministic, so a failure reproduces.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// Random truncations and bit flips of real files never panic; a cut file parses only when the
/// cut falls on a block boundary, and then never with more ink. (Go: `FuzzParse`.)
#[test]
fn truncations_and_bit_flips_never_panic() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for name in ["paperpro_calligraphy.rm", "More_color_highlight_shader_v3.15.4.2.rm", "erasers.rm", "writing_tools.rm"] {
        let data = fixture(name);
        let lines = parse(&data).unwrap().lines().count();
        for _ in 0..300 {
            let cut = HEADER.len() + rng.below(data.len() - HEADER.len());
            if let Ok(page) = parse(&data[..cut]) {
                // only a cut on a block boundary parses, and it never invents ink
                assert!(page.lines().count() <= lines, "{name} cut at {cut}");
            }
        }
        for _ in 0..300 {
            let mut bad = data.clone();
            for _ in 0..1 + rng.below(8) {
                let at = rng.below(bad.len());
                bad[at] ^= 1 << rng.below(8);
            }
            let _ = parse(&bad);
        }
        for _ in 0..50 {
            let junk: Vec<u8> = (0..rng.below(512)).map(|_| rng.next() as u8).collect();
            let mut bad = HEADER.as_bytes().to_vec();
            bad.extend(junk);
            let _ = parse(&bad);
        }
    }
}
