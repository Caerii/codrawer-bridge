"""Typed TOML configuration for the managed responder.

``~/.codrawer-agentd/config.toml`` maps to the existing agentd CLI, so a scheduled task and a
terminal invocation use one runtime contract. The file is explicit for managed startup; the
library's ``parse`` also works on strings for tests and tools. Unknown sections, unknown keys,
wrong types and invalid ranges fail early. See ``scripts/dev/agentd-config.example.toml``.

The tablet address must be configured. The pairing code can come from the file, environment,
the tablet's ``bridge.env`` over SSH, or the cache under ``~/.codrawer-agentd``. Service paths
are absolute; ``term_cwd`` and ``state_dir`` default to the configured source checkout so
existing page threads and settings survive a move to a pinned worktree.
"""

from __future__ import annotations

import logging
import os
import re
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
MAIN_REPO = os.environ.get(
    "CODRAWER_AGENTD_SOURCE", str(Path(__file__).resolve().parents[3])
).replace("\\", "/")


class ConfigError(ValueError):
    """The file is not valid TOML, or a key is unknown or of the wrong type."""


@dataclass
class TabletConfig:
    host: str = ""
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
    term_url: str = "http://127.0.0.1:3456"
    term_token: str = "sig-glasses"
    persona: str = "archivist"
    color: str = "#3a6ea5"
    speed: float = 1.0
    timeout: float = 90.0
    open_timeout: float = 60.0
    include_ai: bool = False
    log_max_bytes: int = 5_000_000
    log_backups: int = 3
    lock_path: str = ""


@dataclass
class ServiceConfig:
    source: str = MAIN_REPO
    checkout: str = f"{MAIN_REPO}-agentd-live"
    ref: str = "origin/dev"
    task_name: str = "codrawer-agentd"


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
    sections = {f.name: f.default_factory for f in fields(Config)}
    unknown = set(raw) - set(sections)
    if unknown:
        raise ConfigError(f"unknown section(s): {', '.join(sorted(unknown))}")
    cfg = Config()
    for name in sections:
        if name in raw:
            setattr(cfg, name, _section(type(getattr(cfg, name)), raw[name], name))
    a = cfg.agentd
    if "term_cwd" not in raw.get("agentd", {}):
        a.term_cwd = cfg.service.source
    if "state_dir" not in raw.get("agentd", {}):
        a.state_dir = f"{cfg.service.source}/.codrawer/agentd"
    if "checkout" not in raw.get("service", {}):
        cfg.service.checkout = f"{cfg.service.source}-agentd-live"
    if a.backend not in ("claude-stream", "even-terminal"):
        raise ConfigError(f"[agentd] backend = {a.backend!r}: claude-stream or even-terminal")
    if a.ink not in ("auto", "on", "off"):
        raise ConfigError(f"[agentd] ink = {a.ink!r}: auto, on or off")
    if a.thinking not in ("dots", "overlay", "none"):
        raise ConfigError(f"[agentd] thinking = {a.thinking!r}: dots, overlay or none")
    if a.pool < 1:
        raise ConfigError("[agentd] pool must be at least 1")
    if a.log_max_bytes < 1 or a.log_backups < 0:
        raise ConfigError("[agentd] log_max_bytes must be positive and log_backups nonnegative")
    if a.timeout <= 0 or a.open_timeout <= 0 or a.speed <= 0:
        raise ConfigError("[agentd] timeout, open_timeout and speed must be positive")
    if a.max_page_y <= 0 or a.keep_images_days < 0:
        raise ConfigError("[agentd] max_page_y must be positive and keep_images_days nonnegative")
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
    if not cfg.tablet.ws and not cfg.tablet.host:
        raise ConfigError("[tablet] host or ws is required")
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
        "--term-url",
        a.term_url,
        "--term-token",
        a.term_token,
        "--persona",
        a.persona,
        "--color",
        a.color,
        "--speed",
        f"{a.speed:g}",
        "--timeout",
        f"{a.timeout:g}",
        "--open-timeout",
        f"{a.open_timeout:g}",
        "--log-max-bytes",
        str(a.log_max_bytes),
        "--log-backups",
        str(a.log_backups),
    ]
    if a.include_ai:
        argv.append("--include-ai")
    for flag, value in (
        ("--agent-cwd", a.agent_cwd),
        ("--state-dir", a.state_dir),
        ("--term-cwd", a.term_cwd),
        ("--lock-path", a.lock_path),
    ):
        if value:
            argv += [flag, expand(value)]
    return argv + list(a.extra_args)


def redacted(argv: list[str]) -> list[str]:
    """``argv`` with the pairing code replaced, for logs and ``status``."""
    out = list(argv)
    for i, v in enumerate(out[:-1]):
        if v in ("--token", "--term-token"):
            out[i + 1] = "***" if out[i + 1] else ""
        elif v == "--ws":
            out[i + 1] = re.sub(r"([?&]token=)[^&]+", r"\1***", out[i + 1])
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
