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
//! - [`stroke`]: the pen stroke state machine (bridge.go `runOnce`)
//! - [`ws_client`]: WebSocket client with ping/pong watchdog (ws_client.go)
//! - [`bridge`]: the reconnect loop and the typer hookup (bridge.go)
//! - [`router`]: the stroke-only session router (router/router.go, serve.go)
//! - `linux` (Linux only): evdev ioctls, device probing, pen/keyboard readers, uinput (linux_input.go,
//!   device_select.go, keyboard.go, uinput.go)

pub mod bridge;
pub mod devices;
pub mod flags;
pub mod input;
pub mod keymap;
pub mod router;
pub mod stroke;
pub mod util;
pub mod ws_client;

#[cfg(target_os = "linux")]
pub mod linux;
