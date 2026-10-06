//! The `page` message (docs/protocol.md) for a parsed page, encoded by hand so the bytes match
//! the Go bridge: same key order, same rounding, same shortest number form, same string escapes.
//!
//! Coordinates are normalised to the paper: `x = (x_rm + W/2) / W` (xochitl's x is centred),
//! `y = y_rm / H`; points on a scrolled page can fall outside 0..1 and are kept. Each point is
//! `[x, y, pressure 0..1, width as a fraction of the page width]` (the file stores the width in
//! quarter pixels). Strokes on hidden layers are left out, and erased strokes are not in the
//! page at all: the snapshot is the page.
//!
//! Precision (decimals): `x`, `y` 5 (1/100000 of 1620 page units is far below a pixel),
//! pressure 3, width 6, size 3, the same as Go, so the two bridges send identical bytes.

use std::fmt::Write;

use super::Location;
use crate::rmlines::{tool_name, CrdtId, Line, Page};
use crate::util::push_rounded;

/// The page size in page units when the file has no SceneInfo (Paper Pro portrait).
pub const DEFAULT_W: u32 = 1620;
pub const DEFAULT_H: u32 = 2160;

/// Builds the `page` message for a parsed page (`None`: a page with no ink saved yet).
pub fn message(loc: &Location, rev: i64, page: Option<&Page>) -> String {
    let (w, h) = paper_size(page);
    let mut out = String::with_capacity(4096);
    out.push_str(r#"{"t":"page","doc":"#);
    push_json_string(&mut out, &loc.doc);
    out.push_str(r#","page":"#);
    push_json_string(&mut out, &loc.page);
    if !loc.title.is_empty() {
        out.push_str(r#","title":"#);
        push_json_string(&mut out, &loc.title);
    }
    let _ = write!(out, r#","rev":{rev},"w":{w},"h":{h},"strokes":["#);
    let mut first = true;
    for (line, agent) in page.map(visible_lines).into_iter().flatten() {
        if !first {
            out.push(',');
        }
        first = false;
        push_stroke(&mut out, line, f64::from(w), f64::from(h), agent);
    }
    out.push_str("]}");
    out
}

/// The file's paper size, or the Paper Pro's when the file does not say.
fn paper_size(page: Option<&Page>) -> (u32, u32) {
    match page {
        Some(p) if p.paper_w > 0 && p.paper_h > 0 => (p.paper_w, p.paper_h),
        _ => (DEFAULT_W, DEFAULT_H),
    }
}

/// The layer the codrawer-layer extension commits agent ink to (NATIVE_AGENT_INK). Its strokes
/// are agent ink that viewers already drew live from the router's `layer:"ai"` stream, so the
/// snapshot labels them `"layer":"ai"` instead of the layer id, as the Go bridge does.
pub const AGENT_LAYER: &str = "codrawer: agent";

/// Strokes with points on visible layers, in drawing order, each with whether it is on the
/// agent layer.
fn visible_lines(page: &Page) -> impl Iterator<Item = (&Line, bool)> {
    page.layers
        .iter()
        .filter(|layer| layer.visible)
        .flat_map(|layer| layer.lines.iter().map(move |line| (line, layer.label == AGENT_LAYER)))
        .filter(|(line, _)| !line.points.is_empty())
}

/// One stroke: `{"id","tool","color","rgba","size","layer","pts"}` (`"layer":"ai"` on the agent
/// layer).
fn push_stroke(out: &mut String, line: &Line, w: f64, h: f64, agent: bool) {
    let c = line.rgba();
    let _ = write!(
        out,
        r##"{{"id":"{}","tool":"{}","color":{},"rgba":"#{:02x}{:02x}{:02x}{:02x}","size":"##,
        line.id,
        tool_name(line.tool),
        line.color,
        c.r,
        c.g,
        c.b,
        c.a
    );
    push_rounded(out, line.thickness_scale, 3);
    if agent {
        out.push_str(r#","layer":"ai""#);
    } else if line.layer != CrdtId::default() {
        let _ = write!(out, r#","layer":"{}""#, line.layer);
    }
    out.push_str(r#","pts":["#);
    for (i, p) in line.points.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('[');
        push_rounded(out, (f64::from(p.x) + w / 2.0) / w, 5);
        out.push(',');
        push_rounded(out, f64::from(p.y) / h, 5);
        out.push(',');
        push_rounded(out, f64::from(p.pressure) / 255.0, 3);
        out.push(',');
        push_rounded(out, f64::from(p.width) / 4.0 / w, 6);
        out.push(']');
    }
    out.push_str("]}");
}

/// A JSON string escaped like Go's `json.Marshal`: also `<`, `>`, `&`, U+2028 and U+2029 as
/// `\u` escapes, so titles come out byte-identical to the Go bridge.
fn push_json_string(out: &mut String, s: &str) {
    let quoted = serde_json::to_string(s).expect("serialize str");
    for ch in quoted.chars() {
        match ch {
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            _ => out.push(ch),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rmlines::{Layer, Point, Rgba, COLOR_HIGHLIGHT, TOOL_HIGHLIGHTER_2};

    fn id(author: u8, counter: u64) -> CrdtId {
        CrdtId { author, counter }
    }

    fn sample_page() -> Page {
        let highlighter = Line {
            id: id(1, 5),
            layer: id(0, 11),
            tool: TOOL_HIGHLIGHTER_2,
            color: COLOR_HIGHLIGHT,
            thickness_scale: 1.0,
            color_rgba: Some(Rgba { r: 255, g: 237, b: 117, a: 255 }),
            points: vec![
                Point { x: -810.0, y: 0.0, pressure: 255.0, width: 120.0, ..Point::default() },
                Point { x: 0.0, y: 1080.0, pressure: 0.0, width: 16.0, ..Point::default() },
                Point { x: 810.0, y: 2700.0, ..Point::default() },
            ],
            ..Line::default()
        };
        let hidden = Line { tool: 17, points: vec![Point::default()], ..Line::default() };
        Page {
            paper_w: 1620,
            paper_h: 2160,
            layers: vec![
                Layer { id: id(0, 11), visible: true, lines: vec![highlighter], ..Layer::default() },
                Layer { id: id(0, 12), visible: false, lines: vec![hidden], ..Layer::default() },
            ],
            ..Page::default()
        }
    }

    /// Go: `TestMessageNormalises`, plus the exact bytes the Go encoder produces.
    #[test]
    fn normalises_and_matches_go_bytes() {
        let loc = Location { doc: "d".into(), page: "p".into(), ..Location::default() };
        let got = message(&loc, 42, Some(&sample_page()));
        let want = concat!(
            r##"{"t":"page","doc":"d","page":"p","rev":42,"w":1620,"h":2160,"strokes":["##,
            r##"{"id":"1:5","tool":"highlighter","color":9,"rgba":"#ffed75ff","size":1,"layer":"0:11","##,
            r##""pts":[[0,0,1,0.018519],[0.5,0.5,0,0.002469],[1,1.25,0,0]]}]}"##,
        );
        assert_eq!(got, want, "the hidden layer leaked or the encoding differs from Go");
    }

    /// Go: `TestMessageLabelsTheAgentLayerAi`, byte for byte.
    #[test]
    fn labels_the_agent_layer_ai() {
        let ink = |line_id: CrdtId, layer: CrdtId| Line {
            id: line_id,
            layer,
            tool: 17,
            thickness_scale: 2.0,
            points: vec![Point { x: 0.0, y: 1080.0, pressure: 255.0, width: 16.0, ..Point::default() }],
            ..Line::default()
        };
        let page = Page {
            paper_w: 1620,
            paper_h: 2160,
            layers: vec![
                Layer { id: id(0, 11), visible: true, lines: vec![ink(id(1, 5), id(0, 11))], ..Layer::default() },
                Layer {
                    id: id(1, 304),
                    label: AGENT_LAYER.into(),
                    visible: true,
                    lines: vec![ink(id(1, 305), id(1, 304))],
                },
            ],
            ..Page::default()
        };
        let loc = Location { doc: "d".into(), page: "p".into(), ..Location::default() };
        let want = concat!(
            r##"{"t":"page","doc":"d","page":"p","rev":9,"w":1620,"h":2160,"strokes":["##,
            r##"{"id":"1:5","tool":"fineliner","color":0,"rgba":"#000000ff","size":2,"layer":"0:11","pts":[[0.5,0.5,1,0.002469]]},"##,
            r##"{"id":"1:305","tool":"fineliner","color":0,"rgba":"#000000ff","size":2,"layer":"ai","pts":[[0.5,0.5,1,0.002469]]}]}"##,
        );
        assert_eq!(message(&loc, 9, Some(&page)), want);
    }

    #[test]
    fn blank_page_and_title() {
        let loc = Location { doc: "d".into(), page: "p".into(), title: "A <b> & c".into(), ..Location::default() };
        let got = message(&loc, 7, None);
        let title = "A \\u003cb\\u003e \\u0026 c"; // Go's json.Marshal escapes <, > and &
        let want = format!(r#"{{"t":"page","doc":"d","page":"p","title":"{title}","rev":7,"w":1620,"h":2160,"strokes":[]}}"#);
        assert_eq!(got, want);
        let v: serde_json::Value = serde_json::from_str(&got).unwrap();
        assert_eq!(v["title"], "A <b> & c");
    }

    #[test]
    fn strokes_without_points_or_layer() {
        let mut page = sample_page();
        page.layers[0].lines[0].layer = CrdtId::default();
        page.layers[0].lines.push(Line { id: id(1, 6), ..Line::default() }); // no points: left out
        let got = message(&Location::default(), 0, Some(&page));
        assert!(!got.contains("\"layer\""), "{got}");
        assert!(!got.contains("1:6"), "{got}");
    }
}
