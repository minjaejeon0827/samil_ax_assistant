// 20차 E2E — 결재하는 사람의 화면이 '그 사이 바뀐 결재 서류'를 어떻게 다루는가.
//   AI 설명은 결재 서류를 연 뒤에 도착할 수 있다(v1.16 두 단계 처리). 그때마다 서류의 판(version)이 올라간다.
//   ① 결정 의견을 쓰는 도중 AI 설명이 도착하면, 쓰던 의견과 커서가 그대로인가
//   ② 화면이 아직 갱신되기 전(느린 망)에 승인을 누르면, 보지 못한 서류로 결재되지 않고 이유를 정확히 알려 주는가
//   ③ '승인자용 설명문'을 펼쳐 읽는 중 설명이 바뀌면, 펼친 채로 두고 바뀌었다고 알려 주는가
//   ④ (회귀 방지) 다른 사람이 다른 건을 결재해도 쓰던 의견이 그대로인가
//   ⑤ API: 설명만 바뀐 서류에 옛 판 번호로 결재하면 409와 함께 '설명이 바뀜'을 알려 주고, 새 판으로는 결재됨
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const H = require("./helpers.cjs");

const KEY = "e2e-key";
const LLM = "http://127.0.0.1:8907";
const LLM_ENV = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `${LLM}/v1`, LLM_TIMEOUT_S: "5" };
const UI_ENV = { ...LLM_ENV, SERVE_FRONTEND: "1", FRONTEND_DIST: path.join(H.ROOT, "frontend", "dist-docker"), ALLOWED_ORIGINS: "" };
const COMMENT = "근거 확인함 — 7월 16일까지 발송 조건으로 승인";
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
const intake = (base, kind, actor) => call(base, "POST", "/api/events", { kind, actor });
const seed = async (base) => {
  await mode("echo", 0); await call(base, "POST", "/api/reset");
  await waitJob(base, await intake(base, "CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER"));
  await waitJob(base, await intake(base, "BUDGET_PLAN_BATCH", "MARKETING_TEAM"));
};
const openApi = async (p, base) => {
  await p.goto(base); await p.waitForSelector(".top");
  await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector(".top");
  await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(800);
};
const llmDone = (p, ms) => p.waitForFunction(() => /판사 통과/.test(document.querySelector('[data-testid="llm-source"]')?.textContent || ""), null, { timeout: ms }).then(() => true).catch(() => false);
/** 45일 가정으로 바꿔 '작성 중'인 결재 대기 건을 만들고, 그 결재자 역할로 서류를 연다. */
async function openWriting(p, base, port) {
  await seed(base);
  await openApi(p, base);
  await mode("echo", 1.5);
  await call(base, "POST", "/api/conditions", { actor: "FINANCE", cash_assumption: "LEGACY45" });
  const t = writing(await snap(base)).find((c) => c.state === "PENDING_APPROVAL" && c.type === "PLAN" && !c.decision?.regulation?.findings?.length);   // 30차(AP-07): 위반 카피가 남은 기안(PLAN-001)은 승인 불가라 제외
  assert.ok(t, "시험 전제: 작성 중인 결재 대기 건이 없음");
  await p.locator('[data-testid="role-select"]').selectOption(t.approval.approver);
  await p.locator(`[data-testid="case-${t.target_id}"]`).click();
  await p.waitForFunction(() => /쓰는 중/.test(document.querySelector('[data-testid="llm-source"]')?.textContent || ""), null, { timeout: 5000 });
  return t;
}
let llm = null;
before(async () => { llm = spawn("python3", [path.join(__dirname, "mock_llm.py"), "8907"], { stdio: "ignore", detached: true }); await H.waitHttp(`${LLM}/__stats`); });
after(() => { H.writeReport("round20", { results }); try { process.kill(-llm.pid); } catch { /* gone */ } });

describe("결재하는 동안 바뀐 결재 서류(서버 모드 화면)", () => {
  T("AG01", "결정 의견을 쓰는 도중 AI 설명이 도착해도, 쓰던 의견과 입력 커서가 그대로", async () => {
    const base = "http://localhost:8140";
    const api = await H.startApi(8140, UI_ENV);
    const B = await H.newPage(); const p = B.page;
    try {
      await openWriting(p, base);
      await p.locator("#cmt").click(); await p.keyboard.type(COMMENT, { delay: 5 });
      const done = await llmDone(p, 15000);
      const r = await p.evaluate(() => ({ value: document.querySelector("#cmt")?.value ?? null, focus: document.activeElement?.id || document.activeElement?.tagName }));
      assert.ok(done, "시험 전제: AI 설명이 화면에 도착하지 않음");
      assert.equal(r.value, COMMENT, `AI 설명이 도착하자 쓰던 결정 의견이 지워짐(남은 값: ${JSON.stringify(r.value)})`);
      assert.equal(r.focus, "cmt", `입력 커서가 사라짐(${r.focus})`);
      assert.deepEqual(p.errors, []);
    } finally { await B.browser.close(); H.stop(api); }
  });

  T("AG02", "화면이 갱신되기 전(느린 망)에 승인을 누르면, 보지 못한 서류로 결재되지 않고 'AI 설명이 바뀌었다'고 알리며 의견은 그대로", async () => {
    const base = "http://localhost:8141";
    const api = await H.startApi(8141, UI_ENV);
    const B = await H.newPage(); const p = B.page;
    try {
      const t = await openWriting(p, base);
      await p.locator("#cmt").fill(COMMENT);
      let release; const held = new Promise((r) => (release = r));
      await p.route(/\/api\/(revision|snapshot)/, async (route) => { await held; await route.continue().catch(() => {}); });   // 느린 망: 갱신이 늦게 옴
      await settle(base);                                                       // 서버에서는 설명이 이미 바뀜
      await p.locator('[data-testid="approve"]').click();
      await new Promise((r) => setTimeout(r, 700)); release();
      await p.waitForFunction(() => (document.querySelector(".toast")?.textContent || "").length > 0, null, { timeout: 5000 });
      const toast = await p.locator(".toast").innerText();
      const c = (await snap(base)).cases.find((x) => x.id === t.id);
      const shown = await llmDone(p, 5000);
      const value = await p.locator("#cmt").inputValue().catch(() => null);
      assert.ok(!(c.approval || {}).decision, `보지 못한 판(AI 설명 도착 뒤)으로 결재됨: ${c.state}`);
      assert.doesNotMatch(toast, /다른 사용자가 먼저/, `이유가 틀림: ${toast}`);
      assert.match(toast, /설명|바뀌/, `이유 안내: ${toast}`);
      assert.ok(shown, "갱신 뒤 바뀐 AI 설명이 화면에 보이지 않음");
      assert.equal(value, COMMENT, "다시 결재하려는데 의견이 지워짐");
    } finally { await B.browser.close(); H.stop(api); }
  });

  T("AG03", "'승인자용 설명문'을 펼쳐 읽는 중 AI 설명이 도착하면, 펼친 채로 새 설명을 보여 주고 '설명이 바뀌었다'고 알림", async () => {
    const base = "http://localhost:8142";
    const api = await H.startApi(8142, UI_ENV);
    const B = await H.newPage(); const p = B.page;
    try {
      await openWriting(p, base);
      await p.locator("details", { hasText: "승인자용 설명문" }).locator("summary").first().click();
      const done = await llmDone(p, 15000);
      const r = await p.evaluate(() => {
        const d = [...document.querySelectorAll("details")].find((x) => /승인자용 설명문/.test(x.querySelector("summary")?.textContent || ""));
        const note = document.querySelector('[data-testid="explain-updated"]');
        return { open: !!d?.open, text: d?.querySelector("pre")?.textContent || "", note: note ? note.textContent : null, live: !!note?.closest('[role="status"],[aria-live]') };
      });
      assert.ok(done, "시험 전제: AI 설명이 화면에 도착하지 않음");
      assert.ok(r.open, "AI 설명이 도착하자 읽던 '승인자용 설명문'이 접힘");
      assert.match(r.text, /■ 승인자:/, "새 설명이 보이지 않음");
      assert.ok(r.note && /AI 설명/.test(r.note), "설명이 바뀌었다는 안내가 없음(읽던 글이 말없이 바뀜)");
      assert.ok(r.live, "안내가 화면 낭독기에 알려지지 않음");
    } finally { await B.browser.close(); H.stop(api); }
  });

  T("AG04", "(회귀 방지) 다른 사람이 다른 건을 결재해도, 쓰던 결정 의견이 그대로", async () => {
    const base = "http://localhost:8143";
    const api = await H.startApi(8143, UI_ENV);
    const B = await H.newPage(); const p = B.page;
    try {
      await seed(base);
      await openApi(p, base);
      const pend = (await snap(base)).cases.filter((c) => c.state === "PENDING_APPROVAL" && c.type === "PLAN");
      const [mine, other] = [pend[0], pend.find((c) => c.id !== pend[0].id)];
      await p.locator('[data-testid="role-select"]').selectOption(mine.approval.approver);
      await p.locator(`[data-testid="case-${mine.target_id}"]`).click();
      await p.locator("#cmt").fill(COMMENT);
      const r = await call(base, "POST", `/api/cases/${other.id}/decision`, { actor: other.approval.approver, action: "approve", comment: "다른 사람" });
      assert.equal(r.status, 200);
      await p.waitForTimeout(3500);                                             // 자동 갱신(2.5초) 한 번 이상
      assert.equal(await p.locator("#cmt").inputValue(), COMMENT);
    } finally { await B.browser.close(); H.stop(api); }
  });
});

describe("API", () => {
  T("AG05", "설명만 바뀐 서류에 옛 판 번호로 결재하면 409와 '설명이 바뀜' 안내, 새 판 번호로는 결재됨", async () => {
    const base = "http://localhost:8144";
    const api = await H.startApi(8144, LLM_ENV);
    try {
      await seed(base);
      await mode("echo", 1.0);
      await call(base, "POST", "/api/conditions", { actor: "FINANCE", cash_assumption: "LEGACY45" });
      const t = writing(await snap(base)).find((c) => c.state === "PENDING_APPROVAL" && !c.decision?.regulation?.findings?.length);   // 30차(AP-07): 위반 카피가 남은 기안(PLAN-001)은 승인 불가라 제외
      assert.ok(t, "시험 전제");
      await settle(base);
      const r1 = await call(base, "POST", `/api/cases/${t.id}/decision`, { actor: t.approval.approver, action: "approve", comment: "옛 판", expected_version: t.version });
      const b1 = await r1.json();
      const now = (await snap(base)).cases.find((x) => x.id === t.id);
      const r2 = await call(base, "POST", `/api/cases/${t.id}/decision`, { actor: t.approval.approver, action: "approve", comment: "새 판", expected_version: now.version });
      assert.equal(r1.status, 409);
      assert.doesNotMatch(String(b1.detail), /다른 사용자가 먼저/, `안내: ${b1.detail}`);
      assert.match(String(b1.detail), /설명|바뀌/, `안내: ${b1.detail}`);
      assert.equal(r2.status, 200);
    } finally { H.stop(api); }
  });
});
