//! Reads reMarkable v6 `.rm` page files ("reMarkable .lines file, version=6") into strokes.
//! Port of the Go package `bridge/remarkable/native/rmlines`.
//!
//! Read-only and portable (no OS-specific code). It follows the format as documented by rmscene
//! (github.com/ricklupton/rmscene, MIT), the reference it is cross-checked against (the
//! `matches_rmscene` test, using the Go package's fixtures).
//!
//! # The format, and how this module reads it
//!
//! A file is the 43-byte [`HEADER`] followed by blocks: `u32` length, `u8` 0, `u8` minimum
//! version, `u8` current version, `u8` type, then a body of tagged values. [`parse`] walks the
//! blocks and hands each body to [`blocks`]:
//!
//! ```text
//! bytes ──► parse (block loop) ──► blocks::read_item        ─► Item (line / group / tombstone …)
//!                               ├─► blocks::read_scene_tree ─┐
//!                               ├─► blocks::read_tree_node  ─┴► Nodes (layer label, visibility)
//!                               └─► blocks::read_scene_info ─► paper size
//!                                              │
//!                         scene::build ◄───────┘  CRDT order per group, tree walk from the root
//!                                │
//!                                ▼
//!                              Page { layers[ lines ], deleted, paper size }
//! ```
//!
//! Strokes are line items of a CRDT sequence whose parent is a layer (a group node). An erased or
//! undone stroke stays in the file as an item without a value (deleted length > 0) or as a
//! tombstone block; both are reported in [`Page::deleted`] and never as a live [`Line`].
//!
//! # Robustness
//!
//! Unknown blocks, unknown trailing fields in a block or subblock (newer firmware) and blocks
//! that fail to parse are skipped by their length, so a newer xochitl degrades to "fewer
//! fields", not to an error ([`Page::skipped`] counts them). A file that is truncated (a block
//! runs past the end, e.g. read while xochitl is writing it) is [`Error::Truncated`]: the caller
//! should retry later.
//!
//! Submodules: [`reader`] (bytes and tagged values), [`blocks`] (block bodies), [`scene`]
//! (ordering and the tree walk), [`tools`] (tool names and palette colours).

mod blocks;
mod reader;
mod scene;
mod tools;

use std::fmt;

pub use tools::*;

use blocks::{
    Item, BLOCK_AUTHOR_IDS, BLOCK_GLYPH_ITEM, BLOCK_GROUP_ITEM, BLOCK_LINE_ITEM, BLOCK_MIGRATION_INFO,
    BLOCK_PAGE_INFO, BLOCK_ROOT_TEXT, BLOCK_SCENE_INFO, BLOCK_SCENE_TREE, BLOCK_TEXT_ITEM, BLOCK_TOMBSTONE_ITEM,
    BLOCK_TREE_NODE,
};
use reader::{ReadError, ReadResult, Reader};

/// The first 43 bytes of every v6 file.
pub const HEADER: &str = "reMarkable .lines file, version=6          ";

/// Why a file could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// The file is not a v6 `.rm` file.
    Header,
    /// The file ends inside a block (most likely it is being written).
    Truncated,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Error::Header => "rmlines: not a reMarkable v6 lines file",
            Error::Truncated => "rmlines: truncated file",
        })
    }
}

impl std::error::Error for Error {}

/// Identifies an item: (author, counter). Author 0 is the document itself. Ordered by author,
/// then counter.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CrdtId {
    pub author: u8,
    pub counter: u64,
}

impl CrdtId {
    /// The end marker (0:0).
    pub fn is_zero(&self) -> bool {
        self.author == 0 && self.counter == 0
    }
}

impl fmt::Display for CrdtId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.author, self.counter)
    }
}

/// The scene tree's root group; its children are the layers.
pub const ROOT_ID: CrdtId = CrdtId { author: 0, counter: 1 };

/// One sample as xochitl stored it. For version-2 points (all current firmware) the values are
/// the stored integers: `speed` and `width` are in quarter units (`width / 4` is the stroke width
/// in page pixels), `direction` 0..255 is a full turn, `pressure` 0..255. Version-1 points (old
/// firmware, six floats) are converted the way rmscene does.
///
/// `x` and `y` are page units: `x` is centred on the page (−W/2..W/2), `y` runs down from the
/// top and grows past H on a scrolled page. The quarter-pixel width follows from rmscene's v1
/// conversion (`width_v2 = round(width_v1 × 4)`); a fineliner at size 2 stores 16, i.e. 4 px
/// (docs/investigations/xochitl-pen-data.md, "Built").
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Point {
    pub x: f32,
    pub y: f32,
    pub speed: f32,
    pub direction: f32,
    pub width: f32,
    pub pressure: f32,
}

/// A colour, components 0..255.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Rgba {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgba {
    /// A fully opaque colour.
    pub const fn opaque(r: u8, g: u8, b: u8) -> Self {
        Rgba { r, g, b, a: 255 }
    }
}

/// One live stroke.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Line {
    pub id: CrdtId,
    /// The top-level group (layer) it belongs to.
    pub layer: CrdtId,
    /// xochitl's pen id (see [`tool_name`]).
    pub tool: u32,
    /// xochitl's palette id (see [`palette_rgba`]).
    pub color: u32,
    /// The explicit colour (Paper Pro highlighter and shader, colour id 9), if stored.
    pub color_rgba: Option<Rgba>,
    /// The size setting (1, 2, 3 or a fraction for pressure-sized tools).
    pub thickness_scale: f64,
    pub starting_length: f32,
    pub points: Vec<Point>,
    /// Set when the stroke was moved with the selection tool.
    pub move_id: Option<CrdtId>,
}

impl Line {
    /// The line's display colour: the explicit `color_rgba` when present, else the palette's.
    /// Legacy highlighters (no `color_rgba`) use their palette colour; renderers apply the tool's
    /// translucency themselves (the Paper Pro highlighter is stored with alpha 255 but drawn
    /// translucent; the shader stores its real alpha).
    pub fn rgba(&self) -> Rgba {
        self.color_rgba.unwrap_or_else(|| palette_rgba(self.color))
    }
}

/// A top-level group of the page.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Layer {
    pub id: CrdtId,
    pub label: String,
    pub visible: bool,
    /// Live strokes in drawing (CRDT) order.
    pub lines: Vec<Line>,
}

/// A parsed `.rm` file.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Page {
    pub layers: Vec<Layer>,
    /// Strokes erased or undone (CRDT tombstones), in file order.
    pub deleted: Vec<CrdtId>,
    /// The paper size from SceneInfo when present (1620×2160 on the Paper Pro), else 0.
    pub paper_w: u32,
    pub paper_h: u32,
    /// Blocks that were unknown or failed to parse (skipped by their length).
    pub skipped: usize,
}

impl Page {
    /// Every live stroke, layer by layer, in drawing order.
    pub fn lines(&self) -> impl Iterator<Item = &Line> {
        self.layers.iter().flat_map(|l| l.lines.iter())
    }
}

/// The 8 bytes that precede every block body.
struct BlockHeader {
    len: usize,
    version: u8,
    block_type: u8,
}

/// Reads a whole `.rm` file.
pub fn parse(data: &[u8]) -> Result<Page, Error> {
    if !data.starts_with(HEADER.as_bytes()) {
        return Err(Error::Header);
    }
    let mut r = Reader::new(data, HEADER.len());
    let mut page = Page::default();
    let mut nodes = blocks::Nodes::new();
    let mut items = Vec::new();
    while r.pos < data.len() {
        r.end = data.len();
        let header = read_block_header(&mut r).map_err(|_| Error::Truncated)?;
        r.need(header.len).map_err(|_| Error::Truncated)?;
        let block_end = r.pos + header.len;
        r.end = block_end;
        match read_block(&mut r, &header, &mut nodes, &mut page) {
            Ok(Some(item)) => items.push(item),
            Ok(None) => {}
            Err(_) => page.skipped += 1, // malformed or a newer layout: skipped by its length
        }
        r.pos = block_end;
    }
    scene::build(&mut page, &nodes, items);
    Ok(page)
}

/// Only truncation can fail here: the header is plain bytes.
fn read_block_header(r: &mut Reader<'_>) -> ReadResult<BlockHeader> {
    let len = r.u32()? as usize;
    let [_, _min_version, version, block_type] = <[u8; 4]>::try_from(r.bytes(4)?).expect("4 bytes");
    Ok(BlockHeader { len, version, block_type })
}

/// Reads one block body. Returns the item for sequence item blocks; other blocks fill `nodes`
/// or `page` directly. Unknown block types count as skipped.
fn read_block(
    r: &mut Reader<'_>,
    header: &BlockHeader,
    nodes: &mut blocks::Nodes,
    page: &mut Page,
) -> ReadResult<Option<Item>> {
    match header.block_type {
        BLOCK_LINE_ITEM | BLOCK_GROUP_ITEM | BLOCK_GLYPH_ITEM | BLOCK_TEXT_ITEM | BLOCK_TOMBSTONE_ITEM => {
            blocks::read_item(r, header.block_type, header.version).map(Some)
        }
        BLOCK_SCENE_TREE => blocks::read_scene_tree(r, nodes).map(|_| None),
        BLOCK_TREE_NODE => blocks::read_tree_node(r, nodes).map(|_| None),
        BLOCK_SCENE_INFO => {
            if let Some((w, h)) = blocks::read_scene_info(r) {
                (page.paper_w, page.paper_h) = (w, h);
            }
            Ok(None)
        }
        // Not needed for strokes.
        BLOCK_MIGRATION_INFO | BLOCK_ROOT_TEXT | BLOCK_AUTHOR_IDS | BLOCK_PAGE_INFO => Ok(None),
        _ => Err(ReadError::Malformed(format!("unknown block type {:#x}", header.block_type))),
    }
}

#[cfg(test)]
pub(crate) mod tests;
