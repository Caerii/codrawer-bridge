//! xochitl's pen and colour ids (rmscene `scene_items.Pen` / `PenColor`) and what they mean to
//! the page model (ADR 008): tool names, and display colours for palette ids.

use super::Rgba;

// Tool ids. The `_1` ids are the legacy tools, the `_2` ids the current ones.
pub const TOOL_PAINTBRUSH_1: u32 = 0;
pub const TOOL_PENCIL_1: u32 = 1;
pub const TOOL_BALLPOINT_1: u32 = 2;
pub const TOOL_MARKER_1: u32 = 3;
pub const TOOL_FINELINER_1: u32 = 4;
pub const TOOL_HIGHLIGHTER_1: u32 = 5;
pub const TOOL_ERASER: u32 = 6;
pub const TOOL_MECHANICAL_PENCIL_1: u32 = 7;
pub const TOOL_ERASE_AREA: u32 = 8;
pub const TOOL_PAINTBRUSH_2: u32 = 12;
pub const TOOL_MECHANICAL_PENCIL_2: u32 = 13;
pub const TOOL_PENCIL_2: u32 = 14;
pub const TOOL_BALLPOINT_2: u32 = 15;
pub const TOOL_MARKER_2: u32 = 16;
pub const TOOL_FINELINER_2: u32 = 17;
pub const TOOL_HIGHLIGHTER_2: u32 = 18;
pub const TOOL_CALLIGRAPHY: u32 = 21;
/// Paper Pro.
pub const TOOL_SHADER: u32 = 23;

/// Maps a pen id to the page model's tool vocabulary (ADR 008): `fineliner`, `ballpoint`,
/// `marker`, `pencil`, `mechanical_pencil`, `brush`, `calligraphy`, `highlighter`, `shader`,
/// `eraser`, `erase_area`; `pen` for an id this module does not know.
pub fn tool_name(tool: u32) -> &'static str {
    match tool {
        TOOL_FINELINER_1 | TOOL_FINELINER_2 => "fineliner",
        TOOL_BALLPOINT_1 | TOOL_BALLPOINT_2 => "ballpoint",
        TOOL_MARKER_1 | TOOL_MARKER_2 => "marker",
        TOOL_PENCIL_1 | TOOL_PENCIL_2 => "pencil",
        TOOL_MECHANICAL_PENCIL_1 | TOOL_MECHANICAL_PENCIL_2 => "mechanical_pencil",
        TOOL_PAINTBRUSH_1 | TOOL_PAINTBRUSH_2 => "brush",
        TOOL_CALLIGRAPHY => "calligraphy",
        TOOL_HIGHLIGHTER_1 | TOOL_HIGHLIGHTER_2 => "highlighter",
        TOOL_SHADER => "shader",
        TOOL_ERASER => "eraser",
        TOOL_ERASE_AREA => "erase_area",
        _ => "pen",
    }
}

// Colour ids. 10–13 are the Paper Pro inks; 9 means "use the line's colour_rgba" (Paper Pro
// highlighter and shader).
pub const COLOR_BLACK: u32 = 0;
pub const COLOR_GRAY: u32 = 1;
pub const COLOR_WHITE: u32 = 2;
pub const COLOR_YELLOW: u32 = 3;
pub const COLOR_GREEN: u32 = 4;
pub const COLOR_PINK: u32 = 5;
pub const COLOR_BLUE: u32 = 6;
pub const COLOR_RED: u32 = 7;
pub const COLOR_GRAY_OVERLAP: u32 = 8;
pub const COLOR_HIGHLIGHT: u32 = 9;
pub const COLOR_GREEN_2: u32 = 10;
pub const COLOR_CYAN: u32 = 11;
pub const COLOR_MAGENTA: u32 = 12;
pub const COLOR_YELLOW_2: u32 = 13;

/// Display colours by palette id (rmc's `RM_PALETTE`; the Paper Pro inks are close
/// approximations, nobody has published xochitl's exact values).
const PALETTE: [Rgba; 14] = [
    Rgba::opaque(0, 0, 0),       // black
    Rgba::opaque(144, 144, 144), // gray
    Rgba::opaque(255, 255, 255), // white
    Rgba::opaque(251, 247, 25),  // yellow
    Rgba::opaque(0, 255, 0),     // green
    Rgba::opaque(255, 192, 203), // pink
    Rgba::opaque(78, 105, 201),  // blue
    Rgba::opaque(179, 62, 57),   // red
    Rgba::opaque(125, 125, 125), // gray overlap
    Rgba::opaque(255, 237, 117), // highlight: the Paper Pro's default yellow highlighter
    Rgba::opaque(161, 216, 125), // green 2
    Rgba::opaque(139, 208, 229), // cyan
    Rgba::opaque(183, 130, 205), // magenta
    Rgba::opaque(247, 232, 81),  // yellow 2
];

/// The display colour of a palette id (black for an unknown id).
pub fn palette_rgba(color: u32) -> Rgba {
    PALETTE.get(color as usize).copied().unwrap_or(PALETTE[COLOR_BLACK as usize])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names() {
        let want = [
            (0, "brush"), (12, "brush"), (1, "pencil"), (14, "pencil"), (2, "ballpoint"), (15, "ballpoint"),
            (3, "marker"), (16, "marker"), (4, "fineliner"), (17, "fineliner"), (5, "highlighter"),
            (18, "highlighter"), (6, "eraser"), (7, "mechanical_pencil"), (13, "mechanical_pencil"),
            (8, "erase_area"), (21, "calligraphy"), (23, "shader"), (99, "pen"),
        ];
        for (id, name) in want {
            assert_eq!(tool_name(id), name, "tool {id}");
        }
    }

    #[test]
    fn palette() {
        assert_eq!(palette_rgba(COLOR_CYAN), Rgba { r: 139, g: 208, b: 229, a: 255 });
        assert_eq!(palette_rgba(COLOR_YELLOW_2), Rgba::opaque(247, 232, 81));
        assert_eq!(palette_rgba(14), palette_rgba(COLOR_BLACK));
        assert_eq!(palette_rgba(u32::MAX), palette_rgba(COLOR_BLACK));
    }
}
