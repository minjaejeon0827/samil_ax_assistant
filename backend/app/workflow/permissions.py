"""권한 정책 — 누가 무엇을 할 수 있는가(한곳에 모음).

8차 E2E(P-01·P-02)에서 확인한 결함: 결재(승인·거절)만 서버가 권한을 확인했다. 부서 작업 완료, 현금 가정 변경,
카피 수정, 사건 접수, 에이전시 회신 입력, 시계 진행은 화면에서 버튼만 막고 서버는 확인하지 않았다. 그래서 로그인
모드에서도 마케팅팀이 계약 담당의 '조건변경 통보 발송'을 완료해 실제 발송(모의)이 일어났다.

- COMMAND_ROLES: 서비스가 모든 모드에서 확인(브라우저 엔진 desk.ts도 같은 규칙)
- 부서 작업은 그 작업의 담당 부서만 완료
- LOGIN_ONLY: 로그인 모드에서만 확인(실제 사람이 정해질 때 의미가 있는 '누가 일으키는가' 규칙)
"""
from __future__ import annotations

ALL = ("MARKETING_TEAM", "MASIL_CEO", "GROUP_CEO", "FINANCE", "SCM", "CONTRACT_OWNER")

COMMAND_ROLES: dict[str, tuple[str, ...]] = {
    "change_condition": ("FINANCE", "SYSTEM"),      # 현금 전망 가정(SYSTEM: 재무 회신 사건이 내부에서 호출)
    "apply_fix": ("MARKETING_TEAM",),                # 광고 카피 수정은 기안 부서
    "contract_facts": ("FINANCE", "CONTRACT_OWNER", "GROUP_CEO"),   # 24차: 확인 필요 계약에 확인한 값(원화 금액·갱신 여부) 입력
    "audit_anchor": ("GROUP_CEO", "SYSTEM"),        # 27차: 감사 기록 머리값을 메신저(밖)로 보내기(SYSTEM: AUDIT_ANCHOR_S 주기 기록)
}

LOGIN_ONLY: dict[str, tuple[str, ...]] = {
    "intake:CONTRACT_RENEWAL_NOTICE": ("CONTRACT_OWNER", "GROUP_CEO"),
    "intake:BUDGET_PLAN_BATCH": ("MARKETING_TEAM", "MASIL_CEO"),
    "intake:AGENCY_COUNTER_OFFER": ("CONTRACT_OWNER",),
    "intake:MARKETING_CLAIM": ("MARKETING_TEAM",),
    "intake:FINANCE_OVERDUE_AR": ("FINANCE",),
    "intake:FREE_TEXT": ALL,
    "intake:CONTRACT_UPLOAD": ("CONTRACT_OWNER", "GROUP_CEO"),   # v1.21: 계약서 업로드(계약 담당·그룹)
    "channel:retry": ("CONTRACT_OWNER", "GROUP_CEO"),            # v1.22: 실패한 외부 전송 다시 보내기
    "reply": ("CONTRACT_OWNER",),          # 외부(에이전시) 회신을 받아 입력하는 사람
    "clock": ("GROUP_CEO",),               # 시뮬레이션 시계 — 기한 경과 자동 확정을 일으키므로 관리자만
    "reset": ("GROUP_CEO",),               # 전체 초기화
}

LABEL = {"audit_anchor": "감사 기록 머리값 기록", "contract_facts": "계약서 확인값 입력", "change_condition": "현금 전망 가정 변경", "apply_fix": "광고 카피 수정", "reply": "에이전시 회신 입력",
         "clock": "시계 진행", "reset": "처음부터(전체 초기화)"}


def allowed(action: str, role: str) -> bool:
    roles = COMMAND_ROLES.get(action) or LOGIN_ONLY.get(action)
    return roles is None or role in roles


def label(action: str) -> str:
    if action.startswith("intake:"):
        return f"사건 접수({action.split(':', 1)[1]})"
    return LABEL.get(action, action)


def roles_for(action: str) -> tuple[str, ...]:
    return COMMAND_ROLES.get(action) or LOGIN_ONLY.get(action) or ALL
