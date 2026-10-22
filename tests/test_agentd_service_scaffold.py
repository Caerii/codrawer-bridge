"""Contract tests for service pieces before they are wired into the running agentd."""

from __future__ import annotations

import asyncio
import json
import os

import pytest

from codrawer_bridge.agentd import __main__ as agentd_cli
from codrawer_bridge.agentd import daemon
from codrawer_bridge.agentd.config import ConfigError, agentd_argv, parse, redacted, resolve_token
from codrawer_bridge.agentd.daemon import configured, inspect, prune_images, status
from codrawer_bridge.agentd.health import HealthState, PoolStats
from codrawer_bridge.agentd.instance import AlreadyRunning, acquire, holder, is_held
from codrawer_bridge.agentd.service import Agentd, Record
from codrawer_bridge.agentd.service import Config as RuntimeConfig


def test_config_rejects_typos_and_builds_existing_cli_arguments() -> None:
    cfg = parse(
        '[tablet]\nhost = "root@10.0.0.8"\n'
        '[agentd]\npool = 3\nink = "off"\nextra_args = ["--dry-run"]\n'
    )
    argv = agentd_argv(cfg, "private-code")
    assert argv[argv.index("--ws") + 1] == "ws://10.0.0.8:8577/ws/session1"
    assert argv[argv.index("--pool") + 1] == "3"
    assert argv[-1] == "--dry-run"
    assert "private-code" not in redacted(argv)
    assert "sig-glasses" not in redacted(argv)
    with pytest.raises(ConfigError, match="unknown section"):
        parse("[tabllet]\nhost = 'root@10.0.0.8'\n")
    with pytest.raises(ConfigError, match="expected int"):
        parse("[agentd]\npool = true\n")


def test_token_cache_is_used_when_tablet_is_unavailable(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("CODRAWER_ROUTER_TOKEN", raising=False)
    cache = tmp_path / "token"
    cache.write_text("cached-code", encoding="utf-8")

    def unavailable(host: str) -> str:
        raise OSError(f"{host} asleep")

    assert resolve_token(parse(""), cache=cache, read=unavailable, give_up_s=0) == "cached-code"


def test_instance_lock_refuses_second_holder_and_releases(tmp_path) -> None:
    path = tmp_path / "agentd.lock"
    with acquire(path, argv=["--dry-run"]) as lock:
        assert holder(path)["pid"] > 0
        assert is_held(path)
        with pytest.raises(AlreadyRunning):
            acquire(path)
        assert lock.path == path
    with acquire(path):
        pass
    assert not is_held(path)


def test_health_failure_recovery_and_pool_grace() -> None:
    state = HealthState(window_s=600, grace_s=30)
    state.observe_pool(PoolStats(ready=1, starting=0, busy=0, size=1), at=100)
    assert state.evaluate("claude-sonnet-5-5", now=100).status == "ok"
    state.ask_finished("empty selection", answered=False, at=101)
    assert state.evaluate("claude-sonnet-5-5", now=101).status == "ok"
    state.ask_finished("request timed out", answered=False, at=102)
    assert state.evaluate("claude-sonnet-5-5", now=103).reason == "answers timing out"
    state.ask_finished("", answered=True, at=104)
    assert state.evaluate("claude-sonnet-5-5", now=105).status == "ok"
    state.observe_pool(PoolStats(ready=0, starting=1, busy=0, size=1), at=106)
    assert state.evaluate("claude-sonnet-5-5", now=135).status == "ok"
    assert state.evaluate("claude-sonnet-5-5", now=136).reason == "claude not ready"
    state.observe_pool(PoolStats(ready=1, starting=0, busy=0, size=1), at=137)
    assert state.evaluate("claude-sonnet-5-5", now=137).status == "ok"


def test_runtime_lock_wraps_the_entire_agent_lifetime(tmp_path, monkeypatch) -> None:
    path = tmp_path / "service.lock"
    seen = []

    async def serve(_args) -> int:
        seen.append(is_held(path))
        return 0

    monkeypatch.setattr(agentd_cli, "_serve", serve)
    args = agentd_cli._args(["--ws", "ws://localhost/ws/test", "--lock-path", str(path)])
    assert asyncio.run(agentd_cli._main(args)) == 0
    assert seen == [True] and not is_held(path)
    with acquire(path):
        with pytest.raises(AlreadyRunning):
            asyncio.run(agentd_cli._main(args))
    args.dry_run = True
    assert asyncio.run(agentd_cli._main(args)) == 0
    assert seen[-1] is False


def test_health_row_and_snapshot_follow_a_record(tmp_path) -> None:
    agent = Agentd(
        RuntimeConfig(
            ws="ws://localhost/ws/test",
            backend="even-terminal",
            state_dir=str(tmp_path),
            term_cwd=str(tmp_path),
        )
    )
    sent = []

    async def send(message) -> bool:
        sent.append(message)
        return True

    agent.send = send
    agent._ws = object()
    agent._connected.set()
    asyncio.run(agent._dock_entries())
    assert [item["owner"] for item in sent] == ["agentd", "agentd-health"]
    agent._log(Record(n=1, kind="ask_page", received=1.0, error="request timed out"))
    asyncio.run(agent.health.publish())
    health = json.loads((tmp_path / "health.json").read_text(encoding="utf-8"))
    assert health["reason"] == "answers timing out"
    assert health["in_flight"] == 0
    assert health["connected"] is True


def test_managed_config_and_status_do_not_expose_codes(tmp_path) -> None:
    cfg_path = tmp_path / "config.toml"
    cfg_path.write_text(
        '[tablet]\nhost = "root@10.0.0.8"\ntoken = "private-code"\n'
        f'[service]\nsource = "{tmp_path.as_posix()}"\n',
        encoding="utf-8",
    )
    cfg = configured(cfg_path)
    result = inspect(cfg, cfg_path)
    assert result["source"] == str(tmp_path)
    assert "private-code" not in json.dumps(result)
    assert status(cfg)["running"] is False


def test_managed_entry_holds_lock_while_resolving_tablet(tmp_path, monkeypatch) -> None:
    lock_path = tmp_path / "instance.lock"
    cfg_path = tmp_path / "config.toml"
    cfg_path.write_text(
        '[tablet]\nhost = "root@10.0.0.8"\n'
        f'[agentd]\nlock_path = "{lock_path.as_posix()}"\n'
        f'[service]\nsource = "{tmp_path.as_posix()}"\n',
        encoding="utf-8",
    )
    seen = []

    def token(_cfg) -> str:
        seen.append(is_held(lock_path))
        return "private-code"

    def launch(argv, held_lock=None) -> int:
        seen.append(is_held(lock_path) and held_lock is not None)
        assert "private-code" in argv
        return 0

    monkeypatch.setattr(daemon, "resolve_token", token)
    monkeypatch.setattr(daemon.cli, "main", launch)
    assert daemon.main(["run", "--config", str(cfg_path)]) == 0
    assert seen == [True, True]
    assert not is_held(lock_path)


def test_image_retention_only_removes_old_request_pngs(tmp_path) -> None:
    old = tmp_path / "req-1.png"
    other = tmp_path / "other.png"
    old.write_bytes(b"old")
    other.write_bytes(b"keep")
    os.utime(old, (0, 0))
    assert prune_images(tmp_path, keep_days=1) == 1
    assert not old.exists() and other.exists()
