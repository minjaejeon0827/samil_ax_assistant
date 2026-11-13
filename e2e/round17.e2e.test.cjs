// 17차 E2E — v1.16의 'AI 설명 두 단계 처리'가 기존 기능과 만날 때, 그리고 실제 외부 LLM의 사용량 한도.
//   ① 설명을 쓰는 사이 조건을 연달아 바꾸면, 마지막에 남는 설명은 '지금' 판단(승인자)과 맞는가
//   ② 백그라운드에서 설명을 쓰는 중 서버가 강제 종료되면, 다시 켰을 때 '작성 중'으로 영영 남지 않는가
//   ③ 제공자가 동시 요청을 4건으로 제한(429)하면, 25건 접수의 설명은 어떻게 되는가
//   ④ 조건을 연달아 세 번 바꿀 때, 지나간 분석의 설명에도 LLM을 부르는가(비용·대기)
//   ⑤ 서버 모드 화면에서 '작성 중'인 건을 열어 두면, 새로 고치지 않아도 LLM 설명으로 바뀌는가
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const H = require("./helpers.cjs");

const KEY = "e2e-key";
const LLM = "http://127.0.0.1:8904";
const LLM_ENV = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `${LLM}/v1`, LLM_TIMEOUT_S: "5" };
const ROLE_KO = { MARKETING_TEAM: "마케팅팀", MASIL_CEO: "Masil 대표", GROUP_CEO: "그룹 CEO/이사회" };
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, body) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const mode = (m, latency = 0, limit = 0) => fetch(`${LLM}/__mode`, { method: "POST", body: JSON.stringify({ mode: m, latency, limit }) });
const stats = async () => (await fetch(`${LLM}/__stats`)).json();
const waitJob = async (base, r, ms = 90000) => { const b = await r.json(); const end = Date.now() + ms; while (Date.now() < end) { const j = await (await call(base, "GET", `/api/jobs/${b.job_id}`)).json(); if (j.status === "done" || j.status === "failed") return j; await new Promise((x) => setTimeout(x, 50)); } throw new Error("job timeout"); };
const snap = async (base) => (await call(base, "GET", "/api/snapshot")).json();
const writing = (s) => s.cases.filter((c) => /작성 중/.test(String(c.llm)));
const settle = async (base, ms = 30000) => { const end = Date.now() + ms; let s; while (Date.now() < end) { s = await snap(base); if (!writing(s).length) return s; await new Promise((r) => setTimeout(r, 200)); } return s; };
const echoed = (c) => (String(c.explanation).match(/■ 승인자: (.+)/) || [])[1]?.trim();
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aurora17-")), "desk.json");
/** 계약 건 + 기안 25건을 빠르게(지연 없음) 접수해 둔다. */
const seed = async (base) => {
  await mode("echo", 0); await call(base, "POST", "/api/reset");
  await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
  await waitJob(base, await call(base, "POST", "/api/events", { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" }));
};
const cond = (base, a) => call(base, "POST", "/api/conditions", { actor: "FINANCE", cash_assumption: a });
let llm = null;
before(async () => { llm = spawn("python3", [path.join(__dirname, "mock_llm.py"), "8904"], { stdio: "ignore", detached: true }); await H.waitHttp(`${LLM}/__stats`); });
after(() => { H.writeReport("round17", { results }); try { process.kill(-llm.pid); } catch { /* gone */ } });

describe("두 단계 설명 × 조건 변경·재시작", () => {
  T("AD01", "설명을 쓰는 사이 조건을 연달아 바꿔도(90일 → 45일 → 보수 가정), 남는 설명은 지금 판단의 승인자와 맞고 모두 LLM 설명", async () => {
    const base = "http://localhost:8110";
    const api = await H.startApi(8110, LLM_ENV);
    try {
      await seed(base);
      await mode("echo", 1.0);
      await cond(base, "LEGACY45");
      await new Promise((r) => setTimeout(r, 300));
      await cond(base, "CONSERVATIVE");          // 처음 접수 때(90일)의 설명은 캐시에 있으므로, 캐시에 없는 가정으로 끝낸다
      const s = await settle(base);
      const plans = s.cases.filter((c) => c.type === "PLAN" && c.decision);
      const wrong = plans.filter((c) => echoed(c) !== ROLE_KO[c.decision.approver]).map((c) => `${c.target_id}: 설명 '${echoed(c)}' ≠ 판단 '${ROLE_KO[c.decision.approver]}'`);
      const notLlm = plans.filter((c) => !/^openai/.test(String(c.llm))).map((c) => `${c.target_id}:${c.llm}`);
      assert.deepEqual(writing(s).map((c) => c.target_id), [], "30초가 지나도 '작성 중'");
      assert.deepEqual(wrong, [], `지난 조건으로 쓴 설명이 남음 ${wrong.length}건`);
      assert.deepEqual(notLlm, [], `LLM 설명이 아닌 건 ${notLlm.length}건`);
      return { plans: plans.length };
    } finally { H.stop(api); }
  });

  T("AD02", "백그라운드에서 설명을 쓰는 중 서버가 강제 종료돼도, 다시 켜면 15초 안에 '작성 중'이 없어지고 LLM 설명으로 마무리됨", async () => {
    const base = "http://localhost:8111";
    const env = { ...LLM_ENV, REPO: "memory", REPO_PATH: tmpFile() };
    let api = await H.startApi(8111, env);
    try {
      await seed(base);
      await mode("echo", 1.5);
      const r = await cond(base, "LEGACY45");     // 조건 변경 → 미결 기안 재분석(설명은 응답 뒤 백그라운드)
      assert.equal(r.status, 200);
      const before = writing(await snap(base)).map((c) => c.id);
      assert.ok(before.length > 0, "결재 뒤 다시 분석된 건이 없음(시험 전제)");
      process.kill(-api.pid, "SIGKILL"); await new Promise((r) => setTimeout(r, 400));
      await mode("echo", 0);
      api = await H.startApi(8111, env);
      const t0 = Date.now();
      const s = await settle(base, 15000);
      const stuck = writing(s).map((c) => c.target_id);
      const notLlm = s.cases.filter((c) => before.includes(c.id) && !/^openai/.test(String(c.llm))).map((c) => `${c.target_id}:${c.llm}`);
      assert.deepEqual(stuck, [], `재시작 15초 뒤에도 '작성 중' ${stuck.length}건`);
      assert.deepEqual(notLlm, [], "LLM 설명으로 마무리되지 않음");
      return { pending_at_kill: before.length, settled_ms: Date.now() - t0 };
    } finally { H.stop(api); }
  });
});

describe("외부 LLM 사용량 한도", () => {
  T("AD03", "제공자가 동시 요청 4건을 넘으면 429를 돌려줘도, 기안 25건 모두 LLM 설명이 붙고 바로 다음 접수도 LLM을 씀(차단기 열리지 않음)", async () => {
    const base = "http://localhost:8112";
    const api = await H.startApi(8112, LLM_ENV);
    try {
      await mode("ok", 0.3, 4);
      await call(base, "POST", "/api/reset");
      const t0 = Date.now();
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" }));
      const jobMs = Date.now() - t0;
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      const s = await snap(base); const st = await stats();
      const bad = s.cases.filter((c) => c.decision && !/^openai/.test(String(c.llm))).map((c) => `${c.target_id}:${c.llm}`);
      H.recordPerf("동시 4건 한도에서 25건 설명", jobMs, { r429: st.r429, max_inflight: st.max_inflight });
      assert.deepEqual(bad, [], `LLM 설명이 아닌 건 ${bad.length}/${s.cases.length}(429 ${st.r429}회)`);
      assert.ok(jobMs < 30000, `25건 작업 ${jobMs}ms`);
      return { job_ms: jobMs, r429: st.r429 };
    } finally { H.stop(api); }
  });

  T("AD04", "조건을 연달아 세 번 바꿔도 지나간 분석의 설명에는 LLM을 부르지 않음(호출 수가 마지막 분석 1회분의 1.5배 이하)", async () => {
    const run = async (port, seq) => {
      const base = `http://localhost:${port}`;
      const api = await H.startApi(port, LLM_ENV);
      try {
        await seed(base);
        await mode("echo", 0.5);
        const t0 = Date.now();
        for (const [i, a] of seq.entries()) { if (i) await new Promise((r) => setTimeout(r, 150)); await cond(base, a); }
        const s = await settle(base, 60000);
        return { calls: (await stats()).calls, ms: Date.now() - t0, writing: writing(s).length };
      } finally { H.stop(api); }
    };
    const one = await run(8113, ["LEGACY45"]);
    const three = await run(8114, ["LEGACY45", "CONSERVATIVE", "LEGACY45"]);
    H.recordPerf("조건 3연속 변경 LLM 호출", three.calls, { one: one.calls, settle_ms: three.ms, settle_one_ms: one.ms });
    assert.equal(three.writing, 0);
    assert.ok(three.calls <= one.calls * 1.5, `LLM 호출 ${three.calls}회(한 번 바꿀 때 ${one.calls}회)`);
    return { calls_one: one.calls, calls_three: three.calls };
  });
});

describe("서버 모드 화면", () => {
  T("AD05", "'작성 중'인 처리 건을 열어 두면, 새로 고치지 않아도 10초 안에 LLM 설명과 판사 결과로 바뀜", async () => {
    const base = "http://localhost:8115";
    const api = await H.startApi(8115, { ...LLM_ENV, SERVE_FRONTEND: "1", FRONTEND_DIST: path.join(H.ROOT, "frontend", "dist-docker"), ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      await seed(base);
      await mode("echo", 1.5);
      await p.goto(base); await p.waitForSelector(".top");
      await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector(".top");
      await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(800);
      await cond(base, "LEGACY45");
      const target = writing(await snap(base))[0];
      assert.ok(target, "다시 분석 중인 건이 없음(시험 전제)");
      await p.locator(`[data-testid="case-${target.target_id}"]`).click();
      await p.locator('[data-testid="llm-source"]').waitFor();
      // 화면은 자동 갱신(2.5초 주기) 뒤에 조건 변경을 반영하므로, 먼저 '쓰는 중'이 보일 때까지 기다린다
      await p.waitForFunction(() => /쓰는 중/.test(document.querySelector('[data-testid="llm-source"]')?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
      const during = await p.locator('[data-testid="llm-source"]').innerText();
      const t0 = Date.now();
      const ok = await p.waitForFunction(() => /LLM\(판사 통과\)/.test(document.querySelector('[data-testid="llm-source"]')?.textContent || ""), null, { timeout: 10000 }).then(() => true).catch(() => false);
      const after = await p.locator('[data-testid="llm-source"]').innerText();
      assert.match(during, /쓰는 중/, `작성 중 안내: ${during}`);
      assert.ok(ok, `10초가 지나도 바뀌지 않음: ${after}`);
      assert.deepEqual(p.errors, []);
      return { switched_ms: Date.now() - t0 };
    } finally { await B.browser.close(); H.stop(api); }
  });
});
