"""Configuration and process entry point for the managed responder.

This module has no scheduler or Git side effects. A platform launcher installs and updates a
pinned checkout; ``run`` reads one TOML file, resolves the tablet code, and calls the same CLI
entry point as a terminal run. ``inspect`` and ``status`` are machine-readable for that launcher.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import tomllib
from pathlib import Path

from . import __main__ as cli
from .config import (
    CONFIG_PATH,
    Config,
    ConfigError,
    agentd_argv,
    expand,
    load,
    redacted,
    resolve_token,
)
from .health import read as read_health
from .instance import EXIT_LOCKED, LOCK_PATH, AlreadyRunning, acquire, holder, is_held

log = logging.getLogger("agentd")


def configured(path: Path) -> Config:
    """Require an explicit file for managed startup, then validate the existing CLI contract."""
    if not path.is_file():
        raise ConfigError(f"config file missing: {path}; create it before installing the service")
    cfg = load(path)
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw.get("service"), dict) or not raw["service"].get("source"):
        raise ConfigError("[service] source must be explicit in a managed config")
    cli._args(agentd_argv(cfg, ""))
    for label, value in (
        ("[service] source", cfg.service.source),
        ("[service] checkout", cfg.service.checkout),
        ("[agentd] state_dir", cfg.agentd.state_dir),
    ):
        if not Path(expand(value)).is_absolute():
            raise ConfigError(f"{label} must be an absolute path")
    source = Path(expand(cfg.service.source)).resolve()
    checkout = Path(expand(cfg.service.checkout)).resolve()
    if source == checkout:
        raise ConfigError("[service] source and checkout must be different paths")
    if not cfg.service.task_name:
        raise ConfigError("[service] task_name must not be empty")
    return cfg


def inspect(cfg: Config, path: Path) -> dict[str, str]:
    """The launcher contract; never includes the tablet or terminal code."""
    source = Path(expand(cfg.service.source)).resolve()
    checkout = Path(expand(cfg.service.checkout)).resolve()
    return {
        "config": str(path.resolve()),
        "source": str(source),
        "checkout": str(checkout),
        "ref": cfg.service.ref,
        "task_name": cfg.service.task_name,
        "state_dir": expand(cfg.agentd.state_dir),
        "lock_path": expand(cfg.agentd.lock_path) if cfg.agentd.lock_path else str(LOCK_PATH),
    }


def status(cfg: Config) -> dict:
    """Live process ownership and the latest published state are separate observations."""
    lock_path = Path(expand(cfg.agentd.lock_path)) if cfg.agentd.lock_path else LOCK_PATH
    running = is_held(lock_path)
    state = read_health(Path(expand(cfg.agentd.state_dir)))
    updated = state.get("updated") if state else None
    age = time.time() - updated if isinstance(updated, (int, float)) else None
    return {
        "running": running,
        "holder": holder(lock_path) if running else None,
        "health": state if running else None,
        "health_age_s": round(age, 1) if running and age is not None else None,
    }


def prune_images(state_dir: Path, keep_days: float) -> int:
    """Remove old request PNGs only; request records and the health snapshot stay durable."""
    if keep_days < 0:
        raise ConfigError("[agentd] keep_images_days must be nonnegative")
    cutoff = time.time() - keep_days * 86400
    removed = 0
    for path in state_dir.glob("req-*.png"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError as exc:
            log.warning("cannot prune %s: %s", path, exc)
    return removed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Managed codrawer responder")
    parser.add_argument("command", choices=("run", "inspect", "status", "validate"))
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    args = parser.parse_args(argv)
    try:
        cfg = configured(args.config)
        if args.command == "validate":
            print("configuration valid")
            return 0
        if args.command == "inspect":
            print(json.dumps(inspect(cfg, args.config)))
            return 0
        if args.command == "status":
            print(json.dumps(status(cfg)))
            return 0
        state_dir = Path(expand(cfg.agentd.state_dir))
        state_dir.mkdir(parents=True, exist_ok=True)
        prune_images(state_dir, cfg.agentd.keep_images_days)
        lock_path = Path(expand(cfg.agentd.lock_path)) if cfg.agentd.lock_path else LOCK_PATH
        owner = ["agentd-managed", cfg.tablet.ws_url.split("?", 1)[0]]
        with acquire(lock_path, argv=owner) as lock:
            token = resolve_token(cfg)
            arguments = agentd_argv(cfg, token)
            log.info("starting managed agentd: %s", redacted(arguments))
            return cli.main(arguments, held_lock=lock)
    except ConfigError as exc:
        print(f"agentd service: {exc}", file=sys.stderr)
        return 2
    except AlreadyRunning as exc:
        print(f"agentd service: {exc}", file=sys.stderr)
        return EXIT_LOCKED


if __name__ == "__main__":
    sys.exit(main())
