# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting:
the repository's **Security** tab → **Report a vulnerability**
(<https://github.com/Caerii/codrawer-bridge/security/advisories/new>). Do not open a public issue
or pull request for them.

Say what an attacker can do, from where (same Wi-Fi, the internet, a malicious page or release),
and how to reproduce it; include the codrawer release (`boot.sh doctor` prints it) and the tablet
OS version. This is a small project maintained alongside other work: expect an acknowledgement
within a week, and a fix or a plan once the problem is understood. Fixes land on `dev` and ship
in the next signed release.

Supported: the latest release built from `dev`. Older releases get no fixes; update with
`scripts/dev/deploy-tablet.sh`.

## What to know before you run codrawer

[What codrawer changes on your tablet](docs/what-codrawer-changes.md) lists every file, service
and port, and how to remove all of it. In short:

- **The bridge runs as root on the tablet.** Reading the pen and keyboard, typing through a
  virtual keyboard (`/dev/uinput`) and loading the Bluetooth driver need it. A flaw in the bridge
  is therefore a root-level flaw on a device that, in Developer Mode, has no disk encryption.
- **The tablet's router listens on the LAN** (port 8577, all interfaces, plain WebSocket without
  TLS). It is guarded by a pairing code (`ROUTER_TOKEN` in `bridge.env`, created by
  `deploy-tablet.sh`) that every client not on the tablet must present; loopback (the bridge's own
  pen stream) is exempt. Anyone holding the code can see the live page and draw, clear and edit
  on it. The code crosses the network in clear, so it is meant for a trusted home or office
  Wi-Fi, not a public network. Without `ROUTER_TOKEN` the router is open to everyone who can reach
  it. `/healthz` answers without the code and reveals only `{"ok":true}`.
- **Releases are signed.** `deploy-tablet.sh` signs every release's `MANIFEST` with an ed25519 key
  kept at `~/.codrawer/release.key` on your computer; the tablet verifies a release against
  `/home/root/codrawer/release.pub` before activating it, using the binary it already trusts. The
  public key is installed on first deploy over your SSH session (trust on first use). Keep the
  private key private: whoever holds it, and can reach the tablet over SSH, can install code that
  runs as root.
- **The desktop router has no pairing code.** `scripts/dev/up.sh` binds it to all interfaces on
  port 8577. When it is connected to a terminal backend (`CODRAWER_TERM_URL`), any client that can
  reach it can send instructions (`term_prompt`) to that Claude Code session, which acts in the
  configured working directory. Run it only on a network you trust, or bind it to `127.0.0.1`, and
  firewall the port otherwise.
- **The glasses app** reaches only the router origins listed in its package manifest (the Even
  app enforces this whitelist), and stores the router address and pairing code in the WebView's
  local storage on the phone.
