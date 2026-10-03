package rmlines

// Tool ids (rmscene scene_items.Pen). The _1 ids are the legacy tools, the _2 ids the current.
const (
	ToolPaintbrush1       = 0
	ToolPencil1           = 1
	ToolBallpoint1        = 2
	ToolMarker1           = 3
	ToolFineliner1        = 4
	ToolHighlighter1      = 5
	ToolEraser            = 6
	ToolMechanicalPencil1 = 7
	ToolEraseArea         = 8
	ToolPaintbrush2       = 12
	ToolMechanicalPencil2 = 13
	ToolPencil2           = 14
	ToolBallpoint2        = 15
	ToolMarker2           = 16
	ToolFineliner2        = 17
	ToolHighlighter2      = 18
	ToolCalligraphy       = 21
	ToolShader            = 23 // Paper Pro
)

// ToolName maps a pen id to the page model's tool vocabulary (ADR 008): fineliner, ballpoint,
// marker, pencil, mechanical_pencil, brush, calligraphy, highlighter, shader, eraser,
// erase_area; "pen" for an id this package does not know.
func ToolName(tool int) string {
	switch tool {
	case ToolFineliner1, ToolFineliner2:
		return "fineliner"
	case ToolBallpoint1, ToolBallpoint2:
		return "ballpoint"
	case ToolMarker1, ToolMarker2:
		return "marker"
	case ToolPencil1, ToolPencil2:
		return "pencil"
	case ToolMechanicalPencil1, ToolMechanicalPencil2:
		return "mechanical_pencil"
	case ToolPaintbrush1, ToolPaintbrush2:
		return "brush"
	case ToolCalligraphy:
		return "calligraphy"
	case ToolHighlighter1, ToolHighlighter2:
		return "highlighter"
	case ToolShader:
		return "shader"
	case ToolEraser:
		return "eraser"
	case ToolEraseArea:
		return "erase_area"
	}
	return "pen"
}

// Colour ids (rmscene scene_items.PenColor). 10–13 are the Paper Pro inks; 9 means "use the
// line's ColorRGBA" (Paper Pro highlighter and shader).
const (
	ColorBlack       = 0
	ColorGray        = 1
	ColorWhite       = 2
	ColorYellow      = 3
	ColorGreen       = 4
	ColorPink        = 5
	ColorBlue        = 6
	ColorRed         = 7
	ColorGrayOverlap = 8
	ColorHighlight   = 9
	ColorGreen2      = 10
	ColorCyan        = 11
	ColorMagenta     = 12
	ColorYellow2     = 13
)

// palette holds display colours per id (rmc's RM_PALETTE; the Paper Pro inks are close
// approximations, nobody has published xochitl's exact values).
var palette = map[int]RGBA{
	ColorBlack:       {0, 0, 0, 255},
	ColorGray:        {144, 144, 144, 255},
	ColorWhite:       {255, 255, 255, 255},
	ColorYellow:      {251, 247, 25, 255},
	ColorGreen:       {0, 255, 0, 255},
	ColorPink:        {255, 192, 203, 255},
	ColorBlue:        {78, 105, 201, 255},
	ColorRed:         {179, 62, 57, 255},
	ColorGrayOverlap: {125, 125, 125, 255},
	ColorHighlight:   {255, 237, 117, 255}, // the Paper Pro's default yellow highlighter
	ColorGreen2:      {161, 216, 125, 255},
	ColorCyan:        {139, 208, 229, 255},
	ColorMagenta:     {183, 130, 205, 255},
	ColorYellow2:     {247, 232, 81, 255},
}

// PaletteRGBA returns the display colour of a palette id (black for an unknown id).
func PaletteRGBA(color int) RGBA {
	if c, ok := palette[color]; ok {
		return c
	}
	return palette[ColorBlack]
}

// RGBA resolves a line's colour: the explicit ColorRGBA when present, else the palette's.
// Legacy highlighters (no ColorRGBA) use their palette colour; renderers apply the tool's
// translucency themselves (the Paper Pro highlighter is stored with alpha 255 but drawn
// translucent; the shader stores its real alpha).
func (l *Line) RGBA() RGBA {
	if l.ColorRGBA != nil {
		return *l.ColorRGBA
	}
	return PaletteRGBA(l.Color)
}
