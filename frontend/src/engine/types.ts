// 백엔드(app/workflow/service.py) 스냅샷과 같은 모양. 브라우저 단독 모드와 API 모드가 같은 화면을 쓴다.
export type Role = "MARKETING_TEAM" | "MASIL_CEO" | "GROUP_CEO" | "FINANCE" | "SCM" | "CONTRACT_OWNER" | "TEST_AURORA" | "AGENCY" | "SYSTEM";
export type EvKind = "ORIGINAL" | "CALC" | "ASSUMPTION" | "CLAIM" | "MOCK";
export type Scale = "SAMPLE" | "FULL" | "NA";
export type CashAssumption = "AS_IS" | "CONSERVATIVE" | "LEGACY45";

export interface Evidence { kind: EvKind; text: string; source: string; scale: Scale }
export interface TaskSpec { dept: string; title: string; due: string | null; kind: string; channel?: string; effect?: string; message?: string; resume_case?: boolean }
export interface Alternative { code: string; label: string; pros?: string; cons?: string }
export interface TraceStep { rule: string; result: string; before: string; why: string; source: string }
export interface Authority { approver: string; group_report: boolean; covenant_override: boolean; needs_info: string[]; trace: TraceStep[] }

export interface Decision {
  subject: { type: "CONTRACT" | "PLAN" | "RENEWAL"; id: string; name: string; deadline: string; dday: number; [k: string]: unknown };
  proposal: string;
  recommendation: string;
  label: string;
  evidence: Evidence[];
  alternatives: Alternative[];
  authority: Authority;
  approver: string | null;
  needs_info: string[];
  linked_plans?: string[];
  regulation?: { verdict: Record<string, string>; findings: { id: string; law: string; title: string; action: string; hits: string[] }[]; rewrite: string } | null;
  copy?: string;
  cash?: { window: [string, string] | null; min_balance: number; min_date: string; assumption: string; official_min: number };
  checks?: { id: string; level: "high" | "watch" | "info" | "missing"; text: string }[];   // v1.21: 계약서 자동 확인
  contract_summary?: { text: string; llm: string; judge?: { faithfulness?: number; issues?: string[] } | null } | null;   // v1.22(⑤): 계약서 요약(참고용)
  on_approve: TaskSpec[];
  on_reject: TaskSpec[];
}

export interface History { sim_date: string; from: string; to: string; by: string; note: string }
export interface Approval { approver: string | null; proposal: string; recommendation: string; label: string; decision: string | null; decided_by?: string; decided_on?: string; comment?: string }
export interface NodeTrace { node: string; note: string; ms: number }

export interface Case {
  id: string; type: "CONTRACT" | "PLAN" | "MEMO" | "RENEWAL"; hold_reason?: "MANUAL"; kind: string; target_id: string; title: string; event_text: string;
  state: string; received_on: string; history: History[]; approval: Approval | null; version: number;
  decision?: Decision; explanation?: string; judge?: { faithfulness: number; policy_grounded: number; issues: string[]; judge?: string; replaced?: string };
  validation?: Record<string, unknown>; trace?: NodeTrace[]; issues?: { message: string }[];
  policy_hits?: { source: string; text: string; score: number }[]; llm?: string; late_explanation?: string; late_llm?: string;
  explain_archive?: { kind: "late" | "late_rejected"; text?: string; llm?: string; reason?: string; faithfulness?: number; case_version?: number; at?: number;
    approval: { approver?: string | null; decision?: string | null; decided_by?: string; decided_on?: string } }[];
  inbound?: { reply_id?: string; masked: boolean };   // ↑ v1.22(⑥): 결재 뒤 AI 설명 보관함
}
export interface Task { id: string; case_id: string; dept: string; title: string; due: string | null; kind: string; status: "OPEN" | "DONE" | "CANCELLED";
  created_on: string; channel?: string; effect?: string; resume_case?: boolean; message?: string; done_by?: string; done_on?: string; result?: string }
export interface Audit { id: string; sim_date: string; at: string; topic: string; actor: string; case_id?: string | null; detail: string; user?: string | null }
export interface Message { id: string; channel: string; body: string; case_id: string | null; sim_date: string; status: string }

export interface Ctx {
  id: "ctx"; today: string; cash_assumption: CashAssumption; contract_status: string;
  offer: Record<string, unknown> | null; claims: { from: string; summary: string }[]; copy_overrides: Record<string, string>;
}
export interface DeskState {
  schema: number; ctx: Ctx; seq: { case: number; task: number; audit: number; outbox: number };
  cases: Record<string, Case>; tasks: Record<string, Task>; audit: Audit[]; outbox: Message[];
  /** Q-03(9차): 브라우저 보관함(IndexedDB)으로 옮긴 오래된 감사 기록 수 */
  archived?: number;
}
export interface AuditPage { total: number; matched: number; offset: number; items: Audit[] }
export interface Snapshot {
  ctx: Ctx; contract_status_ko: string; audit_total?: number; cases: Case[]; plans: Record<string, string>; tasks: Task[]; audit: Audit[]; outbox: Message[];
}

/** v1.27: GET /api/audit/verify — 감사 기록 해시 체인 검증 결과(서버 모드) */
export interface AuditVerify { ok: boolean; checked: number; legacy: number; head: string; head_id: string | null; broken: { id: string; reason: string }[]; broken_total: number; ms: number }
