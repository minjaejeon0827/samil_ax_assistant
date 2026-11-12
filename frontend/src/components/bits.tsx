import type { EvKind, Scale } from "../engine/types";
import { STATE_KO } from "../engine/desk";

export const KIND_KO: Record<EvKind, string> = { ORIGINAL: "원본", CALC: "계산", ASSUMPTION: "가정", CLAIM: "주장", MOCK: "모의" };
export const SCALE_KO: Record<Scale, string> = { SAMPLE: "표본", FULL: "풀스케일", NA: "" };

export function KindBadge({ kind }: { kind: EvKind }) {
  return <span className={`badge kind-${kind}`} title={kindHelp[kind]}>{KIND_KO[kind]}</span>;
}
const kindHelp: Record<EvKind, string> = {
  ORIGINAL: "제공 데이터·문서에서 그대로 확인한 사실", CALC: "원본으로 계산한 값(산식은 calculation_definitions)",
  ASSUMPTION: "참가자가 둔 가정·합성 데이터(ASSUMPTIONS.md)", CLAIM: "부서 의견 — 사실로 쓰지 않음", MOCK: "외부 회신을 흉내 낸 모의 데이터",
};
export function ScaleBadge({ scale }: { scale: Scale }) {
  if (scale === "NA") return null;
  return <span className={`badge scale-${scale}`} title={scale === "SAMPLE" ? "대표 표본 — 비중·순위로만 해석" : "회사 실제 규모 금액"}>{SCALE_KO[scale]}</span>;
}

const TONE: Record<string, string> = {
  PENDING_APPROVAL: "wait", NEEDS_INFO: "hold", ACTION_REQUIRED: "hold", HOLD_LINKED: "hold", SUPERSEDED: "hold",
  APPROVED: "pass", REJECTED: "seal", BLOCKED: "seal", AUTO_COMMITTED: "seal", NEEDS_CLARIFICATION: "hold", REPLACED: "mute", RECEIVED: "mute", ANALYZING: "mute",
};
export function StateChip({ state }: { state: string }) {
  return <span className={`chip tone-${TONE[state] ?? "mute"}`}>{STATE_KO[state] ?? state}</span>;
}

export const RECO_TONE: Record<string, string> = {
  APPROVE: "pass", CONDITIONAL: "hold", CHANGE_TERMS: "hold", REJECT: "seal", HOLD_COPY: "hold", HOLD_SUPPLY: "hold", HOLD_LINKED: "hold", NEEDS_INFO: "hold",
};

export const fmtDate = (d: string) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;

/** 대화상자 안에서만 Tab이 돌게 한다(J-08: 기존에는 Tab이 뒤쪽 화면으로 빠져나감). */
export function trapTab(e: { key: string; shiftKey: boolean; currentTarget: HTMLElement; preventDefault: () => void }) {
  if (e.key !== "Tab") return;
  const f = [...e.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])')];
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1], cur = document.activeElement;
  if (e.shiftKey && (cur === first || !e.currentTarget.contains(cur))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (cur === last || !e.currentTarget.contains(cur))) { e.preventDefault(); first.focus(); }
}
