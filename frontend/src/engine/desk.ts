// 운영 데스크(브라우저 판) — backend/app/workflow/service.py와 같은 상태 전이·작업·감사 규칙.
// 순수 함수: (상태, 명령) → 새 상태. React 쪽에서 localStorage에 저장하므로 새로고침해도 유지된다.
import { addDays, daysBetween } from "./cash";
import { CONTRACT, DS } from "./data";
import { decideContract, decidePlan, HOLD_STATUSES } from "./decision";
import { checkInput, checkOutput, selfCheck } from "./validation";
import type { Case, Ctx, Decision, DeskState, NodeTrace, Snapshot, Task, TaskSpec } from "./types";

export const SCHEMA = 4;   // v4: hold_reason·MEMO 유형·resume_case 작업(E2E 결함 수정)
export const ROLE_KO: Record<string, string> = { MARKETING_TEAM: "마케팅팀", MASIL_CEO: "Masil 대표", GROUP_CEO: "그룹 CEO/이사회", FINANCE: "재무팀",
  SCM: "SCM", CONTRACT_OWNER: "계약 담당", AGENCY: "에이전시(모의)", SYSTEM: "시스템" };
export const CONTRACT_STATUS_KO: Record<string, string> = {
  UNDER_REVIEW: "갱신 통보 접수·검토 중", NOTICE_APPROVED: "조건변경 통보 승인(발송 대기)", NOTICE_SENT: "조건변경 통보 발송·회신 대기",
  COUNTER_OFFER: "에이전시 역제안 검토 중", TERMINATION_APPROVED: "미갱신 결정(통보 발송 대기)", TERMINATION_SENT: "미갱신 통보 발송",
  TERMINATED: "계약 종료 합의", RENEWAL_APPROVED: "갱신 승인(회신 대기)", RENEWED: "갱신 체결", AUTO_RENEWED: "기한 경과 자동 갱신(승인 없는 체결)",
};
export const STATE_KO: Record<string, string> = { RECEIVED: "접수", ANALYZING: "분석 중", PENDING_APPROVAL: "승인 대기", NEEDS_INFO: "확인 필요",
  ACTION_REQUIRED: "수정 필요", HOLD_LINKED: "상위 계약 대기", SUPERSEDED: "재검증 대기", APPROVED: "승인", REJECTED: "거절·부결", BLOCKED: "차단",
  NEEDS_CLARIFICATION: "재입력 요청", AUTO_COMMITTED: "기한 경과 자동 확정", REPLACED: "새 건으로 대체" };
const PLAN_STATUS: Record<string, string> = { RECEIVED: "접수", PENDING_APPROVAL: "승인 대기", ACTION_REQUIRED: "카피 수정 필요", HOLD_LINKED: "상위 계약 대기",
  NEEDS_INFO: "확인 필요", APPROVED: "확정", REJECTED: "부결", AUTO_COMMITTED: "기한 경과 자동 확정", SUPERSEDED: "재검증 대기", ANALYZING: "분석 중" };

// 상태 패턴: 상태별 허용 명령
const ALLOWED: Record<string, string[]> = {
  RECEIVED: ["analyze"], ANALYZING: ["analysis_done"], PENDING_APPROVAL: ["approve", "reject", "request_info", "supersede", "expire"],
  NEEDS_INFO: ["receive_reply", "supersede", "expire"], ACTION_REQUIRED: ["apply_fix", "reject", "supersede", "expire"],
  HOLD_LINKED: ["linked_resolved", "supersede", "expire"], SUPERSEDED: ["analyze"], APPROVED: ["supersede_after_approval"],
};
const OPEN = new Set(["RECEIVED", "ANALYZING", "PENDING_APPROVAL", "NEEDS_INFO", "ACTION_REQUIRED", "HOLD_LINKED", "SUPERSEDED"]);
const TERMINAL = new Set(["APPROVED", "REJECTED", "BLOCKED", "NEEDS_CLARIFICATION", "AUTO_COMMITTED", "REPLACED"]);

export class DeskError extends Error {}
export const CLOCK_MAX = "2027-06-30";
// P-01: 서버 workflow/permissions.py COMMAND_ROLES와 같은 정책
const COMMAND_ROLES: Record<string, string[]> = { change_condition: ["FINANCE", "SYSTEM"], apply_fix: ["MARKETING_TEAM"] };
const COMMAND_LABEL: Record<string, string> = { change_condition: "현금 전망 가정 변경", apply_fix: "광고 카피 수정" };
function need(action: string, actor: string) {
  const roles = COMMAND_ROLES[action];
  if (roles && !roles.includes(actor)) throw new DeskError(`${COMMAND_LABEL[action]}은(는) ${roles.filter((r) => r !== "SYSTEM").map((r) => ROLE_KO[r] ?? r).join(", ")}만 할 수 있습니다(${ROLE_KO[actor] ?? actor} 불가).`);
}   // 기준일 + 계약 갱신 1년(서버 schemas.CLOCK_MAX와 같음)
const ONCE: Record<string, [(c: Case) => boolean, string]> = {
  CONTRACT_RENEWAL_NOTICE: [(c) => c.kind === "CONTRACT_RENEWAL_NOTICE", "전속계약 갱신 통보"],
  BUDGET_PLAN_BATCH: [(c) => c.type === "PLAN", "확대 기안 25건"],
  AGENCY_COUNTER_OFFER: [(c) => c.kind === "AGENCY_COUNTER_OFFER", "에이전시 역제안"],
};

export function initialState(): DeskState {
  return { schema: SCHEMA, seq: { case: 0, task: 0, audit: 0, outbox: 0 }, cases: {}, tasks: {}, audit: [], outbox: [],
    ctx: { id: "ctx", today: "2026-07-01", cash_assumption: "AS_IS", contract_status: "UNDER_REVIEW", offer: null, claims: [], copy_overrides: {} } };
}

type S = DeskState;
const pad = (n: number) => String(n).padStart(4, "0");
const nextId = (s: S, k: keyof S["seq"], p: string) => `${p}-${pad(++s.seq[k])}`;
const now = () => new Date().toISOString().slice(0, 19);

function audit(s: S, topic: string, detail: string, actor = "SYSTEM", case_id: string | null = null) {
  s.audit.push({ id: nextId(s, "audit", "AU"), sim_date: s.ctx.today, at: now(), topic, actor, case_id, detail });
}
function transition(s: S, c: Case, cmd: string, to: string, by: string, note: string) {
  if (!(ALLOWED[c.state] ?? []).includes(cmd)) throw new DeskError(`'${STATE_KO[c.state]}' 상태에서는 '${cmd}'를 할 수 없습니다.`);
  c.history.push({ sim_date: s.ctx.today, from: c.state, to, by, note });
  if (c.state === "NEEDS_INFO" && to !== "NEEDS_INFO") delete c.hold_reason; // 30차(AP-06): 보류가 풀리는 모든 길에서 사유를 지움
  c.state = to;
}
/** 30차(AP-07): 현재 광고 카피에 수정이 필요한 위반이 남아 있는가 — 남아 있으면 누구도 승인할 수 없음(서버와 같은 규칙). */
export function copyUnresolved(c: Case): boolean { return c.type === "PLAN" && !!c.decision?.regulation?.findings?.length; }
/** 30차(AP-04): 확인 요청을 받아 근거를 보완할 부서 = 그 건을 올린 부서. */
export function infoDept(c: Case): string { return c.type === "CONTRACT" || c.type === "RENEWAL" ? "CONTRACT_OWNER" : "MARKETING_TEAM"; }
function createTask(s: S, caseId: string, t: Partial<Task> & TaskSpec) {
  if (["FIX", "INFO_REQUEST", "DEADLINE_ALERT"].includes(t.kind)) { // 재분석해도 같은 확인·수정 작업은 하나만
    const ex = Object.values(s.tasks).find((x) => x.case_id === caseId && x.kind === t.kind && x.status === "OPEN");
    if (ex) return ex;
  }
  const id = nextId(s, "task", "TK");
  s.tasks[id] = { id, case_id: caseId, status: "OPEN", created_on: s.ctx.today, ...t } as Task;
  audit(s, "task.created", `${ROLE_KO[t.dept] ?? t.dept}: ${t.title}`, "SYSTEM", caseId);
  return s.tasks[id];
}

// ---------- LangGraph 파이프라인의 브라우저 판(노드 순서·검증 규칙 동일) ----------
function factsText(d: Decision) { return d.evidence.map((e) => `[${e.kind}/${e.scale}] ${e.text} (${e.source})`).join("\n"); }
function explain(d: Decision, hits: { source: string; text: string }[]) {
  const lines = [`■ 결론: ${d.label}`, `■ 제안: ${d.proposal}`, "■ 근거:", ...d.evidence.slice(0, 4).map((e, i) => `  ${i + 1}. [${e.kind}/${e.scale}] ${e.text} (${e.source})`),
    `■ 승인자: ${ROLE_KO[d.approver ?? ""] ?? "확인 필요"}`];
  if (hits[0]) lines.push(`■ 정책 근거: [${hits[0].source}] ${hits[0].text.split("\n")[0].slice(0, 120)}`);
  if (d.needs_info.length) lines.push(`■ 확인 필요: ${d.needs_info.join("; ")}`);
  return lines.join("\n");
}
const NUM = /-?\d[\d,]*\.?\d*/g;
const nums = (t: string) => new Set((t.replace(/[A-Z]{2,}-[\w\-~]+|\d{4}-\d{2}-\d{2}/g, " ").replace(/^\s*\d+\.\s/gm, "").match(NUM) ?? [])
  .map((n) => n.replace(/,/g, "").replace(/\.$/, "")).filter((n) => n.replace(".", "").replace("-", "").length >= 2));
function judge(facts: string, policy: string, answer: string) {
  const a = nums(answer), f = nums(facts + "\n" + policy);
  const un = [...a].filter((x) => !f.has(x));
  return { faithfulness: a.size ? +(1 - un.length / a.size).toFixed(3) : 1, policy_grounded: answer.includes("정책 근거") ? 1 : 0.5,
    issues: un.length ? [`사실 목록에 없는 수치: ${un.slice(0, 5).join(", ")}`] : [], judge: "rule(브라우저)" };
}

function runPipeline(s: S, c: Case): void {
  const trace: NodeTrace[] = [];
  const step = (node: string, note: string) => trace.push({ node, note, ms: 0 });
  const v = checkInput(c.event_text);
  step("security_input", `check_input → ${v.action}`);
  c.validation = { input: v };
  if (v.action !== "pass") {
    c.trace = trace; c.issues = [{ message: v.message }];
    transition(s, c, "analysis_done", v.action === "block" ? "BLOCKED" : "NEEDS_CLARIFICATION", "SYSTEM", v.message);
    return;
  }
  const d = c.type === "CONTRACT" ? decideContract(s.ctx) : decidePlan(c.target_id, s.ctx);
  step("decide", `권고 ${d.recommendation} · 승인자 ${d.approver ?? "확인 필요"}`);
  step("regulation", c.type === "PLAN" ? `check_regulation → ${d.regulation?.verdict.action ?? "pass"}` : "대상 아님(계약 건)");
  const hits = DS.policy_hits[c.type === "CONTRACT" ? (s.ctx.offer ? "CONTRACT:counter" : "CONTRACT:base") : `PLAN:${c.target_id}`] ?? [];
  step("retrieve_policy", `정책 조각 ${hits.length}개 (백엔드 FAISS 하이브리드 사전 계산)`);
  let text = explain(d, hits);
  step("explain", "설명문 생성(offline)");
  const sc = selfCheck(d);
  const policy = hits.map((h) => `[${h.source}] ${h.text}`).join("\n---\n");
  let jg = judge(`${d.proposal}\n${d.label}\n${factsText(d)}`, policy, text);
  step("judge", `self_check ${sc.action} · faithfulness ${jg.faithfulness}`);
  if (sc.action === "reject" || jg.faithfulness < 0.9) { text = explain(d, hits); step("explain", "재생성(1회)"); jg = judge(factsText(d), policy, text); step("judge", `재심사 faithfulness ${jg.faithfulness}`); }
  let masked = 0;
  d.evidence = d.evidence.map((e) => { const o = checkOutput(e.text); if (o.action === "warn") { masked++; return { ...e, text: o.masked_text }; } return e; });
  const ov = checkOutput(text);
  if (ov.action === "warn") masked++;
  step("security_output", `check_output — 마스킹 ${masked}건`);
  Object.assign(c, { decision: d, explanation: ov.masked_text, judge: jg, trace, policy_hits: hits, llm: "offline",
    validation: { ...c.validation, self_check: sc, regulation: d.regulation?.verdict } });
  c.approval = { approver: d.approver, proposal: d.proposal, recommendation: d.recommendation, label: d.label, decision: null };
  const next = d.needs_info.length ? "NEEDS_INFO" : d.recommendation === "HOLD_COPY" ? "ACTION_REQUIRED" : d.recommendation === "HOLD_LINKED" ? "HOLD_LINKED" : "PENDING_APPROVAL";
  transition(s, c, "analysis_done", next, "SYSTEM", d.label);
}

function analyze(s: S, c: Case, actor = "SYSTEM") {
  c.history.push({ sim_date: s.ctx.today, from: c.state, to: "ANALYZING", by: actor, note: "판단 파이프라인 실행" });
  c.state = "ANALYZING";
  runPipeline(s, c);
  const d = c.decision;
  if (c.state === "NEEDS_INFO" && d) {
    const due = addDays(d.subject.deadline, -7);
    for (const q of d.needs_info) createTask(s, c.id, { dept: "CONTRACT_OWNER", title: `[확인 요청] ${q} → 에이전시에 지급 일정 회신 요청`, due, kind: "INFO_REQUEST",
      channel: "email:agency", message: `[Masil Commerce → 에이전시] 역제안 검토를 위해 고정 피 지급 일정(지급일·금액)을 ${due}까지 회신 부탁드립니다. 지급일에 따라 승인 절차가 달라집니다.` });
  }
  if (c.state === "ACTION_REQUIRED" && d) createTask(s, c.id, { dept: "MARKETING_TEAM", title: `[카피 수정] ${d.subject.id} — 수정안 “${d.regulation?.rewrite}” 검토 후 재상신`, due: d.subject.deadline, kind: "FIX" });
  audit(s, "case.analyzed", `${c.title} → ${STATE_KO[c.state]} (${d?.label ?? ""})`, actor, c.id);
}

/** V-02(11차): 직접 들어온 문장도 연락처·이메일·계좌를 가려서 저장·표시(서버 service._intake와 같음). */
function inboundText(text?: string): { text: string; extra: Partial<Case> } {
  if (!text) return { text: "", extra: {} };
  const o = checkOutput(text);
  return { text: o.action === "block" ? "(시스템 비밀값으로 보이는 문자열이 있어 원문을 가렸습니다)" : o.masked_text, extra: o.action === "pass" ? {} : { inbound: { masked: true } as Case["inbound"] } };
}

function newCase(s: S, kind: string, target: string, title: string, text: string, extra: Partial<Case> = {}): Case {
  const type = kind === "CONTRACT_RENEWAL_NOTICE" || kind === "AGENCY_COUNTER_OFFER" ? "CONTRACT" : kind === "FREE_TEXT" ? "MEMO" : "PLAN"; // D-06
  const c: Case = { id: nextId(s, "case", "CS"), type, kind,
    target_id: target, title, event_text: text, state: "RECEIVED", received_on: s.ctx.today, history: [], approval: null, version: 1, ...extra };
  s.cases[c.id] = c;
  audit(s, "case.received", title, "SYSTEM", c.id);
  return c;
}

function reanalyzeOpen(s: S, pred: (c: Case) => boolean, note: string) {
  const out: Case[] = [];
  for (const c of Object.values(s.cases)) {
    if (!pred(c) || !["PENDING_APPROVAL", "NEEDS_INFO", "ACTION_REQUIRED", "HOLD_LINKED"].includes(c.state)) continue;
    if (c.state === "NEEDS_INFO" && c.hold_reason === "MANUAL") continue; // D-10: 사람이 건 확인 요청은 재검증으로 풀지 않음(30차 AP-06: '확인 필요'일 때만)
    const before = c.approval?.approver;
    transition(s, c, "supersede", "SUPERSEDED", "SYSTEM", note);
    analyze(s, c); c.version++;
    if (before !== c.approval?.approver) audit(s, "authority.changed", `${c.target_id} 승인자 변경 ${ROLE_KO[before ?? ""] ?? "-"} → ${ROLE_KO[c.approval?.approver ?? ""] ?? "-"}`, "SYSTEM", c.id);
    out.push(c);
  }
  return out;
}

// ---------- 명령(커맨드) ----------
export type Command =
  | { type: "intake"; kind: "CONTRACT_RENEWAL_NOTICE" | "BUDGET_PLAN_BATCH" | "AGENCY_COUNTER_OFFER" | "MARKETING_CLAIM" | "FINANCE_OVERDUE_AR" | "FREE_TEXT"; text?: string }
  | { type: "decide"; caseId: string; actor: string; action: "approve" | "reject" | "request_info"; comment?: string; expectedVersion?: number }
  | { type: "reply"; key: "agency_payment_schedule" | "agency_accepts_termination" }
  | { type: "fix"; caseId: string; actor: string; copy?: string }
  | { type: "taskDone"; taskId: string; actor: string }
  | { type: "condition"; actor: string; cash: Ctx["cash_assumption"] }
  | { type: "clock"; to: string; actor?: string };

export function apply(prev: S, cmd: Command): { state: S; info: string } {
  const s: S = structuredClone(prev);
  try {
    const info = exec(s, cmd);
    return { state: s, info };
  } catch (e) {
    if (e instanceof DeskError) {
      const next = structuredClone(prev);
      audit(next, "command.refused", `${cmd.type} 거부: ${e.message}`, "actor" in cmd ? cmd.actor : "SYSTEM", "caseId" in cmd ? cmd.caseId : null);
      return { state: next, info: `⚠ ${e.message}` };
    }
    throw e;
  }
}

function exec(s: S, cmd: Command): string {
  const mr = DS.mock_replies;
  switch (cmd.type) {
    case "intake": {
      const once = ONCE[cmd.kind];   // E-05: 같은 사건 중복 접수 방지(백엔드 Duplicate와 같은 규칙)
      if (once && Object.values(s.cases).some(once[0])) throw new DeskError(`${once[1]}은(는) 이미 접수되어 다시 처리하지 않았습니다(중복 접수 방지).`);
      if (cmd.kind === "CONTRACT_RENEWAL_NOTICE") { const m = inboundText(cmd.text); const c = newCase(s, cmd.kind, CONTRACT.contract_id, "INF-001 혜인 전속계약 갱신 통보", m.text || `에이전시 공문: INF-001 연간 전속계약 갱신 통보(통보 기한 ${CONTRACT.notice_deadline})`, m.extra); analyze(s, c); return `${c.id} 분석 완료 → ${STATE_KO[c.state]}`; }
      if (cmd.kind === "BUDGET_PLAN_BATCH") { DS.plans.forEach((p) => analyze(s, newCase(s, cmd.kind, p.plan_id, `${p.plan_id} 캠페인 확대 기안`, `마케팅팀 확대 기안 상신 ${p.plan_id}`))); return `기안 ${DS.plans.length}건 분석 완료`; }
      if (cmd.kind === "AGENCY_COUNTER_OFFER") {
        const r = mr.agency_counter_offer as { reply_id: string; summary: string; fixed_fee_krw: number; performance_fee: string; payment_schedule: null };
        const m = checkOutput(r.summary);
        s.ctx.contract_status = "COUNTER_OFFER";
        s.ctx.offer = { reply_id: r.reply_id, fixed_fee_krw: r.fixed_fee_krw, performance_fee: r.performance_fee, payment_schedule: r.payment_schedule };
        Object.values(s.cases).filter((x) => x.type === "CONTRACT" && x.state === "PENDING_APPROVAL").forEach((x) => transition(s, x, "supersede", "REPLACED", "SYSTEM", "에이전시 역제안 수신 → 새 건으로 대체"));
        const c = newCase(s, cmd.kind, CONTRACT.contract_id, "INF-001 에이전시 역제안(조건 변경)", m.masked_text, { inbound: { reply_id: r.reply_id, masked: m.action === "warn" } });
        analyze(s, c);
        return `${c.id} 역제안 접수 → ${STATE_KO[c.state]}${m.action === "warn" ? " (연락처 마스킹)" : ""}`;
      }
      if (cmd.kind === "MARKETING_CLAIM") {
        const r = mr.marketing_claim_report;
        s.ctx.claims = [...s.ctx.claims, { from: "마케팅팀", summary: r.summary }];
        audit(s, "claim.recorded", `부서 주장 기록(사실 아님): ${r.summary}`, "MARKETING_TEAM");
        const n = reanalyzeOpen(s, (c) => c.type === "CONTRACT", "마케팅팀 성과 보고(주장) 반영 재검토");
        return `마케팅팀 주장 기록 · 계약 건 ${n.length}건 재검토(결론 유지 여부 확인)`;
      }
      if (cmd.kind === "FINANCE_OVERDUE_AR") {
        const r = mr.finance_overdue_ar;
        audit(s, "reply.received", `모의 회신 ${r.reply_id}: ${r.summary}`, "FINANCE");
        return exec(s, { type: "condition", actor: "FINANCE", cash: "CONSERVATIVE" });
      }
      const m = inboundText(cmd.text);
      const c = newCase(s, "FREE_TEXT", "MEMO", "자유 입력 메모", m.text, m.extra);
      const v = checkInput(cmd.text ?? "");   // 우회 지시 검사는 원문으로
      c.validation = { input: v };
      c.state = v.action === "block" ? "BLOCKED" : v.action === "warn" ? "NEEDS_CLARIFICATION" : "RECEIVED";
      c.issues = v.message ? [{ message: v.message }] : [];
      audit(s, "input.checked", `check_input → ${v.action}: ${v.message || "통과"}`, "SYSTEM", c.id);
      return v.action === "pass" ? "메모 접수" : `⚠ ${v.message}`;
    }
    case "decide": {
      const c = s.cases[cmd.caseId];
      if (!c) throw new DeskError("처리 건을 찾을 수 없습니다.");
      if (cmd.expectedVersion !== undefined && c.version !== cmd.expectedVersion)   // AG-02(20차): 서버와 같은 문장
        throw new DeskError(!c.approval?.decision && c.state === "PENDING_APPROVAL" ? "이 결재 서류는 화면을 연 뒤에 바뀌었습니다(AI 설명 도착·재분석 등). 바뀐 내용을 확인한 뒤 다시 결재하세요." : "다른 사용자가 먼저 이 건을 처리했습니다. 새로고침 후 다시 확인하세요.");
      const ap = c.approval!;
      if (cmd.actor !== ap?.approver) { // D-11: 수정 필요 건 부결도 결재권자만 · 30차(AP-03): 확인 요청도 결재권자만(서버와 같은 문장)
        const who = ROLE_KO[ap?.approver ?? ""] ?? "미정";
        throw new DeskError(cmd.action === "request_info" ? `이 건의 확인 요청은 결재권자(${who})만 할 수 있습니다(${ROLE_KO[cmd.actor]} 불가).` : `이 건의 승인 권한은 ${who}에게 있습니다(${ROLE_KO[cmd.actor]} 불가).`);
      }
      if (cmd.action === "approve" && copyUnresolved(c))
        throw new DeskError("광고 카피 위반이 남아 있어 승인할 수 없습니다 — 마케팅팀이 수정안을 반영해 재검증을 통과한 뒤 결재하세요(부결·확인 요청은 가능).");
      if (cmd.action === "request_info") {
        transition(s, c, "request_info", "NEEDS_INFO", cmd.actor, cmd.comment || "추가 확인 요청");
        c.hold_reason = "MANUAL";
        createTask(s, c.id, { dept: infoDept(c), title: `[확인 요청] ${c.target_id}: ${cmd.comment || "근거 보완"}`, due: c.decision?.subject.deadline ?? null, kind: "INFO_REQUEST", resume_case: true });
        audit(s, "case.info_requested", `${c.title} 확인 요청${cmd.comment ? ` — ${cmd.comment}` : ""}`, cmd.actor, c.id); // 30차(AP-08)
        c.version++;
        return `${c.id} 확인 요청`;
      }
      const to = cmd.action === "approve" ? "APPROVED" : "REJECTED";
      transition(s, c, cmd.action, to, cmd.actor, cmd.comment ?? "");
      Object.assign(ap, { decision: cmd.action, decided_by: cmd.actor, decided_on: s.ctx.today, comment: cmd.comment ?? "" });
      const specs = cmd.action === "approve" ? c.decision!.on_approve : c.decision!.on_reject;
      specs.forEach((t) => createTask(s, c.id, t));
      effects(s, c, cmd.action);
      c.version++;
      audit(s, `case.${to.toLowerCase()}`, `${c.title} ${cmd.action === "approve" ? "승인" : "거절"} — ${cmd.comment ?? ""}`, cmd.actor, c.id);
      return `${c.id} ${cmd.action === "approve" ? "승인" : "거절"} · 작업 ${specs.length}건 생성`;
    }
    case "reply": {
      const r = mr[cmd.key] as { reply_id: string; summary: string; payment_schedule?: { date: string; amount_krw: number }[] };
      const m = checkOutput(r.summary);
      if (cmd.key === "agency_payment_schedule") {
        if (s.ctx.offer?.payment_schedule) throw new DeskError(`이미 받은 회신(${r.reply_id})입니다 — 다시 반영하지 않았습니다.`); // 30차(AP-05)
        const targets = Object.values(s.cases).filter((x) => x.type === "CONTRACT" && x.state === "NEEDS_INFO" && x.hold_reason !== "MANUAL");
        if (!targets.length) throw new DeskError("지급 일정 회신을 기다리는 건이 없습니다.");
        s.ctx.offer = { ...(s.ctx.offer ?? {}), payment_schedule: r.payment_schedule };
        audit(s, "reply.received", m.masked_text, "AGENCY"); // 30차(O-5): 회신 접수 → 결과 순서
        for (const c of targets) {
          transition(s, c, "receive_reply", "RECEIVED", "AGENCY", `모의 회신 ${r.reply_id}: ${m.masked_text}`);
          Object.values(s.tasks).filter((t) => t.case_id === c.id && t.kind === "INFO_REQUEST" && t.status === "OPEN")
            .forEach((t) => Object.assign(t, { status: "DONE", done_by: "AGENCY", done_on: s.ctx.today, result: m.masked_text }));
          analyze(s, c, "AGENCY"); c.version++;
        }
        return `에이전시 회신 반영 → 재분석 ${targets.length}건`;
      }
      if (s.ctx.contract_status === "TERMINATION_SENT") s.ctx.contract_status = "TERMINATED";
      audit(s, "reply.received", m.masked_text, "AGENCY");
      return "에이전시 회신 기록";
    }
    case "fix": {
      need("apply_fix", cmd.actor);
      const c = s.cases[cmd.caseId];
      const copy = cmd.copy || c.decision?.regulation?.rewrite || "";
      s.ctx.copy_overrides = { ...s.ctx.copy_overrides, [c.target_id]: copy };
      transition(s, c, "apply_fix", "RECEIVED", cmd.actor, `카피 수정 반영: “${copy}”`);
      Object.values(s.tasks).filter((t) => t.case_id === c.id && t.kind === "FIX" && t.status === "OPEN").forEach((t) => Object.assign(t, { status: "DONE", done_by: cmd.actor, done_on: s.ctx.today }));
      analyze(s, c, cmd.actor); c.version++;
      return `${c.id} 수정 카피 재검증 → ${STATE_KO[c.state]}`;
    }
    case "taskDone": {
      const t = s.tasks[cmd.taskId];
      if (!t) throw new DeskError("작업을 찾을 수 없습니다.");
      if (cmd.actor !== t.dept) throw new DeskError(`이 작업은 ${ROLE_KO[t.dept] ?? t.dept}의 작업입니다(${ROLE_KO[cmd.actor] ?? cmd.actor} 불가).`);   // P-02(서버와 같은 규칙)
      if (t.status !== "OPEN") throw new DeskError("이미 처리된 작업입니다.");
      Object.assign(t, { status: "DONE", done_by: cmd.actor, done_on: s.ctx.today });
      let info = `작업 완료: ${t.title}`;
      if (t.channel) {
        const o = checkOutput(t.message || t.title);
        if (o.action === "block") throw new DeskError(o.message);
        s.outbox.push({ id: nextId(s, "outbox", "MSG"), channel: t.channel, body: o.masked_text, case_id: t.case_id, sim_date: s.ctx.today, status: "SENT(모의)" });
        audit(s, "channel.sent", `[${t.channel}] ${o.masked_text}`, cmd.actor, t.case_id);
        info += " · 채널 발송(모의)";
      }
      if (t.resume_case) { // D-02: 내부 확인 완료 → 그 건을 다시 판단해 결재로
        const c = s.cases[t.case_id];
        if (c?.state === "NEEDS_INFO") {
          transition(s, c, "receive_reply", "RECEIVED", cmd.actor, `확인 완료: ${t.title}`);
          delete c.hold_reason;
          analyze(s, c, cmd.actor); c.version++;
          info += ` · ${c.target_id} 재판단 → ${STATE_KO[c.state]}`;
        }
      }
      const eff = { CONTRACT_NOTICE_SENT: "NOTICE_SENT", CONTRACT_TERMINATION_SENT: "TERMINATION_SENT", CONTRACT_RENEWED: "RENEWED" }[t.effect ?? ""];
      if (eff) s.ctx.contract_status = eff;
      audit(s, "task.done", t.title, cmd.actor, t.case_id);
      return info;
    }
    case "condition": {
      need("change_condition", cmd.actor);
      const before = s.ctx.cash_assumption;
      s.ctx.cash_assumption = cmd.cash;
      audit(s, "condition.changed", `현금 전망 가정 ${before} → ${cmd.cash}`, cmd.actor);
      const n = reanalyzeOpen(s, () => true, `현금 전망 가정 변경(${before}→${cmd.cash}) 재검증`);
      const rank: Record<string, number> = { MARKETING_TEAM: 1, MASIL_CEO: 2, GROUP_CEO: 3 };
      const reopened: string[] = [];
      for (const c of Object.values(s.cases)) {
        if (c.type !== "PLAN" || c.state !== "APPROVED") continue;
        const nd = decidePlan(c.target_id, s.ctx);
        const by = c.approval?.decided_by ?? "";
        if ((rank[nd.approver ?? ""] ?? 0) > (rank[by] ?? 0) && String(nd.subject.settlement_date) >= s.ctx.today) {
          transition(s, c, "supersede_after_approval", "SUPERSEDED", "SYSTEM", `조건 변경으로 승인 권한 상향(${ROLE_KO[by]}→${ROLE_KO[nd.approver ?? ""]}) — 승인 무효·재상신`);
          Object.values(s.tasks).filter((t) => t.case_id === c.id && t.status === "OPEN").forEach((t) => {
            Object.assign(t, { status: "CANCELLED", done_on: s.ctx.today, result: "승인 무효(조건 변경)로 취소" });
            audit(s, "task.cancelled", `취소: ${t.title}`, "SYSTEM", c.id);
          });
          analyze(s, c); c.version++;
          audit(s, "authority.changed", `${c.target_id} 기승인 무효 → ${ROLE_KO[nd.approver ?? ""]} 재상신`, "SYSTEM", c.id);
          reopened.push(c.target_id);
        }
      }
      return `조건 변경 → 미결 ${n.length}건 재검증${reopened.length ? ` · 기승인 무효·재상신: ${reopened.join(", ")}` : ""}`;
    }
    case "clock": {
      if (cmd.to <= s.ctx.today) throw new DeskError("시계는 앞으로만 진행할 수 있습니다.");
      // D-01(6차): 서버(ClockIn)와 같은 범위 — 기존에는 브라우저 모드만 2027-06-30을 넘어 진행됨
      if (!/^\d{4}-\d{2}-\d{2}$/.test(cmd.to) || Number.isNaN(Date.parse(`${cmd.to}T00:00:00Z`)) || cmd.to > CLOCK_MAX) throw new DeskError(`시계는 2026-07-01~${CLOCK_MAX} 범위에서만 옮길 수 있습니다.`);
      audit(s, "clock.advanced", `시계 진행 ${s.ctx.today} → ${cmd.to}`, cmd.actor ?? "SYSTEM");   // Q-06(9차)
      s.ctx.today = cmd.to;
      const expired: string[] = [];
      for (const c of Object.values(s.cases)) {
        const dl = c.decision?.subject.deadline;
        if (OPEN.has(c.state) && dl && dl < cmd.to) {
          c.history.push({ sim_date: cmd.to, from: c.state, to: "AUTO_COMMITTED", by: "SYSTEM", note: `확정기한 ${dl} 경과 — 미결정이 묵시적 승인으로 확정(철회 불가)` });
          c.state = "AUTO_COMMITTED"; c.version++;
          if (c.type === "CONTRACT") s.ctx.contract_status = "AUTO_RENEWED";
          audit(s, "deadline.expired", `⚠ ${c.target_id} 기한 경과 자동 확정 — 승인 권한을 거치지 않은 체결`, "SYSTEM", c.id);
          expired.push(c.target_id);
        }
      }
      if (cmd.to > CONTRACT.notice_deadline && ["UNDER_REVIEW", "NOTICE_APPROVED", "COUNTER_OFFER", "TERMINATION_APPROVED"].includes(s.ctx.contract_status)) {
        const sent = Object.values(s.tasks).find((t) => t.effect === "CONTRACT_NOTICE_SENT" && t.status === "DONE"); // 30차(O-4)
        const what = sent ? `미갱신 통보 미발송(조건변경 통보는 ${sent.done_on} 발송 — 갱신 거절 통보로 볼 수 있는지 법무 확인 필요)` : "통보 미발송";
        audit(s, "deadline.expired", `⚠ INF-001 통보 기한 ${CONTRACT.notice_deadline}까지 ${what}(${CONTRACT_STATUS_KO[s.ctx.contract_status]}) — 동일 조건 자동 갱신(승인 없는 체결)`);
        s.ctx.contract_status = "AUTO_RENEWED";
      }
      for (const c of Object.values(s.cases)) {
        const dl = c.decision?.subject.deadline;
        if (!OPEN.has(c.state) || !dl) continue;
        const left = daysBetween(cmd.to, dl);
        if (left >= 0 && left <= 3 && !Object.values(s.tasks).some((t) => t.case_id === c.id && t.kind === "DEADLINE_ALERT"))
          createTask(s, c.id, { dept: c.approval?.approver ?? "CONTRACT_OWNER", title: `[기한 임박 D-${left}] ${c.title} 결정 필요`, due: dl, kind: "DEADLINE_ALERT" });
      }
      return `기준일 ${cmd.to}${expired.length ? ` · 기한 경과 자동 확정 ${expired.length}건` : ""}`;
    }
  }
}

function effects(s: S, c: Case, action: string) {
  if (c.type !== "CONTRACT") return;
  s.ctx.contract_status = c.kind === "CONTRACT_RENEWAL_NOTICE" ? (action === "approve" ? "NOTICE_APPROVED" : "UNDER_REVIEW") : (action === "approve" ? "RENEWAL_APPROVED" : "TERMINATION_APPROVED");
  const effs = new Set((action === "approve" ? c.decision!.on_approve : c.decision!.on_reject).map((t) => t.effect));
  const linked = c.decision!.linked_plans ?? [];
  for (const p of Object.values(s.cases)) {
    if (p.type !== "PLAN" || !linked.includes(p.target_id) || TERMINAL.has(p.state)) continue;
    if (effs.has("REJECT_LINKED_PLANS")) {
      p.history.push({ sim_date: s.ctx.today, from: p.state, to: "REJECTED", by: "SYSTEM", note: `상위 계약 결정(${c.id}, 그룹 CEO/이사회)에 따라 부결` });
      p.state = "REJECTED"; p.approval = { ...p.approval!, decision: "reject", decided_by: "SYSTEM(상위 계약 연동)" }; p.version++;
      audit(s, "case.rejected", `${p.target_id} 상위 계약 연동 부결`, "SYSTEM", p.id);
    } else if (effs.has("HOLD_LINKED_PLANS")) {
      p.history.push({ sim_date: s.ctx.today, from: p.state, to: "HOLD_LINKED", by: "SYSTEM", note: `상위 계약 조건변경 통보 승인(${c.id}) — 결과까지 보류` });
      p.state = "HOLD_LINKED"; p.version++;
      audit(s, "case.hold", `${p.target_id} 상위 계약 대기 보류`, "SYSTEM", p.id);
    } else if (p.state === "HOLD_LINKED" && !HOLD_STATUSES.has(s.ctx.contract_status)) { // D-09
      transition(s, p, "linked_resolved", "RECEIVED", "SYSTEM", `상위 계약 결정(${c.id}) — 보류 해제 후 재판단`);
      analyze(s, p); p.version++;
      audit(s, "case.released", `${p.target_id} 상위 계약 결정으로 보류 해제`, "SYSTEM", p.id);
    }
  }
}

/** R-02(10차): 감사 검색 대상 = 화면에 보이는 것(내용·역할 코드와 한국어명·로그인 사용자·건 ID·주제·날짜 두 표기).
 *  서버(service.audit_text, MySQL audit.search_text)와 같은 규칙. 값이 없는 칸은 빈칸. */
export const auditText = (a: DeskState["audit"][number]) => [a.detail, a.actor, ROLE_KO[a.actor], (a as { user?: string | null }).user, a.case_id, a.topic, a.sim_date,
  `${Number(a.sim_date.slice(5, 7))}월 ${Number(a.sim_date.slice(8, 10))}일`].filter((x) => x !== undefined && x !== null && x !== "").join(" ").toLowerCase();

/** Q-01(9차): 자릿수가 늘어나는 ID(CS-9999 → CS-10000)를 숫자 순서로. 문자열 비교면 CS-10000이 앞에 온다. */
const byId = (a: { id: string }, b: { id: string }) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function snapshot(s: S): Snapshot {
  const cases = Object.values(s.cases).sort(byId);
  const plans: Record<string, string> = {};
  cases.filter((c) => c.type === "PLAN").forEach((c) => { plans[c.target_id] = PLAN_STATUS[c.state] ?? c.state; });
  return { ctx: s.ctx, contract_status_ko: CONTRACT_STATUS_KO[s.ctx.contract_status] ?? s.ctx.contract_status, cases, plans,
    tasks: Object.values(s.tasks).sort(byId), audit: s.audit, audit_total: (s.archived ?? 0) + s.audit.length, outbox: s.outbox };
}
