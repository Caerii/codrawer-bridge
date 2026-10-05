# rmlines fixtures

| file | source |
| --- | --- |
| `paperpro_calligraphy.rm` | our Paper Pro (Codex 6.0.105), copied read-only on 2026-10-02: 45 calligraphy strokes |
| `More_color_highlight_shader_v3.15.4.2.rm`, `Color_and_tool_v3.14.4.rm`, `Normal_A_stroke_2_layers_v3.3.2.rm` | [rmscene](https://github.com/ricklupton/rmscene) `tests/data` (MIT, © 2023 Rick Lupton); Paper Pro colours, highlighter, shader, layers |
| `writing_tools.rm`, `layers.stroke.rm`, `erasers.rm`, `pen_size_test.strokes.rm` | [rmc](https://github.com/ricklupton/rmc) `tests/rm` (MIT, © 2023 Rick Lupton); every tool, layers, erased strokes |

`rmscene.json` is what Python rmscene 0.8.0 reads from each file (`rmscene_dump.py`);
`TestMatchesRmscene` compares the Go parser against it stroke by stroke.
