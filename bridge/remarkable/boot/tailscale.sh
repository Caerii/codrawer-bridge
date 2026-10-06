#!/bin/sh
# Tailscale at boot: put the tablet on the user's own tailnet, so a phone on that tailnet reaches
# the tablet's router (:8577) from anywhere, not only on the home Wi-Fi.
#
#   tailscale.sh run       the codrawer-tailscale unit's ExecStart: gates, then exec tailscaled
#   tailscale.sh gate      exit 0 when the unit should run (installed, kill switch absent)
#   tailscale.sh status    one line, tailscale=<state>, for boot.sh doctor
#   tailscale.sh on        remove the kill switch and start the unit
#   tailscale.sh off       write the kill switch and stop the unit (the login is kept)
#   tailscale.sh cli …     the tailscale CLI on codrawer's socket (e.g. `cli status`, `cli up`)
#
# ── The facts it rests on ────────────────────────────────────────────────────────────────────
#
#   - The Paper Pro kernel (6.12, 3.29.0.149) has no /dev/net/tun, so tailscaled runs with
#     --tun=userspace-networking: WireGuard and the TCP/IP stack (netstack) live inside the
#     process, no interface, route or firewall rule is added to the OS. Incoming TCP to the
#     tablet's tailnet address is handed by netstack to the matching local listener, so the
#     router on :8577 answers at http://<tailnet-ip>:8577/ with no `tailscale serve` (verified on
#     Tailscale 1.102.5, 2026-10-06: /healthz and /ws/session1 from another tailnet node). The same
#     holds for every TCP listener on the tablet, loopback-only ones included (netstack dials
#     127.0.0.1: reMarkable's memfaultd on 127.0.0.1:8787 answers too), and only for nodes of the
#     user's own tailnet. SSH does not: the stock dropbear sockets are bound to wlan0 and usb0
#     (BindToDevice), so a tailnet connection to :22 is refused (docs/what-codrawer-changes.md).
#   - `tailscale serve` with --shields-up, to expose :8577 alone, does not work: shields-up drops
#     the served port too (tried on 1.102.5). Restricting ports is a job for the tailnet's ACLs.
#   - An OS update keeps only /home (docs/investigations/durable-install.md §2). The binaries (the
#     official static arm64 build, about 70 MB, installed by scripts/dev/tailscale-tablet.sh) and
#     the node state (keys, login) live in /home/root/codrawer/tailscale, outside releases/, so
#     they are neither copied into every release nor lost on an update. The unit is copied into
#     /run by boot.sh like codrawer's others, and the control socket is in /run/codrawer.
#   - Tailscale is optional, like XOVI: boot.sh starts the bridge first and only then asks systemd,
#     without waiting, to start codrawer-tailscale; nothing is ordered after it. A tablet with no
#     binaries, or with the kill switch, simply never starts it.
#
# Layout under /home/root/codrawer/tailscale: bin/{tailscale,tailscaled}, VERSION (the installed
# release, written by the installer), state/ (tailscaled's --statedir). Kill switch:
# /home/root/codrawer/TAILSCALE_DISABLED.
set -u
ROOT=${CODRAWER_ROOT:-/home/root/codrawer}
TS=$ROOT/tailscale
KILL=$ROOT/TAILSCALE_DISABLED
SOCK=/run/codrawer/tailscaled.sock
UNIT=codrawer-tailscale.service

installed() { [ -f "$TS/bin/tailscaled" ]; }
gate() { installed && [ ! -e "$KILL" ]; }
cli() { "$TS/bin/tailscale" --socket="$SOCK" "$@"; }

# run: the unit's process. Re-checks the gates (the unit can be started by hand), then becomes
# tailscaled, so systemd supervises it directly.
run() {
  if ! installed; then echo "tailscale: not installed ($TS/bin/tailscaled)"; return 0; fi
  if [ -e "$KILL" ]; then echo "tailscale: disabled ($KILL)"; return 0; fi
  chmod +x "$TS/bin/tailscaled" "$TS/bin/tailscale" 2> /dev/null || true
  mkdir -p "$TS/state" /run/codrawer
  exec "$TS/bin/tailscaled" --tun=userspace-networking --statedir="$TS/state" --socket="$SOCK"
}

# status: up (with address and name) / needs login / stopped / disabled / not installed.
# BackendState and the node's own DNSName come from `status --json --peers=false`, whose Self
# block is the only one carrying a DNSName.
status() {
  if ! installed; then echo "tailscale=not installed"; return 0; fi
  if [ -e "$KILL" ]; then echo "tailscale=disabled"; return 0; fi
  if ! systemctl is-active -q "$UNIT" 2> /dev/null; then echo "tailscale=stopped"; return 0; fi
  js=$(cli status --json --peers=false 2> /dev/null)
  st=$(echo "$js" | sed -n 's/.*"BackendState": *"\([^"]*\)".*/\1/p' | head -n 1)
  case "$st" in
    Running)
      name=$(echo "$js" | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -n 1)
      echo "tailscale=up $(cli ip -4 2> /dev/null | head -n 1) $name"
      ;;
    NeedsLogin | NoState | "") echo "tailscale=needs login${st:+ ($st)} (scripts/dev/tailscale-tablet.sh)" ;;
    *) echo "tailscale=$st" ;;
  esac
}

off() {
  echo "off by the user ($(date -u +%Y-%m-%dT%H:%M:%SZ))" > "$KILL"
  systemctl stop "$UNIT" 2> /dev/null || true
  echo "tailscale: off (the login is kept; boot.sh tailscale on to resume)"
}

on() {
  rm -f "$KILL"
  if ! installed; then echo "tailscale: not installed (scripts/dev/tailscale-tablet.sh)"; return 1; fi
  systemctl --no-block start "$UNIT"
  echo "tailscale: on"
}

case "${1:-}" in
  run) run ;;
  gate) gate ;;
  status) status ;;
  on) on ;;
  off) off ;;
  cli) shift; cli "$@" ;;
  *) echo "usage: tailscale.sh run|gate|status|on|off|cli …" >&2; exit 2 ;;
esac
