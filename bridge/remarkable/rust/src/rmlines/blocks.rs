//! Block bodies: what each kind of block in a v6 file contributes to the page.
//!
//! - CRDT sequence items ([`read_item`]): lines, groups (layers), glyphs, text and tombstones.
//!   Every item takes part in ordering its siblings, even kinds whose value is not kept.
//! - Scene tree blocks: they declare a group node ([`read_scene_tree`]) or give its label and
//!   visibility ([`read_tree_node`]).
//! - Scene info ([`read_scene_info`]): the paper size, when present.
//!
//! Each reader works inside the block's limit, so a field it does not know is skipped by the
//! enclosing subblock or block length.

use std::collections::HashMap;

use super::reader::{ReadError, ReadResult, Reader, TAG_BYTE1, TAG_BYTE4, TAG_BYTE8, TAG_ID, TAG_LENGTH4};
use super::{CrdtId, Line, Point, Rgba};

// Block types (rmscene scene_stream.py).
pub(super) const BLOCK_MIGRATION_INFO: u8 = 0x00;
pub(super) const BLOCK_SCENE_TREE: u8 = 0x01;
pub(super) const BLOCK_TREE_NODE: u8 = 0x02;
pub(super) const BLOCK_GLYPH_ITEM: u8 = 0x03;
pub(super) const BLOCK_GROUP_ITEM: u8 = 0x04;
pub(super) const BLOCK_LINE_ITEM: u8 = 0x05;
pub(super) const BLOCK_TEXT_ITEM: u8 = 0x06;
pub(super) const BLOCK_ROOT_TEXT: u8 = 0x07;
pub(super) const BLOCK_TOMBSTONE_ITEM: u8 = 0x08;
pub(super) const BLOCK_AUTHOR_IDS: u8 = 0x09;
pub(super) const BLOCK_PAGE_INFO: u8 = 0x0A;
pub(super) const BLOCK_SCENE_INFO: u8 = 0x0D;

/// Bytes per stored point: version 1 is six f32s, version 2 two f32s, two u16s and two u8s.
const POINT_SIZE_V1: usize = 0x18;
const POINT_SIZE_V2: usize = 0x0E;

/// An item of a CRDT sequence (any item kind) with its value, if it is one we keep.
pub(super) struct Item {
    pub(super) id: CrdtId,
    pub(super) left: CrdtId,
    pub(super) right: CrdtId,
    /// The group whose sequence this item is in.
    pub(super) parent: CrdtId,
    pub(super) block_type: u8,
    /// Erased or undone: a tombstone block, or an item stored without a value.
    pub(super) deleted: bool,
    /// A live line.
    pub(super) line: Option<Line>,
    /// A live group item: the scene tree node it points at.
    pub(super) group: Option<CrdtId>,
}

/// A group node of the scene tree: the label and visibility of a layer.
pub(super) struct Node {
    pub(super) label: String,
    pub(super) visible: bool,
}

impl Default for Node {
    fn default() -> Self {
        Node { label: String::new(), visible: true }
    }
}

/// Nodes by id, as declared and described by the scene tree blocks.
pub(super) type Nodes = HashMap<CrdtId, Node>;

/// Reads a sequence item block: the CRDT header (parent, id, left, right, deleted length), then
/// the value subblock when the item has one.
pub(super) fn read_item(r: &mut Reader<'_>, block_type: u8, version: u8) -> ReadResult<Item> {
    let parent = r.id(1)?;
    let id = r.id(2)?;
    let left = r.id(3)?;
    let right = r.id(4)?;
    let deleted_length = r.t_int(5)?;
    let mut item = Item { id, left, right, parent, block_type, deleted: false, line: None, group: None };

    let is_tombstone = block_type == BLOCK_TOMBSTONE_ITEM;
    if is_tombstone || !r.has_sub(6) {
        item.deleted = deleted_length > 0 || is_tombstone;
        return Ok(item);
    }
    r.sub(6, |r| read_item_value(r, &mut item, version))?;
    Ok(item)
}

/// The value subblock: a type byte, then the line or group. Glyph and text values are not
/// needed and are skipped with the subblock.
fn read_item_value(r: &mut Reader<'_>, item: &mut Item, version: u8) -> ReadResult<()> {
    let kind = r.u8()?;
    match item.block_type {
        BLOCK_LINE_ITEM => {
            if kind != 0x03 {
                return Err(ReadError::Malformed(format!("line item type {kind}")));
            }
            let mut line = read_line(r, version)?;
            line.id = item.id;
            item.line = Some(line);
        }
        BLOCK_GROUP_ITEM => {
            if kind != 0x02 {
                return Err(ReadError::Malformed(format!("group item type {kind}")));
            }
            item.group = Some(r.id(2)?);
        }
        _ => {}
    }
    Ok(())
}

/// A line value: tool, colour, thickness, starting length, points, timestamp, then the
/// optional move id and explicit colour that newer firmware adds.
fn read_line(r: &mut Reader<'_>, version: u8) -> ReadResult<Line> {
    let point_size = match version {
        1 => POINT_SIZE_V1,
        2 => POINT_SIZE_V2,
        v => return Err(ReadError::Malformed(format!("line version {v}"))),
    };
    let mut line = Line {
        tool: r.t_int(1)?,
        color: r.t_int(2)?,
        thickness_scale: r.t_double(3)?,
        starting_length: r.t_float(4)?,
        ..Line::default()
    };
    line.points = r.sub(5, |r| read_points(r, version, point_size))?;
    r.id(6)?; // timestamp, unused
    if r.remaining() >= 3 && r.peek_tag(7, TAG_ID) {
        line.move_id = Some(r.id(7)?);
    }
    if r.peek_tag(8, TAG_BYTE4) {
        line.color_rgba = Some(unpack_bgra(r.t_int(8)?));
    }
    Ok(line)
}

/// The colour is stored as a little-endian u32 `0xAARRGGBB` (bytes B, G, R, A).
fn unpack_bgra(v: u32) -> Rgba {
    let [b, g, r, a] = v.to_le_bytes();
    Rgba { r, g, b, a }
}

/// The point subblock: a whole number of points, nothing else.
fn read_points(r: &mut Reader<'_>, version: u8, point_size: usize) -> ReadResult<Vec<Point>> {
    let n = r.remaining();
    if n % point_size != 0 {
        return Err(ReadError::Malformed(format!("point data {n} not a multiple of {point_size}")));
    }
    let mut points = Vec::with_capacity(n / point_size);
    for _ in 0..n / point_size {
        points.push(read_point(r, version)?);
    }
    Ok(points)
}

/// One point. Version 2 values are kept as stored (see [`Point`]); version 1 floats are
/// converted the way rmscene does.
fn read_point(r: &mut Reader<'_>, version: u8) -> ReadResult<Point> {
    let x = r.f32()?;
    let y = r.f32()?;
    if version == 1 {
        let speed = r.f32()?;
        let direction = r.f32()?;
        let width = r.f32()?;
        let pressure = r.f32()?;
        return Ok(Point {
            x,
            y,
            speed: speed * 4.0,
            direction: (255.0 * f64::from(direction) / (2.0 * std::f64::consts::PI)) as f32,
            width: (f64::from(width) * 4.0).round() as f32,
            pressure: pressure * 255.0,
        });
    }
    let speed = r.u16()?;
    let width = r.u16()?;
    let direction = r.u8()?;
    let pressure = r.u8()?;
    Ok(Point {
        x,
        y,
        speed: f32::from(speed),
        direction: f32::from(direction),
        width: f32::from(width),
        pressure: f32::from(pressure),
    })
}

/// A scene tree block declares a group node.
pub(super) fn read_scene_tree(r: &mut Reader<'_>, nodes: &mut Nodes) -> ReadResult<()> {
    let id = r.id(1)?;
    nodes.entry(id).or_default();
    Ok(())
}

/// A tree node block gives a group's label and visibility (last-write-wins values).
pub(super) fn read_tree_node(r: &mut Reader<'_>, nodes: &mut Nodes) -> ReadResult<()> {
    let id = r.id(1)?;
    let node = nodes.entry(id).or_default();
    r.sub(2, |r| {
        r.id(1)?; // the label's timestamp
        r.sub(2, |r| read_label(r, node))
    })?;
    r.sub(3, |r| {
        r.id(1)?; // the visibility's timestamp
        // As in Go, a visibility that fails to read leaves the node hidden.
        let visible = r.t_bool(2);
        node.visible = matches!(visible, Ok(true));
        visible.map(|_| ())
    })
}

/// A string value: varuint length, an is-ascii byte, the bytes.
fn read_label(r: &mut Reader<'_>, node: &mut Node) -> ReadResult<()> {
    let len = r.varuint()?;
    r.u8()?; // is_ascii
    let len = usize::try_from(len).map_err(|_| ReadError::Truncated)?;
    node.label = String::from_utf8_lossy(r.bytes(len)?).into_owned();
    Ok(())
}

/// The paper size from a scene info block (field 5: two u32s). Any failure leaves it unset:
/// the page then falls back to the Paper Pro size.
pub(super) fn read_scene_info(r: &mut Reader<'_>) -> Option<(u32, u32)> {
    let mut paper = None;
    while r.pos < r.end {
        let Ok(tag) = r.varuint() else { break };
        let (index, typ) = (tag >> 4, (tag & 0xF) as u8);
        let skipped = match typ {
            TAG_LENGTH4 => match read_scene_info_sub(r, index) {
                Ok(Some(size)) => {
                    paper = Some(size);
                    Ok(())
                }
                Ok(None) => Ok(()),
                Err(e) => Err(e),
            },
            TAG_BYTE1 => skip(r, 1),
            TAG_BYTE4 => skip(r, 4),
            TAG_BYTE8 => skip(r, 8),
            TAG_ID => r.crdt().map(|_| ()),
            _ => break,
        };
        if skipped.is_err() {
            break;
        }
    }
    paper
}

/// One length-prefixed field of a scene info block; the paper size when it is field 5.
fn read_scene_info_sub(r: &mut Reader<'_>, index: u64) -> ReadResult<Option<(u32, u32)>> {
    let len = r.u32()? as usize;
    let body = r.bytes(len)?;
    if index != 5 || len < 8 {
        return Ok(None);
    }
    let w = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
    let h = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
    Ok(Some((w, h)))
}

/// Moves past a scalar without bounds checks, as Go does: the loop stops at the block's end.
fn skip(r: &mut Reader<'_>, n: usize) -> ReadResult<()> {
    r.pos = r.pos.saturating_add(n);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colour_is_unpacked_from_bgra() {
        assert_eq!(unpack_bgra(0x40_1C_1E_21), Rgba { r: 0x1C, g: 0x1E, b: 0x21, a: 0x40 });
    }

    #[test]
    fn version_1_points_are_converted_like_rmscene() {
        let mut data = Vec::new();
        for f in [10.0f32, 20.0, 0.5, std::f32::consts::PI, 2.6, 0.5] {
            data.extend_from_slice(&f.to_le_bytes());
        }
        let p = read_point(&mut Reader::new(&data, 0), 1).unwrap();
        assert_eq!((p.x, p.y, p.speed, p.width, p.pressure), (10.0, 20.0, 2.0, 10.0, 127.5));
        assert!((p.direction - 127.5).abs() < 1e-3);
    }

    #[test]
    fn scene_info_finds_the_paper_size_among_other_fields() {
        // field 1: byte1; field 2: id; field 5: 8 bytes of size
        let mut data = vec![0x11, 1, 0x2F, 0, 1, 0x5C, 8, 0, 0, 0];
        data.extend_from_slice(&1620u32.to_le_bytes());
        data.extend_from_slice(&2160u32.to_le_bytes());
        assert_eq!(read_scene_info(&mut Reader::new(&data, 0)), Some((1620, 2160)));
        assert_eq!(read_scene_info(&mut Reader::new(&data[..12], 0)), None);
    }
}
