"""v1.21(21차 E2E) — PRD §15 '다음 단계' 회귀 테스트(단위·통합). 화면·외부 서버를 거치는 흐름은 e2e/round21."""
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "data" / "samples" / "contracts"


def _extract(name, path=None):
    from app.contracts.extract import extract, read_text
    p = path or SAMPLES / name
    return extract(read_text(name, p.read_bytes()), name, "2026-07-01")


# ---- §15-3 조항 추출 ----
def test_AH_extract_agency_contract_terms_and_citations():
    r = _extract("agency_media_renewal.md")
    t = r["terms"]
    assert (t["expiry"], t["notice_deadline"], t["notice_days"]) == ("2026-07-31", "2026-07-17", 14)
    assert t["annual_fee_krw"] == 1.08e9 and t["fee_basis"].startswith("월 9천만원")
    assert t["penalty_pct"] == 60 and t["payment"]["prepay_pct"] == 50 and t["payment"]["monthly_day"] == 10
    assert {c["id"] for c in r["checks"]} >= {"PENALTY_HIGH", "PREPAY_HIGH"}
    assert r["citations"]["penalty_pct"]["ref"].startswith("제6조")
    assert r["masked"] and "110-234-567890" not in str(r)


def test_AH_extract_inf001_notice_matches_engine_policy(engine):
    t = _extract("inf001.md", ROOT / "data/raw/02_masil/marketing/inf001_exclusive_contract_notice.md")["terms"]
    c = engine.policy["contracts"][0]
    assert t["annual_fee_krw"] == c["fixed_fee_krw"] and t["notice_deadline"] == c["notice_deadline"] and t["expiry"] == c["expiry_date"]
    assert t["penalty_pct"] == 50 and t["cash_out_dates"] is None   # 지급 조건이 없으면 지어내지 않음


def test_AH_extract_rejects_bad_files():
    from app.contracts.extract import ContractError, read_text
    for name, data, status in [("a.exe", b"MZ", 415), ("big.md", b"a" * (2 * 1024 * 1024 + 1), 413), ("e.md", b"   ", 422)]:
        with pytest.raises(ContractError) as e:
            read_text(name, data)
        assert e.value.status == status


# ---- §15-4 같은 엔진 ----
def test_AH_renewal_decisions_use_same_authority_chain_and_covenant(desk):
    for f in ("logistics_3pl_renewal.md", "agency_media_renewal.md"):
        r = _extract(f)
        desk.intake("CONTRACT_UPLOAD", "CONTRACT_OWNER", None, {"record": {k: r[k] for k in ("terms", "checks", "citations")}})
    cs = {c["title"]: c for c in desk.repo.list("cases")}
    logi = next(v for k, v in cs.items() if "한빛로지스" in k)
    ag = next(v for k, v in cs.items() if "블루웨이브" in k)
    assert logi["type"] == "RENEWAL" and logi["approval"]["approver"] == "MASIL_CEO"
    assert ag["approval"]["approver"] == "GROUP_CEO" and ag["decision"]["authority"]["covenant_override"]
    assert any("covenant_terms" in h["source"] for h in ag["policy_hits"]), "covenant 사유 문서가 근거에 없음"
    from app.workflow.service import Duplicate
    r = _extract("agency_media_renewal.md")
    with pytest.raises(Duplicate):
        desk.intake("CONTRACT_UPLOAD", "CONTRACT_OWNER", None, {"record": {k: r[k] for k in ("terms", "checks", "citations")}})


# ---- §15-1 비밀번호 규칙·리프레시 토큰 ----
def test_AH_password_policy_messages():
    from app.api.sso import password_problems
    assert password_problems("fin.park", "aaaaaaaaaa", "x") == ["영문·숫자·기호 중 두 종류 이상을 섞어야 합니다"]
    assert "아이디를 포함할 수 없습니다" in password_problems("fin.park", "fin.park-2026!", "x")
    assert "너무 흔한 비밀번호입니다" in password_problems("u", "password12", "x")
    assert password_problems("fin.park", "Better-Pass-2026", "pw-fin") == []


def test_AH_refresh_rotation_detects_reuse_and_password_change(monkeypatch):
    from fastapi import HTTPException
    from app.api.auth import Auth, Identity
    monkeypatch.setenv("AUTH_MODE", "jwt"); monkeypatch.setenv("JWT_SECRET", "x" * 32); monkeypatch.setenv("USERS", "fin.park:pw-fin:FINANCE")
    a = Auth()
    kv: dict = {}

    def upd(name):
        def f(fn):
            doc = kv.setdefault(name, {"id": name})
            fn(doc)
        return f
    a.attach_refresh(upd("refresh")); a.attach_passwords(lambda: kv.get("passwords"), upd("passwords"))
    ident = Identity("fin.park", "FINANCE")
    tok = a.issue(ident); c = a.claims(tok)
    rt = a.new_refresh(ident, c["sid"], c["auth_time"])
    acc, rt2, _, _ = a.rotate(rt)
    with pytest.raises(HTTPException) as e:
        a.rotate(rt)                                   # 재사용 → 그 로그인 전체 무효
    assert e.value.status_code == 401 and "탈취" in e.value.detail
    with pytest.raises(HTTPException):
        a.verify(acc)
    tok = a.issue(ident); c = a.claims(tok)
    rt3 = a.new_refresh(ident, c["sid"], c["auth_time"])
    a.change_password("fin.park", "pw-fin", "Better-Pass-2026")
    for fn in (lambda: a.verify(tok), lambda: a.rotate(rt3)):
        with pytest.raises(HTTPException) as e:
            fn()
        assert e.value.status_code == 401
    assert a.login("fin.park", "Better-Pass-2026").role == "FINANCE"


# ---- §15-2 채널 서명·멱등 ----
def test_AH_channel_signature_window_and_idempotent_callback(desk, monkeypatch):
    from fastapi import HTTPException
    from app.integrations.channel import Channel, sign
    monkeypatch.setenv("CHANNEL", "webhook"); monkeypatch.setenv("CHANNEL_SECRET", "s3cret"); monkeypatch.setenv("ESIGN_USERS", "kim.ceo:GROUP_CEO")
    kv: dict = {}

    def upd(name, fn):
        doc = kv.setdefault(name, {"id": name})
        return fn(doc)
    ch = Channel(desk, upd)
    ts, body = str(int(time.time())), b'{"a":1}'
    ch.verify(ts, sign("s3cret", ts, body), body)
    for t, s in [(ts, sign("other", ts, body)), (str(int(time.time()) - 400), sign("s3cret", str(int(time.time()) - 400), body))]:
        with pytest.raises(HTTPException) as e:
            ch.verify(t, s, body)
        assert e.value.status_code == 401
    c = desk.intake("CONTRACT_RENEWAL_NOTICE")[0]
    r1 = ch.handle_decision({"event_id": "e-1", "case_id": c["id"], "action": "approve", "user": "kim.ceo"})
    r2 = ch.handle_decision({"event_id": "e-1", "case_id": c["id"], "action": "approve", "user": "kim.ceo"})
    assert r1["ok"] and r2.get("duplicate")
    assert sum(1 for a in desk.repo.list("audit") if a["topic"] == "case.approved") == 1
    with pytest.raises(HTTPException) as e:
        ch.handle_decision({"event_id": "e-2", "case_id": c["id"], "action": "approve", "user": "nobody"})
    assert e.value.status_code == 403
