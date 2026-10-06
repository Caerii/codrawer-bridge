# codrawer_bridge_rs: Rust port of the Paper Pro bridge

A parallel implementation of `../native` (Go), kept so the two can be compared on speed, memory and
binary size. **The Go binary is still the production one.** This port uses the same flags, env vars,
log prefixes (`[bridge]`, `[keyboard]`, `[typer]`, `[router]`) and wire protocol
(`docs/protocol.md`), so the boot service can run either binary.

## Build and test (Windows, Linux or macOS host)

```bash
cd bridge/remarkable/rust
cargo test                       # unit tests + router tests (ported from router/router_test.go)
                                 # (rmlines/pagewatch tests read ../native/rmlines/testdata in place)
cargo run -- -router-only -serve :8577   # the router runs on any OS; the pen bridge needs Linux
cargo run -- release verify <dir> <pub>  # the release tool runs on any OS too
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

Sizes (2026-10-02, rustc 1.93, go 1.25.5, both at parity with `dev` a04125c):

| binary | size |
| --- | --- |
| Go, `GOOS=linux GOARCH=arm64 go build` | 8,804,773 B (8.8 MB) |
| Go, same with `-ldflags="-s -w"` | 6,029,496 B (6.0 MB) |
| Rust, `--release` (LTO, 1 CGU, panic=abort, stripped) | 1,275,688 B (1.3 MB) |
| Rust, `--profile min-size` | 1,036,712 B (1.0 MB) |

The `release` subcommand (ed25519 + SHA-256) added about 100 kB to the Rust binary; the page
watcher (rmlines + pagewatch) about another 100 kB.

Memory, measured on x86_64 Linux in a container (not on the tablet). Each binary ran with
`SERVE_ADDR=:8577`, streamed a synthetic pen into its own router for ~3 minutes, and had one
external client attached:

| | VmRSS | VmHWM | threads |
| --- | --- | --- | --- |
| Go | 8,448 kB | 8,448 kB | 8 |
| Rust | 1,280 kB | 1,408 kB | 4 (main + pen + typer + tokio blocking) |

Speed has not been benchmarked yet. Both binaries relayed the same stroke stream with the same
messages.

## How it ships

Every release built by `scripts/dev/deploy-tablet.sh` carries both engines: it cross-builds this
crate (`cargo build --release --target aarch64-unknown-linux-musl`) next to the Go binary unless
`CODRAWER_SKIP_RUST=1` or `cargo` is missing; a failed Rust build only warns, and the release goes
out with Go alone. On the tablet, `boot/run-bridge.sh` starts the engine named by `ENGINE=go|rust`
in `/home/root/codrawer/bridge.env` (Go when unset, or when the chosen binary is missing), and
`boot.sh doctor` prints `engine=<name> (rust binary present|absent)`. Every variable in
`bridge.env` means the same thing to both binaries: the flags and env vars are the same set as
Go's `config.go` (checked by the `same_flags_as_go` and `same_env_vars_as_go` tests, which read
`../native/config.go`), plus `ROUTER_TOKEN` and the `CODRAWER_OS*` host info that `serve.go`
reads. To switch:

```bash
ssh root@<tablet> "sed -i 's/^ENGINE=.*/ENGINE=rust/' /home/root/codrawer/bridge.env && systemctl restart codrawer-bridge"
```

`scripts/dev/engine-bench.sh` runs each engine in turn on the tablet and compares memory, CPU and
battery drain, then restores the engine that was active.

## What is ported

Everything in `../native`:

- **main.go / util.go:** every flag and env var with the same defaults (including `-hover-hz` /
  `HOVER_HZ`, default 30). Flag parsing follows Go's
  `flag` package: `-x v`, `-x=v`, `--x`, bool `-x` / `-x=false`, it stops at the first non-flag,
  `-h` exits 0 and bad flags exit 2. Env parsing matches `Sscanf` and the Go bool rules. The
  page watcher's `-page-watch` / `PAGE_WATCH` (default `auto`), `-xochitl-dir` / `XOCHITL_DIR`,
  `-page-poll-ms` / `PAGE_POLL_MS` (1000) and `-page-dump` are there too. The usage text follows
  Go's `UnquoteUsage` (a back-quoted word names the argument: `-page-watch page`).
- **linux_input.go:** EVIOCGABS ranges, EVIOCGRAB, EVIOCGKEY, and the `input_event` parser with
  kernel timestamps. The struct size comes from the platform's pointer width (24 bytes on aarch64,
  16 on 32-bit), not from the first read. Whole events are decoded straight from the reused read
  buffer; only a partial event is carried over.
- **device_select.go:** `-list-devices` and the activity probe used by auto-detect (poll, then
  score). The `/proc/bus/input/devices` parser marks `I: Bus=0006` devices as virtual (uinput). `pickInputDevicePath` is not ported because the Go code never calls it.
- **pen/pen.go → `src/pen.rs`:** the portable stroke state machine (`pen::Machine`) with all ten
  Go tests. Touch modes auto/btn/pressure/distance/tool, the eraser brush from BTN_TOOL_RUBBER at
  pen-down, and the sub-pixel jitter filter. The first point of a stroke flushes at once, then
  points batch by time window or by size. JSON is hand-encoded, with 4/4/3-decimal points and Go's
  shortest number form (`0`, `1`, `0.1235`). Timestamps are kernel event times, with a fall back
  to the wall clock when they are more than 10 min off. When an emit is refused, the rest of the
  stroke is skipped, but its `stroke_end` is still tried. Hover: while BTN_TOOL_PEN or
  BTN_TOOL_RUBBER is in range and the pen is not touching, `{"t":"cursor","who":"pen","x","y",
  "tool":"pen"|"eraser","ts"}` goes out at most every `hover_every` (1 s / `-hover-hz`) and only
  after a move of 0.002 or more, then one `{"t":"cursor","who":"pen","gone":true}` when the pen
  leaves range. A refused cursor is dropped and never marks a stroke lost. Following the
  toolbar: `pen::Config::tool` (Go's `Config.Tool`) is asked at each pen-down with the tip and on
  hover samples; while it says `eraser`, a tip stroke goes out with `"brush":"eraser","tool":"eraser"`
  and the hover cursor with `"tool":"eraser"`. The eraser end stays `"brush":"eraser"` with no
  `tool`, whatever the toolbar says; any other answer keeps ink. Byte-identical to Go (a Go build
  of package pen and `toolbar_eraser_bytes_match_go` gave the same bytes for a toolbar-eraser hover
  and stroke, 2026-10-05).
- **toolhint/toolhint.go → `src/toolhint.rs`:** follows `/run/codrawer/tool`, where the
  codrawer-layer XOVI extension writes `<tool> <thickness>` (first word, lower case; `none` and
  `unknown` mean unknown). The line is trusted only while the file's mtime is within 3 s of the
  clock, the file is stat'ed at most every 100 ms and re-read only when its mtime or size changed.
  `-tool-file` / `TOOL_FILE` (default `/run/codrawer/tool`, `off` disables) wires it into the pen
  machine (`bridge::tool_of`, Go's `toolOf`). No file or a stale one: the bridge behaves as before.
- **bridge.go:** the pen reader thread reopens the device on error. On SYN_DROPPED it discards
  events up to the next SYN_REPORT, then emits the device state (EVIOCGKEY keys, EVIOCGABS values
  and a SYN_REPORT). It uses a reused 64-event read buffer, and `DUMP_EVENTS` prints happen here,
  with `t=`. The pen machine (`pen_machine_forever`) runs for the whole process and writes into a
  bounded outbox (2048). Its batch timer is armed only while points are waiting. On pen down and up
  it takes a 3 s timed wake lock (`codrawer-pen 3000000000` → `/sys/power/wake_lock`, errors
  ignored). The socket loop (`write_outbox`) drains the outbox and the keys, and sends the latest
  `page` snapshot on every new connection, then each new one (Go's `pumpPages`). It reconnects at once
  when the wall clock jumps more than 2 s past the monotonic clock (`resumed after ~Ns asleep`).
  The dial URL goes through `source_url`, which adds `replay=0` only if no non-empty `replay` is
  present. The loop backs off from 0.5 s to 5 s (×1.7) with jitter. Also here: the `term` → typer
  filter (prompt echo skipped, notes on their own line) and debug stats (touching, strokes,
  skipped, outbox).
- **keyboard.go:** auto-detect skips the power key, **`codrawer virtual keyboard`**, and every other
  virtual (uinput, bus 0x06) device, such as smart_remarkable's typist (unit tested).
  Also ported: modifier and caps-lock tracking, the US keymap, browser key names, chords sending no
  `char`, and reopening the keyboard when it drops.
- **uinput.go:** the virtual keyboard (UI_SET_EVBIT/KEYBIT, UI_DEV_SETUP, UI_DEV_CREATE) and typing
  with Enter/Tab, folded typographic quotes and dashes, and `…` → `...`.
- **ws_client.go:** TCP keepalive 15 s, a 10 s dial and handshake timeout, a ping every
  `PING_SECONDS`, and a pong watchdog: the deadline moves only on a pong. Text frames go to the
  typer. The message callback is installed before the reader starts.
- **serve.go + router/router.go → `src/router/`** (`http`: request head and listening;
  `messages`: wire shapes; `session`: the page and document state; `client`: the read and write
  loops): `/healthz` and `/ws/{session}`. hello carries `"replay"`, and
  `?replay=0` skips the replay (the bridge joins as a pen source). The router relays `stroke_*`,
  `key`, `cursor`, `clear` and `doc` to everyone except the sender, and replays the page to late
  joiners (stroke_pts in chunks of 256). The replay is built from a snapshot taken under the
  session lock but serialized outside it. Live messages for the joiner are held until its replay is
  queued, so order is exact. The joiner's queue holds the whole replay plus 1024. When a client
  leaves, its open strokes get a broadcast `stroke_end` and are marked ended. Also ported:
  - `clear` wipes the replay, the `page` base included.
  - The tablet's `page` snapshot is the page's base: the session keeps the latest and relays it;
    on arrival it drops recorded live strokes whose `stroke_begin.ts` is not after its `rev`.
    Joiners get it right after hello, then the live strokes recorded since. `?replay=0` sources
    get none. Messages up to 16 MB are accepted (a dense page is a few MB).
  - Page bounds: 4000 strokes and 150k points, and a single stroke is capped at 20k points for
    replay. The cap does not apply to live relay.
  - `term_*` gets a `term` status, and `prompt`/`ai_*` are dropped.
  - Each client has a bounded queue (1024) and is dropped when it stalls.
  - Every 10 s the server sends a WebSocket ping and a `{"t":"ping"}` text message. It drops a
    client silent for 30 s.
  - Pairing code: with `ROUTER_TOKEN` set, a client that is not on loopback must send it as
    `?token=` or `Authorization: Bearer` (the query wins when present, as in Go). The compare is
    constant-time. A refused client gets
    `{"t":"error","code":"unauthorized","text":"pairing code required"}`, then close code 4401,
    and the log says `refused: missing or wrong pairing code`.
  - Host info: `CODRAWER_OS`, `CODRAWER_OS_TESTED`, `CODRAWER_VERSION` and `CODRAWER_OS_CHANGED`
    go into hello as `"tablet":{"os","osTested","version","osChangedFrom"}`. Only variables that
    are set and not empty are sent, and the key is left out when none are.
  - Shared live editing: `doc_update` relay, the log replayed as `{"t":"doc_update","us":[…]}` in
    chunks of 256, `doc_compact` / `doc_state` compaction, and the doc surviving `clear`.
    Compaction re-asks the latest writer when the asked client has not answered in 10 s.

- **rmlines → `src/rmlines/`:** the reader for xochitl's v6 `.rm` page files: CRDT ids, layers
  with label and visibility, tool, palette colour 0–13, `color_rgba` (BGRA unpacked),
  `thickness_scale`, points `[x, y, speed, direction, width, pressure]` (v1 converted like
  rmscene), tombstones, and drawing order by the CRDT sequence with rmscene's tie-break. Unknown
  blocks and trailing fields are skipped by length; a truncated file is an error. Split into
  `reader` (bytes and tagged values), `blocks` (block bodies), `scene` (ordering and the tree
  walk) and `tools` (tool names and palette). It matches rmscene stroke for stroke on all eight
  fixtures (`matches_rmscene`, the port of `TestMatchesRmscene`).
- **pagewatch + page_watch.go → `src/pagewatch/`, `src/page_watch.rs`:** finds the open document
  (newest `<doc>.content`) and page (`cPages.lastOpened.value`, then `.metadata`
  `lastOpenedPage`, then the newest `.rm`), polls when inotify reports a write to a `.content`,
  `.metadata` or the open document's `.rm` (`src/inotify.rs`; retries and the no-inotify fallback
  use `PAGE_POLL_MS`, 1 s, floor 100 ms) and parses only on change. The `page` message is encoded by hand and is **byte-identical to Go's**: a Go
  build of `pagewatch` and `-page-dump` here gave the same bytes for all eight fixtures, with a
  title holding `<&>`, U+2028 and a quote (by hand on Windows, not in CI). `rev` is the `.rm` mtime,
  or on a page change the later of that and the `.content` mtime, and never goes backwards on one
  page. A half-written file is retried. Gating: on when `CODRAWER_OS_TESTED=1`; `on`/`off` (and
  `1`/`0`, `true`/`false`, `yes`/`no`) override. The watcher runs on its own thread and publishes
  on a `tokio::sync::watch` channel, which keeps only the latest snapshot (Go: a mutex-guarded
  latest plus a notify channel).

- **release/release.go + release_cmd.go → `src/release.rs`:** `codrawer_bridge_rs release keygen |
  manifest | sign | verify`, with the same arguments, outputs and exit codes (usage 2, failure 1).
  The MANIFEST format is the same: `version <v>`, then `<sha256 hex>  <relative/path>` lines,
  sorted by bytes. MANIFEST and MANIFEST.sig are left out. MANIFEST.sig holds a base64 ed25519
  signature followed by a newline. Keys are a base64 32-byte seed and a base64 public key; a key
  argument is a file path or the key itself. Verify checks the signature first, then every hash.
  It rejects unlisted files, symlinks, and paths with `..` or a leading `/`. It uses ed25519-dalek
  (without the precomputed tables) and sha2. **Interoperable:** `tests/fixtures/go-release` was
  sealed by the Go `codrawer-release` tool with a throwaway key (`go-release.TEST-ONLY.priv`). The
  tests verify it, and check that Rust builds the same MANIFEST and the same signature byte for
  byte. A release signed by this binary was verified by the Go tool (by hand, not in CI). The
  fixtures' `.gitattributes` turns off line-ending conversion, so their hashes survive a Windows
  checkout.

Tests: all fifteen Go router tests are ported to `tests/router.rs`, all ten `pen_test.go` tests to
`src/pen.rs`, all four `toolhint_test.go` tests to `src/toolhint.rs`, all three `release_test.go` tests (the four tamper cases included) to
`src/release.rs`, every `rmlines_test.go` test to `src/rmlines/` (`FuzzParse` as a seeded sweep of
2,600 truncations, bit flips and junk tails per run) and all three `pagewatch_test.go` tests to
`src/pagewatch/`. The rmlines and pagewatch tests read the Go package's fixtures in place
(`../native/rmlines/testdata`), so both ports test the same bytes. Extra tests cover:

- rmlines: the byte reader, subblock limits, BGRA unpacking, v1 points, scene info, CRDT
  ordering (file order, concurrent inserts, cycles), and synthetic files for trailing fields,
  unknown and malformed blocks, and tombstones.
- pagewatch: the exact `page` bytes, Go's `<>&` escapes, deleted pages, out-of-range indexes, the
  newest-`.rm` guess moving, and a page with no file yet. The bridge sends the latest page on
  every connection (a real reconnect against a test server).
- Flags and env vars compared with `../native/main.go`, and the router's page rebase and envelope.

- `/healthz` and bad paths, and a stalled client not blocking others.
- Hover details: exact cursor bytes, the eraser tool, the move threshold, refusals, a single
  `gone`, and `hover_every = 0`.
- Pairing code parsing and the authorization rules (case-sensitive `Bearer `, the query winning,
  IPv4-mapped loopback), host info from env, and a `/proc` block with another uinput keyboard.
- Release: the Go fixture, path safety, bad versions and keys, and the command line.
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
- **Pairing refusal** waits up to 2 s for the client to answer the close frame before dropping
  the socket. Go closes at once. Waiting means the TCP close cannot reset frames the client has
  not read yet. The test swaps the loopback check through `Router::with_local_check`, where Go's
  test rewrites `RemoteAddr` in a wrapping handler.
- **Release path checks are stricter.** On top of Go's rules (`..`, leading `/`), each path part
  must be a plain name, so `a//b`, `./a` and, on Windows, drive or UNC paths are rejected. Go's
  `filepath.Join` cannot escape through those, but Rust's `Path::join` would replace the base on
  an absolute part. Manifests that Go builds never contain such paths.
- **Release base64** is decoded strictly (`data-encoding`): non-zero padding bits are rejected,
  where Go's `StdEncoding` accepts them. Keys and signatures written by either tool are canonical.
  A public key that is not a valid curve point fails when it is parsed, where Go fails it at
  verify time. The error is the same either way.
- Error message wording follows Rust's `io::Error`, e.g. `No such file or directory (os error 2)`
  where Go prints `open …: no such file or directory`. The page watcher's own errors keep Go's
  shape (`open <path>: …`, `file does not exist`, `rmlines: truncated file`).
- **`.content` / `.metadata` decoding is strict about key names.** Go's `encoding/json` matches
  keys case-insensitively and lets a duplicate key win; serde matches exactly and rejects a
  duplicate field, so such a file counts as unreadable (and the page falls back as if it were
  missing). xochitl writes the exact names once.
- **A layer reached twice.** If two group items pointed at the same scene node, Go would list
  that node's lines in both places; here they are moved into the first layer that reaches them.
  No real file does this; rmscene does not expect it either.
- **Page sending shares the outbox loop.** Go runs `pumpPages` as its own goroutine (with a 2 s
  ticker as a fallback for a lost notify); here the page is one more branch of `write_outbox`'s
  select, fed by a `watch` channel that cannot lose a notify.
- **rmlines types:** tool and colour ids are `u32`, the paper size `u32` (Go: `int`). The values
  and the JSON are the same.

## What is not verified

- **The tool-follow pass** (Go b4ffe46 toolhint) was checked by `cargo test` and
  `clippy --all-targets -D warnings` on Windows and for aarch64-musl, the aarch64 release build,
  and the byte comparison above. The extension's file on a real tablet has only fed the Go engine.

- **The page watcher pass** (Go 8f932d5 rmlines, 75da58c page watcher, 4ccd516 router) was
  checked by `cargo test` on Windows, `clippy --all-targets -D warnings` on the host and the
  x86_64-musl target, the aarch64-musl release build, and a byte comparison of `page` messages
  with a Go build of `pagewatch` on Windows. It has not run on Linux or on the tablet: xochitl's
  real directory, mtime resolution on the tablet's filesystem, and polling while xochitl writes
  are known only from the Go watcher's investigation (docs/investigations/xochitl-pen-data.md).

- **Run on the Paper Pro only briefly.** Release 0a729cd ran it for about three minutes under
  `engine-bench.sh` (2026-10-06, OS 3.29.0.149): it opened `/dev/input/event2`, served the router,
  watched xochitl's page, created the virtual keyboard and relayed a synthetic stroke load to two
  other clients without errors. Measured over 90 s idle, then 90 s of synthetic router load (`/proc`
  and the battery gauge sampled every 2 s, screen and Wi-Fi on):

  | engine | RSS idle / load | CPU idle / load (% of one core) | battery draw idle / load |
  | --- | --- | --- | --- |
  | Go | 15.2 / 15.9 MB | 8.5 / 19.7 % | 910 / 1375 mW |
  | Rust | 1.9 / 2.4 MB | 3.0 / 12.2 % | 1313 / 1266 mW |

  The battery column is dominated by the screen and Wi-Fi and is not ordered by engine, so it
  shows no difference. No pen was drawn on, so pen input, the SYN_DROPPED resync, the wake lock,
  suspend detection, keyboard input and uinput typing are still untested on real hardware. The Go
  versions of the resync, wake lock and suspend check have not run on the tablet either.
- **The second 2026-10-02 parity pass** (Go 4941e7a pairing code, 2adddd5 host info, d7e1f64
  virtual keyboards, f217c07 hover, afa0287 release) was checked only by `cargo test` on Windows,
  by `clippy --all-targets -D warnings` on the host, x86_64-musl and aarch64-musl targets, by the
  aarch64 release build, and by the Go tool verifying a release that Rust signed. It has not run
  on Linux or on the tablet.
- **The first 2026-10-02 parity pass** (Go 87c2f7f router and 50d9001 bridge) was checked only by
  `cargo test` on Windows, by `clippy` on the host and aarch64-musl targets, and by the aarch64
  release build. It has not run on Linux. The container run described below predates it.
- **Partly checked on x86_64 Linux in a container.** The Linux-only unit tests and router tests
  pass, and an end-to-end run worked: the pen reader fed a synthetic event file, streamed into
  the in-process router (`-serve`), and a client received the same stroke stream as from the Go
  binary. That run had no real input device (the ioctls fell back to default ranges) and no
  `/dev/uinput`, so the typer only logged "unavailable".
- Keyboard grab, probe scoring on real devices, and how the virtual keyboard registers on the
  tablet's kernel (6.12) all still need a hardware pass.
