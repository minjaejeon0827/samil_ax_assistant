// 판단 엔진 — backend/app/domain/decision.py · authority.py와 같은 규칙(parity 테스트로 일치 검증).
import { addDays, daysBetween, forecast, type Forecast } from "./cash";
import { CONTRACT, DS, PLANS } from "./data";
import { regulationDetail } from "./validation";
import type { Authority, Ctx, Decision, Evidence, TaskSpec } from "./types";

export const HOLD_STATUSES = new Set(["UNDER_REVIEW", "NOTICE_APPROVED", "NOTICE_SENT", "COUNTER_OFFER"]);
export const TERMINATED_STATUSES = new Set(["TERMINATION_APPROVED", "TERMINATION_SENT", "TERMINATED"]);
const RANK: Record<string, number> = { MARKETING_TEAM: 1, MASIL_CEO: 2, GROUP_CEO: 3 };
const AUTH_SRC = "00_common/approval_authority_policy.md";
const COV_SRC = "02_masil/financials/covenant_terms_ms.md";

export const won = (x: number) => (Math.abs(x) >= 1e8 ? `${(x / 1e8).toFixed(2)}억원` : `${Math.round(x / 1e4).toLocaleString("en-US")}만원`);
export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ev = (kind: Evidence["kind"], text: string, source: string, scale: Evidence["scale"] = "NA"): Evidence => ({ kind, text, source, scale });
const task = (dept: string, title: string, due: string | null, kind = "ACTION", extra: Partial<TaskSpec> = {}): TaskSpec => ({ dept, title, due, kind, ...extra });

// ---------- 책임 연쇄: 승인 권한 ----------
interface Commitment { kind: "CAMPAIGN_PLAN" | "EXCLUSIVE_CONTRACT"; amount: number; cashOut: string[] | null; planTotal?: number; annualFee?: number }

export function resolveAuthority(c: Commitment, window: [string, string] | null): Authority {
  const a: Authority = { approver: "MARKETING_TEAM", group_report: false, covenant_override: false, needs_info: [], trace: [] };
  const raise = (role: string, rule: string, why: string) => {
    const before = a.approver;
    if (RANK[role] > RANK[a.approver]) a.approver = role;
    a.trace.push({ rule, result: role, before, why, source: AUTH_SRC });
  };
  const P = DS.policy.authority;
  // 1) 캠페인 금액
  if (c.kind === "CAMPAIGN_PLAN") {
    const total = c.planTotal ?? 0;
    if (c.amount <= P.campaign_item_team_limit_krw && total <= P.campaign_plan_total_ceo_report_krw) raise("MARKETING_TEAM", "캠페인 건별 1천만원 이하", "마케팅팀 전결");
    else {
      const why: string[] = [];
      if (c.amount > P.campaign_item_team_limit_krw) why.push(`건별 ${Math.round(c.amount / 1e4).toLocaleString("en-US")}만원 > 1천만원`);
      if (total > P.campaign_plan_total_ceo_report_krw) why.push(`기안 총액 ${(total / 1e8).toFixed(2)}억 > 1억`);
      raise("MASIL_CEO", "캠페인 확대안 집행", `${why.join(" · ")} → Masil 대표 승인 + 그룹 보고`);
      a.group_report = true;
    }
  }
  // 2) 전속계약 금액
  if (c.kind === "EXCLUSIVE_CONTRACT") {
    const fee = c.annualFee ?? 0;
    if (fee > P.exclusive_contract_ceo_limit_krw) raise("GROUP_CEO", "인플루언서 연간 전속계약 체결·갱신", `연 ${(fee / 1e8).toFixed(0)}억 > 10억 → CEO/이사회 (미통보 자동 갱신도 체결로 봄)`);
    else raise("MASIL_CEO", "인플루언서 연간 전속계약 체결·갱신", "연 10억 이하 → Masil 대표");
  }
  // 3) covenant 우선 규정
  if (!window) a.trace.push({ rule: "covenant 하회 구간 우선 규정", result: "해당 없음", before: a.approver, why: "재전망상 하회 구간 없음", source: COV_SRC });
  else if (c.cashOut === null) {
    a.needs_info.push(`지급 일정(현금 유출일) 미확인 — 하회 구간(${window[0]}~${window[1]}) 포함 여부 판정 불가`);
    a.trace.push({ rule: "covenant 하회 구간 우선 규정", result: "판정 보류", before: a.approver, why: "현금 유출일이 없어 ②단계 대조 불가", source: COV_SRC });
  } else {
    const hits = c.cashOut.filter((x) => window[0] <= x && x <= window[1]);
    if (hits.length) {
      a.covenant_override = true;
      raise("GROUP_CEO", "covenant 하회 구간 우선 규정", `유출일 ${hits.join(", ")} ∈ 하회 구간 ${window[0]}~${window[1]} → 금액·종류 불문 그룹 CEO (평시 전결 효력 상실)`);
    } else a.trace.push({ rule: "covenant 하회 구간 우선 규정", result: "해당 없음", before: a.approver, why: `유출일 ${c.cashOut.join(", ")} 은 하회 구간 밖`, source: COV_SRC });
  }
  return a;
}

const linkedPlans = () => DS.plans.filter((p) => p.influencer_id === CONTRACT.influencer_id).map((p) => p.plan_id);
const cashFor = (ctx: Ctx): Forecast => forecast(ctx.cash_assumption);

// ---------- 전속계약 ----------
export function decideContract(ctx: Ctx): Decision {
  const c = CONTRACT;
  const offer = (ctx.offer ?? {}) as { fixed_fee_krw?: number; performance_fee?: string; payment_schedule?: { date: string; amount_krw: number }[] | null; reply_id?: string };
  const isCounter = !!ctx.offer;
  const fixed = offer.fixed_fee_krw ?? c.fixed_fee_krw;
  const perfFee = offer.performance_fee ?? c.performance_fee;
  const schedule = isCounter ? (offer.payment_schedule ?? null) : c.fixed_fee_payment_schedule;
  const i = DS.influencers[c.influencer_id];
  const fc = cashFor(ctx);
  const deadline = c.notice_deadline;
  const al = DS.alignment;
  const evidence: Evidence[] = [
    ev("ORIGINAL", `연간 전속 고정 피 ${won(c.fixed_fee_krw)}(성과와 무관), 만료 ${c.expiry_date}, 통보 기한 ${deadline} — 미통보 시 동일 조건 1년 자동 갱신·중도해지 위약금 잔여 고정 피 50%`, c.source, "FULL"),
    ev("CALC", `표본 기준 실질 공헌이익 ${i.cp_rank}위/10 (실질 ROAS ${i.real_roas.toFixed(2)}, 명목 ROAS ${i.nominal_roas.toFixed(2)})`, "mkt_orders·returns·ad_spend·cost_master → calculation_definitions §1.4", "SAMPLE"),
    ev("CALC", `광고비 집행 비중 ${pct(i.spend_share)}로 1위인데 실질 공헌이익은 최하위 — 집행비중·성과 순위 상관 ${al.spearman_spend_vs_cp.toFixed(2)}(역전)`, "mkt_ad_spend_ms 비중 vs 실질 공헌이익 순위", "SAMPLE"),
    ev("CALC", `이번 확대 기안에서도 요청 비중 ${pct(i.plan_share)}로 1위 → 같은 배분 원칙이 반복됨`, "mkt_budget_plan_ms", "SAMPLE"),
    ev("ASSUMPTION", `쿠폰을 공헌이익에서 한 번 더 빼는 대안 산식(cp_alt)에서도 ${i.cp_alt_rank}위 — 결론이 산식 선택에 좌우되지 않음`, "가정 A-03 민감도", "SAMPLE"),
  ];
  const t = DS.trend[DS.trend.length - 1];
  evidence.push(ev("CALC", `${t.half} GMV ${pct(t.gmv_growth ?? 0)} 성장 vs 실질 공헌이익 ${pct(t.cp_growth ?? 0)} — 성장의 질 미확인`, "half_year_trend (회의록 요청)", "SAMPLE"));
  for (const cl of ctx.claims ?? []) evidence.push(ev("CLAIM", cl.summary, `${cl.from} 주장 — 사실이 아니라 의견으로 분리`, "SAMPLE"));
  if (isCounter) {
    evidence.push(ev("MOCK", `에이전시 역제안: 고정 피 ${won(fixed)}, 성과 피 '${perfFee}'`, offer.reply_id ?? "모의 회신", "FULL"));
    if (String(perfFee).includes("GMV")) evidence.push(ev("CALC", "성과 피가 GMV에 연동되면 쿠폰·반품·광고비가 커질수록 보수가 늘어 실질 공헌이익과 반대로 움직일 수 있음", "approval_authority_policy: 'GMV가 아니라 실질 공헌이익 기준'"));
  }
  if (fc.window) evidence.push(ev("CALC", `13주 재전망: covenant 하회 구간 ${fc.window[0]}~${fc.window[1]} (${fc.breachDays.length}영업일), 최저 ${won(fc.min)}(${fc.minDate}) — 공식 전망 최저 ${won(fc.officialMin)}과 다름(LC-0001 45→90일 미반영 추정)`, "fin_ar/ap_aging + sc_purchase_orders (§1.2)", "FULL"));
  const auth = resolveAuthority({ kind: "EXCLUSIVE_CONTRACT", amount: fixed, cashOut: schedule ? schedule.map((p) => p.date) : null, annualFee: fixed }, fc.window);
  let needs: string[] = [];
  if (isCounter && schedule === null) needs = auth.needs_info.length ? auth.needs_info : ["고정 피 지급 일정 미확인"];
  if (schedule && fc.window) {
    const fc2 = forecast(ctx.cash_assumption, schedule);
    evidence.push(ev("CALC", `지급 일정 반영 시 최저 잔액 ${won(fc.min)} → ${won(fc2.min)}, 하회 ${fc.breachDays.length}→${fc2.breachDays.length}영업일`, "재전망 + 모의 회신 지급 일정", "FULL"));
  }
  const bad = i.real_roas < DS.policy.recommendation_thresholds.real_roas_reject_below;
  let proposal: string, reco: string, label: string;
  if (isCounter) {
    proposal = `INF-001 에이전시 역제안 수용(고정 피 ${won(fixed)}·성과 피 ${perfFee})으로 갱신 체결`;
    if (needs.length) [reco, label] = ["NEEDS_INFO", "확인 필요 — 지급 일정 회신 전에는 권한·현금 판정 불가"];
    else if (bad) [reco, label] = ["REJECT", "역제안 수용 비권고 — 실질 공헌이익 연동 조건 재요구, 결렬 시 미갱신"];
    else [reco, label] = ["APPROVE", "역제안 수용 검토 가능"];
  } else {
    proposal = "INF-001 전속계약 '조건변경 통보' 발송(고정 피 축소·실질 공헌이익 연동 성과 피 요구) + 연계 기안 PLAN-001~003 보류";
    [reco, label] = bad ? ["CHANGE_TERMS", "조건변경 통보 권고 — 동일 조건 자동 갱신 방지"] : ["APPROVE", "동일 조건 갱신 검토 가능"];
  }
  const linked = linkedPlans();
  const before = addDays(deadline, -1);
  const group = task("GROUP_CEO", "이사회 보고: 인플루언서 배분 원칙(집행 비중↔실질 공헌이익 역전) 개선안", null, "REPORT");
  const on_approve = !isCounter ? [
    task("CONTRACT_OWNER", "에이전시에 INF-001 조건변경 통보 발송(회신 기한 포함)", before, "NOTIFY", { channel: "email:agency", effect: "CONTRACT_NOTICE_SENT",
      message: `[Masil Commerce → 혜인(INF-001) 에이전시] 연간 전속계약 조건변경 통보: 현 조건(고정 피 연 28억) 동일 갱신 불가. 고정 피 축소 및 실질 공헌이익 연동 성과 피 구조로 변경을 요청드립니다. 통보 기한 ${deadline} 이전 회신 바랍니다.` }),
    task("MARKETING_TEAM", `연계 기안 ${linked.join(", ")} 집행 보류 — 상위 계약 결정과 함께 처리`, deadline, "HOLD", { effect: "HOLD_LINKED_PLANS" }),
    task("FINANCE", "13주 재전망(하회 구간)과 계약 지급 일정 대조표 작성", before), group,
  ] : [
    task("CONTRACT_OWNER", "에이전시에 역제안 수용 회신·계약서 갱신", before, "NOTIFY", { channel: "email:agency", effect: "CONTRACT_RENEWED" }),
    task("FINANCE", "고정 피 지급 일정을 현금 계획에 반영(하회 구간 포함 시 그룹 자금 연계)", before),
  ];
  const on_reject = !isCounter ? [
    task("CONTRACT_OWNER", "기한 전 재검토 — 대안(미갱신/동일 조건) 중 결정안 재상신", before, "ESCALATE"),
    task("MARKETING_TEAM", `${deadline} 기한 관리: 미결정 시 자동 갱신(=승인 없는 체결) 경고`, before, "WATCH"),
  ] : [
    task("CONTRACT_OWNER", "에이전시에 미갱신(해지) 통보 발송 — 기한 전", before, "NOTIFY", { channel: "email:agency", effect: "CONTRACT_TERMINATION_SENT",
      message: `[Masil Commerce → 혜인(INF-001) 에이전시] 역제안(고정 피 18억·GMV 3%)은 수용이 어렵습니다. 계약 조항에 따라 ${deadline} 기한 내 미갱신을 통보하며, 현 계약은 만료일(2026-08-31)에 종료됩니다.` }),
    task("MARKETING_TEAM", `연계 기안 ${linked.join(", ")} 부결 처리 및 예산을 실질 공헌이익 상위 인플루언서로 재배분안 작성`, deadline, "REALLOCATE", { effect: "REJECT_LINKED_PLANS" }),
    task("FINANCE", "INF-001 고정 피 제외한 현금 계획 확정", before),
    task("GROUP_CEO", "이사회 보고: 전속계약 미갱신 결정과 배분 원칙 교정", null, "REPORT"),
  ];
  return {
    subject: { type: "CONTRACT", id: c.contract_id, influencer_id: c.influencer_id, name: c.influencer_name, deadline, dday: daysBetween(ctx.today, deadline) },
    proposal, recommendation: reco, label, evidence,
    alternatives: [
      { code: "CHANGE_TERMS", label: "조건변경 통보(고정 피 축소 + 실질 공헌이익 연동)", pros: "관계 유지, 고정비 위험 축소", cons: "협상 결렬 가능" },
      { code: "TERMINATE", label: "미갱신(해지) 통보 + 예산을 실질 공헌이익 상위 인플루언서로 재배분", pros: "역전된 배분 원칙 즉시 교정", cons: "브랜드 노출 공백·전속 해제로 경쟁사 활동 가능" },
      { code: "RENEW_AS_IS", label: "동일 조건 갱신(비권고)", pros: "협상 비용 없음", cons: "고정 피가 성과와 무관하게 1년 발생, 위약금으로만 되돌릴 수 있음" },
    ],
    authority: auth, approver: needs.length ? null : auth.approver, needs_info: needs, linked_plans: linked,
    cash: { window: fc.window, min_balance: fc.min, min_date: fc.minDate, assumption: fc.assumption, official_min: fc.officialMin },
    on_approve, on_reject,
  };
}

// ---------- 캠페인 확대 기안 ----------
export function decidePlan(planId: string, ctx: Ctx): Decision {
  const p = PLANS[planId];
  const c = DS.campaigns[p.campaign_id];
  const i = DS.influencers[c.influencer_id];
  const fc = cashFor(ctx);
  const amount = p.requested_budget_krw;
  const copy = ctx.copy_overrides?.[planId] || DS.ad_copies[planId] || "";
  const reg = copy ? regulationDetail(copy) : null;
  const sup = DS.supply[c.product_line];
  const auth = resolveAuthority({ kind: "CAMPAIGN_PLAN", amount, cashOut: [p.settlement_date], planTotal: DS.plan_total }, fc.window);
  const th = DS.policy.recommendation_thresholds;
  const evidence: Evidence[] = [
    ev("ORIGINAL", `요청 ${won(amount)}, 예상 GMV ${won(p.expected_gmv_krw)}(쿠폰·반품·광고비 차감 전 — 승인 근거 아님), 정산 ${p.settlement_date}, 확정기한 ${p.contract_deadline}`, "mkt_budget_plan_ms", "SAMPLE"),
    ev("CALC", `${c.campaign_name}: 실질 ROAS ${c.real_roas.toFixed(2)} (명목 ${c.nominal_roas.toFixed(2)}), 반품률 ${pct(c.return_rate)}`, "calculation_definitions §1.4", "SAMPLE"),
    ev("CALC", `${i.influencer_name} 실질 공헌이익 ${i.cp_rank}위/10 · 집행 비중 ${pct(i.spend_share)}`, "influencer_performance", "SAMPLE"),
  ];
  let reco = c.real_roas < th.real_roas_reject_below ? "REJECT" : c.real_roas < th.real_roas_conditional_below ? "CONDITIONAL" : "APPROVE";
  let label = { REJECT: "부결·재배분 권고", CONDITIONAL: "조건부(축소) 권고", APPROVE: "승인 권고" }[reco] as string;
  if (reg && reg.findings.length) {
    const v = reg.verdict;
    evidence.push(ev("CALC", `광고 카피 검증(${v.law}): ${v.message}`, "check_regulation + legal_kb"));
    if (v.action === "block") [reco, label] = ["REJECT", "부결 — 집행 불가 표현"];
    else if (reco !== "REJECT") [reco, label] = ["HOLD_COPY", "카피 수정 필요 — 수정안 재검증 통과 후 승인"];
  } else if (reg) evidence.push(ev("CALC", "광고 카피 검증 통과(표시광고법·화장품법·추천보증 지침)", "check_regulation"));
  evidence.push(ev(DS.ad_copies[planId] ? "ASSUMPTION" : "ORIGINAL", `광고 카피 초안: “${copy}”`, "data/assumptions/ad_copies.csv (합성 A-07)"));
  if (sup?.constrained) {
    evidence.push(ev("CALC", `${c.product_line} 재고 커버 최저 ${sup.min_cover_weeks.toFixed(1)}주(${sup.min_cover_sku}) < 안전재고 ${sup.safety_min.toFixed(0)}주, 리드타임 ${sup.lead_time_weeks.toFixed(0)}주, 생산라인 ${sup.product_id} 가동률 ${sup.line_utilization_pct.toFixed(0)}%`, "sku_inventory·sku_weekly_sales·m_sku·strat_capacity", "FULL"));
    if (reco !== "REJECT") [reco, label] = ["HOLD_SUPPLY", "공급 제약 — 제품 전환 또는 입고 후로 일정 조정"];
  }
  const isHyein = c.influencer_id === CONTRACT.influencer_id;
  if (isHyein && HOLD_STATUSES.has(ctx.contract_status)) {
    evidence.push(ev("ORIGINAL", "INF-001 전속계약의 하위 집행분 — 기안만 부결해도 계약이 자동 갱신되면 배분은 유지됨", "inf001_exclusive_contract_notice.md"));
    if (reco !== "REJECT") [reco, label] = ["HOLD_LINKED", "상위 전속계약 결정 대기"];
    else label = "부결 권고 + 상위 전속계약과 함께 처리";
  }
  if (isHyein && TERMINATED_STATUSES.has(ctx.contract_status)) [reco, label] = ["REJECT", "상위 계약 미갱신 결정에 따라 부결"];
  if (fc.window) {
    const inwin = fc.window[0] <= p.settlement_date && p.settlement_date <= fc.window[1];
    evidence.push(ev("CALC", `정산일 ${p.settlement_date} ${inwin ? "∈" : "∉"} covenant 하회 구간 ${fc.window[0]}~${fc.window[1]}`, "13주 재전망", "FULL"));
  }
  const alternatives: Decision["alternatives"] = [];
  if (reco === "REJECT" || reco === "CONDITIONAL") {
    const top = Object.values(DS.influencers).sort((a, b) => a.cp_rank - b.cp_rank).slice(0, 3);
    alternatives.push({ code: "REALLOCATE", label: `실질 공헌이익 상위로 재배분: ${top.map((t) => t.influencer_name).join(", ")}` });
  }
  if (reco === "CONDITIONAL") alternatives.push({ code: "SCALE_DOWN", label: `요청액 50% 축소 집행(${won(amount / 2)})` });
  if (reco === "HOLD_COPY") alternatives.push({ code: "REWRITE", label: `수정안: “${reg!.rewrite}”` });
  if (reco === "HOLD_SUPPLY") {
    const alts = Object.keys(DS.supply).filter((k) => !DS.supply[k].constrained && ["기초", "선케어", "색조"].includes(k));
    alternatives.push({ code: "SWITCH_PRODUCT", label: `제품 전환(${alts.join("/")}) 또는 입고 후 일정 연기` });
  }
  alternatives.push({ code: "AS_PROPOSED", label: "원안 그대로 확정" });
  const on_approve: TaskSpec[] = [
    task("MARKETING_TEAM", `${planId} 집행 확정·계약 체결`, p.contract_deadline, "EXECUTE", { effect: "PLAN_CONFIRMED" }),
    task("FINANCE", `${planId} 정산 ${p.settlement_date} ${won(amount)} 현금계획 반영`, p.settlement_date),
  ];
  if (auth.group_report) on_approve.push(task("GROUP_CEO", `${planId} 집행 그룹 보고(기안 총액 1억 초과)`, null, "REPORT"));
  if (auth.covenant_override) on_approve.push(task("FINANCE", `${planId} 하회 구간 내 유출 — 그룹 자금 투입 계획과 대조`, p.settlement_date));
  if (sup) on_approve.push(task("SCM", `${c.product_line} 캠페인 확대 수요 공유(커버 ${sup.min_cover_weeks.toFixed(1)}주)`, p.contract_deadline, "INFO"));
  const on_reject: TaskSpec[] = [task("MARKETING_TEAM", `${planId} 부결 통보·예산 재배분안 작성(실질 공헌이익 기준)`, p.contract_deadline, "REALLOCATE", { effect: "PLAN_REJECTED" })];
  if (reco === "HOLD_SUPPLY") on_reject.push(task("SCM", `${c.product_line} 입고 일정 회신(전환 가능 제품 포함)`, p.contract_deadline));
  return {
    subject: { type: "PLAN", id: planId, campaign_id: c.campaign_id, campaign_name: c.campaign_name, influencer_id: c.influencer_id, name: i.influencer_name,
      product_line: c.product_line, amount_krw: amount, settlement_date: p.settlement_date, deadline: p.contract_deadline, dday: daysBetween(ctx.today, p.contract_deadline) },
    proposal: `${planId}(${c.campaign_name}) ${won(amount)} 확대 집행 확정`,
    recommendation: reco, label, evidence, alternatives, authority: auth, approver: auth.approver, needs_info: [],
    regulation: reg, copy, on_approve, on_reject,
  };
}
