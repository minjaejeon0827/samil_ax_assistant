"""v1.28(28차 E2E, 기능 고정) — v1.27 기능의 결함 수정 회귀 테스트: '처음부터' 이전 머리값, 전송 요청 문구, 머리값 입력 형식.
실제 MariaDB·메신저 장애·화면으로 하는 시험은 e2e/round28."""
import re


def _journey(desk):
    desk.intake("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER")
    desk.intake("FINANCE_OVERDUE_AR", "FINANCE")


def test_AO03_pre_reset_anchor_is_noted_not_forgery(desk):
    from app.workflow.service import AnchorAuditCommand
    _journey(desk)
    a = desk.run(AnchorAuditCommand("GROUP_CEO"))["anchor"]
    desk.reset()
    _journey(desk)
    for i in range(5):
        desk.intake("FREE_TEXT", "MARKETING_TEAM", f"메모 {i}")
    assert desk.repo.get("audit", a["id"])["hash"] != a["hash"]          # 같은 번호의 다른 기록
    v = desk.verify_audit([f"{a['id']}:{a['hash']}"])
    assert v["ok"] and not v["broken"] and "처음부터" in v["notes"][0]["note"]


def test_AO03_unknown_hash_after_reset_is_still_forgery(desk):
    from app.workflow.service import AnchorAuditCommand
    _journey(desk)
    desk.run(AnchorAuditCommand("GROUP_CEO"))
    desk.reset()
    _journey(desk)
    v = desk.verify_audit(["AU-0002:" + "b" * 64])                      # 어떤 체인에서도 보낸 적 없는 해시
    assert not v["ok"] and "위조" in v["broken"][0]["reason"]


def test_AO04_anchor_audit_says_requested_not_sent(desk):
    from app.workflow.service import AnchorAuditCommand
    _journey(desk)
    r = desk.run(AnchorAuditCommand("GROUP_CEO"))
    d = next(x["detail"] for x in desk.repo.list("audit") if x["topic"] == "audit.anchor")
    assert "보냄" not in d and "전송 요청" in d and "보냈" not in r["info"]


def test_AO05_anchor_format_regex():
    from app.main import ANCHOR_RE
    ok = "AU-0042:" + "a" * 64
    assert ANCHOR_RE.fullmatch(ok)
    for bad in ("AU-0042", "AU-0042:", "AU-0042:abc", "AU-0042:" + "g" * 64, "AU-0042:" + "a" * 65, "x' OR 1=1:" + "a" * 64):
        assert not ANCHOR_RE.fullmatch(bad), bad
    assert re.fullmatch(r"AU-\d{1,9}:[0-9a-f]{64}", ok)
