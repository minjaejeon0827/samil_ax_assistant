"""상태(State) 패턴 — 처리 건(Case)의 생애주기와 허용 전이.

상태 객체가 '이 상태에서 무엇을 할 수 있는가'를 스스로 안다. 허용되지 않은 명령은 거부되고
감사 로그에 남는다(예: 승인대기가 아닌 건에 승인 버튼, 권한 없는 역할의 승인).

  RECEIVED → ANALYZING → PENDING_APPROVAL ─approve→ APPROVED
                     │                     └reject→ REJECTED
                     ├→ NEEDS_INFO ─reply→ ANALYZING        (정보 부족: 확인 요청 후 정지)
                     ├→ ACTION_REQUIRED ─fix→ ANALYZING      (카피 수정 필요: 확장 게이트)
                     ├→ HOLD_LINKED ─contract decided→ ...   (상위 전속계약 대기)
                     ├→ BLOCKED / NEEDS_CLARIFICATION        (check_input)
  PENDING_APPROVAL ─condition change→ SUPERSEDED → ANALYZING (조건 변경 재검증)
  미결정 상태에서 기한 경과 → AUTO_COMMITTED (묵시적 승인 = 승인 없는 체결, 위반 기록)
"""
from __future__ import annotations

from abc import ABC


class InvalidTransition(Exception):
    pass


class CaseStateBase(ABC):
    name = "BASE"
    label = ""
    allowed: frozenset[str] = frozenset()
    terminal = False
    open_decision = False  # 기한 감시 대상(아직 사람이 결정하지 않음)

    def check(self, command: str) -> None:
        if command not in self.allowed:
            raise InvalidTransition(f"'{self.label}' 상태에서는 '{command}'를 할 수 없습니다.")


def _s(name, label, allowed, terminal=False, open_decision=False):
    return type(name, (CaseStateBase,), {"name": name, "label": label, "allowed": frozenset(allowed),
                                          "terminal": terminal, "open_decision": open_decision})


STATES: dict[str, type[CaseStateBase]] = {s.name: s for s in [
    _s("RECEIVED", "접수", {"analyze"}, open_decision=True),
    _s("ANALYZING", "분석 중", {"analysis_done"}, open_decision=True),
    _s("PENDING_APPROVAL", "승인 대기", {"approve", "reject", "request_info", "supersede", "expire"}, open_decision=True),
    _s("NEEDS_INFO", "확인 필요", {"receive_reply", "supersede", "expire"}, open_decision=True),
    _s("ACTION_REQUIRED", "수정 필요", {"apply_fix", "reject", "supersede", "expire"}, open_decision=True),
    _s("HOLD_LINKED", "상위 계약 대기", {"linked_resolved", "supersede", "expire"}, open_decision=True),
    _s("SUPERSEDED", "재검증 대기", {"analyze"}, open_decision=True),
    _s("APPROVED", "승인", {"supersede_after_approval"}, terminal=True),
    _s("REJECTED", "거절·부결", set(), terminal=True),
    _s("BLOCKED", "차단", set(), terminal=True),
    _s("NEEDS_CLARIFICATION", "재입력 요청", set(), terminal=True),
    _s("AUTO_COMMITTED", "기한 경과 자동 확정", set(), terminal=True),
    _s("REPLACED", "새 건으로 대체", set(), terminal=True),
]}


def state_of(name: str) -> CaseStateBase:
    return STATES[name]()


def next_state_for(decision: dict, pipeline_status: str) -> str:
    """분석 결과 → 다음 상태."""
    if pipeline_status == "blocked":
        return "BLOCKED"
    if pipeline_status == "needs_clarification":
        return "NEEDS_CLARIFICATION"
    if decision.get("needs_info"):
        return "NEEDS_INFO"
    reco = decision.get("recommendation")
    if reco == "HOLD_COPY":
        return "ACTION_REQUIRED"
    if reco == "HOLD_LINKED":
        return "HOLD_LINKED"
    return "PENDING_APPROVAL"
