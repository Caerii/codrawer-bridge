"""Contract tests for service pieces before they are wired into the running agentd."""

from __future__ import annotations

import pytest

from codrawer_bridge.agentd.config import ConfigError, agentd_argv, parse, redacted, resolve_token
from codrawer_bridge.agentd.health import HealthState, PoolStats
from codrawer_bridge.agentd.instance import AlreadyRunning, acquire, holder


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
        with pytest.raises(AlreadyRunning):
            acquire(path)
        assert lock.path == path
    with acquire(path):
        pass


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
