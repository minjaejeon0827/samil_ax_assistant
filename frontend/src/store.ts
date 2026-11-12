// 상태 저장소 — 기본은 브라우저 단독(localStorage 영속), VITE_API_URL이 있으면 FastAPI 모드도 선택 가능.
// v1.2(2차 E2E): 여러 탭 동기화(E-01·E-02), 저장 형식 변경 안내·보관(E-03), 중복 클릭 차단(E-05),
//                충돌 후 자동 갱신(E-06), 서버 모드 자동 갱신(E-07), 서버 장애 표시·한국어 오류(E-08).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apply, auditText, initialState, SCHEMA, snapshot, type Command } from "./engine/desk";
import type { AuditPage, AuditVerify, DeskState, Snapshot } from "./engine/types";

const KEY = "aurora-desk-state";
const UI_KEY = "aurora-desk-ui";
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "";  // 비우면 같은 출처(/api)
export const API_ENABLED = import.meta.env.VITE_ENABLE_API === "1" || !!API_URL;
const API_KEY = (import.meta.env.VITE_API_KEY as string | undefined) ?? "dev-local-key";
const POLL_MS = 2500;   // 서버 모드 변경 확인 주기(수십 바이트 요청, 바뀌었을 때만 스냅샷)

/** 저장된 상태를 읽는다. 없거나 읽을 수 없으면 null(초기 상태로 덮어쓰지 않기 위해 구분). */
function readStored(): { state: DeskState | null; notice: string } {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { state: null, notice: "" };
    const s = JSON.parse(raw) as DeskState;
    if (s.schema === SCHEMA) return { state: s, notice: "" };
    // E-03: 기존에는 형식이 다르면 아무 안내 없이 초기화 → 이전 기록을 따로 보관하고 이유를 알린다
    localStorage.setItem(`${KEY}.v${s.schema ?? "unknown"}`, raw);
    localStorage.removeItem(KEY);
    return { state: null, notice: `저장 형식이 바뀌어(v${s.schema ?? "?"} → v${SCHEMA}) 처음 상태로 시작합니다. 이전 기록은 '${KEY}.v${s.schema ?? "unknown"}'에 보관했습니다.` };
  } catch {
    return { state: null, notice: "" };   // 저장소 차단·손상 → 초기 상태(이전 데이터는 건드리지 않음)
  }
}
/** 저장 결과를 돌려준다(G-05: 기존에는 실패를 조용히 삼켜, 새로고침하면 기록이 사라지는 것을 사용자가 몰랐음). */
function save(s: DeskState): "" | "quota" | "blocked" {
  try { localStorage.setItem(KEY, JSON.stringify(s)); return ""; }
  catch (e) { return (e as DOMException)?.name === "QuotaExceededError" ? "quota" : "blocked"; }
}
export const SAVE_WARNING: Record<string, string> = {
  quota: "브라우저 저장 공간이 부족해 마지막 변경을 저장하지 못했습니다. 이 탭을 닫거나 새로고침하면 저장되지 않은 기록이 사라집니다. 다른 사이트 데이터를 정리하거나 서버 모드를 쓰세요.",
  blocked: "이 브라우저가 저장소를 막고 있어(사생활 보호 모드 등) 새로고침하면 기록이 사라집니다. 기록을 남기려면 일반 창이나 서버 모드를 쓰세요.",
};

// Q-03(9차): 브라우저 단독 모드의 감사 기록 보관함. localStorage는 약 5MB 한도라 감사 기록이 3만 건쯤 쌓이면 더는
// 저장되지 않았다(G-05 경고만 뜨고 새로고침하면 기록 유실). 최근 AUDIT_KEEP건만 상태에 두고, 오래된 기록은
// IndexedDB(수백 MB 이상)로 옮긴다. 전체 기록 보기·검색은 두 곳을 합쳐서 보여 준다.
const AUDIT_KEEP = 2000, AUDIT_SPILL = 3000;
const IDB_NAME = "aurora-desk-archive";
type Audit = DeskState["audit"][number];
// v1.10(10차 R-04): 기록 하나를 레코드 하나로 두면 4만 건을 읽는 데 0.5초가 넘게 걸렸다 → 1,000건 묶음(청크) 하나를
// 레코드 하나로 둔다(키 = 묶음 첫 기록의 번호). v1.9 형식(DB 버전 1)은 열 때 자동으로 묶음 형식으로 옮긴다.
type Chunk = { n: number; items: Audit[] };
const num = (id: string) => Number(id.replace(/\D/g, ""));
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 2);
    r.onupgradeneeded = (ev) => {
      const db = r.result;
      const chunks = db.createObjectStore("chunks", { keyPath: "n" });
      if (ev.oldVersion >= 1 && db.objectStoreNames.contains("audit")) {   // v1.9 보관함 → 묶음 형식
        const old = r.transaction!.objectStore("audit").getAll();
        old.onsuccess = () => {
          const all = (old.result as (Audit & { n?: number })[]).map(({ n: _n, ...a }) => a as Audit).sort((a, b) => num(a.id) - num(b.id));
          for (let i = 0; i < all.length; i += 1000) chunks.put({ n: num(all[i].id), items: all.slice(i, i + 1000) });
          db.deleteObjectStore("audit");
        };
      }
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbRun<T>(mode: IDBTransactionMode, fn: (st: IDBObjectStore, done: (v: T) => void) => void): Promise<T | undefined> {
  const db = await idb();
  try {
    return await new Promise<T | undefined>((res, rej) => {
      let out: T | undefined;
      const tx = db.transaction("chunks", mode); fn(tx.objectStore("chunks"), (v) => { out = v; });
      tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  } finally { db.close(); }
}
/** 1,000건 묶음으로 기록. 같은 키의 묶음이 이미 있으면(다른 탭이 먼저 옮김) 합친다 — 두 탭이 동시에 옮겨도 중복·누락 없음. */
async function archivePut(items: Audit[]) {
  for (let i = 0; i < items.length; i += 1000) {
    const part = items.slice(i, i + 1000);
    await idbRun<void>("readwrite", (st) => {
      const g = st.get(num(part[0].id));
      g.onsuccess = () => {
        const prev = (g.result as Chunk | undefined)?.items ?? [];
        const ids = new Set(part.map((a) => a.id));
        st.put({ n: num(part[0].id), items: [...prev.filter((a) => !ids.has(a.id)), ...part].sort((a, b) => num(a.id) - num(b.id)) });
      };
    });
    await new Promise((r) => setTimeout(r, 0));   // 사이사이 화면에 양보
  }
}
const archiveAll = async () => {
  const chunks = (await idbRun<Chunk[]>("readonly", (st, done) => { const q = st.getAll(); q.onsuccess = () => done(q.result as Chunk[]); })) ?? [];
  const seen = new Set<string>();
  return chunks.flatMap((c) => c.items).filter((a) => !seen.has(a.id) && (seen.add(a.id), true));
};
/** 전체 기록 보기 첫 화면(검색어 없음): 앞쪽 묶음만 읽는다(기존: 4만 건 전부 읽은 뒤 50건 표시). */
const archivePage = (offset: number, limit: number) => idbRun<Audit[]>("readonly", (st, done) => {
  const out: Audit[] = []; let skip = offset;
  const cur = st.openCursor();
  cur.onsuccess = () => {
    const c = cur.result;
    if (!c || out.length >= limit) { done(out); return; }
    const items = (c.value as Chunk).items;
    if (skip >= items.length) skip -= items.length;
    else { out.push(...items.slice(skip, skip + limit - out.length)); skip = 0; }
    c.continue();
  };
});
const archiveClear = () => idbRun<void>("readwrite", (st) => { st.clear(); }).catch(() => undefined);

export interface UiPrefs { role: string; selected: string | null; tab: "case" | "plans" | "facts"; mode: "local" | "api" }
function loadUi(): UiPrefs {
  try { const r = localStorage.getItem(UI_KEY); if (r) return { mode: "local", ...JSON.parse(r) }; } catch { /* ignore */ }
  return { role: "GROUP_CEO", selected: null, tab: "facts", mode: "local" };
}

export class ApiError extends Error { constructor(message: string, public status = 0) { super(message); } }

/** Pydantic 422 상세를 사람이 읽을 문장으로(E-08: 기존 '[object Object]'). */
function readable422(detail: unknown): string {
  if (!Array.isArray(detail)) return String(detail);
  const field: Record<string, string> = { text: "메모", comment: "결정 의견", copy_text: "수정 문구", actor: "역할", kind: "사건 종류" };
  return "입력값을 확인하세요 — " + detail.map((d: { loc?: string[]; type?: string; msg?: string; ctx?: { max_length?: number } }) => {
    const f = field[d.loc?.[d.loc.length - 1] ?? ""] ?? d.loc?.[d.loc.length - 1] ?? "입력";
    if (d.type === "string_too_long") return `${f}은(는) ${d.ctx?.max_length}자 이하로 입력하세요`;
    if (d.type === "literal_error") return `${f} 값이 허용 목록에 없습니다`;
    return `${f}: ${d.msg}`;
  }).join(" / ");
}

// J-01·J-02(7차): 서버가 로그인 모드(AUTH_MODE=jwt)면 로그인 토큰으로 요청하고, 역할은 토큰이 정한다
export interface Session { token: string; user: string; role: string; expires_at: number; ttl_ms?: number; idp?: string }
const SESSION_KEY = "aurora-desk-session";
let SESSION: Session | null = (() => { try { const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null") as Session | null; return s && s.expires_at > Date.now() ? s : null; } catch { return null; } })();
function setSessionStore(s: Session | null) { SESSION = s; try { if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); else sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }

// V-05(11차): 응답 제한 시간. 기존에는 서버·망이 멈추면 요청이 끝나지 않아 '서버 처리 중…'과 버튼 잠금이 풀리지 않았다
// (DB 잠금 대기 최대 4초 + 처리 시간을 넉넉히 덮는 15초).
export const API_TIMEOUT_MS = 15000;
/** 24차: 계약서 요약 평가 집계 · 자동 갱신 계약 확인값 입력 */
export interface SummaryFeedback { total: number; up: number; down: number; up_rate: number | null; notes?: { note: string; rating: string; role: string }[] }
export interface RenewalApi {
  facts: (contractId: string, body: { annual_fee_krw?: number; auto_renew?: boolean; notice_days?: number; note: string }) => Promise<boolean>;
  feedback: (caseId: string) => Promise<SummaryFeedback>;
  vote: (caseId: string, rating: "up" | "down", note: string) => Promise<SummaryFeedback | null>;
}

/** v1.22(§15-2): 외부 채널(전자결재·메신저) 전송 기록 한 줄 */
export interface Delivery { id: string; type: string; case_id?: string | null; status: "queued" | "sent" | "failed"; attempts: number; last_error?: string | null; retried?: number; at?: number }

async function api(path: string, body?: unknown) {
  let r: Response;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
  const form = typeof FormData !== "undefined" && body instanceof FormData;   // v1.21: 계약서 업로드(multipart)
  try {
    r = await fetch(`${API_URL}${path}`, { method: body ? "POST" : "GET", signal: ctl.signal, headers: { ...(form ? {} : { "Content-Type": "application/json" }), "X-API-Key": API_KEY, ...(SESSION ? { Authorization: `Bearer ${SESSION.token}` } : {}) },
      body: body ? (form ? (body as FormData) : JSON.stringify(body)) : undefined });
  } catch {
    clearTimeout(timer);
    if (ctl.signal.aborted) throw new ApiError(`서버가 ${API_TIMEOUT_MS / 1000}초 동안 응답하지 않았습니다. 처리되었는지 화면이 자동으로 갱신되면 확인하고, 반영되지 않았으면 다시 누르세요.`, 0);
    throw new ApiError("서버에 연결할 수 없습니다. FastAPI 서버가 켜져 있는지 확인하거나 실행 위치를 '브라우저'로 바꾸세요.", 0);
  }
  clearTimeout(timer);
  let j: { detail?: unknown } & Record<string, unknown>;
  try { j = await r.json(); } catch { throw new ApiError(`서버 응답을 읽을 수 없습니다(HTTP ${r.status}).`, r.status); }
  if (!r.ok) throw new ApiError(r.status === 422 ? readable422(j.detail) : String(j.detail ?? r.statusText), r.status);
  return j;
}

const info = (r: Record<string, unknown>, fallback: string) => (typeof r.info === "string" && r.info ? r.info : fallback);

/** AE-01(18차): 접수는 '작업 맡기기'와 '결과 기다리기'를 나눈다. 기다리는 동안에도 화면은 갱신하고 다른 명령을 받는다.
 *  기존: 결과를 기다리는 내내 처리 중으로 묶어(자동 갱신 중지·다른 클릭 무시), 서버가 0.65초에 저장한 25건이 LLM 설명이 끝날 때(6초)까지 안 보였다. */
async function startIntake(cmd: Extract<Command, { type: "intake" }>, role: string): Promise<string> {
  const job = await api("/api/events", { kind: cmd.kind, actor: role, text: cmd.text ?? null });
  return String(job.job_id);
}

async function waitIntake(jobId: string, tick: () => Promise<unknown>, onMsg?: (m: string) => void): Promise<string> {
  // 점진 폴링: 대부분 작업이 200ms 안에 끝나므로 처음엔 촘촘히, 길어지면 간격을 늘려 서버 부하를 줄인다
  const delays = [30, 50, 80, 120, 200, 300, 500];
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
    let j: Record<string, unknown>;
    try { j = await api(`/api/jobs/${jobId}`); }
    catch (e) {
      // Y-03(13차): 서버가 다시 시작되는 동안(연결 끊김)은 기다렸다가 다시 묻고, 재시작으로 작업 기록이 사라졌으면(404) 그 사실을 알린다.
      if (e instanceof ApiError && e.status === 0) continue;
      if (e instanceof ApiError && e.status === 404) throw new ApiError("처리하는 동안 서버가 다시 시작되어 이 접수의 진행 기록이 사라졌습니다. 화면을 갱신했으니 목록에서 접수 결과를 확인하고, 없으면 다시 접수하세요(같은 사건은 두 번 만들어지지 않습니다).", 404);
      throw e;
    }
    if (j.status === "failed") throw new ApiError(`처리 실패: ${j.message}`);   // 기존: 실패도 일반 안내처럼 표시
    if (onMsg && typeof j.message === "string" && j.status !== "done") onMsg(j.message);   // 23차 AJ05: '스캔 PDF 글자 인식 중 3/11쪽'처럼 진행을 보여 준다
    if (j.status === "done") return (j.result as { duplicate?: boolean } | null)?.duplicate ? `⚠ ${j.message}` : String(j.message);
    if (i >= 3) await tick().catch(() => {});   // 판단은 먼저 저장되므로(AC-02) 기다리는 동안 바뀐 목록을 바로 보여 준다
  }
  return "처리 중입니다. 잠시 후 화면이 자동으로 갱신됩니다.";
}

async function apiCommand(cmd: Exclude<Command, { type: "intake" }>, role: string): Promise<string> {
  switch (cmd.type) {
    // G-02: 서버가 돌려준 안내 문구(브라우저 엔진과 같은 문장)를 그대로 보여 준다(기존: '결정 반영'·'작업 완료'처럼 무엇이 일어났는지 없음)
    case "decide": return info(await api(`/api/cases/${cmd.caseId}/decision`, { actor: cmd.actor, action: cmd.action, comment: cmd.comment ?? "", expected_version: cmd.expectedVersion }), "결정 반영");
    case "reply": return info(await api("/api/replies", { reply_key: cmd.key, actor: role }), "회신 반영");
    case "fix": return info(await api(`/api/cases/${cmd.caseId}/fix`, { actor: cmd.actor, copy_text: cmd.copy ?? null }), "수정 반영");
    case "taskDone": return info(await api(`/api/tasks/${cmd.taskId}/done`, { actor: cmd.actor }), "작업 완료");
    case "condition": return info(await api("/api/conditions", { actor: cmd.actor, cash_assumption: cmd.cash }), "조건 변경");
    case "clock": return info(await api("/api/clock", { to: cmd.to, actor: role }), "시계 진행");
  }
}

const EMPTY = snapshot(initialState());
/** 지금 실행 중인 화면 번들 이름(assets/index-*.js) — 서버가 알려 주는 배포 번들과 비교한다. */
const MY_BUNDLE = (() => { try { return /assets\/(index-[\w-]+\.js)/.exec(Array.from(document.scripts).map((s) => s.src).join(" "))?.[1] ?? null; } catch { return null; } })();

export function useDesk() {
  const first = useRef(readStored());
  const [state, setState] = useState<DeskState>(() => first.current.state ?? initialState());
  const [ui, setUi] = useState<UiPrefs>(loadUi);
  const [remote, setRemote] = useState<Snapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const [newVersion, setNewVersion] = useState(false);   // X-03(12차): 서버에 새 화면이 배포됨
  const [toast, setToast] = useState<string>(first.current.notice);
  const [busy, setBusy] = useState(false);
  const [authMode, setAuthMode] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(SESSION);
  const [ssoLabel, setSsoLabel] = useState<string | null>(null);
  const [channel, setChannel] = useState<string>("outbox");               // v1.22(§15-2): 외부 채널 연동 방식(서버 health)
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const tickN = useRef(0);
  const sending = useRef(false);   // 보내는 중(queued)인 전송이 있으면 다음 갱신에서도 다시 본다
  const ssoDone = useRef(false);
  const needLogin = ui.mode === "api" && authMode === "jwt" && !session;
  const role = session?.role ?? ui.role;     // 로그인 모드에서는 토큰의 역할만 쓴다
  const lost = useCallback((e: unknown) => {   // 토큰 만료·무효 → 로그인 창으로(조용히 실패하지 않음)
    if (e instanceof ApiError && e.status === 401 && SESSION) { setSessionStore(null); setSession(null); return true; }
    return false;
  }, []);
  // 서버의 인증 방식 확인. 서버가 꺼져 있으면 연결 실패로 표시하고, 자동 갱신 주기에서 다시 확인한다(7차 회귀 R13·R14)
  const checkHealth = useCallback(async () => {
    try { const h = await (await fetch(`${API_URL}/api/health`)).json(); setAuthMode(h.auth ?? "apikey"); setSsoLabel(h.oidc ? String(h.oidc_label || "사내 SSO") : null); setChannel(String(h.channel ?? "outbox")); setOffline(false); return true; }
    catch { setOffline(true); return false; }
  }, []);
  useEffect(() => { if (ui.mode === "api") void checkHealth(); }, [ui.mode, checkHealth]);
  const lastActive = useRef(Date.now());
  const renewing = useRef(false);
  const capped = useRef(false);   // 최대 시간에 닿아 더 연장되지 않는 토큰
  const adopt = useCallback((r: Record<string, unknown>) => {
    const s: Session = { token: String(r.token), user: String(r.user), role: String(r.role), expires_at: Date.now() + Number(r.expires_in) * 1000, ttl_ms: Number(r.expires_in) * 1000, idp: String(r.idp ?? "local") };
    capped.current = false; setSessionStore(s); setSession(s);
  }, []);
  const login = useCallback(async (user: string, password: string) => { adopt(await api("/api/auth/login", { user, password })); }, [adopt]);
  // v1.21(§15-1): 사내 SSO(OIDC) — 시작하면 IdP 로그인 화면으로 이동, 돌아오면(?code&state) 서버가 검증하고 로그인
  const ssoStart = useCallback(async () => { const r = await api("/api/auth/oidc/start"); window.location.assign(String(r.url)); }, []);
  const changePassword = useCallback(async (current: string, next: string) => { adopt(await api("/api/auth/password", { current_password: current, new_password: next })); }, [adopt]);
  useEffect(() => {
    if (ssoDone.current || ui.mode !== "api" || authMode !== "jwt") return;
    const q = new URLSearchParams(window.location.search);
    const code = q.get("code"), state = q.get("state");
    if (!code || !state) { if (state && !code) window.history.replaceState(null, "", window.location.pathname); return; }   // IdP 로그아웃에서 돌아옴
    ssoDone.current = true;
    window.history.replaceState(null, "", window.location.pathname);   // 코드는 주소창에 남기지 않는다(한 번만 쓸 수 있음)
    api("/api/auth/oidc/callback", { code, state }).then((r) => { adopt(r); setToast(`${ssoLabel ?? "사내 SSO"}로 로그인했습니다: ${String(r.user)}`); })
      .catch((e) => setToast(`⚠ ${(e as Error).message}`));
  }, [ui.mode, authMode, adopt, ssoLabel]);
  // Q-05(9차): 활동 중이면 만료 전에 자동 연장(기존: 일하는 중에도 15분마다 로그인 창). 쉬고 있으면 연장하지 않아 그대로
  // 만료되고, 서버의 최대 시간(기본 8시간)이 지나면 연장이 거절돼 다시 로그인한다.
  useEffect(() => {
    if (!session) return;
    const ttl = session.ttl_ms ?? 900_000;
    const renew = async () => {
      if (renewing.current || capped.current || !SESSION || SESSION.expires_at - Date.now() > ttl / 3) return;
      if (Date.now() - lastActive.current > ttl) return;           // 한동안 아무것도 하지 않음 → 연장하지 않음
      renewing.current = true;
      try {
        const r = await api("/api/auth/refresh", {});
        const s: Session = { ...SESSION, token: String(r.token), role: String(r.role), expires_at: Date.now() + Number(r.expires_in) * 1000 };
        capped.current = Number(r.expires_in) * 1000 < ttl / 3;
        setSessionStore(s); setSession(s);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) { setSessionStore(null); setSession(null); setToast(`⚠ ${e.message}`); }
      } finally { renewing.current = false; }
    };
    const onActive = () => { lastActive.current = Date.now(); void renew(); };
    const ev = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    ev.forEach((n) => window.addEventListener(n, onActive, { passive: true }));
    const t = window.setTimeout(() => void renew(), Math.max(0, session.expires_at - Date.now() - ttl / 3 + 50));
    return () => { ev.forEach((n) => window.removeEventListener(n, onActive)); window.clearTimeout(t); };
  }, [session]);
  const logout = useCallback(() => {   // v1.22(§15-1): SSO 로그인이면 서버가 준 IdP 로그아웃 주소로 이동(IdP 로그인도 끝냄)
    void api("/api/auth/logout", {}).then((r) => { if (typeof r.logout_url === "string" && r.logout_url) window.location.assign(r.logout_url); }).catch(() => {});
    setSessionStore(null); setSession(null); setRemote(null);
  }, []);   // P-03: 서버에서도 토큰 무효화
  const inFlight = useRef(false);       // E-05: setBusy가 화면에 반영되기 전의 두 번째 클릭도 막는다
  const intaking = useRef(false);       // AE-01: 결과를 기다리는 접수(같은 접수 두 번 방지용 — 다른 명령·갱신은 막지 않음)
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [intakeMsg, setIntakeMsg] = useState("");   // 23차: 오래 걸리는 접수(스캔 PDF 글자 인식)의 진행 안내
  const rev = useRef("");
  const timer = useRef<number>();
  const notify = useCallback((m: string) => { setToast(m); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setToast(""), 6000); }, []);
  useEffect(() => { if (first.current.notice) notify(first.current.notice); }, [notify]);

  // Q-03: 감사 기록이 AUDIT_SPILL건을 넘으면 오래된 것을 보관함으로 옮기고, 옮기기에 성공한 것만 상태에서 뺀다
  const spilling = useRef(false);
  const archCache = useRef<{ n: number; items: Audit[] } | null>(null);
  useEffect(() => {
    if (state.audit.length <= AUDIT_SPILL || spilling.current || typeof indexedDB === "undefined") return;
    spilling.current = true;
    const out = state.audit.slice(0, state.audit.length - AUDIT_KEEP);
    archivePut(out).then(() => {
      const ids = new Set(out.map((a) => a.id));
      archCache.current = null;
      setState((s) => { const keep = s.audit.filter((a) => !ids.has(a.id)); return { ...s, audit: keep, archived: (s.archived ?? 0) + (s.audit.length - keep.length) }; });
    }).catch(() => { /* 보관함을 쓸 수 없음 → 그대로 둔다(한도에 닿으면 저장 경고가 알려 줌) */ })
      .finally(() => { spilling.current = false; });
  }, [state]);

  const [saveError, setSaveError] = useState<"" | "quota" | "blocked">("");
  useEffect(() => { setSaveError(save(state)); }, [state]);
  useEffect(() => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* ignore */ } }, [ui]);

  // E-01·E-02: 다른 탭이 저장하면 이 탭 상태를 그 값으로 바꾼다(기존: 각 탭이 자기 상태로 덮어써 기록 유실)
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key !== KEY || !e.newValue) return;
      try { const s = JSON.parse(e.newValue) as DeskState; if (s.schema === SCHEMA) setState(s); } catch { /* ignore */ }
    };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);

  const refresh = useCallback(async () => {
    if (ui.mode !== "api" || needLogin || authMode === null) return;
    try {
      const [snap, r] = await Promise.all([api("/api/snapshot"), api("/api/revision")]);
      setRemote(snap as unknown as Snapshot); rev.current = `${r.boot}:${r.rev}`; setOffline(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) setOffline(true);
      if (lost(e)) { notify(`⚠ ${(e as Error).message}`); return; }
      throw e;
    }
  }, [ui.mode, needLogin, authMode, lost, notify]);
  useEffect(() => { rev.current = ""; void refresh().catch((e) => notify(`⚠ ${(e as Error).message}`)); }, [refresh, notify]);

  /** v1.22: 외부 채널 전송 기록(최근 20건) — 변경 번호와 따로 바뀌므로(보내기 스레드) 자동 갱신 때마다 받는다. */
  const loadDeliveries = useCallback(async () => {
    if (ui.mode !== "api" || needLogin || channel !== "webhook") return;
    const r = await api("/api/integrations/deliveries?limit=20");
    const items = ((r.items as [string, Omit<Delivery, "id">][]) ?? []).map(([id, v]) => ({ id, ...v }));   // 서버가 실패 먼저·새것부터 정렬(23차)
    sending.current = items.some((d) => d.status === "queued");
    setDeliveries(items);
  }, [ui.mode, needLogin, channel]);
  useEffect(() => { void loadDeliveries().catch(() => {}); }, [loadDeliveries]);
  /** 변경 번호만 확인하고 바뀌었을 때만 스냅샷을 받는다(자동 갱신·접수 대기 중 공용). */
  const syncIfChanged = useCallback(async () => {
    const r = await api("/api/revision");
    const now = `${r.boot}:${r.rev}`;
    if (typeof r.ui === "string" && MY_BUNDLE && r.ui !== MY_BUNDLE) setNewVersion(true);
    if (now !== rev.current || offline) { await refresh(); return true; }
    return false;
  }, [refresh, offline]);
  // E-07: 서버 모드에서는 다른 사용자·MCP의 변경을 자동 반영(변경 번호만 확인, 바뀌었을 때만 스냅샷)
  useEffect(() => {
    if (ui.mode !== "api") return;
    const id = window.setInterval(async () => {
      if (document.hidden || inFlight.current || needLogin) return;
      if (authMode === null) { await checkHealth(); return; }
      try {
        const changed = await syncIfChanged();
        // 전송 기록은 보내기 스레드가 바꾸므로 변경 번호와 따로 본다 — 바뀐 일이 있거나, 보내는 중인 것이 있거나, 4번에 1번만(대기 중 통신량 예산)
        tickN.current += 1;
        if (channel === "webhook" && (changed || sending.current || tickN.current % 4 === 0)) await loadDeliveries();
      }
      catch (e) { if (e instanceof ApiError && e.status === 0) setOffline(true); if (lost(e)) notify(`⚠ ${(e as Error).message}`); }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [ui.mode, needLogin, authMode, lost, notify, checkHealth, syncIfChanged, channel, loadDeliveries]);
  /** v1.22(§15-2 남은 일): 끝내 실패한 외부 전송을 다시 보낸다(같은 event_id라 받는 쪽이 중복을 거름). */
  const redeliver = useCallback(async (eid: string) => {
    try { await api(`/api/integrations/deliveries/${encodeURIComponent(eid)}/retry`, { actor: role }); notify("외부 채널로 다시 보냈습니다. 결과는 전송 기록에 표시됩니다."); await loadDeliveries(); }
    catch (e) { if (!lost(e)) notify(`⚠ ${(e as Error).message}`); }
  }, [role, notify, lost, loadDeliveries]);

  /** 24차(AK03·AK04): 계약서 확인값 입력·요약 평가 — 서버 모드의 자동 갱신 계약 건에서만. */
  const renewalApi = useMemo<RenewalApi | null>(() => (ui.mode !== "api" ? null : {
    facts: async (contractId, body) => {
      try { const r = await api(`/api/contracts/${encodeURIComponent(contractId)}/facts`, { actor: role, ...body }); notify(info(r, "확인한 값 반영")); await refresh(); return true; }
      catch (e) { if (!lost(e)) notify(`⚠ ${(e as Error).message}`); return false; }
    },
    feedback: async (caseId) => (await api(`/api/cases/${encodeURIComponent(caseId)}/summary-feedback`)) as unknown as SummaryFeedback,
    vote: async (caseId, rating, note) => {
      try { const r = await api(`/api/cases/${encodeURIComponent(caseId)}/summary-feedback`, { actor: role, rating, note }); notify(info(r, "요약 평가 반영")); return (r.feedback ?? null) as SummaryFeedback | null; }
      catch (e) { if (!lost(e)) notify(`⚠ ${(e as Error).message}`); return null; }
    },
  }), [ui.mode, role, notify, refresh, lost]);

  /** v1.21(§15-3): 계약서 업로드 → 조항 추출 → 자동 갱신 계약 건. 접수처럼 결과를 따로 기다린다(그동안 화면·결재는 그대로). */
  const uploadContract = useCallback(async (file: File) => {
    if (ui.mode !== "api") { notify("계약서 업로드는 서버 모드(실행 위치: FastAPI 서버)에서 쓸 수 있습니다."); return; }
    if (intaking.current) { notify("앞의 접수를 처리하는 중입니다. 끝나면 다시 올리세요."); return; }
    // AH-08(21차): 보내기 전에 화면에서 먼저 확인 — 큰 파일을 다 보낸 뒤에야(또는 연결 끊김으로) 알게 되지 않게
    if (!/\.(md|txt|pdf)$/i.test(file.name)) { notify("⚠ 계약서는 .md·.txt·.pdf 파일만 올릴 수 있습니다."); return; }
    if (file.size > 2 * 1024 * 1024) { notify(`⚠ 계약서 파일이 너무 큽니다(${(file.size / 1024 / 1024).toFixed(1)}MB — 2MB 이하로 올려 주세요).`); return; }
    intaking.current = true; setIntakeBusy(true);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("actor", role);
      const job = await api("/api/contracts", fd);
      notify(await waitIntake(String(job.job_id), syncIfChanged, setIntakeMsg)); await refresh();
    } catch (e) {
      const err = e as ApiError;
      if (lost(e)) { notify(`⚠ ${err.message} 다시 로그인한 뒤 올리세요.`); return; }
      notify(`⚠ ${err.message}`);
    } finally { intaking.current = false; setIntakeBusy(false); setIntakeMsg(""); }
  }, [ui.mode, role, notify, refresh, lost, syncIfChanged]);
  const dispatch = useCallback(async (cmd: Command) => {
    if (ui.mode === "api") {
      const fail = async (e: unknown) => {
        const err = e as ApiError;
        if (lost(e)) { notify(`⚠ ${err.message} 다시 로그인한 뒤 같은 버튼을 누르세요(입력한 의견은 그대로 있습니다).`); return; }
        // E-06: 충돌·거부(409) 뒤에는 최신 상태로 다시 그려 늦은 사용자가 이전 화면에 머물지 않게 한다
        let msg = `⚠ ${err.message}`;
        if (err.status === 409 || err.status === 404) { try { await refresh(); msg += " — 화면을 최신 상태로 갱신했습니다."; } catch { /* offline */ } }
        notify(msg);
      };
      // AE-02(18차): 앞의 요청이 아직이면 알린다(기존: 클릭을 조용히 버려, 누른 사람은 결재된 줄 앎)
      if (inFlight.current) { notify("앞의 요청을 처리하는 중입니다. 끝나면 다시 눌러 주세요."); return; }
      if (cmd.type === "intake") {
        if (intaking.current) { notify("앞의 접수를 처리하는 중입니다. 끝나면 다시 접수하세요."); return; }
        intaking.current = true; setIntakeBusy(true);
        let jobId = "";
        inFlight.current = true; setBusy(true);
        try { jobId = await startIntake(cmd, role); }
        catch (e) { intaking.current = false; setIntakeBusy(false); await fail(e); return; }
        finally { inFlight.current = false; setBusy(false); }
        // 결과는 따로 기다린다 — 그동안 자동 갱신과 다른 결재는 그대로
        try { notify(await waitIntake(jobId, syncIfChanged)); await refresh(); }
        catch (e) { await fail(e); }
        finally { intaking.current = false; setIntakeBusy(false); }
        return;
      }
      inFlight.current = true; setBusy(true);
      try { notify(await apiCommand(cmd, role)); await refresh(); }
      catch (e) { await fail(e); }
      finally { inFlight.current = false; setBusy(false); }
      return;
    }
    // 브라우저 단독: 다른 탭이 방금 저장한 값이 있으면 그 위에 적용(같은 순간의 두 탭 쓰기 대비)
    setState((prev) => { const latest = readStored().state; const base = latest && latest.seq.audit >= prev.seq.audit ? latest : prev; const r = apply(base, cmd); notify(r.info); return r.state; });
  }, [ui.mode, role, refresh, notify, lost, syncIfChanged]);

  const reset = useCallback(async () => {
    try {
      if (ui.mode === "api") { await api("/api/reset", {}); await refresh(); }
      else { setState(initialState()); archCache.current = null; void archiveClear(); }   // 화면은 바로 비우고 보관함은 뒤에서 비움
      setUi((u) => ({ ...u, selected: null, tab: "facts" }));
      notify("처음 상태로 되돌렸습니다");
    } catch (e) { notify(`⚠ ${(e as Error).message}`); }
  }, [ui.mode, refresh, notify]);

  // E-08: 서버 모드인데 서버 데이터가 없으면 브라우저 데이터를 대신 보여주지 않는다(기존: 서버 데이터인 것처럼 표시)
  const snap = useMemo(() => (ui.mode === "api" ? remote ?? EMPTY : snapshot(state)), [ui.mode, remote, state]);
  // K-01: 감사 로그 전체 열람(오래된 순·검색·페이지). 브라우저 모드는 저장된 전체 기록, 서버 모드는 /api/audit
  const loadAudit = useCallback(async (offset: number, q: string, limit = 50): Promise<AuditPage> => {
    if (ui.mode === "api") return (await api(`/api/audit?offset=${offset}&limit=${limit}&q=${encodeURIComponent(q)}`)) as unknown as AuditPage;
    const needle = q.trim().toLowerCase();
    const arch = state.archived ?? 0;
    if (!needle) {   // R-04: 검색어가 없으면 필요한 페이지만(보관함 앞쪽 묶음 + 상태의 최근 기록)
      let items: Audit[] = [];
      if (offset < arch) { try { items = (await archivePage(offset, limit)) ?? []; } catch { items = []; } }
      if (items.length < limit) {
        const have = new Set(items.map((a) => a.id));
        const from = Math.max(0, offset + items.length - arch);
        items = [...items, ...state.audit.slice(from).filter((a) => !have.has(a.id)).slice(0, limit - items.length)];
      }
      return { total: arch + state.audit.length, matched: arch + state.audit.length, offset, items };
    }
    let all = state.audit;
    if (state.archived) {   // Q-03: 보관함의 오래된 기록 + 상태의 최근 기록(같은 ID는 한 번만)
      if (!archCache.current || archCache.current.n !== state.archived) {
        try { archCache.current = { n: state.archived, items: await archiveAll() }; } catch { archCache.current = { n: state.archived, items: [] }; }
      }
      const recent = new Set(state.audit.map((a) => a.id));
      all = [...archCache.current.items.filter((a) => !recent.has(a.id)), ...state.audit];
    }
    const hits = all.filter((a) => auditText(a).includes(needle));
    return { total: all.length, matched: hits.length, offset, items: hits.slice(offset, offset + limit) };
  }, [ui.mode, state.audit, state.archived]);

  // v1.27(AN06): 감사 기록 해시 체인 검증 — 서버 모드에서만(브라우저 단독 기록에는 체인이 없음)
  const verifyAudit = useCallback(async (): Promise<AuditVerify> => (await api("/api/audit/verify")) as unknown as AuditVerify, []);

  return { newVersion: ui.mode === "api" && newVersion, snap, ui, setUi, dispatch, reset, toast, busy, intaking: ui.mode === "api" && intakeBusy, uploadContract, ssoLabel, ssoStart, changePassword, offline: ui.mode === "api" && offline, saveError: ui.mode === "local" ? saveError : "", loadAudit,
    verifyAudit: ui.mode === "api" ? verifyAudit : undefined,
    role, session: ui.mode === "api" ? session : null, needLogin, login, logout, intakeMsg: intakeBusy ? intakeMsg : "",
    deliveries: ui.mode === "api" && channel === "webhook" ? deliveries : null, redeliver, renewalApi };
}
