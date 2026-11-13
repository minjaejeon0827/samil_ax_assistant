"""v1.22(22차 E2E) — §15 남은 일·다음 후보 ⑤⑥⑦ 회귀 테스트(단위·통합). 화면·외부 서버를 거치는 흐름은 e2e/round22."""
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "data" / "samples" / "contracts"


# ---- §15-3 남은 일: 영문 계약서 ----
def test_AI05_english_contract_terms():
    from app.contracts.extract import extract, read_text
    p = SAMPLES / "logistics_en_renewal.md"
    r = extract(read_text(p.name, p.read_bytes()), p.name, "2026-07-01")
    t = r["terms"]
    assert (t["expiry"], t["notice_deadline"], t["auto_renew"]) == ("2026-09-30", "2026-08-01", True)
    assert t["annual_fee_krw"] == 1.5e9 and t["penalty_pct"] == 40 and t["payment"]["monthly_day"] == 25
    assert t["counterparty"].startswith("Harbor Fulfillment")
    assert "ops@harbor-fulfillment.example" not in str(r) and "010-3456-7890" not in str(r)


# ---- §15-3 남은 일: 스캔 PDF(OCR) ----
@pytest.mark.skipif(not (shutil.which("tesseract") and shutil.which("pdftoppm")), reason="OCR 도구 없음")
def test_AI04_scanned_pdf_uses_ocr(tmp_path):
    from app.contracts.extract import extract, read_text_ex
    pdf = tmp_path / "scan.pdf"
    subprocess.run([sys.executable, str(ROOT / "e2e" / "make_scanned_pdf.py"), str(SAMPLES / "logistics_3pl_renewal.md"), str(pdf)], check=True)
    text, meta = read_text_ex("scan.pdf", pdf.read_bytes())
    assert meta["ocr"] is True
    r = extract(text, "scan.pdf", "2026-07-01", ocr=True)
    t = r["terms"]
    assert (t["notice_deadline"], t["expiry"], t["annual_fee_krw"], t["penalty_pct"]) == ("2026-08-01", "2026-08-31", 9.6e8, 20)
    assert any(c["id"] == "OCR_USED" for c in r["checks"])


# ---- ⑤ 계약서 요약: 판사를 통과하지 못하면 근거 기반 요약 ----
def _rec():
    from app.contracts.extract import extract, read_text
    p = SAMPLES / "agency_media_renewal.md"
    return extract(read_text(p.name, p.read_bytes()), p.name, "2026-07-01")


def test_AI06_summary_offline_and_hallucination_fallback(monkeypatch):
    from langchain_core.runnables import RunnableLambda
    import app.contracts.summary as S
    rec = _rec()
    monkeypatch.setattr(S, "get_llm", lambda: ("offline", None))
    off = S.summarize(rec)
    assert off["llm"] == "offline" and "■ 요약" in off["text"]
    fake = RunnableLambda(lambda _: "■ 요약: 위약금은 99.9%이고 연간 37.5억원입니다. ■ 주의할 조항: 없음 ■ 결재 전 확인할 것: 없음")
    monkeypatch.setattr(S, "get_llm", lambda: ("openai:mock", fake))
    bad = S.summarize(rec)
    assert bad["llm"].startswith("대체문") and "99.9" not in bad["text"] and "37.5억" not in bad["text"]


# ---- ⑦ 분당 토큰 한도 ----
def test_AI08_token_budget_waits_instead_of_overrunning(monkeypatch):
    from app.llm.provider import _TokenBudget
    monkeypatch.setenv("LLM_TPM", "1000"); monkeypatch.setenv("LLM_TPM_WINDOW_S", "0.6")
    b = _TokenBudget()
    t0 = time.monotonic()
    e1 = b.acquire(700)
    b.settle(e1)
    b.acquire(700)                       # 창이 비워질 때까지 기다림
    assert time.monotonic() - t0 >= 0.5
    # 429로 거절된 요청은 세지 않음(제공자도 세지 않으므로)
    b2 = _TokenBudget()
    e = b2.acquire(900)
    b2.settle(e, counted=False)
    t1 = time.monotonic()
    b2.acquire(900)
    assert time.monotonic() - t1 < 0.2


def test_AI08_estimate_counts_prompt_template():
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.runnables import RunnableLambda
    from app.llm.provider import estimate_tokens
    p = ChatPromptTemplate.from_messages([("system", "가" * 2000), ("human", "{x}")])
    assert estimate_tokens({"x": "나" * 100}, p | RunnableLambda(lambda m: m)) >= 1050


# ---- ⑥ 결재 뒤 AI 설명 보관함 ----
def test_AI07_archive_keeps_approval_and_survives_reanalysis(desk):
    c = desk.intake("CONTRACT_RENEWAL_NOTICE")[0]
    c = desk.repo.get("cases", c["id"])
    c["approval"].update({"decision": "approve", "decided_by": "MASIL_CEO", "decided_on": "2026-07-01"})
    for i in range(7):
        desk._archive(c, {"kind": "late", "text": f"■ 결론 {i}", "llm": "openai:mock"})
    assert len(c["explain_archive"]) == 5 and c["explain_archive"][-1]["text"] == "■ 결론 6"
    assert c["explain_archive"][0]["approval"]["decided_by"] == "MASIL_CEO"


# ---- §15-1 남은 일: SSO 로그아웃 주소 ----
def test_AI02_logout_url_uses_saved_id_token_once(monkeypatch):
    from app.api.sso import OIDC
    monkeypatch.setenv("OIDC_ISSUER", "http://idp.example"); monkeypatch.setenv("OIDC_CLIENT_ID", "desk"); monkeypatch.setenv("OIDC_REDIRECT_URI", "http://localhost/")
    kv: dict = {}
    o = OIDC(lambda: None, lambda fn: None, lambda fn: fn(kv))
    o._disc = (time.time(), {"end_session_endpoint": "http://idp.example/logout"})
    o.remember("sid-1", "IDT", time.time() + 60)
    u = o.logout_url("sid-1")
    assert u.startswith("http://idp.example/logout?") and "id_token_hint=IDT" in u and "post_logout_redirect_uri=" in u
    assert o.logout_url("sid-1") is None             # 한 번만


# ---- §15-2 남은 일: 실패한 전송 다시 보내기 ----
def test_AI03_retry_only_failed_and_keeps_event_id(desk, monkeypatch):
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
    eid = sent[0]
    with pytest.raises(HTTPException) as e:
        ch.retry(eid, "CONTRACT_OWNER")                  # 아직 실패가 아님
    assert e.value.status_code == 409
    ch._record(eid, {"status": "failed", "last_error": "HTTP 503"})
    assert ch.retry(eid, "CONTRACT_OWNER")["ok"] and sent == [eid, eid]
    assert kv["deliveries"]["items"][eid]["retried"] == 1
    assert any(a["topic"] == "channel.retried" for a in desk.repo.list("audit"))
    with pytest.raises(HTTPException) as e:
        ch.retry("nope", "CONTRACT_OWNER")
    assert e.value.status_code == 404


def test_AI08_offline_chain_does_not_use_token_budget(monkeypatch):
    """22차에서 찾은 결함: 잠금 안 1단계의 오프라인 설명(LLM 미사용)까지 토큰 한도를 예약해 한도의 1/3을 헛되이 씀."""
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.runnables import RunnableLambda
    import app.llm.provider as P
    monkeypatch.setenv("LLM_TPM", "10"); monkeypatch.setenv("LLM_TPM_WINDOW_S", "60")
    monkeypatch.setattr(P, "_BUDGET", P._TokenBudget())
    off = RunnableLambda(lambda v: "오프라인") | StrOutputParser()
    t0 = time.monotonic()
    for _ in range(3):
        assert P.invoke_llm(off, {"x": "가" * 500}) == "오프라인"
    assert time.monotonic() - t0 < 0.5 and P._BUDGET._log == []
