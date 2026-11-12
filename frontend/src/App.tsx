import { useCallback, useEffect, useRef, useState } from "react";
import { CONTRACT } from "./engine/data";
import { addDays, daysBetween } from "./engine/cash";
import { CLOCK_MAX, ROLE_KO } from "./engine/desk";
import { API_ENABLED, SAVE_WARNING, useDesk } from "./store";
import type { Command } from "./engine/desk";
import { CaseSheet } from "./components/CaseSheet";
import { LoginDialog, PasswordDialog } from "./components/Login";
import { AllocationChart, CashChart } from "./components/Charts";
import { AuditLog, CaseList, Deliveries, FactsView, Intake, Outbox, PlanBoard, StateRegister, Tasks } from "./components/Panels";
import { fmtDate } from "./components/bits";

const ROLES = ["GROUP_CEO", "MASIL_CEO", "MARKETING_TEAM", "FINANCE", "CONTRACT_OWNER", "SCM"];

export function App() {
  // Y-01(13차): 머리글 실제 높이를 CSS 변수로(줄바꿈·글꼴 크기에 따라 63~118px) — 고정 패널이 머리글 아래에서 시작하게
  const topRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = topRef.current; if (!el || typeof ResizeObserver === "undefined") return;
    const set = () => document.documentElement.style.setProperty("--top-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    set(); const ro = new ResizeObserver(set); ro.observe(el); return () => ro.disconnect();
  }, []);
  const { snap, ui, setUi, dispatch, reset, toast, busy, intaking, uploadContract, ssoLabel, ssoStart, changePassword, offline, saveError, loadAudit, verifyAudit, role, session, needLogin, login, logout, newVersion, deliveries, redeliver, intakeMsg, renewalApi } = useDesk();
  const [pwOpen, setPwOpen] = useState(false);   // v1.21(§15-1): 비밀번호 변경 창
  // E-04: 결재 서류에서 결정하면 서류가 새로 그려져 포커스가 사라지고(키보드) 결과가 화면 밖에 남았다(모바일)
  //       → 사용자가 서류에서 직접 한 동작 뒤에 다시 그려질 때만 제목으로 포커스·스크롤을 옮긴다
  const actedAt = useRef(0);
  const sheetDispatch = useCallback((cmd: Command) => { actedAt.current = Date.now(); return dispatch(cmd); }, [dispatch]);
  const takeFocus = useCallback(() => { const ok = Date.now() - actedAt.current < 3000; actedAt.current = 0; return ok; }, []);
  const selected = snap.cases.find((c) => c.id === ui.selected) ?? null;
  const dday = daysBetween(snap.ctx.today, CONTRACT.notice_deadline);
  const select = (id: string) => setUi((u) => ({ ...u, selected: id, tab: "case" }));
  const offer = snap.ctx.offer as { payment_schedule?: { date: string; amount_krw: number }[] | null } | null;

  return (
    <div className="app">
      <header className="top" ref={topRef}>
        <div className="brand"><h1>Aurora 판단 데스크</h1><p>인플루언서 계약 · 캠페인 집행</p></div>
        <div className="clock">
          <span className="lbl">기준일</span><b>{fmtDate(snap.ctx.today)}</b>
          <button className="small" onClick={() => dispatch({ type: "clock", to: addDays(snap.ctx.today, 1), actor: role })} disabled={snap.ctx.today >= CLOCK_MAX} title={snap.ctx.today >= CLOCK_MAX ? `시뮬레이션은 ${CLOCK_MAX}까지입니다` : undefined}>하루 진행</button>
          <button className="small" onClick={() => dispatch({ type: "clock", to: addDays(CONTRACT.notice_deadline, 1), actor: role })} disabled={snap.ctx.today > CONTRACT.notice_deadline}>통보 기한 다음 날로</button>
        </div>
        <p className={`deadline ${dday <= 3 ? "seal" : ""}`}>INF-001 통보 기한 {fmtDate(CONTRACT.notice_deadline)} <b>{dday >= 0 ? `D-${dday}` : "경과"}</b></p>
        <label className="role">결재자 역할
          {/* J-01: 로그인 모드에서는 역할을 토큰이 정하므로 바꿀 수 없다 */}
          <select data-testid="role-select" value={role} disabled={!!session} onChange={(e) => setUi((u) => ({ ...u, role: e.target.value }))}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_KO[r]}</option>)}</select>
        </label>
        {API_ENABLED && <label className="role">실행 위치
          <select value={ui.mode} onChange={(e) => setUi((u) => ({ ...u, mode: e.target.value as "local" | "api" }))}><option value="local">브라우저</option><option value="api">FastAPI 서버</option></select></label>}
        {session && <span className="whoami" data-testid="whoami">{session.user} · {ROLE_KO[session.role] ?? session.role}{session.idp === "oidc" ? " · SSO" : ""} {session.idp !== "oidc" && <button className="small ghost" data-testid="pw-open" onClick={() => setPwOpen(true)}>비밀번호 변경</button>} <button className="small ghost" data-testid="logout" onClick={logout}>로그아웃</button></span>}
        <button className="small ghost" onClick={() => { if (confirmReset()) void reset(); }}>처음부터</button>
        {saveError && <p className="offline" role="alert" data-testid="save-warning">{SAVE_WARNING[saveError]}</p>}
        {newVersion && <p className="offline" role="status" data-testid="new-version">새 버전이 배포되었습니다. 새로고침하면 새 화면으로 바뀝니다(처리 기록은 서버에 그대로 있습니다). <button className="small" onClick={() => window.location.reload()}>새로고침</button></p>}
        {offline && <p className="offline" role="alert" data-testid="api-offline">FastAPI 서버에 연결할 수 없습니다. 서버가 다시 켜지면 자동으로 이어집니다. 지금 바로 쓰려면 실행 위치를 ‘브라우저’로 바꾸세요.</p>}
      </header>

      <aside className="left" aria-label="사건 접수와 처리 건">
        <Intake dispatch={dispatch} snap={snap} busy={busy || intaking || offline} onUpload={ui.mode === "api" ? uploadContract : undefined} />
        <CaseList cases={snap.cases} selected={ui.selected} onSelect={select} />
      </aside>

      <main className="center">
        <div className="tabs" role="tablist">
          {([["case", "결재 서류"], ["plans", "확대 기안 25건"], ["facts", "판단 기준과 근거"]] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={ui.tab === k} className={ui.tab === k ? "on" : ""} onClick={() => setUi((u) => ({ ...u, tab: k }))}>{l}</button>
          ))}
        </div>
        {/* AF-04(19차): 처리 상태는 탭 목록 밖의 상태 영역에 — 화면 낭독기가 '접수 처리 중'을 알린다(기존: 탭 목록 안의 글자라 알려지지 않음) */}
        <p className="busy" role="status" aria-live="polite">{busy ? "서버 처리 중…" : intaking ? <span data-testid="intaking">{intakeMsg ? `${intakeMsg} — 결재·조회는 계속할 수 있습니다` : "접수 처리 중(AI 설명 작성 포함) — 결재·조회는 계속할 수 있습니다"}</span> : null}</p>
        {ui.tab === "case" && (selected
          ? <CaseSheet key={selected.id} today={snap.ctx.today} c={selected} role={role} tasks={snap.tasks.filter((t) => t.case_id === selected.id)} dispatch={sheetDispatch} takeFocus={takeFocus} renewalApi={renewalApi} cashAssumption={snap.ctx.cash_assumption} schedule={offer?.payment_schedule ?? null} />
          : <p className="empty big">왼쪽에서 처리 건을 고르면 결재 서류가 열립니다.</p>)}
        {ui.tab === "plans" && <PlanBoard snap={snap} onSelect={select} />}
        {ui.tab === "facts" && (<><FactsView /><h3 className="sec">배분은 성과를 따라가는가</h3><AllocationChart /><h3 className="sec">13주 현금 재전망</h3><CashChart assumption={snap.ctx.cash_assumption} /></>)}
      </main>

      <aside className="right" tabIndex={0} aria-label="부서 작업·상태 기록·발송함·감사 로그">
        <Tasks snap={snap} role={role} dispatch={dispatch} />
        <StateRegister snap={snap} role={role} dispatch={dispatch} />
        <Outbox snap={snap} />
        {deliveries && <Deliveries items={deliveries} role={role} onRetry={(eid) => void redeliver(eid)} />}
        <AuditLog snap={snap} loadAudit={loadAudit} verifyAudit={verifyAudit} />
      </aside>

      {needLogin && <LoginDialog onLogin={login} ssoLabel={ssoLabel} onSso={ssoStart} />}
      {pwOpen && session && <PasswordDialog onChange={changePassword} onClose={() => setPwOpen(false)} />}
      <div className={`toast ${toast ? "show" : ""} ${toast.startsWith("⚠") ? "warn" : ""}`} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}

function confirmReset() { try { return window.confirm("모든 처리 기록을 지우고 처음 상태로 돌아갈까요?"); } catch { return true; } }
