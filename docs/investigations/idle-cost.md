# The bridge's idle cost on the Paper Pro

What the bridge (both engines) does while nobody draws, what it cost, and what changed. Measured
on the maintainer's Paper Pro (OS 3.29.0.149, 4 cores, `CLK_TCK` 100), the bridge hosting the
router (`SERVE_ADDR=:8577`) and streaming into it over loopback, no glasses connected, no
keyboard paired, xochitl idle on an open notebook.

## Method

Per thread, over 60 s of idle: CPU from `utime+stime` in `/proc/<pid>/task/<tid>/stat` (ticks
per second = % of one core) and wakeups from `voluntary_ctxt_switches` in
`/proc/<pid>/task/<tid>/status`. The tablet has no `strace` or `perf`. A timed wake lock held
the tablet awake during each sample. `scripts/dev/engine-bench.sh` then compares the engines
whole-process: 90 s idle, 90 s of synthetic router load.

## Before (2026-10-06)

Rust (`codrawer_bridge_rs`, release 2026.10.06-0333):

| thread | CPU % | wakeups/s | what wakes it |
|---|---|---|---|
| page | 3.15 | 1.0 (+0.8 involuntary) | the page watcher's 1 s poll |
| main (tokio) | 0.03 | 3.1 | 1 s suspend ticker; bridge ping every 2 s and its pong; router ping every 10 s |
| keyboard | 0.02 | 0.2 | rescans `/proc/bus/input/devices` every 5 s for a keyboard |
| pen, typer | 0 | 0 | blocking reads, as intended |
| **total** | **3.20** | **4.2** | |

Go (`codrawer_bridge_native`, same release): **4.30 % CPU, 66.9 wakeups/s**, spread over 8
threads; one runtime thread alone switched 52 times a second, the rest 2–3 times each.

The page poll dominates CPU because finding the open document means listing xochitl's data
directory and stat'ing every entry: **3011 entries** on this tablet, once a second. The other
wakeups are timers that ran whether or not anything happened. In Go each timer firing also
wakes the runtime (the scheduler, sysmon, the netpoller) on whichever thread is free.

Not offenders: the pen machine's batch timer is armed only while points wait; the hover cursor
has no ticker (it is paced on pen events, which only arrive while the pen is in range); the
toolbar-tool file (`/run/codrawer/tool`) is stat'ed only on pen events, at most every 100 ms;
pen, keyboard and typer reads block. The router's per-client ping (10 s) is needed: the glasses
app calls a router silent after 25 s.

## Changes

- **Page watcher on inotify** (`page_watch.rs` / `page_watch.go`, binding in `inotify.rs` /
  `inotify.go`): it sleeps until a `<doc>.content` or `<doc>.metadata` changes in the data
  directory, a document folder appears, or a `.rm` changes in the open document's folder, and
  polls only then. `PAGE_POLL_MS` still paces retries (a file mid-write, no document yet) and the
  fallback when inotify cannot start or breaks; with inotify working, a safety poll runs once a
  minute. Same `page` bytes: the poll itself is unchanged.
- **Suspend check at writes, not every second** (`SuspendCheck` / `suspendCheck`): comparing the
  wall and monotonic clocks costs two reads, so it runs before each write; a message that finds
  the tablet just resumed is held and written first on the next connection.
- **Bridge keepalive 10 s / 25 s** (was 2 s / 8 s): `PING_SECONDS`, `PONG_TIMEOUT_SECONDS`. A
  suspend, the usual cause of a dead socket, is caught at the next write; a half-open uplink to a
  desktop router is now detected within ≤ 35 s instead of ≤ 10 s. On loopback (the default)
  half-open cannot happen.
- **Keyboard waits on `/dev/input`** (inotify, 60 s net) instead of rescanning every 5 s.
- **Go: the page pump's 2 s ticker is gone.** The feed now wakes pumps by closing a channel,
  which no pump can swallow (the ticker covered a capacity-1 notice swallowed by an exiting pump).

## After (release 2026.10.06-0422-a64f120)

Steady state, 60 s idle, per thread as above:

| engine | CPU % before → after | wakeups/s before → after | RSS |
|---|---|---|---|
| Rust | 3.20 → **0.02** | 4.2 → **1.1** | 1.9 MB |
| Go | 4.30 → **0.15** | 66.9 → **14.6** | 12.6 MB |

Rust's remaining wakeups are all on the tokio thread: the keepalive pings between the bridge and
its router and the router's 10 s pings to the connected clients (three during the sample: the
bridge, the phone, the desktop). The page, keyboard, pen and typer threads did not wake at all.
Go's remaining wakeups are mostly one runtime thread (~12/s, the scheduler's sysmon and timer
servicing); `GOMAXPROCS=1` measured 0.08 % / 13.2 per second, within noise of the default, so
it is not set.

`engine-bench.sh` (90 s idle starting 8 s after a restart, then 90 s of synthetic load):

| engine | RSS idle / load | CPU idle / load (% of one core) |
|---|---|---|
| Go, before | 15.2 / 15.9 MB | 8.5 / 19.7 % |
| Rust, before | 1.9 / 2.4 MB | 3.0 / 12.2 % |
| Go, after | 12.6 / 12.8 MB | 0.09 / 2.32 % |
| Rust, after | 2.0 / 2.6 MB | 0.78 / 1.18 % |

The bench's idle window includes the restart's tail (the first page parse, clients reconnecting
and replaying), which is why its Rust idle figure sits above the steady-state 0.02 %. In the
bench run the load generator's own WebSocket keepalive timed out partway through the Rust load
phase; a separate 85 s run of the same load completed and measured 1.24 % CPU, 23 wakeups/s. The
load phase depends on the Wi-Fi and on which viewers are connected, so compare engines within
one run rather than across days.

## Not changed

- The router's per-client 10 s ping (the glasses app needs traffic within 25 s).
- The toolbar-tool hint's 100 ms stat rate limit (it only runs on pen events).
- The codrawer-layer XOVI extension inside xochitl reads the tool every 100 ms and rewrites
  `/run/codrawer/tool` every second as a heartbeat. That is xochitl's cost, not the bridge's,
  and the next candidate if xochitl's idle wakeups matter.
