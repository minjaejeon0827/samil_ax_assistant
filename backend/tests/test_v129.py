"""v1.29(30차 E2E, 기능 고정) — 29차(배포 주소·실제 Chrome)에서 기록한 결함의 회귀 테스트.
AP-03 확인 요청 권한 · AP-04 확인 작업 부서 · AP-05 같은 회신 재접수 · AP-06 보류 사유 · AP-07 카피 게이트 · AP-08 감사 문구 ·
AP-01 PDF 구성 요소 · AP-02 USERS 경고 · O-3 한 줄 당사자 · O-4 기한 경과 문구 · O-5 회신 감사 순서.
화면·배포 컨테이너·MariaDB로 하는 시험은 e2e/round30."""
import builtins
import os

import pytest


def _counter_pending(desk):
    from app.workflow.service import ReceiveReplyCommand
    desk.intake("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER")
    desk.intake("AGENCY_COUNTER_OFFER", "CONTRACT_OWNER")
    assert desk.run(ReceiveReplyCommand("CONTRACT_OWNER", reply_key="agency_payment_schedule"))["ok"]
    return next(c for c in desk.repo.list("cases") if c["kind"] == "AGENCY_COUNTER_OFFER")


def test_AP03_only_the_approver_can_request_info(desk):
    from app.workflow.service import DecideCommand
    co = _counter_pending(desk)
    r = desk.run(DecideCommand("CONTRACT_OWNER", case_id=co["id"], action="request_info"))
    assert not r["ok"] and r["forbidden"] and "결재권자" in r["error"]
    assert desk.repo.get("cases", co["id"])["state"] == "PENDING_APPROVAL"


def test_AP04_AP08_info_task_goes_to_the_drafting_dept_and_audit_names_the_case(desk):
    from app.workflow.service import DecideCommand
    co = _counter_pending(desk)
    assert desk.run(DecideCommand("GROUP_CEO", case_id=co["id"], action="request_info", comment="지급 일정 근거 재확인"))["ok"]
    t = next(t for t in desk.repo.list("tasks") if t["case_id"] == co["id"] and t["kind"] == "INFO_REQUEST" and t["status"] == "OPEN")
    assert t["dept"] == "CONTRACT_OWNER"
    a = [x for x in desk.repo.list("audit") if x["topic"] == "case.info_requested"][-1]
    assert a["detail"] == f"{co['title']} 확인 요청 — 지급 일정 근거 재확인"


def test_AP05_same_reply_twice_is_refused_and_manual_hold_stays(desk):
    from app.workflow.service import DecideCommand, ReceiveReplyCommand
    co = _counter_pending(desk)
    desk.run(DecideCommand("GROUP_CEO", case_id=co["id"], action="request_info", comment="근거"))
    r = desk.run(ReceiveReplyCommand("CONTRACT_OWNER", reply_key="agency_payment_schedule"))
    assert not r["ok"] and "이미 받은 회신" in r["error"]
    c = desk.repo.get("cases", co["id"])
    assert c["state"] == "NEEDS_INFO" and c["hold_reason"] == "MANUAL"
    assert any(t["case_id"] == co["id"] and t["kind"] == "INFO_REQUEST" and t["status"] == "OPEN" for t in desk.repo.list("tasks"))


def test_AP06_released_hold_is_rechecked_by_the_next_condition_change(desk):
    from app.workflow.service import ChangeConditionCommand, CompleteTaskCommand, DecideCommand
    co = _counter_pending(desk)
    desk.run(DecideCommand("GROUP_CEO", case_id=co["id"], action="request_info", comment="근거"))
    desk.run(ChangeConditionCommand("FINANCE", cash_assumption="CONSERVATIVE"))
    assert desk.repo.get("cases", co["id"])["state"] == "NEEDS_INFO"                     # D-10 유지
    t = next(t for t in desk.repo.list("tasks") if t["case_id"] == co["id"] and t["kind"] == "INFO_REQUEST" and t["status"] == "OPEN")
    desk.run(CompleteTaskCommand("CONTRACT_OWNER", task_id=t["id"]))
    c = desk.repo.get("cases", co["id"])
    assert c["state"] == "PENDING_APPROVAL" and "hold_reason" not in c
    assert c["decision"]["cash"]["window"][1] == "2026-08-28"                           # 보수 가정으로 다시 판단됨
    desk.run(ChangeConditionCommand("FINANCE", cash_assumption="AS_IS"))
    c = desk.repo.get("cases", co["id"])
    assert c["decision"]["cash"]["window"][1] == "2026-08-21" and "재검증" in c["history"][-3]["note"] + c["history"][-2]["note"] + c["history"][-1]["note"]


def test_AP06_transition_out_of_needs_info_always_clears_the_reason(desk):
    case = {"state": "NEEDS_INFO", "hold_reason": "MANUAL", "history": []}
    desk._transition(case, "receive_reply", "RECEIVED", "SYSTEM", "test")
    assert "hold_reason" not in case


def test_AP07_copy_violation_with_supply_constraint_needs_the_fix_first(desk):
    from app.workflow.service import ApplyFixCommand, DecideCommand
    desk.intake("BUDGET_PLAN_BATCH", "MARKETING_TEAM")
    p11 = next(c for c in desk.repo.list("cases") if c.get("target_id") == "PLAN-011")
    assert p11["state"] == "ACTION_REQUIRED" and "공급 제약" in p11["decision"]["label"]
    assert not desk.run(DecideCommand("MASIL_CEO", case_id=p11["id"], action="approve"))["ok"]
    assert desk.run(ApplyFixCommand("MARKETING_TEAM", case_id=p11["id"]))["ok"]
    p11 = desk.repo.get("cases", p11["id"])
    assert p11["state"] == "PENDING_APPROVAL" and p11["decision"]["recommendation"] == "HOLD_SUPPLY"
    assert any(t["dept"] == "SCM" for t in p11["decision"]["on_reject"])


def test_AP07_violating_copy_cannot_be_approved_even_against_a_reject_recommendation(desk):
    from app.workflow.service import DecideCommand
    desk.intake("BUDGET_PLAN_BATCH", "MARKETING_TEAM")
    p01 = next(c for c in desk.repo.list("cases") if c.get("target_id") == "PLAN-001")
    assert p01["state"] == "PENDING_APPROVAL" and p01["decision"]["regulation"]["findings"]
    r = desk.run(DecideCommand(p01["approval"]["approver"], case_id=p01["id"], action="approve"))
    assert not r["ok"] and "카피 위반" in r["error"]
    assert desk.run(DecideCommand(p01["approval"]["approver"], case_id=p01["id"], action="reject"))["ok"]


def test_O5_reply_is_audited_before_its_result(desk):
    co = _counter_pending(desk)
    topics = [(a["topic"], a.get("case_id")) for a in desk.repo.list("audit")]
    i_reply = max(i for i, t in enumerate(topics) if t[0] == "reply.received")
    i_result = max(i for i, t in enumerate(topics) if t == ("case.analyzed", co["id"]))
    assert i_reply < i_result


def test_O4_expiry_after_a_change_terms_notice_says_so(desk):
    from app.workflow.service import AdvanceClockCommand, CompleteTaskCommand, DecideCommand, ReceiveReplyCommand
    desk.intake("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER")
    n = next(c for c in desk.repo.list("cases") if c["kind"] == "CONTRACT_RENEWAL_NOTICE")
    desk.run(DecideCommand("GROUP_CEO", case_id=n["id"], action="approve"))
    t = next(t for t in desk.repo.list("tasks") if t.get("effect") == "CONTRACT_NOTICE_SENT")
    desk.run(CompleteTaskCommand(t["dept"], task_id=t["id"]))
    desk.intake("AGENCY_COUNTER_OFFER", "CONTRACT_OWNER")
    desk.run(ReceiveReplyCommand("CONTRACT_OWNER", reply_key="agency_payment_schedule"))
    co = next(c for c in desk.repo.list("cases") if c["kind"] == "AGENCY_COUNTER_OFFER")
    desk.run(DecideCommand("GROUP_CEO", case_id=co["id"], action="reject"))
    desk.run(AdvanceClockCommand("GROUP_CEO", to="2026-07-18"))
    d = [a for a in desk.repo.list("audit") if a["topic"] == "deadline.expired" and "INF-001 통보 기한" in a["detail"]][-1]["detail"]
    assert "미갱신 통보 미발송(조건변경 통보는 2026-07-01 발송" in d and "법무 확인" in d


def test_O3_one_line_party_clause_reads_the_counterparty():
    from app.contracts.extract import extract
    text = ('계약 당사자: 주식회사 마실커머스(이하 "갑")와 주식회사 한결물류(이하 "을")\n'
            "제2조(계약 기간) 계약 기간은 2025년 9월 30일부터 2026년 9월 30일까지로 한다.\n")
    assert extract(text, "a.md", "2026-07-01")["terms"]["counterparty"] == "주식회사 한결물류"


def test_AP01_missing_pdf_module_is_a_server_problem_not_the_users_file(monkeypatch):
    from app.contracts import extract as ex
    real = builtins.__import__

    def fake(name, *a, **k):
        if name == "pypdf":
            raise ModuleNotFoundError("No module named 'pypdf'")
        return real(name, *a, **k)
    monkeypatch.setattr(builtins, "__import__", fake)
    with pytest.raises(ex.ContractError) as e:
        ex.read_text_ex("x.pdf", b"%PDF-1.4 whatever")
    assert e.value.status == 503 and "서버" in str(e.value) and "스캔" not in str(e.value)


def test_AP01_health_reports_pdf_readiness():
    from app.contracts.extract import readiness
    r = readiness()
    assert r["pdf"] is True and set(r) == {"pdf", "ocr"}


def test_AP02_weak_shared_plaintext_users_warn_without_values(monkeypatch, capsys):
    from app.api.auth import Auth
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_SECRET", "x" * 32)
    monkeypatch.setenv("USERS", "ceo.kang:demo1234:GROUP_CEO;contract.park:demo1234:CONTRACT_OWNER")
    Auth()
    err = capsys.readouterr().err
    assert "USERS" in err and "공용" in err and "규칙" in err and "demo1234" not in err and "ceo.kang" not in err


def test_R30_01_auto_renewal_without_a_notice_deadline_stops_for_info(engine):
    """30차에서 새로 찾음: 스캔 OCR이 통보 일수('60일')를 못 읽으면 만료일을 통보 기한처럼 올렸다 → 이제 '확인 필요'."""
    from app.domain.decision import Context
    terms = {"filename": "scan.pdf", "counterparty": "주식회사 새솔애드", "expiry": "2026-12-31", "auto_renew": True, "renewal_years": 1,
             "annual_fee_krw": 900000000.0, "fee_basis": "연간 대행 수수료", "penalty_pct": 40.0, "payment": {"quarterly": "말일"}}
    d = engine.decide_renewal("RC-X", Context(renewals={"RC-X": {"terms": terms, "checks": [], "citations": {}}}))
    assert d["recommendation"] == "NEEDS_INFO" and d["approver"] is None
    assert any("통보 기한 미확인" in n for n in d["needs_info"])
