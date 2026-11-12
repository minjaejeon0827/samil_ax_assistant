// 검증 함수 4종의 브라우저 판 — backend/app/validation/*과 같은 계약(반환 키·action 값·normalize+squeeze).
import { DS, type LegalRule } from "./data";

// V-01(11차): 보이지 않는 문자(서식 문자 Cf·한글 채움 문자)를 지우고 검사 — backend text.py strip_invisible과 같은 규칙
export const stripInvisible = (t: string) => (t ?? "").replace(/[\p{Cf}\u115F\u1160\u3164\uFFA0]/gu, "");
// X-04(12차): 키릴·그리스 문자로 쓴 '영어처럼 보이는' 글자를 라틴 문자로(검사용) — backend text.py CONFUSABLE과 같은 표
const CONF_SRC = "аАвВеЕёЁкКмМнНоОрРсСтТуУхХѕЅіІїјЈԁԛԝɡαΑβΒεΕζΖηΗιΙκΚμΜνΝοΟρΡτΤυΥχΧ", CONF_DST = "aAbBeEeEkKmMhHoOpPcCtTyYxXsSiIijJdqwgaAbBeEzZnHiIkKuMvNoOpPtTuYxX";
const CONF = new Map([...CONF_SRC].map((c, i) => [c, CONF_DST[i]]));
export const foldConfusables = (t: string) => [...(t ?? "")].map((c) => CONF.get(c) ?? c).join("");
const foldWidth = (t: string) => t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
export const normalize = (t: string) => foldConfusables(stripInvisible(t).normalize("NFKC")).toLowerCase().replace(/\s+/g, " ").trim();
export const squeeze = (t: string) => normalize(t).replace(/\s+/g, "");

const INJECTION = ["이전 지시 무시", "이전지시무시", "ignore previous", "ignore all previous", "system prompt", "시스템 프롬프트",
  "<|im_start|>", "</s>", "승인된 것으로 처리", "승인으로 간주", "관리자 권한으로"];
// F-03: 흔한 변형(조사·어순·영어)을 정규식으로 함께 본다 — backend security.py INJECTION_RE와 같은 식
const INJECTION_RE = [
  /(이전|앞|위|기존|모든|지금까지|위의|앞의)\s*(의|에서)?\s*(모든\s*)?(지시|명령|지침|규칙|설정|프롬프트|규정)\s*(사항|들)?\s*(을|를|은|는|도)?\s*(모두|전부|다)?\s*(무시|잊어|잊고|따르지\s*(말|않))/,
  /\b(ignore|disregard|forget|override)\b[\w\s,']{0,30}?\b(previous|prior|above|earlier|preceding|all|system)\b[\w\s']{0,20}?\b(instructions?|prompts?|rules|directions|guidelines)\b/,
];
const hitRe = (text: string) => { const n = normalize(text), s = squeeze(text); for (const rx of INJECTION_RE) { const m = rx.exec(n) ?? rx.exec(s); if (m) return m[0]; } return undefined; };
const ILLEGAL = ["리베이트 현금", "허위 세금계산서", "뒷돈", "비자금"];

const hit = (pats: string[], text: string) => {
  const n = normalize(text), s = squeeze(text);
  return pats.find((p) => n.includes(normalize(p)) || s.includes(normalize(p).replace(/ /g, "")));
};

export function checkInput(text: string): { action: "pass" | "warn" | "block"; message: string } {
  if (!text || !text.trim()) return { action: "warn", message: "입력 내용이 비어 있습니다. 사건 내용을 한 줄 이상 적어 주세요." };
  let p = hit(INJECTION, text) ?? hitRe(text);
  if (p) return { action: "block", message: `승인 절차를 우회하려는 지시('${p}')가 포함되어 처리하지 않습니다.` };
  p = hit(ILLEGAL, text);
  if (p) return { action: "block", message: `부정 지급이 의심되는 표현('${p}')이 있어 내부감시로 이관합니다.` };
  if (normalize(text).length < 4) return { action: "warn", message: "내용이 너무 짧아 판단할 수 없습니다. 대상(계약/기안 ID)과 요청을 적어 주세요." };
  return { action: "pass", message: "" };
}

const PHONE = /01[016789]-?\d{3,4}-?\d{4}/g;
const ACCOUNT = /\b\d{3}-\d{2,6}-\d{4,8}\b/g;
const RRN = /\b\d{6}-[1-4]\d{6}\b/g;   // 서버 security.py와 같게(기존: 브라우저 판에 없음)
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

export function checkOutput(text: string): { action: "pass" | "warn" | "block"; message: string; masked_text: string } {
  const clean = foldWidth(stripInvisible(text ?? ""));
  if (["sk-", "api_key=", "x-api-key:"].some((k) => foldConfusables(clean).toLowerCase().includes(k))) return { action: "block", message: "시스템 비밀값으로 보이는 문자열이 있어 내보내지 않습니다.", masked_text: "" };
  const masked = clean.replace(PHONE, (m) => `${m.slice(0, 3)}-****-****`).replace(ACCOUNT, "***-***-******").replace(RRN, "******-*******")
    .replace(EMAIL, (_m, a: string, d: string) => `${a}***@${d}`);
  if (masked !== clean) return { action: "warn", message: "연락처·이메일·계좌 등 민감정보를 가렸습니다.", masked_text: masked };
  return { action: "pass", message: "", masked_text: text ?? "" };
}

const ORDER = { pass: 0, warn: 1, block: 2 } as const;

function triggerHits(text: string, r: LegalRule): string[] {
  let n = normalize(text), s = squeeze(text);
  for (const e of r.exceptions ?? []) { const en = normalize(e); n = n.split(en).join(" "); s = s.split(en.replace(/ /g, "")).join(""); }
  return (r.triggers ?? []).filter((t) => { const tn = normalize(t); return n.includes(tn) || s.includes(tn.replace(/ /g, "")); });
}

export function screen(text: string) {
  const out: { rule: LegalRule; hits: string[] }[] = [];
  const low = normalize(text);
  for (const r of DS.legal_kb.rules) {
    if (r.type === "trigger") { const h = triggerHits(text, r); if (h.length) out.push({ rule: r, hits: h }); }
    else if (!(r.required_any ?? []).some((k) => low.includes(normalize(k)))) out.push({ rule: r, hits: ["(공개 문구 없음)"] });
  }
  return out;
}

const passesStage1 = (p: string) => !screen(p).some((f) => f.rule.type === "trigger");
const safeAlt = (r: LegalRule) => r.alternatives.find(passesStage1) ?? "표현을 사실 위주로 바꿔 주세요";

export function suggestRewrite(text: string, findings: ReturnType<typeof screen>): string {
  let out = text;
  for (const f of findings) {
    if (f.rule.type === "trigger") {
      Object.entries(f.rule.replace ?? {}).sort((a, b) => b[0].length - a[0].length).forEach(([src, dst]) => { out = out.split(src).join(dst); });
    } else out = `#광고 ${out}`;
  }
  return out.split(/\s+/).filter(Boolean).join(" ");
}

export function checkRegulation(copy: string): Record<string, string> {
  const f = screen(copy ?? "");
  if (!f.length) return { action: "pass", law: "", reason: "", alternative: "", message: "" };
  const worst = f.reduce((a, b) => (ORDER[b.rule.action] > ORDER[a.rule.action] ? b : a));
  const r = worst.rule, alt = safeAlt(r);
  const others = f.filter((x) => x !== worst).map((x) => x.rule.law);
  const extra = others.length ? ` (그 밖에 ${others.join(", ")} 검토 필요)` : "";
  const head = r.type === "required_disclosure" ? "광고·협찬 표시가 없어요" : `${worst.hits.map((h) => `'${h}'`).join(", ")} 표현이 걸려요`;
  const message = r.action === "block"
    ? `${head} — ${r.reason}(${r.law}). 집행할 수 없으니 '${alt}' 같은 표현으로 바꿔 주세요.${extra}`
    : `${head} — ${r.reason}(${r.law}). 대신 '${alt}' 같은 표현은 어떨까요?${extra}`;
  return { action: r.action, law: r.law, reason: r.reason, alternative: alt, message };
}

export function regulationDetail(copy: string) {
  const f = screen(copy);
  return {
    verdict: checkRegulation(copy),
    findings: f.map((x) => ({ id: x.rule.id, law: x.rule.law, title: x.rule.title, action: x.rule.action, hits: x.hits })),
    rewrite: f.length ? suggestRewrite(copy, f) : copy,
  };
}

export function selfCheck(d: { recommendation?: string; evidence?: { kind: string }[]; alternatives?: unknown[]; approver?: string | null; needs_info?: string[] }) {
  const reasons: string[] = [];
  if (!d.recommendation) reasons.push("권고 없음");
  if (!d.evidence?.length) reasons.push("판단 근거 없음");
  if (!d.alternatives?.length) reasons.push("대안 없음");
  if (!d.approver && !d.needs_info?.length) reasons.push("승인자·확인필요 사유 모두 없음");
  return reasons.length ? { action: "reject", reasons, message: "판단 결과에 근거·대안이 부족해 다시 생성합니다." } : { action: "pass", reasons: [], message: "" };
}
