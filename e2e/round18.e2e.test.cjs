// 18차 E2E — 결재 서류의 무결성과 화면, 시간 흐름 × AI 설명 두 단계 처리(v1.16~v1.17).
//   ① 서버 모드 화면에서 25건 접수(설명은 LLM 1.5초/회)를 누르면, 서버가 0.65초에 저장한 목록이 화면에도 바로 보이는가
//   ② 그 접수가 끝나기 전에 같은 화면에서 다른 결재를 누르면 처리되는가(조용히 무시되지 않는가)
//   ③ AI 설명이 '작성 중'일 때 결재하면, 결재한 사람이 본 설명이 결재 서류에 그대로 남는가(결재 뒤 바뀌지 않는가)
//   ④ 설명을 쓰는 사이 시계를 진행(하루 진행)해도 설명이 LLM으로 마무리되는가
//   ⑤ ③을 화면에서: 결재 뒤 도착한 AI 설명은 결재 서류와 구분해 보여 주는가
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const H = require("./helpers.cjs");

const KEY = "e2e-key";
const LLM = "http://127.0.0.1:8905";
const LLM_ENV = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `${LLM}/v1`, LLM_TIMEOUT_S: "5" };
const UI_ENV = { ...LLM_ENV, SERVE_FRONTEND: "1", FRONTEND_DIST: path.join(H.ROOT, "frontend", "dist-docker"), ALLOWED_ORIGINS: "" };
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, body) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const mode = (m, latency = 0) => fetch(`${LLM}/__mode`, { method: "POST", body: JSON.stringify({ mode: m, latency }) });
const waitJob = async (base, r, ms = 90000) => { const b = await r.json(); const end = Date.now() + ms; while (Date.now() < end) { const j = await (await call(base, "GET", `/api/jobs/${b.job_id}`)).json(); if (j.status === "done" || j.status === "failed") return j; await new Promise((x) => setTimeout(x, 50)); } throw new Error("job timeout"); };
const snap = async (base) => (await call(base, "GET", "/api/snapshot")).json();
const writing = (s) => s.cases.filter((c) => /작성 중/.test(String(c.llm)));
const settle = async (base, ms = 30000) => { const end = Date.now() + ms; let s; while (Date.now() < end) { s = await snap(base); if (!writing(s).length) return s; await new Promise((r) => setTimeout(r, 200)); } return s; };
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
const intake = (base, kind, actor) => call(base, "POST", "/api/events", { kind, actor });
const openApi = async (p, base, role) => {
  await p.goto(base); await p.waitForSelector(".top");
  await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector(".top");
  await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(800);
  if (role) await p.locator('[data-testid="role-select"]').selectOption(role);
};
let llm = null;
before(async () => { llm = spawn("python3", [path.join(__dirname, "mock_llm.py"), "8905"], { stdio: "ignore", detached: true }); await H.waitHttp(`${LLM}/__stats`); });
after(() => { H.writeReport("round18", { results }); try { process.kill(-llm.pid); } catch { /* gone */ } });

describe("서버 모드 화면 × 오래 걸리는 접수", () => {
  T("AE01", "화면에서 기안 25건 접수(LLM 1.5초/회)를 누르면, 작업이 끝나기 전 2초 안에 목록에 25건이 보임", async () => {
    const base = "http://localhost:8120";
    const api = await H.startApi(8120, UI_ENV);
    const B = await H.newPage(); const p = B.page;
    try {
      await mode("echo", 0); await call(base, "POST", "/api/reset");
      await openApi(p, base, "MARKETING_TEAM");
      await mode("echo", 1.5);
      const t0 = Date.now();
      await p.getByRole("button", { name: "확대 기안 25건 접수" }).click();
      const ok = await until(async () => (await p.locator('[data-testid^="case-PLAN-"]').count()) === 25, 2000);
      const shown = Date.now() - t0;
      const jobDone = await until(async () => !writing(await snap(base)).length && (await snap(base)).cases.length === 25, 30000);
      H.recordPerf("화면 25건 표시(느린 LLM)", ok ? shown : 99999);
      assert.ok(jobDone, "작업이 끝나지 않음");
      assert.ok(ok, `2초 안에 목록에 25건이 보이지 않음(서버에는 이미 저장됨) — 화면은 작업이 끝날 때까지 갱신을 멈춤`);
      return { shown_ms: shown };
    } finally { await B.browser.close(); H.stop(api); }
  });

  T("AE02", "그 접수가 끝나기 전에 같은 화면에서 역할을 바꿔 계약 건을 승인하면 2.5초 안에 처리됨(클릭이 조용히 무시되지 않음)", async () => {
    const base = "http://localhost:8121";
    const api = await H.startApi(8121, UI_ENV);
    const B = await H.newPage(); const p = B.page;
    try {
      await mode("echo", 0); await call(base, "POST", "/api/reset");
      await waitJob(base, await intake(base, "CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER"));
      await openApi(p, base, "MARKETING_TEAM");
      await p.locator('[data-testid="case-CT-INF001-2025"]').waitFor();
      await mode("echo", 1.5);
      await p.getByRole("button", { name: "확대 기안 25건 접수" }).click();
      await p.waitForTimeout(300);
      await p.locator('[data-testid="role-select"]').selectOption("GROUP_CEO");
      await p.locator('[data-testid="case-CT-INF001-2025"]').click();
      const t0 = Date.now();
      await p.locator('[data-testid="approve"]').click();
      const ok = await until(async () => (await snap(base)).cases.find((c) => c.type === "CONTRACT").state !== "PENDING_APPROVAL", 2500);
      const ms = Date.now() - t0;
      const toast = await p.locator(".toast").innerText().catch(() => "");
      await settle(base);
      assert.ok(ok, `2.5초 안에 승인되지 않음(안내: '${toast.slice(0, 60)}')`);
      return { decide_ms: ms };
    } finally { await B.browser.close(); H.stop(api); }
  });
});

describe("결재 서류의 무결성", () => {
  T("AE03", "AI 설명이 '작성 중'일 때 결재하면, 결재한 사람이 본 설명이 결재 서류에 그대로 남고 늦게 온 LLM 설명은 따로 보관되며 감사 기록이 남음", async () => {
    const base = "http://localhost:8122";
    const api = await H.startApi(8122, LLM_ENV);
    try {
      await mode("echo", 0); await call(base, "POST", "/api/reset");
      await waitJob(base, await intake(base, "CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER"));
      await waitJob(base, await intake(base, "BUDGET_PLAN_BATCH", "MARKETING_TEAM"));
      await mode("echo", 1.5);
      await call(base, "POST", "/api/conditions", { actor: "FINANCE", cash_assumption: "LEGACY45" });
      const t = writing(await snap(base)).find((c) => c.state === "PENDING_APPROVAL");
      assert.ok(t, "작성 중인 결재 대기 건이 없음(시험 전제)");
      const seen = t.explanation;
      const r = await call(base, "POST", `/api/cases/${t.id}/decision`, { actor: t.approval.approver, action: "approve", comment: "작성 중 결재" });
      assert.equal(r.status, 200);
      const s = await settle(base);
      const c = s.cases.find((x) => x.id === t.id);
      const audit = s.audit.filter((a) => a.case_id === t.id && /설명/.test(`${a.topic} ${a.detail}`) && /결재 뒤/.test(a.detail || ""));
      assert.equal(c.explanation, seen, "결재 뒤 결재 서류의 설명이 바뀜(결재한 사람이 보지 못한 글이 서류에 남음)");
      assert.match(String(c.late_explanation || ""), /■ 결론/, "늦게 온 LLM 설명이 보관되지 않음");
      assert.ok(audit.length >= 1, "결재 뒤 설명 도착이 감사 기록에 없음");
      return { case: t.target_id };
    } finally { H.stop(api); }
  });

  T("AE04", "설명을 쓰는 사이 시계를 하루 진행해도, 다시 분석하지 않은 건의 설명은 LLM으로 마무리됨('판단이 바뀌어 생략' 없음)", async () => {
    const base = "http://localhost:8123";
    const api = await H.startApi(8123, LLM_ENV);
    try {
      await mode("echo", 0); await call(base, "POST", "/api/reset");
      await waitJob(base, await intake(base, "CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER"));
      await waitJob(base, await intake(base, "BUDGET_PLAN_BATCH", "MARKETING_TEAM"));
      await mode("echo", 1.0);
      await call(base, "POST", "/api/conditions", { actor: "FINANCE", cash_assumption: "LEGACY45" });
      // 설명 작성이 조건을 읽기 전(명령 직후 0.1초)에 시계를 옮긴다 — 화면에서 조건 변경 뒤 바로 '하루 진행'을 누른 상황
      await new Promise((r) => setTimeout(r, 100));
      const ck = await call(base, "POST", "/api/clock", { to: "2026-07-02", actor: "SYSTEM" });
      assert.equal(ck.status, 200);
      const s = await settle(base);
      const bad = s.cases.filter((c) => c.decision && !/^openai/.test(String(c.llm))).map((c) => `${c.target_id}:${c.llm}`);
      assert.deepEqual(bad, [], `LLM 설명으로 마무리되지 않은 건 ${bad.length}건`);
    } finally { H.stop(api); }
  });
});

describe("서버 모드 화면 × 결재 서류", () => {
  T("AE05", "화면에서 '작성 중'인 건을 결재하면, 결재 서류의 설명은 그대로이고 늦게 온 AI 설명은 '결재 뒤 도착'으로 따로 보임", async () => {
    const base = "http://localhost:8124";
    const api = await H.startApi(8124, UI_ENV);
    const B = await H.newPage(); const p = B.page;
    try {
      await mode("echo", 0); await call(base, "POST", "/api/reset");
      await waitJob(base, await intake(base, "CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER"));
      await waitJob(base, await intake(base, "BUDGET_PLAN_BATCH", "MARKETING_TEAM"));
      await openApi(p, base, null);
      await mode("echo", 1.5);
      await call(base, "POST", "/api/conditions", { actor: "FINANCE", cash_assumption: "LEGACY45" });
      const t = writing(await snap(base)).find((c) => c.state === "PENDING_APPROVAL");
      assert.ok(t, "작성 중인 결재 대기 건이 없음(시험 전제)");
      await p.locator('[data-testid="role-select"]').selectOption(t.approval.approver);
      await p.locator(`[data-testid="case-${t.target_id}"]`).click();
      await p.waitForFunction(() => /쓰는 중/.test(document.querySelector('[data-testid="llm-source"]')?.textContent || ""), null, { timeout: 5000 });
      const seen = await p.locator("pre.explain").textContent();
      await p.locator('[data-testid="approve"]').click();
      const late = await p.locator('[data-testid="late-explanation"]').waitFor({ timeout: 12000 }).then(() => true).catch(() => false);
      const now = await p.locator("pre.explain").first().textContent();
      assert.ok(late, "결재 뒤 도착한 AI 설명이 화면에 따로 보이지 않음");
      assert.equal(now, seen, "결재 뒤 화면의 결재 서류 설명이 바뀜");
      assert.deepEqual(p.errors, []);
    } finally { await B.browser.close(); H.stop(api); }
  });
});
