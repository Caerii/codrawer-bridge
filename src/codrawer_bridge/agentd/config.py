"""
agentd's service configuration: one TOML file instead of a command line typed into a terminal.

**The problem.** Until 2026-10-07 agentd ran from a terminal with a dozen flags
(docs/checkpoints/2026-10-07.md, "Run agentd"), the pairing code among them. A service that
starts with the PC (scripts/dev/agentd-service.ps1) needs the same choices written down once, and
the pairing code must not be written into anything that could be committed. This module reads
``~/.codrawer-agentd/config.toml`` and turns it into the argument list of
``python -m codrawer_bridge.agentd`` (__main__.py), so the service and a terminal run take exactly
the same options and nothing in the service duplicates __main__'s defaults.

**The facts it rests on.**

- The pairing code is ``ROUTER_TOKEN`` in the tablet's ``/home/root/codrawer/bridge.env``
  (CLAUDE.md, "Bring the stack up"; inktest.py reads it the same way). The tablet sleeps within
  minutes and drops SSH, and the PC usually logs on while it sleeps: so the code is read over SSH
  when the tablet answers and cached in ``~/.codrawer-agentd/token`` (the user's profile, never a
  repository), and the cache is used when it does not.
- The service runs a pinned checkout (``[service] checkout``) but keeps its state where the
  terminal runs kept it, ``C:/Github/tool-codrawer-bridge/.codrawer/agentd`` (the user's dock
  settings and page threads live there, threads.py), so switching to the service loses nothing.

**The file**, every key optional (the defaults are the checkpoint's live command line)::

    [tablet]
    host = "root@192.168.50.156"            # ssh target: the token, the ink setting
    ws = "ws://192.168.50.156:8577/ws/session1"   # default: from host
    token = ""                              # empty: ROUTER_TOKEN over ssh, else the cache

    [agentd]
    backend = "claude-stream"
    model = "claude-sonnet-5-5"
    fast_model = "claude-haiku-4-5-20251001"
    pool = 2
    thinking = "overlay"
    ink = "auto"
    max_page_y = 18.0
    agent_cwd = "~/.codrawer-agentd/live"
    state_dir = "C:/Github/tool-codrawer-bridge/.codrawer/agentd"
    term_cwd = "C:/Github/tool-codrawer-bridge"
    extra_args = []                         # anything else __main__ takes, verbatim
    keep_images_days = 14                   # req-*.png older than this are pruned at start

    [service]                               # read by agentd-service.ps1 (plain strings only)
    source = "C:/Github/tool-codrawer-bridge"     # the main checkout
    checkout = "C:/Github/codrawer-agentd-live"   # the pinned worktree the service runs
    ref = "origin/dev"                      # what `agentd-service.ps1 update` moves it to

    [nightly]
    test_notebooks = ["Test", "codrawer: test"]
    live_ask = true                         # a real Ask round trip, only in a test notebook
    report_dir = "C:/Github/tool-codrawer-bridge/.codrawer/nightly"

Unknown sections and keys are errors, so a typo is caught at start rather than ignored.
"""

from __future__ import annotations

import logging
import os
import subprocess
import time
import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

log = logging.getLogger("agentd")

#: Where the service's own files live: config.toml, the token cache, the lock (instance.py).
HOME = Path(os.environ.get("CODRAWER_AGENTD_HOME", Path.home() / ".codrawer-agentd"))
CONFIG_PATH = HOME / "config.toml"
TOKEN_CACHE = HOME / "token"

#: The main checkout on this PC (CLAUDE.md); the state stays under it.
MAIN_REPO = "C:/Github/tool-codrawer-bridge"


class ConfigError(ValueError):
    """The file is not valid TOML, or a key is unknown or of the wrong type."""


@dataclass
class TabletConfig:
    host: str = "root@192.168.50.156"
    ws: str = ""  # derived from host when empty (ws_url)
    token: str = ""

    @property
    def ip(self) -> str:
        return self.host.split("@")[-1]

    @property
    def ws_url(self) -> str:
        return self.ws or f"ws://{self.ip}:8577/ws/session1"


@dataclass
class AgentdConfig:
    backend: str = "claude-stream"
    model: str = "claude-sonnet-5-5"
    fast_model: str = "claude-haiku-4-5-20251001"
    pool: int = 2
    thinking: str = "overlay"
    ink: str = "auto"
    max_page_y: float = 18.0
    agent_cwd: str = "~/.codrawer-agentd/live"
    state_dir: str = f"{MAIN_REPO}/.codrawer/agentd"
    term_cwd: str = MAIN_REPO
    extra_args: list[str] = field(default_factory=list)
    keep_images_days: float = 14.0


@dataclass
class ServiceConfig:
    source: str = MAIN_REPO
    checkout: str = "C:/Github/codrawer-agentd-live"
    ref: str = "origin/dev"


@dataclass
class NightlyConfig:
    test_notebooks: list[str] = field(default_factory=lambda: ["Test", "codrawer: test"])
    live_ask: bool = True
    report_dir: str = f"{MAIN_REPO}/.codrawer/nightly"


@dataclass
class Config:
    """The whole file (module docstring), defaults filled in."""

    tablet: TabletConfig = field(default_factory=TabletConfig)
    agentd: AgentdConfig = field(default_factory=AgentdConfig)
    service: ServiceConfig = field(default_factory=ServiceConfig)
    nightly: NightlyConfig = field(default_factory=NightlyConfig)


# ── reading the file ─────────────────────────────────────────────────────────────────────────


def _section(cls: type, raw: Any, name: str) -> Any:
    """One ``[name]`` table as ``cls``: every key known, every value of the default's type."""
    if not isinstance(raw, dict):
        raise ConfigError(f"[{name}] must be a table")
    known = {f.name: f for f in fields(cls)}
    out = cls()
    for key, value in raw.items():
        if key not in known:
            raise ConfigError(f"[{name}] has no key {key!r} (known: {', '.join(sorted(known))})")
        default = getattr(out, key)
        if isinstance(default, bool):
            ok = isinstance(value, bool)
        elif isinstance(default, float):
            ok = isinstance(value, (int, float)) and not isinstance(value, bool)
            value = float(value) if ok else value
        elif isinstance(default, int):
            ok = isinstance(value, int) and not isinstance(value, bool)
        elif isinstance(default, list):
            ok = isinstance(value, list) and all(isinstance(v, str) for v in value)
        else:
            ok = isinstance(value, str)
        if not ok:
            raise ConfigError(
                f"[{name}] {key} = {value!r}: expected {type(default).__name__}"
                + (" of strings" if isinstance(default, list) else "")
            )
        setattr(out, key, value)
    return out


def parse(text: str) -> Config:
    """A :class:`Config` from the file's text; :class:`ConfigError` names what is wrong."""
    try:
        raw = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"not valid TOML: {e}") from e
    sections = {f.name: f.default_factory for f in fields(Config)}  # type: ignore[misc]
    unknown = set(raw) - set(sections)
    if unknown:
        raise ConfigError(f"unknown section(s): {', '.join(sorted(unknown))}")
    cfg = Config()
    for name in sections:
        if name in raw:
            setattr(cfg, name, _section(type(getattr(cfg, name)), raw[name], name))
    a = cfg.agentd
    if a.backend not in ("claude-stream", "even-terminal"):
        raise ConfigError(f"[agentd] backend = {a.backend!r}: claude-stream or even-terminal")
    if a.ink not in ("auto", "on", "off"):
        raise ConfigError(f"[agentd] ink = {a.ink!r}: auto, on or off")
    if a.thinking not in ("dots", "overlay", "none"):
        raise ConfigError(f"[agentd] thinking = {a.thinking!r}: dots, overlay or none")
    if a.pool < 1:
        raise ConfigError("[agentd] pool must be at least 1")
    return cfg


def load(path: Path | None = None) -> Config:
    """The configuration at ``path`` (default ``~/.codrawer-agentd/config.toml``); no file means
    every default."""
    path = path or CONFIG_PATH
    if not path.exists():
        return Config()
    return parse(path.read_text(encoding="utf-8"))


def expand(p: str) -> str:
    """``~`` and environment variables expanded, forward slashes (both work on Windows)."""
    return os.path.expandvars(os.path.expanduser(p)).replace("\\", "/") if p else p


# ── the command line ─────────────────────────────────────────────────────────────────────────


def agentd_argv(cfg: Config, token: str) -> list[str]:
    """The arguments for ``python -m codrawer_bridge.agentd`` (__main__.py) this file asks for."""
    a = cfg.agentd
    argv = [
        "--ws",
        cfg.tablet.ws_url,
        "--token",
        token,
        "--ssh",
        cfg.tablet.host,
        "--backend",
        a.backend,
        "--model",
        a.model,
        "--fast-model",
        a.fast_model,
        "--pool",
        str(a.pool),
        "--thinking",
        a.thinking,
        "--ink",
        a.ink,
        "--max-page-y",
        f"{a.max_page_y:g}",
    ]
    for flag, value in (
        ("--agent-cwd", a.agent_cwd),
        ("--state-dir", a.state_dir),
        ("--term-cwd", a.term_cwd),
    ):
        if value:
            argv += [flag, expand(value)]
    return argv + list(a.extra_args)


def redacted(argv: list[str]) -> list[str]:
    """``argv`` with the pairing code replaced, for logs and ``status``."""
    out = list(argv)
    for i, v in enumerate(out[:-1]):
        if v == "--token":
            out[i + 1] = "***" if out[i + 1] else ""
    return out


# ── the pairing code ─────────────────────────────────────────────────────────────────────────


def read_tablet_token(host: str, timeout_s: float = 25.0) -> str:
    """``ROUTER_TOKEN`` from the tablet's bridge.env over SSH; raises when it cannot be read."""
    out = subprocess.run(
        [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            host,
            "cd /home/root/codrawer && (set -a; . ./bridge.env; set +a; "
            "printf 'token=%s\\n' \"$ROUTER_TOKEN\")",
        ],
        capture_output=True,
        text=True,
        timeout=timeout_s,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:200] or f"ssh exit {out.returncode}")
    for line in out.stdout.splitlines():
        if line.startswith("token="):
            return line[len("token=") :].strip()
    raise RuntimeError("no ROUTER_TOKEN line in bridge.env")


def resolve_token(
    cfg: Config,
    cache: Path = TOKEN_CACHE,
    read=read_tablet_token,
    retry_s: float = 30.0,
    give_up_s: float | None = None,
    sleep=time.sleep,
) -> str:
    """
    The pairing code, in order: ``[tablet] token``; ``CODRAWER_ROUTER_TOKEN``; the tablet's
    bridge.env over SSH (then cached); the cache. With neither the tablet nor a cache, try again
    every ``retry_s`` (the tablet is asleep) until ``give_up_s`` (None: for ever), then return "".
    An empty code is legal: a router without ROUTER_TOKEN accepts anyone.
    """
    if cfg.tablet.token:
        return cfg.tablet.token
    if os.environ.get("CODRAWER_ROUTER_TOKEN"):
        return os.environ["CODRAWER_ROUTER_TOKEN"]
    t0 = time.monotonic()
    while True:
        try:
            token = read(cfg.tablet.host)
            try:
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text(token, encoding="utf-8")
            except OSError as e:
                log.warning("cannot cache the pairing code in %s (%s)", cache, e)
            return token
        except Exception as e:  # noqa: BLE001 - asleep, off the network, no key: use the cache
            if cache.exists():
                log.info("tablet unreachable (%s); using the cached pairing code", e)
                return cache.read_text(encoding="utf-8").strip()
            if give_up_s is not None and time.monotonic() - t0 >= give_up_s:
                log.warning("no pairing code: tablet unreachable (%s) and nothing cached", e)
                return ""
            log.info("tablet unreachable (%s) and no cached pairing code; retrying", e)
            sleep(retry_s)
