"""The Primer inside the desktop router (CODRAWER_PRIMER=1), offline, over a real WebSocket."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from codrawer_bridge.primer.recognize import FIXTURES, load_recording


def test_router_answers_a_primer_request_with_a_reading(tmp_path, monkeypatch):
    monkeypatch.setenv("CODRAWER_PRIMER", "1")
    monkeypatch.setenv("CODRAWER_PRIMER_MODE", "offline")
    monkeypatch.setenv("CODRAWER_PRIMER_LEARNER", "nell")
    monkeypatch.setenv("CODRAWER_STATE_DIR", str(tmp_path))
    from codrawer_bridge.server.app import app

    with TestClient(app) as client, client.websocket_connect("/ws/primer-router-test") as ws:
        assert json.loads(ws.receive_text())["t"] == "hello"
        dock = json.loads(ws.receive_text())
        assert dock["t"] == "dock_entries" and dock["entries"][0]["id"] == "primer.coach"
        for m in load_recording(FIXTURES / "sqrt2_flawed.jsonl"):
            ws.send_text(json.dumps(m))
        ws.send_text(json.dumps({"t": "primer_request", "what": "proof", "learner": "nell"}))
        reading = None
        for _ in range(2000):
            m = json.loads(ws.receive_text())
            if m.get("t") == "primer":
                reading = m
                break
        assert reading is not None
        assert reading["move"]["kind"] == "socratic" and reading["move"]["step"] == 6
        assert reading["learner"]["name"] == "nell"
    assert (tmp_path / "primer" / "learners" / "nell.json").exists()
