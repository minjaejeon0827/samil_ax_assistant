// 실서버 E2E — uvicorn을 실제로 띄워 HTTP로 모든 API·시나리오·보안·동시성·성능을 검증하고, MCP 서버를 stdio로 호출한다.
// 실행: node --test --test-concurrency=1 e2e/api.e2e.test.cjs
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const H = require("./helpers.cjs");

const BASE = "http://localhost:8000";
const KEY = "e2e-key";
let api, apiFile;
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0 }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});

async function call(method, p, body, { key = KEY, base = BASE, headers = {} } = {}) {
  const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(key ? { "X-API-Key": key } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: j, headers: r.headers };
}
async function event(kind, extra = {}, base = BASE) {
  const t0 = performance.now();
  const r = await call("POST", "/api/events", { kind, ...extra }, { base });
  assert.equal(r.status, 202);
  for (let i = 0; i < 400; i++) {
    const j = await call("GET", `/api/jobs/${r.body.job_id}`, null, { base });
    if (j.body.status === "done" || j.body.status === "failed") return { ...j.body, ms: performance.now() - t0 };
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("job timeout");
}
const snap = async (base = BASE) => (await call("GET", "/api/snapshot", null, { base })).body;
const caseOf = (s, target, kind) => s.cases.filter((c) => c.target_id === target && (!kind || c.kind === kind)).at(-1);
const decide = (id, actor, action, extra = {}) => call("POST", `/api/cases/${id}/decision`, { actor, action, ...extra });
const reset = (base = BASE) => call("POST", "/api/reset", {}, { base });

before(async () => { api = await H.startApi(8000); });
after(() => { H.writeReport(process.env.E2E_REPORT || "api", { suite: "api", results }); H.stop(api); H.stop(apiFile); });

describe("보안·입력", () => {
  T("A01", "헬스 체크", async () => { assert.deepEqual((await call("GET", "/api/health", null, { key: null })).body.status, "ok"); });
  T("A02", "API 키: 없음 401 · 틀림 403 · 맞음 200", async () => {
    assert.equal((await call("GET", "/api/snapshot", null, { key: null })).status, 401);
    assert.equal((await call("GET", "/api/snapshot", null, { key: "wrong" })).status, 403);
    assert.equal((await call("GET", "/api/snapshot")).status, 200);
  });
  T("A03", "CORS: 허용 출처만 Access-Control-Allow-Origin", async () => {
    const pre = (o) => fetch(BASE + "/api/snapshot", { method: "OPTIONS", headers: { Origin: o, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-api-key" } });
    assert.equal((await pre("http://localhost:4174")).headers.get("access-control-allow-origin"), "http://localhost:4174");
    assert.equal((await pre("https://evil.example")).headers.get("access-control-allow-origin"), null);
  });
  T("A04", "Pydantic 검증: 알 수 없는 사건·잘못된 날짜·역할 → 422", async () => {
    assert.equal((await call("POST", "/api/events", { kind: "DROP" })).status, 422);
    assert.equal((await call("POST", "/api/clock", { to: "7월 18일" })).status, 422);
    assert.equal((await call("POST", "/api/cases/CS-0001/decision", { actor: "HACKER", action: "approve" })).status, 422);
  });
  T("A05", "없는 건 조회 404 · 없는 작업 완료 404", async () => {
    await reset();
    assert.equal((await call("GET", "/api/cases/CS-9999")).status, 404);
    assert.equal((await call("POST", "/api/tasks/TK-9999/done", { actor: "FINANCE" })).status, 404);
  });
});

describe("시나리오(HTTP)", () => {
  T("A06", "정상: 접수(202→job) → 권한 거부 403 → CEO 승인 → 작업 4건 → 발송 → 상태", async () => {
    await reset();
    const j = await event("CONTRACT_RENEWAL_NOTICE");
    assert.equal(j.status, "done");
    const cid = j.result.case_ids[0];
    assert.equal((await decide(cid, "MASIL_CEO", "approve")).status, 403);
    const ok = await decide(cid, "GROUP_CEO", "approve");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.tasks.length, 4);
    const t = ok.body.tasks.find((x) => x.effect === "CONTRACT_NOTICE_SENT");
    assert.equal((await call("POST", `/api/tasks/${t.id}/done`, { actor: "CONTRACT_OWNER" })).status, 200);
    const s = await snap();
    assert.equal(s.ctx.contract_status, "NOTICE_SENT");
    assert.equal(s.outbox.length, 1);
  });
  T("A07", "조건 변경: 기안 승인 후 연체 채권 회신 → 승인 무효·작업 취소·CEO 재상신", async () => {
    const b = await event("BUDGET_PLAN_BATCH");
    H.recordPerf("API 기안 25건 일괄 판단(메모리 저장소)", b.ms);
    let s = await snap();
    const p24 = caseOf(s, "PLAN-024");
    assert.equal((await decide(p24.id, "MASIL_CEO", "approve")).status, 200);
    const c = await event("FINANCE_OVERDUE_AR");
    H.recordPerf("API 조건 변경 재검증(25건)", c.ms);
    s = await snap();
    const after = caseOf(s, "PLAN-024");
    assert.equal(after.state, "PENDING_APPROVAL");
    assert.equal(after.approval.approver, "GROUP_CEO");
    assert.ok(s.tasks.filter((t) => t.case_id === p24.id && t.title.startsWith("PLAN-024 집행 확정")).every((t) => t.status === "CANCELLED"));
  });
  T("A08", "정보 부족 → 회신 → 거절: 역제안 확인 필요 → 지급 일정 → CEO 거절 → 연계 기안 부결", async () => {
    await event("AGENCY_COUNTER_OFFER");
    let s = await snap();
    const co = caseOf(s, "CT-INF001-2025", "AGENCY_COUNTER_OFFER");
    assert.equal(co.state, "NEEDS_INFO");
    assert.match(co.event_text, /010-\*\*\*\*-\*\*\*\*/);
    const r = await call("POST", "/api/replies", { reply_key: "agency_payment_schedule" });
    assert.equal(r.status, 200);
    assert.equal(r.body.cases[0].decision.authority.covenant_override, true);
    assert.equal((await decide(co.id, "GROUP_CEO", "reject", { comment: "미갱신" })).status, 200);
    s = await snap();
    assert.equal(s.ctx.contract_status, "TERMINATION_APPROVED");
    assert.deepEqual(["PLAN-001", "PLAN-002", "PLAN-003"].map((p) => s.plans[p]), ["부결", "부결", "부결"]);
  });
  T("A09", "미갱신 통보 발송 → 에이전시 수령 확인 → 계약 상태 '계약 종료'로 한글 표기", async () => {
    let s = await snap();
    const t = s.tasks.find((x) => x.effect === "CONTRACT_TERMINATION_SENT");
    await call("POST", `/api/tasks/${t.id}/done`, { actor: "CONTRACT_OWNER" });
    await call("POST", "/api/replies", { reply_key: "agency_accepts_termination" });
    s = await snap();
    assert.equal(s.ctx.contract_status, "TERMINATED");
    assert.match(s.contract_status_ko, /종료/);
  });
  T("A10", "역제안 수용(갱신 승인) 시 '상위 계약 대기' 기안이 풀려 다시 판단되어야 한다", async () => {
    await reset();
    const c = (await event("CONTRACT_RENEWAL_NOTICE")).result.case_ids[0];
    await event("BUDGET_PLAN_BATCH");
    await decide(c, "GROUP_CEO", "approve");                         // 연계 기안 보류
    await event("AGENCY_COUNTER_OFFER");
    await call("POST", "/api/replies", { reply_key: "agency_payment_schedule" });
    let s = await snap();
    const co = caseOf(s, "CT-INF001-2025", "AGENCY_COUNTER_OFFER");
    assert.equal((await decide(co.id, "GROUP_CEO", "approve", { comment: "AI 권고와 달리 수용" })).status, 200);
    s = await snap();
    const held = ["PLAN-001", "PLAN-002", "PLAN-003"].filter((p) => s.plans[p] === "상위 계약 대기");
    assert.deepEqual(held, [], `여전히 보류: ${held}`);
  });
  T("A11", "사람이 요청한 '확인 필요'는 조건 변경 재검증에도 유지되어야 한다", async () => {
    await reset();
    await event("BUDGET_PLAN_BATCH");
    let s = await snap();
    const p = caseOf(s, "PLAN-019");
    await decide(p.id, "MASIL_CEO", "request_info", { comment: "근거 보완" });
    await event("FINANCE_OVERDUE_AR");
    s = await snap();
    assert.equal(caseOf(s, "PLAN-019").state, "NEEDS_INFO");
  });
  T("A12", "확인 요청 작업을 완료하면 건이 다시 판단되어 결재로 돌아와야 한다", async () => {
    let s = await snap();
    const t = s.tasks.find((x) => x.kind === "INFO_REQUEST" && x.title.includes("PLAN-019") && x.status === "OPEN");
    assert.ok(t, "확인 요청 작업 없음");
    assert.equal((await call("POST", `/api/tasks/${t.id}/done`, { actor: t.dept })).status, 200);
    s = await snap();
    assert.equal(caseOf(s, "PLAN-019").state, "PENDING_APPROVAL");
  });
  T("A13", "기한 감시: 미결정 계약 → 7/18 진행 시 자동 갱신 기록", async () => {
    await reset();
    await event("CONTRACT_RENEWAL_NOTICE");
    const r = await call("POST", "/api/clock", { to: "2026-07-18" });
    assert.equal(r.status, 200);
    assert.equal((await snap()).ctx.contract_status, "AUTO_RENEWED");
    assert.equal((await call("POST", "/api/clock", { to: "2026-07-10" })).status, 409);
  });
});

describe("동시성·성능", () => {
  T("A14", "두 승인자가 동시에 같은 건 결정 → 정확히 1건만 반영", async () => {
    await reset();
    const c = (await event("CONTRACT_RENEWAL_NOTICE")).result.case_ids[0];
    const v = (await call("GET", `/api/cases/${c}`)).body.version;
    const rs = await Promise.all([decide(c, "GROUP_CEO", "approve", { expected_version: v }), decide(c, "GROUP_CEO", "reject", { expected_version: v })]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  });
  T("A15", "처리 중에도 다른 사용자 조회 응답 지연 없음(일괄 판단 중 snapshot < 500ms)", async () => {
    await reset();
    const r = await call("POST", "/api/events", { kind: "BUDGET_PLAN_BATCH" });
    const t0 = performance.now();
    await call("GET", "/api/health", null, { key: null });
    const ms = performance.now() - t0;
    H.recordPerf("일괄 판단 중 다른 요청 응답", ms);
    assert.ok(ms < 500, `${ms}ms`);
    for (let i = 0; i < 200; i++) { if ((await call("GET", `/api/jobs/${r.body.job_id}`)).body.status === "done") break; await new Promise((x) => setTimeout(x, 25)); }
  });
  T("A16", "스냅샷 응답 크기·시간(전 시나리오 후): 400KB 이하·300ms 이하", async () => {
    await event("CONTRACT_RENEWAL_NOTICE"); await event("AGENCY_COUNTER_OFFER"); await event("FINANCE_OVERDUE_AR");
    const t0 = performance.now();
    const r = await fetch(BASE + "/api/snapshot", { headers: { "X-API-Key": KEY } });
    const txt = await r.text();
    const ms = performance.now() - t0;
    H.recordPerf("스냅샷 응답", ms, { kb: Math.round(txt.length / 1024) });
    assert.ok(txt.length / 1024 < 400, `${Math.round(txt.length / 1024)}KB`);
    assert.ok(ms < 300, `${ms}ms`);
  });
  T("A17", "파일 영속 저장소(REPO_PATH, Docker 기본값)에서 기안 25건 일괄 판단 1.5초 이내", async () => {
    const f = path.join(os.tmpdir(), `desk-e2e-${Date.now()}.json`);
    apiFile = await H.startApi(8001, { REPO_PATH: f });
    const b = await event("BUDGET_PLAN_BATCH", {}, "http://localhost:8001");
    H.recordPerf("API 기안 25건 일괄 판단(파일 저장소)", b.ms, { file_kb: Math.round(fs.statSync(f).size / 1024) });
    // 재시작 후에도 데이터 유지
    H.stop(apiFile); await new Promise((x) => setTimeout(x, 800));
    apiFile = await H.startApi(8001, { REPO_PATH: f });
    assert.equal((await snap("http://localhost:8001")).cases.length, 25);
    assert.ok(b.ms < 1500, `${Math.round(b.ms)}ms`);
  });
});

describe("MCP 채널", () => {
  T("A18", "MCP stdio 클라이언트: 도구 6종·사건 주입·권한 거부·승인·조회·발송함", async () => {
    await reset();
    const out = JSON.parse(execFileSync("python3", [path.join(__dirname, "mcp_e2e.py"), BASE, KEY], { encoding: "utf8", timeout: 60000 }).trim().split("\n").pop());
    assert.deepEqual(out.tools, ["get_case", "inject_event", "list_outbox", "list_pending_approvals", "receive_mock_reply", "submit_decision"]);
    assert.match(out.pending, /CS-\d{4} \| INF-001/);
    assert.match(out.denied, /거부됨/);
    assert.match(out.approved, /APPROVED/);
    assert.match(out.case, /조건변경 통보/);
    assert.match(out.reply_without_wait, /기다리는 건이 없습니다/);
  });
});
