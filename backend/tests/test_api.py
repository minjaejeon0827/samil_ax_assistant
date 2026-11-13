"""FastAPI — 보안(CORS·API 키)·비동기 작업·결정 API."""
import importlib
import time

import pytest
from fastapi.testclient import TestClient

H = {"X-API-Key": "test-key"}


@pytest.fixture
def client(monkeypatch):
    from app import config, main
    config.get_settings.cache_clear()
    importlib.reload(main)
    return TestClient(main.app)


def _wait(client, job_id):
    for _ in range(50):
        j = client.get(f"/api/jobs/{job_id}", headers=H).json()
        if j["status"] in ("done", "failed"):
            return j
        time.sleep(0.05)
    raise AssertionError("job timeout")


def test_api_key_401_403(client):
    assert client.get("/api/snapshot").status_code == 401
    assert client.get("/api/snapshot", headers={"X-API-Key": "wrong"}).status_code == 403
    assert client.get("/api/snapshot", headers=H).status_code == 200


def test_cors_only_frontend_origin(client):
    ok = client.options("/api/snapshot", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    bad = client.options("/api/snapshot", headers={"Origin": "http://evil.example", "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert bad.headers.get("access-control-allow-origin") is None


def test_pydantic_rejects_unknown_event(client):
    assert client.post("/api/events", json={"kind": "DROP_TABLE"}, headers=H).status_code == 422


def test_background_job_and_decision_flow(client):
    client.post("/api/reset", headers=H)
    r = client.post("/api/events", json={"kind": "CONTRACT_RENEWAL_NOTICE"}, headers=H)
    assert r.status_code == 202 and r.json()["status"] == "queued"
    j = _wait(client, r.json()["job_id"])
    cid = j["result"]["case_ids"][0]
    bad = client.post(f"/api/cases/{cid}/decision", json={"actor": "MARKETING_TEAM", "action": "approve"}, headers=H)
    assert bad.status_code == 403   # v1.8: 권한 거부는 403(충돌·상태 오류는 409)
    ok = client.post(f"/api/cases/{cid}/decision", json={"actor": "GROUP_CEO", "action": "approve"}, headers=H)
    assert ok.status_code == 200 and ok.json()["case"]["state"] == "APPROVED"
    f = client.get("/api/facts", headers=H).json()
    assert f["cash"]["window"] == ["2026-07-21", "2026-08-21"]
