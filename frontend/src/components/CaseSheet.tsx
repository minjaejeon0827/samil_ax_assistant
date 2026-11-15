import { useEffect, useRef, useState } from "react";
import { copyUnresolved, ROLE_KO } from "../engine/desk";
import { daysBetween } from "../engine/cash";
import type { Case, Task } from "../engine/types";
import type { Command } from "../engine/desk";
import type { RenewalApi, SummaryFeedback } from "../store";
import { CashChart } from "./Charts";
import { fmtDate, KindBadge, RECO_TONE, ScaleBadge, StateChip } from "./bits";

const LINE = ["MARKETING_TEAM", "MASIL_CEO", "GROUP_CEO"] as const;

/** 결재란 — 필요한 승인자 칸이 두껍게, 결정이 나면 도장이 찍힌다. */
function ApprovalLine({ c }: { c: Case }) {
  const ap = c.approval;
  const need = ap?.approver;
  const decided = ap?.decision && ap.decision !== "request_info" ? ap : null;
  return (
    <table className="kyeoljae" aria-label="결재란">
      <thead><tr><th scope="col">기안</th>{LINE.map((r) => <th key={r} scope="col" className={need === r ? "need" : ""}>{ROLE_KO[r].replace("/이사회", "")}</th>)}</tr></thead>
      <tbody>
        <tr>
          <td className="stamp-cell"><span className="sign">{c.type === "PLAN" ? "마케팅" : "계약담당"}</span></td>
          {LINE.map((r) => (
            <td key={r} className={`stamp-cell ${need === r ? "need" : ""}`}>
              {decided && (decided.decided_by === r || (r === "GROUP_CEO" && decided.decided_by?.startsWith("SYSTEM"))) ? (
                <span className={`stamp ${decided.decision === "approve" ? "ok" : "no"}`} aria-label={decided.decision === "approve" ? "승인" : "반려"}>
                  <b>{decided.decision === "approve" ? "승인" : "반려"}</b><small>{decided.decided_on ? fmtDate(decided.decided_on) : "연동"}</small>
                </span>
              ) : need === r ? <span className="await">{c.state === "AUTO_COMMITTED" ? "기한 경과" : "결재 대기"}</span> : <span className="skip">—</span>}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

function llmLabel(llm?: string): string {
  if (!llm || llm === "offline") return "오프라인 템플릿(LLM 미사용 · 사실 목록의 숫자만 사용)";
  if (llm.startsWith("작성 중")) return `${llm.replace(/^작성 중\(|\)$/g, "")} LLM이 설명문을 쓰는 중 — 지금은 사실 목록의 숫자로 만든 설명을 보여 줍니다(판단·결재란은 이미 확정, 결재해도 됩니다)`;   // AC-01(16차)
  if (llm.startsWith("결재 당시") && llm.includes("불채택")) return "결재 당시 보던 근거 기반 설명(사실 목록의 숫자만 사용)을 결재 서류에 그대로 둠 — 결재 뒤 받은 LLM 설명은 판사를 통과하지 못해 쓰지 않음";   // AF-02(19차)
  if (llm.startsWith("결재 당시")) return "결재 당시 보던 근거 기반 설명(사실 목록의 숫자만 사용)을 결재 서류에 그대로 둠 — LLM 설명은 결재 뒤 도착해 아래에 따로 보관";   // AE-03(18차)
  if (llm.startsWith("대체문")) return `근거 기반 대체문 — ${llm.replace(/^대체문\(|\)$/g, "")}으로 LLM 설명문을 쓰지 않음`;
  return `${llm} LLM(판사 통과)`;
}

function summaryLabel(llm: string): string {
  if (!llm || llm === "offline") return "근거 기반 요약(LLM 미사용 · 추출값만 사용)";
  if (llm.startsWith("대체문")) return `근거 기반 요약 — ${llm.replace(/^대체문\(|\)$/g, "")}으로 LLM 요약을 쓰지 않음`;
  return `${llm} LLM 요약(판사 통과 · 추출값에 없는 숫자 없음)`;
}
const archiveWho = (a: NonNullable<Case["explain_archive"]>[number]) => (a.approval.decided_by ? ROLE_KO[a.approval.decided_by] ?? a.approval.decided_by : "결재자");

/** 24차(AK03, ⑤ 남은 일): 계약서 요약 품질 평가 — 한 사람 한 표, 부정확하면 사유. */
function SummaryVote({ caseId, api }: { caseId: string; api: RenewalApi }) {
  const [fb, setFb] = useState<SummaryFeedback | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => { let on = true; api.feedback(caseId).then((x) => { if (on) setFb(x); }).catch(() => {}); return () => { on = false; }; }, [caseId, api]);
  const vote = async (r: "up" | "down") => { const x = await api.vote(caseId, r, note); if (x) { setFb(x); setNote(""); } };
  return (
    <div className="summary-vote">
      <label htmlFor="summary-note" className="lbl">이 요약은 결재에 도움이 됐나요?</label>
      <input id="summary-note" data-testid="summary-note" value={note} maxLength={300} placeholder="부정확하면 무엇이 틀렸는지(선택)" onChange={(e) => setNote(e.target.value)} />
      <button type="button" className="small" data-testid="summary-up" onClick={() => void vote("up")}>도움됨</button>
      <button type="button" className="small" data-testid="summary-down" onClick={() => void vote("down")}>부정확함</button>
      <span className="hint" data-testid="summary-score" role="status" aria-live="polite">{fb && fb.total ? `평가 ${fb.total}건 · 도움됨 ${Math.round((fb.up_rate ?? 0) * 100)}%` : "아직 평가가 없습니다"}</span>
    </div>
  );
}

const FACT_ROLES = ["FINANCE", "CONTRACT_OWNER", "GROUP_CEO"];
/** 24차(AK04): 확인 필요로 멈춘 자동 갱신 계약에 사람이 확인한 값을 넣어 다시 판단(§14 '확인 필요로 정지하고 확인 요청'의 끝맺음). */
function ContractFacts({ c, role, api }: { c: Case; role: string; api: RenewalApi }) {
  const ids = new Set((c.decision?.checks ?? []).map((k) => k.id));
  const [fee, setFee] = useState(""); const [renew, setRenew] = useState(""); const [notice, setNotice] = useState(""); const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const may = FACT_ROLES.includes(role);
  const save = async () => {
    const body: { annual_fee_krw?: number; auto_renew?: boolean; notice_days?: number; note: string } = { note };
    if (fee.trim()) body.annual_fee_krw = Number(fee.replace(/[,\s원]/g, ""));
    if (renew) body.auto_renew = renew === "yes";
    if (notice.trim()) body.notice_days = Number(notice);
    setBusy(true); try { if (await api.facts(c.target_id, body)) { setFee(""); setRenew(""); setNotice(""); setNote(""); } } finally { setBusy(false); }
  };
  return (
    <section data-testid="contract-facts" className="facts"><h3>확인한 값 넣기</h3>
      <p className="hint">계약서에서 찾지 못했거나 원화가 아닌 값을 확인해 넣으면 다시 판단합니다. 넣은 값은 근거에 ‘사람 입력’(누가·언제·근거 메모)으로 남습니다.</p>
      <div className="facts-grid">
        {(ids.has("FOREIGN_CURRENCY") || ids.has("FEE_MISSING")) && (<label>연간 금액(원){ids.has("FOREIGN_CURRENCY") ? " — 외화를 원화로 환산" : ""}<input data-testid="facts-fee" inputMode="numeric" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="예: 1324800000" disabled={!may} /></label>)}
        {(ids.has("RENEWAL_MISSING") || ids.has("NOTICE_MISSING")) && (<>
          <label>자동 갱신<select data-testid="facts-renew" value={renew} onChange={(e) => setRenew(e.target.value)} disabled={!may}><option value="">확인 전</option><option value="yes">있음</option><option value="no">없음</option></select></label>
          <label>만료 며칠 전 통보<input data-testid="facts-notice" inputMode="numeric" value={notice} onChange={(e) => setNotice(e.target.value)} placeholder="예: 30" disabled={!may} /></label>
        </>)}
        <label className="wide">근거 메모<input data-testid="facts-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="예: 재무팀 7/1 환율 1,380원/USD · 원문 3쪽 확인" disabled={!may} /></label>
      </div>
      <button type="button" data-testid="facts-save" disabled={!may || busy || !note.trim() || (!fee.trim() && !renew && !notice.trim())} title={may ? "" : "재무팀·계약 담당·그룹 CEO가 넣을 수 있습니다"} onClick={() => void save()}>확인한 값 반영</button>
    </section>
  );
}

export function CaseSheet({ c, role, tasks, dispatch, cashAssumption, schedule, today, takeFocus, renewalApi, loginMode = false }: { c: Case; role: string; tasks: Task[]; dispatch: (cmd: Command) => void; takeFocus?: () => boolean; renewalApi?: RenewalApi | null; loginMode?: boolean;
  cashAssumption: "AS_IS" | "CONSERVATIVE" | "LEGACY45"; schedule: { date: string; amount_krw: number }[] | null; today: string }) {
  const [comment, setComment] = useState("");
  const head = useRef<HTMLHeadingElement>(null);
  // AG-01(20차): 서류를 판(version)이 바뀔 때마다 새로 그리지 않는다(App의 key는 건 ID만). AI 설명이 도착해도 쓰던 의견·커서·펼친 설명이 그대로.
  // 결정이 실제로 바뀌었을 때만(내 결재·다른 사람의 결재) 의견을 비운다.
  const decided = `${c.state}|${c.approval?.decision ?? ""}`;
  const lastDecided = useRef(decided);
  useEffect(() => { if (lastDecided.current !== decided) { lastDecided.current = decided; setComment(""); } }, [decided]);
  // AG-03: 열어 둔 서류의 AI 설명이 바뀌면(작성 중 → LLM 설명, 결재 뒤 도착) 말없이 바꾸지 않고 알린다
  const [explainNote, setExplainNote] = useState("");
  const lastExplain = useRef(`${c.explanation ?? ""}|${c.late_explanation ?? ""}`);
  // 30차(O-6): 결재할 사람에게만 알린다(결재권자 + 결재 대기, 또는 결재 뒤 도착 보관). 기존: 결재권자가 아닌 역할에게도 거의 모든 동작 뒤에 떴음
  const approverNow = role === c.approval?.approver && c.state === "PENDING_APPROVAL";
  useEffect(() => {
    const now = `${c.explanation ?? ""}|${c.late_explanation ?? ""}`;
    if (lastExplain.current === now) return;
    const late = (lastExplain.current.split("|")[1] ?? "") !== (c.late_explanation ?? "");
    lastExplain.current = now;
    if (late && c.late_explanation) setExplainNote("결재 뒤 AI 설명이 도착해 아래에 따로 보관했습니다(결재 서류의 설명은 그대로).");
    else if (approverNow) setExplainNote("승인자용 설명문이 바뀌었습니다(AI 설명 도착 또는 다시 판단) — 결재하기 전에 다시 확인하세요.");
  }, [c.explanation, c.late_explanation, approverNow]);
  useEffect(() => {   // E-04: 결정 직후 다시 그려지면 결과(결재란·도장)가 있는 서류 머리로 포커스·스크롤
    if (takeFocus?.() && head.current) { head.current.focus({ preventScroll: true }); head.current.closest(".sheet")?.scrollIntoView({ block: "start", behavior: "instant" as ScrollBehavior }); }
  }, [takeFocus, c.version]);
  const d = c.decision;
  const canDecide = c.state === "PENDING_APPROVAL";
  const isApprover = role === c.approval?.approver;
  const copyHold = copyUnresolved(c);   // 30차(AP-07): 위반 카피가 남은 기안은 승인 불가(서버와 같은 규칙)
  const approverKo = ROLE_KO[c.approval?.approver ?? ""];
  const extra = c.kind === "AGENCY_COUNTER_OFFER" && schedule ? schedule : [];
  return (
    <article className="sheet" aria-labelledby="sheet-title" data-testid="case-sheet">
      <header className="sheet-head">
        <div>
          <p className="sheet-meta">{c.id} · 접수 {fmtDate(c.received_on)} · <StateChip state={c.state} />{d && (() => {
            // 32차(AR-04): 통보 기한을 모르는 업로드 계약서는 만료일을 기한처럼 보이지 않고 '미확인'으로 경고
            if (!d.subject.deadline) return <> · <b data-testid="dday" className="seal">통보 기한 미확인 — 원문 확인 필요</b></>;
            const left = daysBetween(today, d.subject.deadline);
            return <> · 기한 {fmtDate(d.subject.deadline)} <b data-testid="dday" className={left <= 3 ? "seal" : ""}>({left >= 0 ? `D-${left}` : "기한 경과"})</b></>; })()}</p>
          <h2 id="sheet-title" ref={head} tabIndex={-1}>{c.title}</h2>
          <p className="event">{c.event_text}{c.inbound?.masked && <span className="badge kind-MOCK">연락처 마스킹</span>}</p>
        </div>
        {c.approval && <ApprovalLine c={c} />}
      </header>

      {c.issues?.length ? <p className="alert seal">{c.issues[0].message}</p> : null}

      {d && (
        <>
          <section className="proposal">
            <h3>결재 요청</h3>
            <p className="proposal-text">{d.proposal}</p>
            <p className={`reco tone-${RECO_TONE[d.recommendation] ?? "mute"}`}><span>AI 권고</span>{d.label}</p>
            {d.needs_info.length > 0 && <p className="alert hold">확인 필요: {d.needs_info.join(" / ")} — 회신이 올 때까지 결재를 올리지 않습니다.</p>}
          </section>

          <section className="decide" aria-label="결정">
            {canDecide && (
              <>
                <label htmlFor="cmt">결정 의견</label>
                <input id="cmt" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="예: 조건변경 통보 승인, 7월 16일까지 발송" maxLength={200} />
                <div className="btns">
                  <button className="primary" data-testid="approve" disabled={!isApprover || copyHold} title={copyHold ? "광고 카피 위반이 남아 있어 승인할 수 없습니다" : ""} onClick={() => dispatch({ type: "decide", caseId: c.id, actor: role, action: "approve", comment, expectedVersion: c.version })}>승인</button>
                  <button className="danger" data-testid="reject" disabled={!isApprover} onClick={() => dispatch({ type: "decide", caseId: c.id, actor: role, action: "reject", comment, expectedVersion: c.version })}>거절</button>
                  {/* 30차(AP-03): 확인 요청도 결재권자만(PRD §9) — 기존에는 누구나 눌러 결재를 멈출 수 있었음 */}
                  <button data-testid="request-info" disabled={!isApprover} title={isApprover ? "" : `${approverKo}만 확인을 요청할 수 있습니다`} onClick={() => dispatch({ type: "decide", caseId: c.id, actor: role, action: "request_info", comment })}>확인 요청</button>
                  {!isApprover && <button className="ghost" onClick={() => dispatch({ type: "decide", caseId: c.id, actor: role, action: "approve", comment })} title="권한 검사가 어떻게 막는지 보여줍니다">현재 역할로 승인 시도</button>}
                </div>
                {/* 30차(AP-10): 로그인 모드에서는 역할 선택이 잠겨 있으므로 '역할을 바꾸면'이 아니라 계정으로 안내 */}
                {!isApprover && <p className="hint">이 건은 {approverKo} 결재 사항입니다. {loginMode ? `${approverKo} 계정으로 로그인해야 결정할 수 있습니다.` : "상단에서 역할을 바꾸면 결정할 수 있습니다."}</p>}
                {copyHold && <p className="hint seal">광고 카피 위반이 남아 있어 승인할 수 없습니다(부결·확인 요청은 가능).</p>}
              </>
            )}
            {c.state === "ACTION_REQUIRED" && (
              <>
                <p className="hint">수정안: “{d.regulation?.rewrite}”</p>
                <div className="btns">
                  {/* P-01: 카피 수정은 기안 부서(마케팅팀)만 — 기존에는 누구나 눌렀고 마케팅팀 이름으로 기록됨 */}
                  <button className="primary" data-testid="apply-fix" disabled={role !== "MARKETING_TEAM"} title={role !== "MARKETING_TEAM" ? "마케팅팀 역할에서 반영할 수 있습니다" : ""}
                    onClick={() => dispatch({ type: "fix", caseId: c.id, actor: role })}>수정안 반영하고 재검증</button>
                  <button className="danger" data-testid="reject-hold" disabled={!isApprover} title={isApprover ? "" : `${ROLE_KO[c.approval?.approver ?? ""]}만 부결할 수 있습니다`}
                    onClick={() => dispatch({ type: "decide", caseId: c.id, actor: role, action: "reject", comment: "카피 위반으로 부결", expectedVersion: c.version })}>부결</button>
                </div>
              </>
            )}
            {c.state === "NEEDS_INFO" && <p className="hint">{c.hold_reason === "MANUAL"
              ? "담당 부서가 오른쪽 ‘부서 작업’의 확인 요청을 완료하면 이 건을 다시 판단해 결재로 돌려보냅니다."
              : c.type === "RENEWAL"   // 32차(AR-03): 업로드 계약서는 에이전시 회신이 아니라 원문 확인 → 확인한 값 넣기
                ? "계약 담당이 원문을 확인해 아래 ‘확인한 값 넣기’에 입력하면 이어서 판단합니다(외부 발송 없음)."
                : "에이전시 회신을 기다리는 중입니다. 왼쪽 ‘에이전시 지급 일정 회신’으로 모의 회신을 받으면 이어서 판단합니다."}</p>}
            {c.state === "HOLD_LINKED" && <p className="hint">상위 전속계약(INF-001) 결정이 나면 함께 처리됩니다.</p>}
          </section>

          <section>
            <h3>판단 근거</h3>
            <table className="evidence">
              <thead><tr><th scope="col">출처</th><th scope="col">내용</th><th scope="col" className="src">근거 자료</th></tr></thead>
              <tbody>{d.evidence.map((e, i) => (
                <tr key={i} className={e.kind === "CLAIM" ? "claim" : ""}><td><KindBadge kind={e.kind} /> <ScaleBadge scale={e.scale} /></td><td>{e.text}<span className="src-inline">{e.source}</span></td><td className="src">{e.source}</td></tr>
              ))}</tbody>
            </table>
          </section>

          {d.regulation && d.regulation.findings.length > 0 && (
            <section>
              <h3>광고 카피 검증</h3>
              <div className="copy-diff">
                <p><span className="lbl">초안</span>{d.copy}</p>
                <ul>{d.regulation.findings.map((f) => <li key={f.id}><b>{f.law}</b> {f.title} — {f.hits.join(", ")}</li>)}</ul>
                <p><span className="lbl">수정안</span>{d.regulation.rewrite}</p>
              </div>
            </section>
          )}

          {c.type === "RENEWAL" && d.checks && (   /* v1.21(§15-3): 계약서에서 뽑은 조건의 자동 확인 */
            <section data-testid="contract-checks"><h3>계약서 자동 확인(위약금·지급 조건·통보 기한)</h3>
              <ul className="checks">{d.checks.map((k) => <li key={k.id} className={`lv-${k.level}`}><b>{{ high: "위험", watch: "주의", info: "참고", missing: "확인 필요" }[k.level]}</b> {k.text}</li>)}</ul>
              <p className="hint">값은 계약서 원문에서 규칙으로 뽑았습니다(LLM 미사용). 출처는 위 판단 근거의 조항 번호를 보세요. 찾지 못한 항목은 ‘확인 필요’로 남깁니다.</p>
            </section>
          )}
          {c.type === "RENEWAL" && d.contract_summary && (   /* v1.22(⑤): 계약서 요약 — 판단·값·결재자에는 쓰지 않음 */
            <section data-testid="contract-summary"><h3>계약서 요약(참고용)</h3>
              <pre className="explain">{d.contract_summary.text}</pre>
              <p className="hint">{summaryLabel(d.contract_summary.llm)} · 판단·금액·날짜·결재자는 위의 규칙 추출값으로 정했습니다.</p>
              {renewalApi && <SummaryVote caseId={c.id} api={renewalApi} />}
            </section>
          )}
          {c.type === "RENEWAL" && renewalApi && ["NEEDS_INFO", "PENDING_APPROVAL"].includes(c.state)
            && (d.checks ?? []).some((k) => ["FOREIGN_CURRENCY", "FEE_MISSING", "RENEWAL_MISSING", "NOTICE_MISSING"].includes(k.id)) && <ContractFacts c={c} role={role} api={renewalApi} />}

          {(c.type === "CONTRACT" || d.authority.covenant_override) && (
            <section><h3>현금 재전망</h3><CashChart assumption={cashAssumption} extra={extra} /></section>
          )}

          <section className="two">
            <div>
              <h3>대안</h3>
              <ul className="alts">{d.alternatives.map((a) => <li key={a.code}><b>{a.label}</b>{a.pros && <span> 장점: {a.pros} / 단점: {a.cons}</span>}</li>)}</ul>
            </div>
            <div>
              <h3>승인 권한 판정</h3>
              <ol className="chain">{d.authority.trace.map((t, i) => <li key={i}><b>{t.rule}</b> <span className="res">{ROLE_KO[t.result] ?? t.result}</span><br /><span className="why">{t.why}</span></li>)}</ol>
            </div>
          </section>

          <section>
            <h3>판단 파이프라인</h3>
            <ol className="pipe">{(c.trace ?? []).map((t, i) => <li key={i}><b>{t.node}</b><span>{t.note}</span></li>)}</ol>
            {c.judge && <p className="hint">LLM-as-a-Judge({c.judge.judge}) 충실도 {c.judge.faithfulness} {c.judge.issues.length ? `· ${c.judge.issues[0]}` : "· 근거 없는 수치 없음"}</p>}
            {/* H-05: 설명문을 누가 썼는지 사실대로(LLM·오프라인 템플릿·LLM 실패로 쓴 대체문) */}
            <p className="hint" data-testid="llm-source">설명문 작성: {llmLabel(c.llm)}{c.judge?.replaced ? ` — ${c.judge.replaced}` : ""}</p>
            <p className="hint note" role="status" aria-live="polite">{explainNote && <span data-testid="explain-updated">{explainNote}</span>}</p>
            {c.policy_hits && c.policy_hits.length > 0 && (
              <details><summary>검색된 정책 조각 {c.policy_hits.length}개</summary>
                <ul className="hits">{c.policy_hits.map((h, i) => <li key={i}><b>{h.source}</b> ({h.score})<br />{h.text}</li>)}</ul></details>
            )}
            <details><summary>승인자용 설명문</summary><pre className="explain">{c.explanation}</pre></details>
            {c.explain_archive && c.explain_archive.length > 0 && (   /* v1.22(⑥): 결재 뒤 도착한 AI 설명 보관함 — 다시 판단해도 지워지지 않음 */
              <details data-testid="explain-archive"><summary>AI 설명 보관함 {c.explain_archive.length}건 (마지막: {archiveWho(c.explain_archive[c.explain_archive.length - 1])} 결재 뒤 도착)</summary>
                <ol className="archive">{c.explain_archive.slice().reverse().map((a, i) => (
                  <li key={i}><p className="hint">{a.approval.decided_by ? `${ROLE_KO[a.approval.decided_by] ?? a.approval.decided_by} ${a.approval.decision === "approve" ? "승인" : a.approval.decision === "reject" ? "반려" : a.approval.decision ?? ""}` : "결재"}{a.approval.decided_on ? ` (${fmtDate(a.approval.decided_on)})` : ""} · 판 {a.case_version ?? "-"} · {a.kind === "late" ? `${a.llm} LLM(판사 통과, 충실도 ${a.faithfulness ?? "-"})` : `불채택 — ${a.reason ?? "판사 불통과"}`}</p>
                    {a.text ? <pre className="explain late">{a.text}</pre> : <p className="hint">판사를 통과하지 못한 설명은 내용을 보관하지 않습니다(근거 없는 숫자가 남지 않게).</p>}</li>))}</ol>
              </details>
            )}
            {c.late_explanation && (
              <details data-testid="late-explanation"><summary>결재 뒤 도착한 AI 설명({c.late_llm}) — 참고용, 결재 서류에는 결재 당시 설명이 남습니다</summary><pre className="explain late">{c.late_explanation}</pre></details>
            )}
          </section>
        </>
      )}

      <section className="two">
        <div>
          <h3>처리 이력</h3>
          <ol className="history">{c.history.map((h, i) => <li key={i}><span className="when">{fmtDate(h.sim_date)}</span> <StateChip state={h.to} /> <span className="who">{ROLE_KO[h.by] ?? h.by}</span><br /><span className="why">{h.note}</span></li>)}</ol>
        </div>
        <div>
          <h3>이 건에서 생긴 작업</h3>
          {tasks.length ? <ul className="mini-tasks">{tasks.map((t) => <li key={t.id} className={t.status !== "OPEN" ? "done" : ""} title={t.result ?? ""}><b>{ROLE_KO[t.dept] ?? t.dept}</b> {t.title}{t.due && <span className="due"> ~{fmtDate(t.due)}</span>}</li>)}</ul> : <p className="hint">결정이 나면 부서 작업이 여기에 생깁니다.</p>}
        </div>
      </section>
    </article>
  );
}
