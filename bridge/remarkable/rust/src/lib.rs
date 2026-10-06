//! Rust port of the reMarkable Paper Pro native bridge (`bridge/remarkable/native`, Go).
//!
//! The Go binary stays the production one; this crate exists so the two can be compared
//! (speed, memory, binary size). Same flags, env vars and log prefixes, so the boot service
//! (`bridge/remarkable/boot/codrawer-bridge.service`) can run either binary unchanged.
//!
//! Layout (mirrors the Go files):
//! - [`util`]: env helpers, clamp/norm, Go-style duration formatting (util.go)
//! - [`flags`]: config from env + Go `flag`-compatible command line (main.go)
//! - [`input`]: Linux input constants, `input_event` stream parser (linux_input.go)
//! - [`keymap`]: US keymap, key names, key-message translation, text → keystrokes (keyboard.go, uinput.go)
//! - [`devices`]: `/proc/bus/input/devices` parsing and keyboard selection (device_select.go, keyboard.go)
//! - [`pen`]: the pen stroke state machine, pure and portable (package pen, pen/pen.go)
//! - [`ws_client`]: WebSocket client with ping/pong watchdog (ws_client.go)
//! - [`bridge`]: the pen machine task, the outbox writer + reconnect loop, the typer hookup (bridge.go)
//! - [`router`]: the stroke-only session router (router/router.go, serve.go), split into
//!   `http`, `messages`, `session` and `client` submodules
//! - [`rmlines`]: reader for xochitl's v6 `.rm` page files (package rmlines)
//! - [`pagewatch`]: finds xochitl's open page and builds the `page` snapshot (package pagewatch)
//! - [`page_watch`]: the watcher thread (woken by inotify), its gating and its feed into the
//!   bridge (page_watch.go)
//! - [`inotify`]: the minimal inotify binding the page and keyboard threads sleep on
//!   (inotify_linux.go)
//! - [`release`]: build, sign and verify tablet releases (package release, release_cmd.go)
//! - [`toolhint`]: follows the tool selected in xochitl's toolbar, reported by the codrawer-layer
//!   XOVI extension (package toolhint)
//! - `linux` (Linux only): evdev ioctls, device probing, pen/keyboard readers, uinput (linux_input.go,
//!   device_select.go, keyboard.go, uinput.go)

pub mod bridge;
pub mod devices;
pub mod flags;
pub mod inotify;
pub mod input;
pub mod keymap;
pub mod page_watch;
pub mod pagewatch;
pub mod pen;
pub mod release;
pub mod rmlines;
pub mod router;
pub mod toolhint;
pub mod util;
pub mod ws_client;

#[cfg(target_os = "linux")]
pub mod linux;
