// 16차 E2E — 느린 외부 LLM이 다른 사람의 일을 막는가(15차 R-90).
//   설명문(LLM)을 만드는 동안 서버가 '처리 순서'를 쥐고 있으면, 그 사이 다른 사람의 결재·조건 변경은 모두 기다린다(서버 한 대에서도).
//   LLM 응답 1.5초(실제 외부 LLM에서 흔한 값)로 기안 25건을 접수하면서 다른 사용자가 결재해 본다.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const H = require("./helpers.cjs");

const KEY = "e2e-key";
const LLM = "http://127.0.0.1:8903";
const LLM_ENV = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `${LLM}/v1`, LLM_TIMEOUT_S: "5" };
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, body) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const timed = async (fn) => { const t0 = performance.now(); const r = await fn(); return [performance.now() - t0, r]; };
const mode = (m, latency = 0) => fetch(`${LLM}/__mode`, { method: "POST", body: JSON.stringify({ mode: m, latency }) });
const waitJob = async (base, id, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { const j = await (await call(base, "GET", `/api/jobs/${id}`)).json(); if (j.status === "done" || j.status === "failed") return j; await new Promise((x) => setTimeout(x, 50)); } throw new Error("job timeout"); };
const snap = async (base) => (await call(base, "GET", "/api/snapshot")).json();
let llm = null, db = null;
before(async () => { llm = spawn("python3", [path.join(__dirname, "mock_llm.py"), "8903"], { stdio: "ignore", detached: true }); await H.waitHttp(`${LLM}/__stats`); });
after(() => { H.writeReport("round16", { results }); try { process.kill(-llm.pid); } catch { /* gone */ } H.stop(db); });

/** 계약 건을 먼저 접수(설명 완료까지)해 두고, 기안 25건 일괄 접수를 시작한 0.3초 뒤 다른 서버/같은 서버로 계약 건을 결재한다. */
async function decideDuringBatch(writeBase, decideBase) {
  await mode("ok", 0);
  await call(writeBase, "POST", "/api/reset");
  const j0 = await (await call(writeBase, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" })).json();
  await waitJob(writeBase, j0.job_id);
  const ct = (await snap(writeBase)).cases[0];
  await mode("ok", 1.5);
  const job = await (await call(writeBase, "POST", "/api/events", { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" })).json();
  await new Promise((r) => setTimeout(r, 300));
  const [ms, r] = await timed(() => call(decideBase, "POST", `/api/cases/${ct.id}/decision`, { actor: "GROUP_CEO", action: "approve", comment: "접수와 동시에 결재" }));
  const [jobMs] = await timed(() => waitJob(writeBase, job.job_id));
  return { ms, status: r.status, jobMs };
}

describe("느린 LLM과 다른 사용자", () => {
  T("AC01", "기안 25건 접수(LLM 1.5초/회) 중에도 다른 사용자의 결재가 1초 안에 끝남(같은 서버)", async () => {
    const api = await H.startApi(8100, LLM_ENV);
    try {
      const r = await decideDuringBatch("http://localhost:8100", "http://localhost:8100");
      H.recordPerf("느린 LLM 접수 중 결재(같은 서버)", r.ms, { job_ms: Math.round(r.jobMs) });
      assert.equal(r.status, 200);
      assert.ok(r.ms < 1000, `결재 응답 ${Math.round(r.ms)}ms — 접수의 LLM 호출이 끝날 때까지 기다림`);
      return { decide_ms: Math.round(r.ms) };
    } finally { H.stop(api); }
  });

  T("AC02", "서버 2대(같은 MySQL): A에서 접수하는 동안 B로 한 결재가 1초 안에 끝남", async () => {
    db = await H.startMariaDB(3316);
    if (!db) { if (process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음"); return { skipped: true }; }
    const a = await H.startApi(8101, { ...LLM_ENV, ...db.env }); const b = await H.startApi(8102, { ...LLM_ENV, ...db.env });
    try {
      const r = await decideDuringBatch("http://localhost:8101", "http://localhost:8102");
      H.recordPerf("느린 LLM 접수 중 결재(다른 서버)", r.ms, { job_ms: Math.round(r.jobMs) });
      assert.equal(r.status, 200, `B 결재 응답 ${r.status}`);
      assert.ok(r.ms < 1000, `B 결재 응답 ${Math.round(r.ms)}ms`);
      return { decide_ms: Math.round(r.ms) };
    } finally { H.stop(a); H.stop(b); }
  });

  T("AC03", "25건 접수 뒤 1.5초 안에 목록에 25건(규칙 판단·결재란) — AI 설명은 '작성 중'으로 표시되고, 작업이 끝나면 모두 LLM 설명", async () => {
    const base = "http://localhost:8103";
    const api = await H.startApi(8103, LLM_ENV);
    try {
      await mode("ok", 1.5);
      const t0 = Date.now();
      const job = await (await call(base, "POST", "/api/events", { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" })).json();
      let shownMs = null, writing = 0;
      while (Date.now() - t0 < 1500) {
        const s = await snap(base);
        const plans = s.cases.filter((c) => c.type === "PLAN" && c.decision);
        if (plans.length === 25) { shownMs = Date.now() - t0; writing = plans.filter((c) => /작성 중/.test(String(c.llm))).length; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      await waitJob(base, job.job_id);
      const done = (await snap(base)).cases.filter((c) => c.type === "PLAN");
      const notLlm = done.filter((c) => !/^openai/.test(String(c.llm)));
      H.recordPerf("25건 목록 표시(느린 LLM)", shownMs ?? 99999);
      assert.ok(shownMs !== null, "1.5초 안에 25건이 목록에 보이지 않음(LLM이 모두 끝나야 보임)");
      assert.equal(writing, 25, `'작성 중' 표시 ${writing}건`);
      assert.deepEqual(notLlm.map((c) => `${c.target_id}:${c.llm}`), [], "작업이 끝났는데 LLM 설명이 아닌 건");
      return { shown_ms: shownMs };
    } finally { H.stop(api); }
  });

  T("AC04", "AI 설명이 '작성 중'일 때 결재해도, 늦게 온 설명이 결재 결과(상태·결재 기록)를 덮어쓰지 않음", async () => {
    const base = "http://localhost:8104";
    const api = await H.startApi(8104, LLM_ENV);
    try {
      await mode("ok", 1.5);
      const job = await (await call(base, "POST", "/api/events", { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" })).json();
      let target = null;
      const t0 = Date.now();
      while (!target && Date.now() - t0 < 1500) {
        target = (await snap(base)).cases.find((c) => c.state === "PENDING_APPROVAL" && c.approval?.approver === "MASIL_CEO");
        if (!target) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(target, "설명 작성 중에 결재할 건이 목록에 없음(접수가 끝나야 보임)");
      const r = await call(base, "POST", `/api/cases/${target.id}/decision`, { actor: "MASIL_CEO", action: "approve", comment: "작성 중 결재" });
      await waitJob(base, job.job_id);
      const c = (await snap(base)).cases.find((x) => x.id === target.id);
      assert.equal(r.status, 200);
      assert.notEqual(c.state, "PENDING_APPROVAL", `늦은 설명이 상태를 되돌림: ${c.state}`);
      assert.equal(c.approval?.decision, "approve", "결재 기록이 사라짐");
    } finally { H.stop(api); }
  });

  T("AC05", "설명을 쓰는 도중 LLM이 고장 나도 작업은 끝나고, '작성 중'인 채로 남는 건이 없음(근거 기반 대체문)", async () => {
    const base = "http://localhost:8105";
    const api = await H.startApi(8105, LLM_ENV);
    try {
      await mode("ok", 1.0);
      const job = await (await call(base, "POST", "/api/events", { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" })).json();
      await new Promise((r) => setTimeout(r, 400));
      await mode("error", 0);
      const [ms] = await timed(() => waitJob(base, job.job_id));
      const s = await snap(base);
      const stuck = s.cases.filter((c) => /작성 중/.test(String(c.llm)) || !c.explanation);
      assert.deepEqual(stuck.map((c) => c.target_id), [], "설명 없이 남은 건");
      assert.ok(ms < 30000, `작업 ${Math.round(ms)}ms`);
    } finally { H.stop(api); }
  });
});
