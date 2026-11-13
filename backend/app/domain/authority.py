"""승인 권한 판정 — 책임 연쇄(Chain of Responsibility) 패턴.

approval_authority_policy.md의 규칙을 처리자(handler) 사슬로 옮겼다.
각 처리자는 자기 규칙에 해당하면 승인자를 '상향'하고 근거(trace)를 남긴 뒤 다음 처리자에게 넘긴다.
마지막 처리자인 covenant 우선 규정은 금액과 무관하게 그룹 CEO로 올리며 평시 전결을 무효화한다.

판단 순서(정책 원문): ① 재전망으로 하회 구간 특정 → ② 현금 유출일이 구간에 들어가는지 대조 → ③ 들어가면 그룹 상신.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Literal

Role = Literal["MARKETING_TEAM", "MASIL_CEO", "GROUP_CEO"]
RANK = {"MARKETING_TEAM": 1, "MASIL_CEO": 2, "GROUP_CEO": 3}
SRC = "00_common/approval_authority_policy.md"


@dataclass
class Commitment:
    """승인 대상 약정 한 건."""
    ref_id: str
    kind: Literal["CAMPAIGN_PLAN", "EXCLUSIVE_CONTRACT", "AUTO_RENEWAL_CONTRACT"]
    amount_krw: float
    cash_out_dates: list[str] | None  # None = 지급 일정 미확인
    plan_total_krw: float = 0.0
    annual_fee_krw: float = 0.0


@dataclass
class AuthorityDecision:
    approver: Role = "MARKETING_TEAM"
    group_report: bool = False
    covenant_override: bool = False
    needs_info: list[str] = field(default_factory=list)
    trace: list[dict] = field(default_factory=list)

    def raise_to(self, role: Role, rule: str, why: str) -> None:
        before = self.approver
        if RANK[role] > RANK[self.approver]:
            self.approver = role
        self.trace.append({"rule": rule, "result": role, "before": before, "why": why, "source": SRC})

    def to_dict(self) -> dict:
        return self.__dict__.copy()


class AuthorityHandler(ABC):
    def __init__(self) -> None:
        self._next: AuthorityHandler | None = None

    def set_next(self, h: "AuthorityHandler") -> "AuthorityHandler":
        self._next = h
        return h

    def handle(self, c: Commitment, ctx: dict, dec: AuthorityDecision) -> AuthorityDecision:
        self.apply(c, ctx, dec)
        return self._next.handle(c, ctx, dec) if self._next else dec

    @abstractmethod
    def apply(self, c: Commitment, ctx: dict, dec: AuthorityDecision) -> None: ...


class CampaignAmountHandler(AuthorityHandler):
    def apply(self, c, ctx, dec):
        if c.kind != "CAMPAIGN_PLAN":
            return
        lim_item = ctx["policy"]["authority"]["campaign_item_team_limit_krw"]
        lim_total = ctx["policy"]["authority"]["campaign_plan_total_ceo_report_krw"]
        if c.amount_krw <= lim_item and c.plan_total_krw <= lim_total:
            dec.raise_to("MARKETING_TEAM", "캠페인 건별 1천만원 이하", "마케팅팀 전결")
            return
        why = []
        if c.amount_krw > lim_item:
            why.append(f"건별 {c.amount_krw/1e4:,.0f}만원 > 1천만원")
        if c.plan_total_krw > lim_total:
            why.append(f"기안 총액 {c.plan_total_krw/1e8:.2f}억 > 1억")
        dec.raise_to("MASIL_CEO", "캠페인 확대안 집행", " · ".join(why) + " → Masil 대표 승인 + 그룹 보고")
        dec.group_report = True


class ExclusiveContractHandler(AuthorityHandler):
    def apply(self, c, ctx, dec):
        if c.kind != "EXCLUSIVE_CONTRACT":
            return
        lim = ctx["policy"]["authority"]["exclusive_contract_ceo_limit_krw"]
        if c.annual_fee_krw > lim:
            dec.raise_to("GROUP_CEO", "인플루언서 연간 전속계약 체결·갱신",
                         f"연 {c.annual_fee_krw/1e8:.0f}억 > 10억 → CEO/이사회 (미통보 자동 갱신도 체결로 봄)")
        else:
            dec.raise_to("MASIL_CEO", "인플루언서 연간 전속계약 체결·갱신", "연 10억 이하 → Masil 대표")


class AutoRenewalContractHandler(AuthorityHandler):
    """v1.21(PRD §15-4): 물류·대행사 등 다른 자동 갱신 계약. 권한표에 이 유형의 구간이 없어, 가장 가까운 규정
    (연간 전속계약 — '미통보 자동 갱신도 체결로 본다', 연 10억 기준)을 준용한다[가정 A-23]. 근거에 준용 사실을 남긴다."""

    def apply(self, c, ctx, dec):
        if c.kind != "AUTO_RENEWAL_CONTRACT":
            return
        lim = ctx["policy"]["authority"]["exclusive_contract_ceo_limit_krw"]
        rule = "자동 갱신 계약 체결·갱신(전속계약 구간 준용, 가정 A-23)"
        if c.annual_fee_krw > lim:
            dec.raise_to("GROUP_CEO", rule, f"연 {c.annual_fee_krw/1e8:.2f}억 > 10억 → CEO/이사회 (미통보 자동 갱신도 체결로 봄)")
        else:
            dec.raise_to("MASIL_CEO", rule, f"연 {c.annual_fee_krw/1e8:.2f}억 ≤ 10억 → Masil 대표")


class CovenantWindowHandler(AuthorityHandler):
    """우선 규정: 하회 예상 구간에 현금이 나가는 신규 약정은 금액·종류 불문 그룹 CEO."""

    def apply(self, c, ctx, dec):
        window = ctx.get("covenant_window")
        if not window:
            dec.trace.append({"rule": "covenant 하회 구간 우선 규정", "result": "해당 없음",
                              "before": dec.approver, "why": "재전망상 하회 구간 없음",
                              "source": "02_masil/financials/covenant_terms_ms.md"})
            return
        if c.cash_out_dates is None:
            dec.needs_info.append("지급 일정(현금 유출일) 미확인 — 하회 구간(%s~%s) 포함 여부 판정 불가" % tuple(window))
            dec.trace.append({"rule": "covenant 하회 구간 우선 규정", "result": "판정 보류",
                              "before": dec.approver, "why": "현금 유출일이 없어 ②단계 대조 불가",
                              "source": "02_masil/financials/covenant_terms_ms.md"})
            return
        hits = [x for x in c.cash_out_dates if window[0] <= x <= window[1]]
        if hits:
            dec.covenant_override = True
            dec.raise_to("GROUP_CEO", "covenant 하회 구간 우선 규정",
                         f"유출일 {', '.join(hits)} ∈ 하회 구간 {window[0]}~{window[1]} → 금액·종류 불문 그룹 CEO (평시 전결 효력 상실)")
        else:
            dec.trace.append({"rule": "covenant 하회 구간 우선 규정", "result": "해당 없음",
                              "before": dec.approver,
                              "why": f"유출일 {', '.join(c.cash_out_dates)} 은 하회 구간 밖",
                              "source": "02_masil/financials/covenant_terms_ms.md"})


def build_chain() -> AuthorityHandler:
    head = CampaignAmountHandler()
    head.set_next(ExclusiveContractHandler()).set_next(AutoRenewalContractHandler()).set_next(CovenantWindowHandler())
    return head


def resolve_authority(c: Commitment, policy: dict, covenant_window: tuple[str, str] | list | None) -> AuthorityDecision:
    return build_chain().handle(c, {"policy": policy, "covenant_window": covenant_window}, AuthorityDecision())
