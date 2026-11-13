"""판단 엔진 — 계약 갱신·캠페인 확대 기안을 '같은 자'(실질 공헌이익·현금·권한·규제·공급)로 판단한다.

출력은 사람이 승인할 수 있는 '결정 패키지'다.
  proposal       : 승인 대상(무엇을 하겠다는 것인지)
  recommendation : AI 권고(APPROVE / CHANGE_TERMS / REJECT / HOLD_* / NEEDS_INFO)
  evidence       : 근거 목록 — kind(ORIGINAL·CALC·ASSUMPTION·CLAIM·MOCK)·scale(SAMPLE·FULL)·source
  alternatives   : 대안
  authority      : 승인자와 판정 경로(책임 연쇄 trace)
  needs_info     : 확인이 필요한 공백(있으면 승인 요청 대신 확인 요청을 먼저 만든다)
  on_approve / on_reject : 사람의 결정 이후 자동 생성될 작업(부서·기한)

표본(SAMPLE) 값과 풀스케일(FULL) 금액은 곱하지 않고 나란히 놓는다(data_dictionary §6).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from ..validation.regulation import regulation_detail
from .authority import Commitment, resolve_authority
from .cash import AS_OF, LegacyTerms45, ScheduleAsIs, forecast
from .data import DataRoom, num
from .metrics import allocation_alignment, campaign_performance, half_year_trend, influencer_performance
from .supply import category_supply

HOLD_STATUSES = {"UNDER_REVIEW", "NOTICE_APPROVED", "NOTICE_SENT", "COUNTER_OFFER"}
TERMINATED_STATUSES = {"TERMINATION_APPROVED", "TERMINATION_SENT", "TERMINATED"}

CASH_ASSUMPTIONS = {
    "AS_IS": lambda: ScheduleAsIs(),
    "CONSERVATIVE": lambda: ScheduleAsIs(include_overdue=False),
    "LEGACY45": lambda: LegacyTerms45(),
}


ROLE_KO_SHORT = {"FINANCE": "재무팀", "CONTRACT_OWNER": "계약 담당", "GROUP_CEO": "그룹 CEO", "MASIL_CEO": "Masil 대표", "MARKETING_TEAM": "마케팅팀"}


def ev(kind: str, text: str, source: str, scale: str = "NA", **kw) -> dict:
    return {"kind": kind, "text": text, "source": source, "scale": scale, **kw}


def won(x: float) -> str:
    if abs(x) >= 1e8:
        return f"{x/1e8:,.2f}억원"
    return f"{x/1e4:,.0f}만원"


def pct(x: float) -> str:
    return f"{x*100:.1f}%"


def task(dept: str, title: str, due: str | None = None, kind: str = "ACTION", **kw) -> dict:
    return {"dept": dept, "title": title, "due": due, "kind": kind, **kw}


@dataclass
class Context:
    """판단 시점의 조건. 조건이 바뀌면(사건) 이 값이 바뀌고 같은 엔진으로 재판단한다."""
    today: str = AS_OF.isoformat()
    cash_assumption: str = "AS_IS"
    contract_status: str = "UNDER_REVIEW"     # INF-001 상위 계약 상태
    offer: dict | None = None                 # 검토 중인 계약 조건(에이전시 역제안 등)
    copy_overrides: dict | None = None        # 수정된 광고 카피
    claims: list | None = None                # 부서 주장(사실 아님)
    renewals: dict | None = None              # v1.21: 업로드한 자동 갱신 계약의 추출 조건(계약 ID → terms)


class DecisionEngine:
    def __init__(self, dr: DataRoom):
        self.dr = dr
        self.policy = dr.policy
        self._camp = campaign_performance(dr)
        self._inf = influencer_performance(dr)
        self._align = allocation_alignment(self._inf)
        self._trend = half_year_trend(dr)
        self._supply = category_supply(dr)
        self._plans = {p["plan_id"]: p for p in dr.table("budget_plan")}
        self._plan_total = sum(num(p["requested_budget_krw"]) for p in self._plans.values())
        self._fc_cache: dict[str, object] = {}

    # ---------- 공통 사실 ----------
    def cash(self, ctx: Context, extra: list[dict] | None = None):
        key = ctx.cash_assumption
        if extra:
            return forecast(self.dr, CASH_ASSUMPTIONS[key](), extra)
        if key not in self._fc_cache:
            self._fc_cache[key] = forecast(self.dr, CASH_ASSUMPTIONS[key]())
        return self._fc_cache[key]

    def facts(self) -> dict:
        return {"influencers": self._inf, "campaigns": {k: v.to_dict() for k, v in self._camp.items()},
                "alignment": self._align, "trend": self._trend, "supply": self._supply,
                "plan_total": self._plan_total}

    def _contract(self) -> dict:
        return self.policy["contracts"][0]

    # ---------- 전속계약 ----------
    def decide_contract(self, ctx: Context) -> dict:
        c = self._contract()
        offer = ctx.offer or {}
        fixed = float(offer.get("fixed_fee_krw", c["fixed_fee_krw"]))
        perf_fee = offer.get("performance_fee", c["performance_fee"])
        schedule = offer.get("payment_schedule", c["fixed_fee_payment_schedule"])
        is_counter = bool(ctx.offer)
        i = self._inf[c["influencer_id"]]
        fc = self.cash(ctx)
        deadline = c["notice_deadline"]
        dday = (date.fromisoformat(deadline) - date.fromisoformat(ctx.today)).days

        evidence = [
            ev("ORIGINAL", f"연간 전속 고정 피 {won(c['fixed_fee_krw'])}(성과와 무관), 만료 {c['expiry_date']}, "
               f"통보 기한 {deadline} — 미통보 시 동일 조건 1년 자동 갱신·중도해지 위약금 잔여 고정 피 50%",
               c["source"], "FULL"),
            ev("CALC", f"표본 기준 실질 공헌이익 {i['cp_rank']}위/10 (실질 ROAS {i['real_roas']:.2f}, 명목 ROAS {i['nominal_roas']:.2f})",
               "mkt_orders·returns·ad_spend·cost_master → calculation_definitions §1.4", "SAMPLE"),
            ev("CALC", f"광고비 집행 비중 {pct(i['spend_share'])}로 1위인데 실질 공헌이익은 최하위 — 집행비중·성과 순위 상관 {self._align['spearman_spend_vs_cp']:.2f}(역전)",
               "mkt_ad_spend_ms 비중 vs 실질 공헌이익 순위", "SAMPLE"),
            ev("CALC", f"이번 확대 기안에서도 요청 비중 {pct(i['plan_share'])}로 1위 → 같은 배분 원칙이 반복됨",
               "mkt_budget_plan_ms", "SAMPLE"),
            ev("ASSUMPTION", f"쿠폰을 공헌이익에서 한 번 더 빼는 대안 산식(cp_alt)에서도 {i['cp_alt_rank']}위 — 결론이 산식 선택에 좌우되지 않음",
               "가정 A-03 민감도", "SAMPLE"),
        ]
        t = self._trend[-1]
        evidence.append(ev("CALC", f"{t['half']} GMV {pct(t['gmv_growth'])} 성장 vs 실질 공헌이익 {pct(t['cp_growth'])} — 성장의 질 미확인",
                           "half_year_trend (회의록 요청)", "SAMPLE"))
        for cl in ctx.claims or []:
            evidence.append(ev("CLAIM", cl["summary"], f"{cl.get('from','부서')} 주장 — 사실이 아니라 의견으로 분리", "SAMPLE"))
        if is_counter:
            evidence.append(ev("MOCK", f"에이전시 역제안: 고정 피 {won(fixed)}, 성과 피 '{perf_fee}'", offer.get("reply_id", "모의 회신"), "FULL"))
            if "GMV" in str(perf_fee):
                evidence.append(ev("CALC", "성과 피가 GMV에 연동되면 쿠폰·반품·광고비가 커질수록 보수가 늘어 실질 공헌이익과 반대로 움직일 수 있음",
                                   "approval_authority_policy: 'GMV가 아니라 실질 공헌이익 기준'", "NA"))
        if fc.window:
            evidence.append(ev("CALC", f"13주 재전망: covenant 하회 구간 {fc.window[0]}~{fc.window[1]} ({len(fc.breach_days)}영업일), 최저 {won(fc.min_balance)}({fc.min_date}) — 공식 전망 최저 {won(fc.official_min)}과 다름(LC-0001 45→90일 미반영 추정)",
                               "fin_ar/ap_aging + sc_purchase_orders (§1.2)", "FULL"))

        cash_dates = [p["date"] for p in schedule] if schedule else None
        auth = resolve_authority(Commitment(c["contract_id"], "EXCLUSIVE_CONTRACT", fixed, cash_dates,
                                            annual_fee_krw=fixed), self.policy, fc.window)

        needs_info: list[str] = []
        if is_counter and schedule is None:
            needs_info = auth.needs_info or ["고정 피 지급 일정 미확인"]
        if schedule and fc.window:
            extra = [{"date": p["date"], "amount_krw": p["amount_krw"], "label": "INF-001 고정 피"} for p in schedule]
            fc2 = self.cash(ctx, extra)
            evidence.append(ev("CALC", f"지급 일정 반영 시 최저 잔액 {won(fc.min_balance)} → {won(fc2.min_balance)}, 하회 {len(fc.breach_days)}→{len(fc2.breach_days)}영업일",
                               "재전망 + 모의 회신 지급 일정", "FULL"))

        bad_perf = i["real_roas"] < self.policy["recommendation_thresholds"]["real_roas_reject_below"]
        if is_counter:
            proposal = f"INF-001 에이전시 역제안 수용(고정 피 {won(fixed)}·성과 피 {perf_fee})으로 갱신 체결"
            if needs_info:
                reco, label = "NEEDS_INFO", "확인 필요 — 지급 일정 회신 전에는 권한·현금 판정 불가"
            elif bad_perf:
                reco, label = "REJECT", "역제안 수용 비권고 — 실질 공헌이익 연동 조건 재요구, 결렬 시 미갱신"
            else:
                reco, label = "APPROVE", "역제안 수용 검토 가능"
        else:
            proposal = "INF-001 전속계약 '조건변경 통보' 발송(고정 피 축소·실질 공헌이익 연동 성과 피 요구) + 연계 기안 PLAN-001~003 보류"
            reco, label = ("CHANGE_TERMS", "조건변경 통보 권고 — 동일 조건 자동 갱신 방지") if bad_perf else ("APPROVE", "동일 조건 갱신 검토 가능")

        alternatives = [
            {"code": "CHANGE_TERMS", "label": "조건변경 통보(고정 피 축소 + 실질 공헌이익 연동)", "pros": "관계 유지, 고정비 위험 축소", "cons": "협상 결렬 가능"},
            {"code": "TERMINATE", "label": "미갱신(해지) 통보 + 예산을 실질 공헌이익 상위 인플루언서로 재배분", "pros": "역전된 배분 원칙 즉시 교정", "cons": "브랜드 노출 공백·전속 해제로 경쟁사 활동 가능"},
            {"code": "RENEW_AS_IS", "label": "동일 조건 갱신(비권고)", "pros": "협상 비용 없음", "cons": "고정 피가 성과와 무관하게 1년 발생, 위약금으로만 되돌릴 수 있음"},
        ]
        linked = [p for p, v in self._plans.items() if self._camp[v["campaign_id"]].influencer_id == c["influencer_id"]]
        on_approve, on_reject = self._contract_tasks(is_counter, deadline, linked, reco)
        return {
            "subject": {"type": "CONTRACT", "id": c["contract_id"], "influencer_id": c["influencer_id"],
                        "name": c["influencer_name"], "deadline": deadline, "dday": dday},
            "proposal": proposal, "recommendation": reco, "label": label,
            "evidence": evidence, "alternatives": alternatives,
            "authority": auth.to_dict(), "approver": None if needs_info else auth.approver,
            "needs_info": needs_info, "linked_plans": linked,
            "terms": {"fixed_fee_krw": fixed, "performance_fee": perf_fee, "payment_schedule": schedule},
            "cash": {"window": fc.window, "min_balance": fc.min_balance, "min_date": fc.min_date,
                     "assumption": fc.assumption, "official_min": fc.official_min},
            "on_approve": on_approve, "on_reject": on_reject,
        }

    def _contract_tasks(self, is_counter, deadline, linked, reco):
        before = (date.fromisoformat(deadline) - timedelta(days=1)).isoformat()
        group = task("GROUP_CEO", "이사회 보고: 인플루언서 배분 원칙(집행 비중↔실질 공헌이익 역전) 개선안", None, "REPORT")
        if not is_counter:
            on_approve = [
                task("CONTRACT_OWNER", "에이전시에 INF-001 조건변경 통보 발송(회신 기한 포함)", before, "NOTIFY", channel="email:agency", effect="CONTRACT_NOTICE_SENT",
                     message=f"[Masil Commerce → 혜인(INF-001) 에이전시] 연간 전속계약 조건변경 통보: 현 조건(고정 피 연 28억) 동일 갱신 불가. 고정 피 축소 및 실질 공헌이익 연동 성과 피 구조로 변경을 요청드립니다. 통보 기한 {deadline} 이전 회신 바랍니다."),
                task("MARKETING_TEAM", f"연계 기안 {', '.join(linked)} 집행 보류 — 상위 계약 결정과 함께 처리", deadline, "HOLD", effect="HOLD_LINKED_PLANS"),
                task("FINANCE", "13주 재전망(하회 구간)과 계약 지급 일정 대조표 작성", before),
                group,
            ]
            on_reject = [
                task("CONTRACT_OWNER", "기한 전 재검토 — 대안(미갱신/동일 조건) 중 결정안 재상신", before, "ESCALATE"),
                task("MARKETING_TEAM", f"{deadline} 기한 관리: 미결정 시 자동 갱신(=승인 없는 체결) 경고", before, "WATCH"),
            ]
        else:
            on_approve = [
                task("CONTRACT_OWNER", "에이전시에 역제안 수용 회신·계약서 갱신", before, "NOTIFY", channel="email:agency", effect="CONTRACT_RENEWED"),
                task("FINANCE", "고정 피 지급 일정을 현금 계획에 반영(하회 구간 포함 시 그룹 자금 연계)", before),
            ]
            on_reject = [
                task("CONTRACT_OWNER", "에이전시에 미갱신(해지) 통보 발송 — 기한 전", before, "NOTIFY", channel="email:agency", effect="CONTRACT_TERMINATION_SENT",
                     message=f"[Masil Commerce → 혜인(INF-001) 에이전시] 역제안(고정 피 18억·GMV 3%)은 수용이 어렵습니다. 계약 조항에 따라 {deadline} 기한 내 미갱신을 통보하며, 현 계약은 만료일(2026-08-31)에 종료됩니다."),
                task("MARKETING_TEAM", f"연계 기안 {', '.join(linked)} 부결 처리 및 예산을 실질 공헌이익 상위 인플루언서로 재배분안 작성", deadline, "REALLOCATE", effect="REJECT_LINKED_PLANS"),
                task("FINANCE", "INF-001 고정 피 제외한 현금 계획 확정", before),
                task("GROUP_CEO", "이사회 보고: 전속계약 미갱신 결정과 배분 원칙 교정", None, "REPORT"),
            ]
        return on_approve, on_reject

    # ---------- v1.21(PRD §15-4): 다른 자동 갱신 계약(물류·대행사 등) ----------
    def decide_renewal(self, rid: str, ctx: Context) -> dict:
        """업로드한 계약서에서 뽑은 조건으로, 전속계약과 같은 원칙(미통보 자동 갱신 = 승인 없는 체결)·같은 권한 사슬·
        같은 현금 재전망(covenant 하회 구간)으로 판단한다. 금액·날짜는 추출값만 쓰고 모르면 '확인 필요'."""
        rec = (ctx.renewals or {}).get(rid) or {}
        t, chk, cite = rec.get("terms") or {}, rec.get("checks") or [], rec.get("citations") or {}
        name = t.get("counterparty") or "상대방 미상"
        src = lambda k: f"{t.get('filename', '계약서')} {cite.get(k, {}).get('ref', '')}".strip()  # noqa: E731
        deadline = t.get("notice_deadline") or t.get("expiry") or ctx.today
        dday = (date.fromisoformat(deadline) - date.fromisoformat(ctx.today)).days
        fee = t.get("annual_fee_krw")
        fc = self.cash(ctx)
        evidence = []
        if t.get("expiry"):
            evidence.append(ev("ORIGINAL", f"계약 만료 {t['expiry']}" + (f", 자동 갱신 {t.get('renewal_years') or '?'}년" if t.get("auto_renew") else (", 자동 갱신하지 않음(계약서에 명시)" if t.get("auto_renew") is False else ", 자동 갱신 여부 미확인(원문 확인)")), src("expiry"), "FULL"))
        if t.get("notice_deadline"):
            left = f" — D-{dday}" if dday >= 0 else f" — {-dday}일 지남"
            evidence.append(ev("ORIGINAL", f"해지·조건변경 통보 기한 {t['notice_deadline']}" + (f"(만료 {t['notice_days']}일 전)" if t.get("notice_days") else "") + left, src("notice_deadline"), "FULL"))
        if fee is not None:
            evidence.append(ev("ORIGINAL", f"연간 고정 금액 {won(fee)}({t.get('fee_basis')})" + (f" + 변동 {t['variable_fee']}" if t.get("variable_fee") else ""), src("annual_fee_krw"), "FULL"))
        for k, pv in (t.get("provided") or {}).items():   # 24차: 사람이 확인해 넣은 값은 원문과 구분해 표시
            label = {"annual_fee_krw": f"연간 금액 {won(fee) if fee is not None else '-'}", "auto_renew": "자동 갱신 " + ("있음" if t.get("auto_renew") else "없음"),
                     "notice_deadline": f"통보 기한 {t.get('notice_deadline')}(만료 {t.get('notice_days')}일 전)"}.get(k, k)
            evidence.append(ev("CLAIM", f"사람 입력({ROLE_KO_SHORT.get(pv.get('by'), pv.get('by'))}{', ' + pv['user'] if pv.get('user') else ''}, {pv.get('at')}): {label} — {pv.get('note') or '근거 메모 없음'}",
                               "contract_facts(사람 확인값)", "NA"))
        if t.get("penalty_pct") is not None:
            evidence.append(ev("ORIGINAL", f"중도 해지 위약금 {t['penalty_pct']:g}%({t.get('penalty_base') or '기준 미기재'})", src("penalty_pct"), "FULL"))
        pay = t.get("payment") or {}
        if pay:
            parts = []
            if "monthly_day" in pay:
                parts.append(f"매월 {pay['monthly_day']}{'' if pay['monthly_day'] == '말일' else '일'} 지급")
            if pay.get("due_days"):
                parts.append(f"{pay['due_days']}일 이내")
            if pay.get("prepay_pct"):
                parts.append(f"갱신일 {pay['prepay_pct']:g}% 선급")
            if pay.get("quarterly"):
                parts.append("분기 말일 지급")
            evidence.append(ev("ORIGINAL", "지급 조건: " + ", ".join(parts or ["원문 참조"]), src("payment"), "FULL"))
        for c in chk:
            if c["level"] in ("high", "watch", "missing"):
                evidence.append(ev("CALC", f"[자동 확인] {c['text']}", "contracts/extract.checks (기준: 위약금·선급 30%, 통보 D-14)", "NA"))
        if fc.window:
            evidence.append(ev("CALC", f"13주 재전망: covenant 하회 구간 {fc.window[0]}~{fc.window[1]}, 최저 {won(fc.min_balance)}({fc.min_date})",
                               "fin_ar/ap_aging + sc_purchase_orders (§1.2)", "FULL"))
        evidence.append(ev("ASSUMPTION", "권한표에 이 계약 유형의 구간이 없어 연간 전속계약 구간(연 10억, 미통보 자동 갱신 = 체결)을 준용",
                           "가정 A-23 (approval_authority_policy 준용)", "NA"))
        auth = resolve_authority(Commitment(rid, "AUTO_RENEWAL_CONTRACT", fee or 0.0, t.get("cash_out_dates"), annual_fee_krw=fee or 0.0), self.policy, fc.window)
        if auth.covenant_override:   # 근거 검색(RAG)이 차입 약정 문서를 고정하도록(Y-02와 같은 규칙) 사실 목록에도 남긴다
            hit = [x for x in (t.get("cash_out_dates") or []) if fc.window and fc.window[0] <= x <= fc.window[1]]
            evidence.append(ev("CALC", f"갱신 시 현금 유출일 {', '.join(hit)} ∈ covenant 하회 구간 {fc.window[0]}~{fc.window[1]} → 금액과 무관하게 그룹 CEO",
                               "covenant_terms_ms 우선 규정", "FULL"))
        needs = list(auth.needs_info)
        if fee is None:
            needs.append(f"연간 금액이 외화({t.get('fee_basis')}) — 재무팀 환율로 원화 환산 필요(승인 권한 판정 불가)" if t.get("currency") else "연간 금액 미확인 — 승인 권한 판정 불가(원문 확인)")
        if t.get("auto_renew") is None:   # 23차 AJ06: 못 찾은 갱신 조항을 '없음'으로 단정하지 않음
            needs.append("자동 갱신 여부 미확인 — 원문의 기간·갱신 조항 확인(통보 기한이 있을 수 있음)")
        high = [c for c in chk if c["level"] == "high"]
        if t.get("auto_renew") is None:
            reco, label = "APPROVE", "자동 갱신 여부 확인 필요 — 원문의 갱신 조항을 확인한 뒤 결정"
            proposal = f"{name} 계약 — 자동 갱신 여부를 원문에서 확인(만료 {t.get('expiry') or '미상'})"
        elif not t.get("auto_renew"):
            reco, label = "APPROVE", "자동 갱신하지 않는 계약 — 만료 관리만"
            proposal = f"{name} 계약 만료({t.get('expiry') or '미상'}) 관리 — 갱신 여부는 만료 전 별도 결정"
        elif high:
            reco, label = "CHANGE_TERMS", "조건변경 통보 권고 — 위약금·선급·기한 위험을 그대로 자동 갱신하지 않음"
            proposal = f"{name} 계약 '조건변경 통보' 발송(위약금·선급 조건 재협상) — 통보 기한 {deadline} 전"
        else:
            reco, label = "APPROVE", "동일 조건 갱신 검토 가능 — 기한 전 결정 기록"
            proposal = f"{name} 계약 동일 조건 갱신(통보하지 않음)을 승인으로 기록 — 기한 {deadline}"
        before = (date.fromisoformat(deadline) - timedelta(days=1)).isoformat()
        notify = task("CONTRACT_OWNER", f"{name}에 조건변경 통보 발송(통보 기한 {deadline} 전)", before, "NOTIFY", channel="email:counterparty", effect="RENEWAL_NOTICE_SENT",
                      message=f"[Masil Commerce → {name}] 계약 조건변경 통보: 현 조건 동일 갱신 불가. 위약금·지급 조건 재협상을 요청드립니다. 통보 기한 {deadline} 이전 회신 바랍니다.")
        on_approve = ([notify] if reco == "CHANGE_TERMS" else []) + [task("FINANCE", f"{name} 계약 지급 일정을 현금 계획에 반영", before)]
        on_reject = [task("CONTRACT_OWNER", f"{name} 계약 — 기한 전 재검토 후 재상신", before, "ESCALATE"),
                     task("CONTRACT_OWNER", f"{deadline} 기한 관리: 미결정 시 자동 갱신(=승인 없는 체결) 경고", before, "WATCH")]
        return {
            "subject": {"type": "RENEWAL", "id": rid, "name": name, "deadline": deadline, "dday": dday},
            "proposal": proposal, "recommendation": "NEEDS_INFO" if needs else reco,
            "label": "확인 필요 — " + needs[0] if needs else label,
            "evidence": evidence,
            "alternatives": [
                {"code": "CHANGE_TERMS", "label": "조건변경 통보(위약금·선급 축소 요구)", "pros": "관계 유지, 위험 조건 교정", "cons": "협상 결렬 가능"},
                {"code": "TERMINATE", "label": "미갱신(해지) 통보", "pros": "고정비·위약금 위험 제거", "cons": "대체 거래처 확보 필요"},
                {"code": "RENEW_AS_IS", "label": "동일 조건 자동 갱신 허용", "pros": "업무 연속성", "cons": "위약금으로만 되돌릴 수 있음"},
            ],
            "authority": auth.to_dict(), "approver": None if needs else auth.approver, "needs_info": needs,
            "terms": t, "checks": chk, "contract_summary": rec.get("summary"),   # v1.22(⑤): 참고용 요약(판단에 쓰지 않음)
            "cash": {"window": fc.window, "min_balance": fc.min_balance, "min_date": fc.min_date, "assumption": fc.assumption, "official_min": fc.official_min},
            "on_approve": on_approve, "on_reject": on_reject,
        }

    # ---------- 캠페인 확대 기안 ----------
    def decide_plan(self, plan_id: str, ctx: Context) -> dict:
        p = self._plans[plan_id]
        c = self._camp[p["campaign_id"]]
        i = self._inf[c.influencer_id]
        fc = self.cash(ctx)
        amount = num(p["requested_budget_krw"])
        copy = (ctx.copy_overrides or {}).get(plan_id) or self.dr.ad_copies.get(plan_id, {}).get("draft_copy", "")
        reg = regulation_detail(copy) if copy else None
        sup = self._supply.get(c.product_line)
        auth = resolve_authority(Commitment(plan_id, "CAMPAIGN_PLAN", amount, [p["settlement_date"]],
                                            plan_total_krw=self._plan_total), self.policy, fc.window)
        th = self.policy["recommendation_thresholds"]
        evidence = [
            ev("ORIGINAL", f"요청 {won(amount)}, 예상 GMV {won(num(p['expected_gmv_krw']))}(쿠폰·반품·광고비 차감 전 — 승인 근거 아님), 정산 {p['settlement_date']}, 확정기한 {p['contract_deadline']}",
               "mkt_budget_plan_ms", "SAMPLE"),
            ev("CALC", f"{c.campaign_name}: 실질 ROAS {c.real_roas:.2f} (명목 {c.nominal_roas:.2f}), 반품률 {pct(c.return_rate)}",
               "calculation_definitions §1.4", "SAMPLE"),
            ev("CALC", f"{i['influencer_name']} 실질 공헌이익 {i['cp_rank']}위/10 · 집행 비중 {pct(i['spend_share'])}",
               "influencer_performance", "SAMPLE"),
        ]
        reasons = []
        if c.real_roas < th["real_roas_reject_below"]:
            perf = "REJECT"
            reasons.append("마케팅비를 공헌이익으로 회수하지 못함(실질 ROAS<0)")
        elif c.real_roas < th["real_roas_conditional_below"]:
            perf = "CONDITIONAL"
            reasons.append("실질 ROAS 0~1 — 축소 집행 권고")
        else:
            perf = "APPROVE"
        reco, label = perf, {"REJECT": "부결·재배분 권고", "CONDITIONAL": "조건부(축소) 권고", "APPROVE": "승인 권고"}[perf]

        if reg and reg["findings"]:
            v = reg["verdict"]
            evidence.append(ev("CALC", f"광고 카피 검증({v['law']}): {v['message']}", "check_regulation + legal_kb", "NA"))
            if v["action"] == "block":
                reco, label = "REJECT", "부결 — 집행 불가 표현"
            elif reco != "REJECT":
                reco, label = "HOLD_COPY", "카피 수정 필요 — 수정안 재검증 통과 후 승인"
        elif reg:
            evidence.append(ev("CALC", "광고 카피 검증 통과(표시광고법·화장품법·추천보증 지침)", "check_regulation", "NA"))
        evidence.append(ev("ASSUMPTION" if plan_id in self.dr.ad_copies else "ORIGINAL",
                           f"광고 카피 초안: “{copy}”", "data/assumptions/ad_copies.csv (합성 A-07)", "NA"))

        if sup and sup["constrained"]:
            evidence.append(ev("CALC", f"{c.product_line} 재고 커버 최저 {sup['min_cover_weeks']:.1f}주({sup['min_cover_sku']}) < 안전재고 {sup['safety_min']:.0f}주, 리드타임 {sup['lead_time_weeks']:.0f}주, 생산라인 {sup['product_id']} 가동률 {sup['line_utilization_pct']:.0f}%",
                               "sku_inventory·sku_weekly_sales·m_sku·strat_capacity", "FULL"))
            if reco not in ("REJECT",):
                reco, label = "HOLD_SUPPLY", "공급 제약 — 제품 전환 또는 입고 후로 일정 조정"

        if c.influencer_id == self._contract()["influencer_id"] and ctx.contract_status in HOLD_STATUSES:
            evidence.append(ev("ORIGINAL", "INF-001 전속계약의 하위 집행분 — 기안만 부결해도 계약이 자동 갱신되면 배분은 유지됨",
                               "inf001_exclusive_contract_notice.md", "NA"))
            if reco != "REJECT":
                reco, label = "HOLD_LINKED", "상위 전속계약 결정 대기"
            else:
                label = "부결 권고 + 상위 전속계약과 함께 처리"
        if ctx.contract_status in TERMINATED_STATUSES and c.influencer_id == self._contract()["influencer_id"]:
            reco, label = "REJECT", "상위 계약 미갱신 결정에 따라 부결"
        if fc.window:
            inwin = fc.in_window(p["settlement_date"])
            evidence.append(ev("CALC", f"정산일 {p['settlement_date']} {'∈' if inwin else '∉'} covenant 하회 구간 {fc.window[0]}~{fc.window[1]}",
                               "13주 재전망", "FULL"))

        alternatives = []
        if reco in ("REJECT", "CONDITIONAL"):
            top = sorted(self._inf.values(), key=lambda x: x["cp_rank"])[:3]
            alternatives.append({"code": "REALLOCATE", "label": "실질 공헌이익 상위로 재배분: " + ", ".join(t["influencer_name"] for t in top)})
        if reco == "CONDITIONAL":
            alternatives.append({"code": "SCALE_DOWN", "label": f"요청액 50% 축소 집행({won(amount/2)})"})
        if reco == "HOLD_COPY":
            alternatives.append({"code": "REWRITE", "label": f"수정안: “{reg['rewrite']}”"})
        if reco == "HOLD_SUPPLY":
            alts = [k for k, v in self._supply.items() if not v["constrained"] and k in ("기초", "선케어", "색조")]
            alternatives.append({"code": "SWITCH_PRODUCT", "label": f"제품 전환({'/'.join(alts)}) 또는 입고 후 일정 연기"})
        alternatives.append({"code": "AS_PROPOSED", "label": "원안 그대로 확정"})

        on_approve = [task("MARKETING_TEAM", f"{plan_id} 집행 확정·계약 체결", p["contract_deadline"], "EXECUTE", effect="PLAN_CONFIRMED"),
                      task("FINANCE", f"{plan_id} 정산 {p['settlement_date']} {won(amount)} 현금계획 반영", p["settlement_date"])]
        if auth.group_report:
            on_approve.append(task("GROUP_CEO", f"{plan_id} 집행 그룹 보고(기안 총액 1억 초과)", None, "REPORT"))
        if auth.covenant_override:
            on_approve.append(task("FINANCE", f"{plan_id} 하회 구간 내 유출 — 그룹 자금 투입 계획과 대조", p["settlement_date"]))
        if sup and c.product_line in self._supply:
            on_approve.append(task("SCM", f"{c.product_line} 캠페인 확대 수요 공유(커버 {sup['min_cover_weeks']:.1f}주)", p["contract_deadline"], "INFO"))
        on_reject = [task("MARKETING_TEAM", f"{plan_id} 부결 통보·예산 재배분안 작성(실질 공헌이익 기준)", p["contract_deadline"], "REALLOCATE", effect="PLAN_REJECTED")]
        if reco == "HOLD_SUPPLY":
            on_reject.append(task("SCM", f"{c.product_line} 입고 일정 회신(전환 가능 제품 포함)", p["contract_deadline"]))

        return {
            "subject": {"type": "PLAN", "id": plan_id, "campaign_id": c.campaign_id, "campaign_name": c.campaign_name,
                        "influencer_id": c.influencer_id, "name": i["influencer_name"], "product_line": c.product_line,
                        "amount_krw": amount, "settlement_date": p["settlement_date"], "deadline": p["contract_deadline"],
                        "dday": (date.fromisoformat(p["contract_deadline"]) - date.fromisoformat(ctx.today)).days},
            "proposal": f"{plan_id}({c.campaign_name}) {won(amount)} 확대 집행 확정",
            "recommendation": reco, "label": label, "reasons": reasons,
            "evidence": evidence, "alternatives": alternatives,
            "authority": auth.to_dict(), "approver": auth.approver, "needs_info": [],
            "regulation": reg, "copy": copy,
            "supply": {k: v for k, v in (sup or {}).items() if k != "skus"},
            "on_approve": on_approve, "on_reject": on_reject,
        }

    def all_plans(self, ctx: Context) -> list[dict]:
        return [self.decide_plan(pid, ctx) for pid in self._plans]
