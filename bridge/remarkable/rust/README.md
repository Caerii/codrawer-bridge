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

Sizes (2026-10-02, rustc 1.93, go 1.25.5, both at parity with `dev` d3e0b2a):

| binary | size |
| --- | --- |
| Go, `GOOS=linux GOARCH=arm64 go build` | 8,682,774 B (8.7 MB) |
| Go, same with `-ldflags="-s -w"` | 5,963,960 B (6.0 MB) |
| Rust, `--release` (LTO, 1 CGU, panic=abort, stripped) | 1,073,576 B (1.1 MB) |
| Rust, `--profile min-size` | 891,352 B (0.9 MB) |

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
- **linux_input.go:** EVIOCGABS ranges, EVIOCGRAB, EVIOCGKEY, and the `input_event` parser with
  kernel timestamps. The struct size comes from the platform's pointer width (24 bytes on aarch64,
  16 on 32-bit), not from the first read. Whole events are decoded straight from the reused read
  buffer; only a partial event is carried over.
- **device_select.go:** `-list-devices` and the activity probe used by auto-detect (poll, then
  score). `pickInputDevicePath` is not ported because the Go code never calls it.
- **pen/pen.go → `src/pen.rs`:** the portable stroke state machine (`pen::Machine`) with all five
  Go tests. Touch modes auto/btn/pressure/distance/tool, the eraser brush from BTN_TOOL_RUBBER at
  pen-down, and the sub-pixel jitter filter. The first point of a stroke flushes at once, then
  points batch by time window or by size. JSON is hand-encoded, with 4/4/3-decimal points and Go's
  shortest number form (`0`, `1`, `0.1235`). Timestamps are kernel event times, with a fall back
  to the wall clock when they are more than 10 min off. When an emit is refused, the rest of the
  stroke is skipped, but its `stroke_end` is still tried.
- **bridge.go:** the pen reader thread reopens the device on error. On SYN_DROPPED it discards
  events up to the next SYN_REPORT, then emits the device state (EVIOCGKEY keys, EVIOCGABS values
  and a SYN_REPORT). It uses a reused 64-event read buffer, and `DUMP_EVENTS` prints happen here,
  with `t=`. The pen machine (`pen_machine_forever`) runs for the whole process and writes into a
  bounded outbox (2048). Its batch timer is armed only while points are waiting. On pen down and up
  it takes a 3 s timed wake lock (`codrawer-pen 3000000000` → `/sys/power/wake_lock`, errors
  ignored). The socket loop (`write_outbox`) drains the outbox and the keys. It reconnects at once
  when the wall clock jumps more than 2 s past the monotonic clock (`resumed after ~Ns asleep`).
  The dial URL goes through `source_url`, which adds `replay=0` only if no non-empty `replay` is
  present. The loop backs off from 0.5 s to 5 s (×1.7) with jitter. Also here: the `term` → typer
  filter (prompt echo skipped, notes on their own line) and debug stats (touching, strokes,
  skipped, outbox).
- **keyboard.go:** auto-detect skips the power key and **`codrawer virtual keyboard`** (unit tested).
  Also ported: modifier and caps-lock tracking, the US keymap, browser key names, chords sending no
  `char`, and reopening the keyboard when it drops.
- **uinput.go:** the virtual keyboard (UI_SET_EVBIT/KEYBIT, UI_DEV_SETUP, UI_DEV_CREATE) and typing
  with Enter/Tab, folded typographic quotes and dashes, and `…` → `...`.
- **ws_client.go:** TCP keepalive 15 s, a 10 s dial and handshake timeout, a ping every
  `PING_SECONDS`, and a pong watchdog: the deadline moves only on a pong. Text frames go to the
  typer. The message callback is installed before the reader starts.
- **serve.go + router/router.go:** `/healthz` and `/ws/{session}`. hello carries `"replay"`, and
  `?replay=0` skips the replay (the bridge joins as a pen source). The router relays `stroke_*`,
  `key`, `cursor`, `clear` and `doc` to everyone except the sender, and replays the page to late
  joiners (stroke_pts in chunks of 256). The replay is built from a snapshot taken under the
  session lock but serialized outside it. Live messages for the joiner are held until its replay is
  queued, so order is exact. The joiner's queue holds the whole replay plus 1024. When a client
  leaves, its open strokes get a broadcast `stroke_end` and are marked ended. Also ported:
  - `clear` wipes the replay.
  - Page bounds: 4000 strokes and 150k points, and a single stroke is capped at 20k points for
    replay. The cap does not apply to live relay.
  - `term_*` gets a `term` status, and `prompt`/`ai_*` are dropped.
  - Each client has a bounded queue (1024) and is dropped when it stalls.
  - Every 10 s the server sends a WebSocket ping and a `{"t":"ping"}` text message. It drops a
    client silent for 30 s.
  - Shared live editing: `doc_update` relay, the log replayed as `{"t":"doc_update","us":[…]}` in
    chunks of 256, `doc_compact` / `doc_state` compaction, and the doc surviving `clear`.
    Compaction re-asks the latest writer when the asked client has not answered in 10 s.

Tests: all ten Go router tests are ported to `tests/router.rs`, and all five `pen_test.go` tests to
`src/pen.rs`. Extra tests cover:

- `/healthz` and bad paths, and a stalled client not blocking others.
- Router internals: the `replay` query, the per-stroke cap, snapshot isolation, ending a leaver's
  strokes, and the compaction re-ask.
- The pen machine task: timer flush, and a pen-up during an outage.
- `source_url`, suspend detection, and the 16/24-byte parser with timestamps.
- Flag parsing, key translation, `/proc` parsing and keyboard selection.
- ioctl numbers and key bits (Linux), and Go-style duration formatting.

## Deliberate differences

- **Snapshot cost.** Go's snapshot copies slice headers, O(strokes). Here the points are kept in
  shared blocks of 256 (one replayed `stroke_pts` each), so a snapshot is O(strokes + points/256)
  refcount bumps. A stroke still being drawn copies its partly filled last block once, on the next
  append after a snapshot.
- **Order of synthetic `stroke_end`s** when a client leaves with several open strokes: page order
  here, Go's map order (random) there.
- **The pen machine is a task on the socket thread**, not its own goroutine. It never awaits
  anything but its event channel and its timer: the outbox uses `try_send`, and the wake-lock write
  is one small sysfs write. Keys are written by the same select loop as the outbox, where Go uses a
  separate `pumpKeys` goroutine.
- **`source_url` keeps the query as written** and appends `replay=0` (or replaces an empty
  `replay=`). Go re-encodes the whole query, which sorts keys and canonicalizes escapes.
- **Brush and color strings** in `stroke_begin` are quoted with serde_json. Go uses
  `strconv.Quote`. The two agree for printable text and differ only for control or invalid
  characters, where Go's `\x..` would not be valid JSON.
- **Text → key mapping is fixed.** Go builds it from a randomly ordered map, so `7` could be typed
  with the keypad key on some runs. Here the main block is preferred, then shifted keys, then the
  keypad. So `*` and `+` are typed as Shift+8 and Shift+= instead of keypad keys.
- **JSON key order.** Pen messages are byte-identical to Go's. Router messages that Go builds
  from maps, such as `hello` and the replayed or synthetic `stroke_end`, put `t` first here. They
  are JSON-equivalent.
- **`ws://` only** on the bridge side. Go's client would also accept `wss://`.
- **The router's HTTP layer is minimal:** a request-head reader plus tungstenite. No keep-alive or
  ServeMux path cleaning; `/ws/` paths are percent-decoded, and the query is only read for
  `replay` (first value, `+` and `%XX` decoded, as Go's `Values.Get`). Router log lines carry a UTC
  `YYYY/MM/DD HH:MM:SS` prefix where Go's `log` uses local time (the tablet runs on UTC).
- Error message wording follows Rust's `io::Error`, e.g. `No such file or directory (os error 2)`
  where Go prints `open …: no such file or directory`.

## What is not verified

- **Never run on the Paper Pro.** The aarch64 binary is built but has not been run on the tablet.
  The following are untested on real hardware: the evdev reader, EVIOCGABS/EVIOCGRAB/EVIOCGKEY, the
  SYN_DROPPED resync, the wake lock, suspend detection, the device probe, the keyboard reader and
  uinput typing. The Go versions of the resync, wake lock and suspend check have not run on the
  tablet either.
- **The 2026-10-02 parity pass** (Go 87c2f7f router and 50d9001 bridge) was checked only by
  `cargo test` on Windows, by `clippy` on the host and aarch64-musl targets, and by the aarch64
  release build. It has not run on Linux. The container run described below predates it.
- **Partly checked on x86_64 Linux in a container.** The Linux-only unit tests and router tests
  pass, and an end-to-end run worked: the pen reader fed a synthetic event file, streamed into
  the in-process router (`-serve`), and a client received the same stroke stream as from the Go
  binary. That run had no real input device (the ioctls fell back to default ranges) and no
  `/dev/uinput`, so the typer only logged "unavailable".
- Keyboard grab, probe scoring on real devices, and how the virtual keyboard registers on the
  tablet's kernel (6.12) all still need a hardware pass.
