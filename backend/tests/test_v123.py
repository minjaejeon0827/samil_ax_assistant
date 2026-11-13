"""v1.23(23차 E2E) — 새 기능 × 기존 보장, §15 남은 일 회귀 테스트(단위·통합). 화면·외부 서버를 거치는 흐름은 e2e/round23."""
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
VAR = ROOT / "data" / "samples" / "contracts" / "variants"


def _x(name):
    from app.contracts.extract import extract, read_text
    p = VAR / name
    return extract(read_text(name, p.read_bytes()), name, "2026-07-01")


# ---- AJ06: 조항 문구 변형 — 맞거나 '확인 필요', 틀린 값 0 ----
def test_AJ06_korean_variant_words_and_inline_parties():
    t = _x("logistics_kr_variant.md")["terms"]
    assert t["counterparty"] == "동해물류 주식회사" and t["annual_fee_krw"] == 9.6e8 and t["penalty_pct"] == 30
    assert (t["auto_renew"], t["notice_deadline"]) == (True, "2026-07-02")


def test_AJ06_english_usd_not_converted_and_renewal_found():
    r = _x("freight_en_usd.md")
    t = r["terms"]
    assert t["auto_renew"] is True and t["notice_deadline"] == "2026-07-02" and t["counterparty"] == "Pacific Freight LLC"
    assert t["currency"] == "USD" and t.get("annual_fee_krw") is None
    assert any(c["id"] == "FOREIGN_CURRENCY" and "USD" in c["text"] for c in r["checks"])
    assert "billing@pacific-freight.example" not in str(r)


def test_AJ06_missing_renewal_clause_is_unknown_not_no():
    r = _x("service_kr_no_clause.md")
    assert r["terms"]["auto_renew"] is None
    ids = [c["id"] for c in r["checks"]]
    assert "RENEWAL_MISSING" in ids and "NO_AUTO_RENEW" not in ids
    f = _x("service_en_fixed_term.md")
    assert f["terms"]["auto_renew"] is False and f["terms"]["penalty_pct"] == 10


def test_AJ06_unknown_renewal_needs_info_in_decision(desk):
    r = _x("service_kr_no_clause.md")
    desk.intake("CONTRACT_UPLOAD", "CONTRACT_OWNER", None, {"record": {k: r[k] for k in ("terms", "checks", "citations")}})
    c = next(x for x in desk.repo.list("cases") if x["type"] == "RENEWAL")
    assert any("자동 갱신 여부 미확인" in n for n in c["decision"]["needs_info"])
    assert "자동 갱신 조항 없음" not in c["decision"]["label"]


# ---- AJ05: OCR 자원 ----
def test_AJ05_oversized_page_rejected_before_rendering(tmp_path):
    from PIL import Image
    from app.contracts.extract import ContractError, read_text_ex
    pdf = tmp_path / "big.pdf"
    im = Image.new("1", (300, 300), 1)
    im.save(pdf, resolution=5.0, save_all=True, append_images=[im.copy()])
    t0 = time.monotonic()
    with pytest.raises(ContractError) as e:
        read_text_ex("big.pdf", pdf.read_bytes(), True)
    assert time.monotonic() - t0 < 1 and "너무 큽니다" in str(e.value)


def test_AJ05_truncated_ocr_is_reported():
    from app.contracts.extract import extract
    text = (VAR / "logistics_kr_variant.md").read_text(encoding="utf-8")
    r = extract(text, "scan.pdf", "2026-07-01", {"ocr": True, "pages": 11, "read": 8})
    c = next(c for c in r["checks"] if c["id"] == "OCR_TRUNCATED")
    assert "8쪽" in c["text"] and "11쪽" in c["text"] and c["level"] == "missing"


# ---- AJ04: 다시 보내기 동시 클릭 ----
def test_AJ04_concurrent_retry_sends_once(desk, monkeypatch):
    from fastapi import HTTPException
    from app.integrations.channel import Channel
    monkeypatch.setenv("CHANNEL", "webhook"); monkeypatch.setenv("CHANNEL_SECRET", "s3cret")
    kv: dict = {}
    lock = threading.Lock()

    def upd(name, fn):
        with lock:
            return fn(kv.setdefault(name, {"id": name}))
    ch = Channel(desk, upd)
    sent: list = []
    monkeypatch.setattr(ch, "_start", lambda url, body: sent.append(body["event_id"]))
    ch._enqueue("http://esign.example/hook", {"type": "approval.requested", "case_id": "C-1"})
    eid = sent.pop()
    ch._record(eid, {"status": "failed"})
    out: list = []

    def go():
        try:
            out.append(ch.retry(eid, "CONTRACT_OWNER")["ok"])
        except HTTPException as e:
            out.append(e.detail)
    ts = [threading.Thread(target=go) for _ in range(5)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert sent == [eid] and out.count(True) == 1
    assert all("이미 다시 보내는 중" in x for x in out if x is not True)


# ---- AJ03: '처음부터'에도 남는 연동 상태 ----
def test_AJ03_reset_keeps_integration_state(desk):
    from app.workflow.service import KEEP_ON_RESET
    for k in ("oidc_sessions", "esign_inbound", "oidc_bc_jti"):
        desk.repo.put("kv", {"id": k, "items": {"x": 1}})
    desk.repo.put("kv", {"id": "deliveries", "items": {"y": 1}})
    desk.reset()
    assert {"oidc_sessions", "esign_inbound", "oidc_bc_jti"} <= set(KEEP_ON_RESET)
    assert all((desk.repo.get("kv", k) or {}).get("items") == {"x": 1} for k in ("oidc_sessions", "esign_inbound", "oidc_bc_jti"))
    assert not (desk.repo.get("kv", "deliveries") or {}).get("items")    # 지난 전송 기록은 지움(옛 건 번호로 다시 보내지 않게)


# ---- AJ02: 백채널 로그아웃 ----
def test_AJ02_backchannel_token_rules(monkeypatch):
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa
    from fastapi import HTTPException
    from app.api.sso import OIDC
    monkeypatch.setenv("OIDC_ISSUER", "http://idp.example"); monkeypatch.setenv("OIDC_CLIENT_ID", "desk"); monkeypatch.setenv("OIDC_REDIRECT_URI", "http://localhost/")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    sess: dict = {}
    jti: dict = {}
    o = OIDC(lambda: None, lambda fn: None, lambda fn: fn(sess))
    o._disc = (time.time(), {"issuer": "http://idp.example", "jwks_uri": "http://idp.example/jwks"})
    o._jwk = type("K", (), {"uri": "http://idp.example/jwks", "get_signing_key_from_jwt": lambda self, t: type("S", (), {"key": key.public_key()})()})()
    o.remember("our-1", "IDT", time.time() + 60, "idp-A", "u-1")
    o.remember("our-2", "IDT", time.time() + 60, "idp-B", "u-1")
    tok = lambda **kw: jwt.encode({"iss": "http://idp.example", "aud": "desk", "iat": int(time.time()), "jti": kw.pop("jti", "j1"),  # noqa: E731
                                    "events": {OIDC.BC_EVENT: {}}, **kw}, key, algorithm="RS256")
    upd = lambda fn: fn(jti)  # noqa: E731
    assert [s for s, _ in o.backchannel(tok(sid="idp-A"), upd)] == ["our-1"]       # 그 IdP 세션만
    for bad in (tok(sid="idp-A"), tok(jti="j2", sid="idp-B", nonce="n"), jwt.encode({"iss": "http://idp.example", "aud": "desk", "iat": int(time.time()), "jti": "j3", "sid": "idp-B"}, key, algorithm="RS256")):
        with pytest.raises(HTTPException) as e:
            o.backchannel(bad, upd)
        assert e.value.status_code == 400
    assert [s for s, _ in o.backchannel(tok(jti="j4", sub="u-1"), upd)] == ["our-2"]   # sid 없으면 그 사람 전부(남은 것)


# ---- AJ07: 서버 여러 대 공동 토큰 한도 ----
def test_AJ07_shared_budget_waits_across_instances(monkeypatch):
    from app.llm.provider import _SharedBudget
    monkeypatch.setenv("LLM_TPM", "1000"); monkeypatch.setenv("LLM_TPM_WINDOW_S", "0.6")
    store: dict = {}
    lock = threading.Lock()

    def upd(fn):
        with lock:
            return fn(store)
    a, b = _SharedBudget(), _SharedBudget()       # 두 서버, 같은 저장소
    a.update = b.update = upd
    t0 = time.monotonic()
    a.settle(a.acquire(700))
    b.acquire(700)                                 # 다른 서버도 a가 쓴 양을 보고 기다림
    assert time.monotonic() - t0 >= 0.5
