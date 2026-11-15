"""v1.30(32차 E2E, 기능 고정) — 31차(재배포 주소·실제 Chrome)에서 기록한 결함의 회귀 테스트.
AR-02 권한표에 없는 역할 · AR-03 업로드 계약서 확인 작업 · AR-04 통보 기한 미확인 · AR-05 자동 갱신 뒤 작업 · O-7 출처 · O-8 확인 요청 기한 · O-9 마스킹 기록.
화면·배포 컨테이너·MariaDB·빌드 확인은 e2e/round32."""
import pytest

SCAN_TERMS = {"filename": "scan.pdf", "counterparty": "주식회사 새솔애드", "expiry": "2026-12-31", "auto_renew": True, "renewal_years": 1,
              "annual_fee_krw": 900000000.0, "fee_basis": "연간 대행 수수료", "penalty_pct": 40.0, "payment": {"quarterly": "말일"}}


def _renewal_case(desk, terms=None):
    """업로드 경로(CONTRACT_UPLOAD)와 같은 접수 — 파일 대신 추출 결과(스캔 OCR이 통보 일수를 못 읽은 모양)를 넣는다."""
    t = {**(terms or SCAN_TERMS), "contract_id": "RC-SCAN"}
    desk.intake("CONTRACT_UPLOAD", "CONTRACT_OWNER", None, {"record": {"terms": t, "checks": [], "citations": {}}})
    return next(c for c in desk.repo.list("cases") if c["type"] == "RENEWAL")


def test_AR04_unknown_notice_deadline_is_not_the_expiry(engine):
    from app.domain.decision import Context
    d = engine.decide_renewal("RC-X", Context(renewals={"RC-X": {"terms": SCAN_TERMS, "checks": [], "citations": {}}}))
    assert d["recommendation"] == "NEEDS_INFO"
    assert d["subject"]["deadline"] is None and d["subject"]["dday"] is None
    assert "2026-12-31 전" not in d["proposal"] and "미확인" in d["proposal"]


def test_AR03_AR04_upload_needs_info_makes_an_internal_task_with_a_short_due(desk):
    c = _renewal_case(desk)
    assert c["state"] == "NEEDS_INFO"
    t = next(t for t in desk.repo.list("tasks") if t["case_id"] == c["id"] and t["kind"] == "INFO_REQUEST")
    assert t["dept"] == "CONTRACT_OWNER" and not t.get("channel") and "에이전시" not in t["title"] and "확인한 값 넣기" in t["title"]
    assert t["due"] == "2026-07-04"                               # 접수(7/1) 뒤 3일 — 만료일 기준이면 12/24였다
    from app.workflow.service import CompleteTaskCommand
    n0 = len(desk.repo.list("outbox"))
    desk.run(CompleteTaskCommand("CONTRACT_OWNER", task_id=t["id"]))
    assert len(desk.repo.list("outbox")) == n0                     # 외부 발송 없음


def test_O7_human_entered_notice_deadline_is_sourced_to_the_human(desk):
    from app.workflow.service import ContractFactsCommand
    c = _renewal_case(desk)
    r = desk.run(ContractFactsCommand("CONTRACT_OWNER", case_id=c["id"], notice_days=60, note="원문 제3조"))
    assert r["ok"], r
    c = desk.repo.get("cases", c["id"])
    assert c["decision"]["subject"]["deadline"] == "2026-11-01"
    e = next(e for e in c["decision"]["evidence"] if e["text"].startswith("해지·조건변경 통보 기한 2026-11-01"))
    assert "사람 입력" in e["source"]


def test_AR04_unknown_notice_still_auto_renews_at_expiry(desk):
    from app.workflow.service import AdvanceClockCommand
    c = _renewal_case(desk)
    desk.run(AdvanceClockCommand("GROUP_CEO", to="2027-01-01"))
    assert desk.repo.get("cases", c["id"])["state"] == "AUTO_COMMITTED"   # 기한을 몰라도 만료일이 마지막 선


def _counter_rejected(desk):
    from app.workflow.service import CompleteTaskCommand, DecideCommand, ReceiveReplyCommand
    desk.intake("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER")
    n = next(c for c in desk.repo.list("cases") if c["kind"] == "CONTRACT_RENEWAL_NOTICE")
    desk.run(DecideCommand("GROUP_CEO", case_id=n["id"], action="approve"))
    t = next(t for t in desk.repo.list("tasks") if t.get("effect") == "CONTRACT_NOTICE_SENT")
    desk.run(CompleteTaskCommand(t["dept"], task_id=t["id"]))
    desk.intake("AGENCY_COUNTER_OFFER", "CONTRACT_OWNER")
    desk.run(ReceiveReplyCommand("CONTRACT_OWNER", reply_key="agency_payment_schedule"))
    co = next(c for c in desk.repo.list("cases") if c["kind"] == "AGENCY_COUNTER_OFFER")
    desk.run(DecideCommand("GROUP_CEO", case_id=co["id"], action="reject"))
    return co


def test_AR05_auto_renewal_closes_pre_deadline_tasks_and_adds_follow_ups(desk):
    from app.workflow.service import AdvanceClockCommand, CompleteTaskCommand
    co = _counter_rejected(desk)
    term = next(t for t in desk.repo.list("tasks") if t.get("effect") == "CONTRACT_TERMINATION_SENT")
    desk.run(AdvanceClockCommand("GROUP_CEO", to="2026-07-18"))
    assert desk.ctx()["contract_status"] == "AUTO_RENEWED"
    tasks = {t["id"]: t for t in desk.repo.list("tasks")}
    assert tasks[term["id"]]["status"] == "CANCELLED"
    assert all(t["status"] != "OPEN" for t in tasks.values() if t["case_id"] == co["id"] and t["dept"] == "FINANCE" and "제외" in t["title"])
    assert all(t["status"] == "OPEN" for t in tasks.values() if t.get("effect") == "REJECT_LINKED_PLANS")   # 연계 기안 작업은 그대로
    follow = [t for t in tasks.values() if t["status"] == "OPEN" and t["title"].startswith("[기한 경과]")]
    assert {t["dept"] for t in follow} == {"CONTRACT_OWNER", "FINANCE"} and any("28억" in t["title"] for t in follow)
    r = desk.run(CompleteTaskCommand("CONTRACT_OWNER", task_id=term["id"]))
    assert not r["ok"] and "닫힌 작업" in r["error"]
    assert desk.ctx()["contract_status"] == "AUTO_RENEWED" and not any("미갱신을 통보" in m["body"] for m in desk.repo.list("outbox"))


def test_AR05_notice_task_cannot_complete_once_auto_renewed(desk):
    """작업이 어떤 이유로 열려 있더라도(예: 정리 전 저장본) 자동 갱신 상태에서는 통보 작업을 완료하지 않는다."""
    from app.workflow.service import CompleteTaskCommand
    _counter_rejected(desk)
    term = next(t for t in desk.repo.list("tasks") if t.get("effect") == "CONTRACT_TERMINATION_SENT")
    desk._set_ctx(contract_status="AUTO_RENEWED")
    r = desk.run(CompleteTaskCommand("CONTRACT_OWNER", task_id=term["id"]))
    assert not r["ok"] and "자동 갱신" in r["error"]
    assert desk.repo.get("tasks", term["id"])["status"] == "OPEN"


def test_O8_manual_info_request_due_is_seven_days_before(desk):
    from app.workflow.service import DecideCommand
    desk.intake("BUDGET_PLAN_BATCH", "MARKETING_TEAM")
    p19 = next(c for c in desk.repo.list("cases") if c.get("target_id") == "PLAN-019")
    desk.run(DecideCommand(p19["approval"]["approver"], case_id=p19["id"], action="request_info", comment="근거"))
    t = next(t for t in desk.repo.list("tasks") if t["case_id"] == p19["id"] and t["kind"] == "INFO_REQUEST")
    assert t["due"] == "2026-09-04"


def test_O9_output_trace_mentions_intake_masking(desk):
    from app.workflow.service import ReceiveReplyCommand
    desk.intake("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER")
    desk.intake("AGENCY_COUNTER_OFFER", "CONTRACT_OWNER")
    desk.run(ReceiveReplyCommand("CONTRACT_OWNER", reply_key="agency_payment_schedule"))
    co = next(c for c in desk.repo.list("cases") if c["kind"] == "AGENCY_COUNTER_OFFER")
    note = [x for x in co["trace"] if x["node"] == "security_output"][-1]["note"]
    assert "접수 단계" in note and "출력 단계 추가 마스킹" in note


def test_AR02_unknown_role_in_users_refuses_to_start(monkeypatch):
    from app.api.auth import Auth
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_SECRET", "x" * 32)
    monkeypatch.setenv("USERS", "test.aurora:Strong-pass-123:TEST_AURORA")
    with pytest.raises(ValueError, match="역할이 올바르지 않습니다"):
        Auth()
