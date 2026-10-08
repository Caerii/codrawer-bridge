# Supporting both tablet models

Use one implementation for both tablets. Model differences belong in explicit
profiles or ABI handling, not copies of the router, agent or glasses app.

| Setting | Paper Pro (existing default) | reMarkable 2 |
| --- | --- | --- |
| `CODRAWER_TABLET_MODEL` | `paper-pro` | `rm2` |
| Go build | `GOARCH=arm64` | `GOARCH=arm GOARM=7` |
| Native extension `CODRAWER_ARCH` | `arm64` | `armhf` |
| Extension output | `out/codrawer-layer.so` | `out/armhf/codrawer-layer.so` |
| Pen defaults | Existing automatic discovery, no axis transform | `event1`, swap XY, invert Y |
| Nominal page units | 1620 × 2160 | 1404 × 1872 |
| Handwriting geometry | Existing 179.6 × 239.5 mm | 226 PPI, about 157.795 × 210.393 mm |
| Linux input-event size | 24 bytes | 16 bytes |
| Native `Line` size | 88 bytes | 72 bytes |

Set `CODRAWER_TABLET_MODEL` in **both** bridge and agent processes, including when
the agent runs on a computer. An unset value keeps Paper Pro behavior. Unknown
models fail explicitly. `INPUT_DEVICE`, `PEN_SWAP_XY`, `PEN_INVERT_X`, and
`PEN_INVERT_Y` remain independent overrides for input calibration. The model does
not turn off keyboard, eraser or native ink features; deployment settings decide
which services and integrations to enable.

## Where changes belong

- `bridge/remarkable/native/tablet.go`: pen defaults. The Go pen state machine,
  router, page watcher and AI layer deletion handling stay shared.
- `src/codrawer_bridge/agentd/geometry.py`: nominal page geometry, consumed by both
  placement and handwriting output. Keep the two conversions consistent.
- `bridge/remarkable/xovi/codrawer-layer/src/line_layout.h`: native word-size
  differences. Runtime gadget validation and firmware gating still apply;
  architecture alone does not establish compatibility with a firmware version.
- `apps/even-g2`: one app for either tablet. Ring dispatch, responsive controls,
  wide view and AI rendering must not depend on the tablet model.
- `src/codrawer_bridge/agentd`: one agent. `--backend anthropic-api` is available
  with either model, with `ANTHROPIC_API_KEY` and an explicit API model supplied
  through configuration. Existing Claude Code and terminal backends remain.
- `scripts/rm2`: the experimental ARMv7 standalone runtime and service installer.
  Its bundled loader, dependencies and systemd paths are rM2-specific. Do not use
  this installer on Paper Pro. The established Paper Pro release/boot flow stays
  in `bridge/remarkable/boot`.

## Build and verification

Build the Go source in `bridge/remarkable/native` with `CGO_ENABLED=0 GOOS=linux`
and the architecture settings above. For the shared extension:

```sh
CODRAWER_ARCH=arm64 bridge/remarkable/xovi/codrawer-layer/build.sh
CODRAWER_ARCH=armhf bridge/remarkable/xovi/codrawer-layer/build.sh
```

The outputs are separate so building rM2 cannot replace the file consumed by the
existing Paper Pro release tooling. Never copy one architecture's binary to the
other model. CI builds both extensions and Go bridges, executes the Go input
ABI tests under ARM emulation, and checks the native Line layout at both pointer
widths. Shared agent tests exercise both handwriting geometry profiles; app
checks cover ring behavior independently of tablet hardware.

The rM2 implementation was exercised on firmware **3.28.0.172** with native ink,
selected handwriting requests and an on-tablet API backend. Layer removal was
observed reaching the bridge directly; physical G2 disappearance timing still
needs confirmation. These changes have not been physically retested on Paper
Pro. Builds and tests are not a replacement for checking pen orientation,
selection, eraser, native ink, layer deletion and startup on each target firmware.

Keep compatibility allowlists tied to actual device validation. This branch
does not expand Paper Pro's firmware allowlist or publish an rM2 auto-update
release. See [rM2 setup and limitations](remarkable2-setup.md).
