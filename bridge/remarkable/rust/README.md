# codrawer_bridge_rs: Rust port of the Paper Pro bridge

A parallel implementation of `../native` (Go), kept so the two can be compared on speed, memory and
binary size. **The Go binary is still the production one.** This port uses the same flags, env vars,
log prefixes (`[bridge]`, `[keyboard]`, `[typer]`, `[router]`) and wire protocol
(`docs/protocol.md`), so the boot service can run either binary.

## Build and test (Windows, Linux or macOS host)

```bash
cd bridge/remarkable/rust
cargo test                       # unit tests + router tests (ported from router/router_test.go)
cargo run -- -router-only -serve :8577   # the router runs on any OS; the pen bridge needs Linux
```

## Cross-build for the Paper Pro (aarch64, static)

No zig and no cross toolchain needed. The musl target ships its own C runtime and libc, and
`rust-lld` (bundled with rustc) links them. `.cargo/config.toml` sets this up.

```bash
rustup target add aarch64-unknown-linux-musl
cargo build --release --target aarch64-unknown-linux-musl
# → target/aarch64-unknown-linux-musl/release/codrawer_bridge_rs  (static ELF, stripped)
cargo build --profile min-size --target aarch64-unknown-linux-musl   # opt-level=z
```

The binary is fully static, so the tablet's glibc version does not matter.

Sizes (2026-10-02, rustc 1.93, go 1.25.5):

| binary | size |
| --- | --- |
| Go, `GOOS=linux GOARCH=arm64 go build` | 8,604,758 B (8.6 MB) |
| Go, same with `-ldflags="-s -w"` | 5,898,424 B (5.9 MB) |
| Rust, `--release` (LTO, 1 CGU, panic=abort, stripped) | 1,046,544 B (1.0 MB) |
| Rust, `--profile min-size` | 878,664 B (0.9 MB) |

Memory, measured on x86_64 Linux in a container (not on the tablet). Each binary ran with
`SERVE_ADDR=:8577`, streamed a synthetic pen into its own router for ~3 minutes, and had one
external client attached:

| | VmRSS | VmHWM | threads |
| --- | --- | --- | --- |
| Go | 8,448 kB | 8,448 kB | 8 |
| Rust | 1,280 kB | 1,408 kB | 4 (main + pen + typer + tokio blocking) |

Speed has not been benchmarked yet. Both binaries relayed the same stroke stream with the same
messages.

## Swap it into the boot service

`bridge/remarkable/boot/codrawer-bridge.service` runs `ExecStart=/home/root/codrawer_bridge_native`
with `EnvironmentFile=/home/root/codrawer/bridge.env`. Every variable in `bridge.env` means the same
thing to this binary. To try it:

```bash
scp target/aarch64-unknown-linux-musl/release/codrawer_bridge_rs root@<tablet>:/home/root/codrawer_bridge_rs
ssh root@<tablet> 'chmod +x /home/root/codrawer_bridge_rs'
# either point ExecStart at it (systemctl edit codrawer-bridge →
#   [Service]
#   ExecStart=
#   ExecStart=/home/root/codrawer_bridge_rs )
# or swap the file behind the existing path, keeping the Go binary as .go to roll back:
ssh root@<tablet> 'cd /home/root && mv codrawer_bridge_native codrawer_bridge_native.go && \
  cp codrawer_bridge_rs codrawer_bridge_native && systemctl restart codrawer-bridge'
```

Roll back by restoring `codrawer_bridge_native.go` (or by removing the drop-in) and restarting.

## What is ported

Everything in `../native`:

- **main.go / util.go:** every flag and env var with the same defaults. Flag parsing follows Go's
  `flag` package: `-x v`, `-x=v`, `--x`, bool `-x` / `-x=false`, it stops at the first non-flag,
  `-h` exits 0 and bad flags exit 2. Env parsing matches `Sscanf` and the Go bool rules.
- **linux_input.go:** EVIOCGABS ranges, EVIOCGRAB, and the 16/24-byte `input_event` parser.
- **device_select.go:** `-list-devices` and the activity probe used by auto-detect (poll, then
  score). `pickInputDevicePath` is not ported because the Go code never calls it.
- **bridge.go:** the pen reader thread (it reopens the device on error), the stroke state machine
  (touch modes auto/btn/pressure/distance/tool, eraser brush, jitter filter, batch-by-size and
  batch-by-timer), and the reconnect loop with 0.5 s → 5 s backoff ×1.7 plus jitter. `run_once`
  selects on socket errors, pen events, keys and the flush timer, so an idle pen still notices a
  dead socket. It also contains the `term` → typer filter (prompt echo skipped, notes on their own
  line).
- **keyboard.go:** auto-detect skips the power key and **`codrawer virtual keyboard`** (unit tested).
  Also ported: modifier and caps-lock tracking, the US keymap, browser key names, chords sending no
  `char`, and reopening the keyboard when it drops.
- **uinput.go:** the virtual keyboard (UI_SET_EVBIT/KEYBIT, UI_DEV_SETUP, UI_DEV_CREATE) and typing
  with Enter/Tab, folded typographic quotes and dashes, and `…` → `...`.
- **ws_client.go:** TCP keepalive 15 s, a 10 s dial and handshake timeout, a ping every
  `PING_SECONDS`, and a pong watchdog: the deadline moves only on a pong. Text frames go to the
  typer.
- **serve.go + router/router.go:** `/healthz`, `/ws/{session}`, hello, relaying `stroke_*`, `key`,
  `cursor`, `clear` and `doc` to everyone except the sender, and replaying the page to late joiners
  (stroke_pts in chunks of 256). Also ported: `clear` wiping the replay, page bounds (4000 strokes,
  400k points), `term_*` getting a `term` status, and `prompt`/`ai_*` being dropped. Each client
  has a bounded queue (1024) and is dropped when stalled; the server pings every 10 s and drops a
  client silent for 30 s. Shared live editing is ported too: `doc_update` relay, the log replayed
  as `{"t":"doc_update","us":[…]}` chunks of 256, `doc_compact` / `doc_state` compaction, and the
  doc surviving `clear`.

Tests: all six Go router tests are ported to `tests/router.rs`. Extra tests cover `/healthz` and
bad paths, a stalled client not blocking others, flag parsing, the stroke state machine, key
translation, `/proc` parsing and keyboard selection, ioctl numbers (Linux), and Go-style duration
formatting.

## Deliberate differences

- **Replay queue size.** A late joiner's queue is sized to hold the whole replay plus 1024. In Go,
  replay and live traffic share 1024 slots, so on a busy page (more than about 1000 replay messages)
  a joiner is dropped as "stalled" before anything is sent. This is worth fixing in Go too.
- **Text → key mapping is fixed.** Go builds it from a randomly ordered map, so `7` could be typed
  with the keypad key on some runs. Here the main block is preferred, then shifted keys, then the
  keypad. So `*` and `+` are typed as Shift+8 and Shift+= instead of keypad keys.
- **JSON number formatting.** Point coordinates are written as `0.0` / `1.0` where Go writes `0` /
  `1`. Timestamps are integers in both. Map-ordered Go messages such as `hello` and the replayed
  `stroke_end` put `t` first here. Both are JSON-equivalent.
- **Write errors** on the bridge socket are reported to the reconnect loop right away. Go only
  does that for key writes; stroke write errors surface later through the reader.
- **`ws://` only** on the bridge side. Go's client would also accept `wss://`.
- **The router's HTTP layer is minimal:** a request-head reader plus tungstenite. No keep-alive or
  ServeMux path cleaning; `/ws/` paths are percent-decoded. Router log lines carry a UTC
  `YYYY/MM/DD HH:MM:SS` prefix where Go's `log` uses local time (the tablet runs on UTC).
- Error message wording follows Rust's `io::Error`, e.g. `No such file or directory (os error 2)`
  where Go prints `open …: no such file or directory`.

## What is not verified

- **Never run on the Paper Pro.** The aarch64 binary is built but has not been run on the tablet.
  The evdev reader, EVIOCGABS/EVIOCGRAB, the device probe, the keyboard reader and uinput typing are
  untested on real hardware.
- **Partly checked on x86_64 Linux in a container.** The Linux-only unit tests and router tests
  pass, and an end-to-end run worked: the pen reader fed a synthetic event file, streamed into
  the in-process router (`-serve`), and a client received the same stroke stream as from the Go
  binary. That run had no real input device (the ioctls fell back to default ranges) and no
  `/dev/uinput`, so the typer only logged "unavailable".
- Keyboard grab, probe scoring on real devices, and how the virtual keyboard registers on the
  tablet's kernel (6.12) all still need a hardware pass.
