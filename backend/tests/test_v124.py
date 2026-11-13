"""v1.24(24차 E2E) — §15 남은 일(응답 헤더 한도·요약 평점)·확인 필요의 끝맺음 회귀 테스트. 화면·서버 2대 흐름은 e2e/round24."""
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VAR = ROOT / "data" / "samples" / "contracts" / "variants"


def _upload(desk, name):
    from app.contracts.extract import extract, read_text
    p = VAR / name
    r = extract(read_text(name, p.read_bytes()), name, "2026-07-01")
    desk.intake("CONTRACT_UPLOAD", "CONTRACT_OWNER", None, {"record": {k: r[k] for k in ("terms", "checks", "citations")}})
    return next(c for c in desk.repo.list("cases") if c["type"] == "RENEWAL" and c["target_id"] == r["terms"]["contract_id"])


# ---- AK04: 확인 필요 → 사람이 확인한 값 → 다시 판단 ----
def test_AK04_fx_contract_resolved_by_finance(desk):
    from app.workflow.service import ContractFactsCommand
    c = _upload(desk, "freight_en_usd.md")
    assert c["state"] == "NEEDS_INFO"
    r = desk.run(ContractFactsCommand("FINANCE", case_id=c["id"], annual_fee_krw=1324800000, note="USD 80,000 × 12 × 1,380원"))
    c2 = r["case"]
    assert r["ok"] and c2["state"] == "PENDING_APPROVAL" and c2["approval"]["approver"] == "GROUP_CEO"
    assert any(e["kind"] == "CLAIM" and "사람 입력" in e["text"] for e in c2["decision"]["evidence"])
    rec = desk._renewal(c["target_id"])
    assert rec["terms"]["provided"]["annual_fee_krw"]["by"] == "FINANCE"
    assert any(k["id"] == "FX_CONVERTED" for k in rec["checks"]) and not any(k["id"] == "FOREIGN_CURRENCY" for k in rec["checks"])


def test_AK04_unknown_renewal_resolved_and_permission(desk):
    from app.workflow.service import ContractFactsCommand
    c = _upload(desk, "service_kr_no_clause.md")
    bad = desk.run(ContractFactsCommand("MARKETING_TEAM", case_id=c["id"], auto_renew=True, notice_days=30, note="x"))
    assert not bad["ok"] and bad["forbidden"]
    r = desk.run(ContractFactsCommand("CONTRACT_OWNER", case_id=c["id"], auto_renew=True, notice_days=30, note="원문 확인"))
    t = desk._renewal(c["target_id"])["terms"]
    assert r["case"]["state"] == "PENDING_APPROVAL" and t["notice_deadline"] == "2026-12-01"


def test_AK04_quarterly_payment_parsed():
    from app.contracts.extract import extract, read_text
    for name in ("service_kr_no_clause.md", "service_en_fixed_term.md"):
        t = extract(read_text(name, (VAR / name).read_bytes()), name, "2026-07-01")["terms"]
        assert t["payment"] == {"quarterly": "말일"} and t["cash_out_dates"] == ["2027-03-31", "2027-06-30", "2027-09-30", "2027-12-31"]


# ---- AK03: 요약 평점 ----
def test_AK03_summary_feedback_one_vote_per_person(desk):
    from app.api.auth import CURRENT_USER
    from app.workflow.service import SummaryFeedbackCommand
    from app.contracts.extract import extract, read_text
    p = ROOT / "data" / "samples" / "contracts" / "agency_media_renewal.md"
    r = extract(read_text(p.name, p.read_bytes()), p.name, "2026-07-01")
    rec = {k: r[k] for k in ("terms", "checks", "citations")}
    rec["summary"] = {"text": "■ 요약: 테스트", "llm": "offline", "judge": None}
    desk.intake("CONTRACT_UPLOAD", "CONTRACT_OWNER", None, {"record": rec})
    c = next(x for x in desk.repo.list("cases") if x["type"] == "RENEWAL")
    v0 = c["version"]
    for user, role, rating in (("a", "GROUP_CEO", "up"), ("b", "FINANCE", "down"), ("b", "FINANCE", "up")):
        CURRENT_USER.set(user)
        assert desk.run(SummaryFeedbackCommand(role, case_id=c["id"], rating=rating, note="n"))["ok"]
    CURRENT_USER.set(None)
    fb = desk.summary_feedback(c["id"])
    assert (fb["total"], fb["up"], fb["down"]) == (2, 2, 0)
    assert desk.repo.get("cases", c["id"])["version"] == v0     # 결재 서류의 판 번호는 그대로(결재자 409 방지)


# ---- AK02: 응답 헤더로 한도 맞춤 ----
def test_AK02_header_budget_waits_and_disables_without_headers():
    from app.llm.provider import _HeaderBudget, _secs
    assert (_secs("6m0s"), _secs("1.5s"), _secs("20ms")) == (360.0, 1.5, 0.02)
    b = _HeaderBudget()
    e = b.acquire(100)                            # 첫 요청(확인용)
    b.settle(e, headers={"x-ratelimit-remaining-tokens": "150", "x-ratelimit-reset-tokens": "0.5s"})
    e2 = b.acquire(100)                           # 150 남음 → 보냄
    t0 = time.monotonic()
    got = []
    th = threading.Thread(target=lambda: got.append(b.acquire(100)))   # 50 남음 → 초기화 시각까지 기다림
    th.start(); th.join(2)
    assert got and time.monotonic() - t0 >= 0.4
    b.settle(e2); b.settle(got[0])
    nb = _HeaderBudget()
    nb.settle(nb.acquire(10), headers={})         # 헤더를 주지 않는 제공자 → 기다리지 않음
    assert nb.absent and nb.acquire(10) is None
