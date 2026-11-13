// 19차 E2E — 18차에 넣은 '결재 뒤 도착한 AI 설명'과 '접수 처리 중' 표시가 기존 기능과 만날 때.
//   ① 결재 뒤 AI 설명을 보관한 건이 조건 변경으로 재상신되면, 새 결재 서류에 옛 결재의 AI 설명이 따라붙지 않는가
//   ② 늦게 온 LLM 설명이 판사를 통과하지 못하면(환각), 그것을 'AI 설명'이라며 보관·표시하지 않는가
//   ③ 휴대폰(320·390px)에서 '접수 처리 중' 안내가 화면을 가로로 밀거나 잘리지 않는가
//   ④ 그 안내와 '결재 뒤 도착한 AI 설명'이 접근성 자동 점검(axe)을 통과하고, 화면 낭독기에 알려지는가
//   ⑤ MySQL 저장소: 결재 서류(결재 당시 설명)와 늦은 AI 설명·감사 기록이 서버 재시작 뒤에도 남고 검색되는가
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const H = require("./helpers.cjs");

const KEY = "e2e-key";
const LLM = "http://127.0.0.1:8906";
const LLM_ENV = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `${LLM}/v1`, LLM_TIMEOUT_S: "5" };
const UI_ENV = { ...LLM_ENV, SERVE_FRONTEND: "1", FRONTEND_DIST: path.join(H.ROOT, "frontend", "dist-docker"), ALLOWED_ORIGINS: "" };
const AXE = require.resolve("axe-core/axe.min.js", { paths: [path.join(H.ROOT, "frontend")] });
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
const cond = (base, a) => call(base, "POST", "/api/conditions", { actor: "FINANCE", cash_assumption: a });
/** 45일 가정에서 '작성 중'인 Masil 대표 결재 건을 골라 결재 — 90일 가정이면 그룹 CEO 결재 대상인 건(재상신 시험용) */
const approveWhileWriting = async (base, llmMode) => {
  const asIs = Object.fromEntries((await snap(base)).cases.filter((c) => c.decision).map((c) => [c.id, c.decision.approver]));
  await mode(llmMode, 1.5);
  await cond(base, "LEGACY45");
  const t = writing(await snap(base)).find((c) => c.state === "PENDING_APPROVAL" && c.approval?.approver === "MASIL_CEO" && asIs[c.id] === "GROUP_CEO");
  assert.ok(t, "시험 전제: 45일 가정에서 작성 중인 Masil 대표 결재 건이 없음");
  const r = await call(base, "POST", `/api/cases/${t.id}/decision`, { actor: "MASIL_CEO", action: "approve", comment: "작성 중 결재" });
  assert.equal(r.status, 200);
  return { t, seen: t.explanation };
};
const openApi = async (p, base, role) => {
  await p.goto(base); await p.waitForSelector(".top");
  await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector(".top");
  await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(800);
  if (role) await p.locator('[data-testid="role-select"]').selectOption(role);
};
let llm = null, db = null;
before(async () => { llm = spawn("python3", [path.join(__dirname, "mock_llm.py"), "8906"], { stdio: "ignore", detached: true }); await H.waitHttp(`${LLM}/__stats`); });
after(() => { H.writeReport("round19", { results }); try { process.kill(-llm.pid); } catch { /* gone */ } H.stop(db); });

describe("결재 뒤 AI 설명 × 재상신·판사", () => {
  T("AF01", "결재 뒤 AI 설명을 보관한 건이 조건 변경으로 재상신되면, 새 결재 서류에는 옛 결재의 AI 설명이 따라붙지 않고 새 LLM 설명이 붙음", async () => {
    const base = "http://localhost:8130";
    const api = await H.startApi(8130, LLM_ENV);
    try {
      await seed(base);
      const { t } = await approveWhileWriting(base, "echo");
      const s1 = await settle(base);
      assert.ok(s1.cases.find((c) => c.id === t.id).late_explanation, "시험 전제: 결재 뒤 AI 설명이 보관되지 않음");
      await mode("echo", 0);
      await cond(base, "AS_IS");                                  // 90일 → 권한 상향 → 기승인 무효·그룹 CEO 재상신
      const c = (await settle(base)).cases.find((x) => x.id === t.id);
      assert.equal(c.approval?.approver, "GROUP_CEO", `시험 전제: 재상신되지 않음(${c.state})`);
      assert.ok(!(c.approval || {}).decision, "재상신 건에 옛 결재가 남음");
      assert.equal(c.late_explanation ?? null, null, "재상신된 결재 서류에 옛 결재(Masil 대표) 뒤에 도착한 AI 설명이 그대로 붙어 있음");
      assert.match(String(c.llm), /^openai/, `새 결재 서류의 설명: ${c.llm}`);
      return { case: t.target_id };
    } finally { H.stop(api); }
  });

  T("AF02", "결재 뒤 도착한 LLM 설명이 판사를 통과하지 못하면(지어낸 수치), 'AI 설명'으로 보관·표시하지 않음", async () => {
    const base = "http://localhost:8131";
    const api = await H.startApi(8131, LLM_ENV);
    try {
      await seed(base);
      const { t, seen } = await approveWhileWriting(base, "hallucinate");
      const c = (await settle(base)).cases.find((x) => x.id === t.id);
      assert.equal(c.explanation, seen, "결재 서류의 설명이 바뀜");
      const late = c.late_explanation ? `${c.late_llm}: ${String(c.late_explanation).slice(0, 40)}` : null;
      assert.equal(late, null, "판사를 통과하지 못한 글을 '결재 뒤 도착한 AI 설명'으로 보관함");
      assert.doesNotMatch(String(c.llm), /설명은 결재 뒤 도착/, `안내: ${c.llm}`);
    } finally { H.stop(api); }
  });
});

describe("'접수 처리 중' 안내 — 휴대폰·접근성", () => {
  const during = async (port, dev, fn) => {   // 포트를 따로: 끈 서버는 쓰던 설명을 마치느라(최대 8초) 잠시 남아 있음
    const base = `http://localhost:${port}`;
    const api = await H.startApi(port, UI_ENV);
    const B = await H.newPage(dev); const p = B.page;
    try {
      await mode("echo", 0); await call(base, "POST", "/api/reset");
      await openApi(p, base, "MARKETING_TEAM");
      await mode("echo", 1.5);
      await p.getByRole("button", { name: "확대 기안 25건 접수" }).click();
      await p.locator('[data-testid="intaking"]').waitFor({ timeout: 3000 });
      return await fn(p);
    } finally { await B.browser.close(); H.stop(api); await mode("echo", 0); }
  };
  T("AF03", "휴대폰(320·390px)에서 '접수 처리 중' 안내가 화면을 가로로 밀지 않고, 잘리지 않으며, 탭을 가리지 않음", async () => {
    const bad = [];
    for (const [port, name, dev] of [[8132, "320px", { viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true }], [8135, "390px", H.devices["iPhone 12"]]]) {
      const r = await during(port, dev, (p) => p.evaluate(() => {
        const el = document.querySelector('[data-testid="intaking"]'); const b = el.getBoundingClientRect();
        const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => t.getBoundingClientRect());
        return { page: document.documentElement.scrollWidth - innerWidth, clipped: el.scrollWidth - el.clientWidth, right: Math.round(b.right - innerWidth),
          overlap: tabs.some((t) => Math.min(t.right, b.right) - Math.max(t.left, b.left) > 1 && Math.min(t.bottom, b.bottom) - Math.max(t.top, b.top) > 1) };
      }));
      if (r.page > 1) bad.push(`${name}: 가로 스크롤 ${r.page}px`);
      if (r.clipped > 1 || r.right > 1) bad.push(`${name}: 안내가 잘림(${r.clipped}px·오른쪽 ${r.right}px)`);
      if (r.overlap) bad.push(`${name}: 탭과 겹침`);
    }
    assert.deepEqual(bad, []);
  });

  T("AF04", "'접수 처리 중' 안내와 '결재 뒤 도착한 AI 설명'이 axe(WCAG 2.1 AA) 심각·치명 위반 0건이고, 안내는 화면 낭독기에 알려짐(상태 영역)", async () => {
    const scan = async (p, where) => {
      // 결재 도장은 0.28초 동안 투명도가 바뀌며 찍힌다 — 다 찍힌 뒤의 색을 잰다(도중에 재면 대비가 낮게 나옴)
      await p.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
      await p.addScriptTag({ path: AXE });
      return (await p.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] })).violations
        .filter((v) => ["serious", "critical"].includes(v.impact)).map((v) => `${v.id}(${v.nodes.length}: ${v.nodes.map((n) => n.target.join(" ") + " " + (n.any[0]?.message || "").slice(0, 90)).join(" | ")})`))).map((x) => `${where}:${x}`);
    };
    const v = [];
    const live = await during(8136, {}, async (p) => {
      v.push(...await scan(p, "접수 처리 중"));
      return p.locator('[data-testid="intaking"]').evaluate((el) => !!el.closest('[role="status"],[aria-live="polite"],[aria-live="assertive"]'));
    });
    // 결재 뒤 도착한 AI 설명이 보이는 결재 서류
    const base = "http://localhost:8133";
    const api = await H.startApi(8133, UI_ENV);
    const B = await H.newPage(); const p = B.page;
    try {
      await seed(base);
      const { t } = await approveWhileWriting(base, "echo");
      await settle(base);
      await openApi(p, base, "MASIL_CEO");
      await p.evaluate(() => document.querySelectorAll(".left details").forEach((d) => { d.open = true; }));   // 결재된 건은 '완료' 목록(접힘)에 있음
      await p.locator(`[data-testid="case-${t.target_id}"]`).click();
      await p.locator('[data-testid="late-explanation"]').waitFor();
      await p.locator('[data-testid="late-explanation"] summary').click();
      v.push(...await scan(p, "결재 뒤 AI 설명"));
    } finally { await B.browser.close(); H.stop(api); }
    assert.deepEqual(v, [], `axe 위반 ${v.join(", ")}`);
    assert.ok(live, "'접수 처리 중' 안내가 상태 영역(role=status·aria-live) 밖에 있어 화면 낭독기가 알리지 않음");
  });
});

describe("MySQL 저장소", () => {
  T("AF05", "MySQL: 결재 당시 설명·늦은 AI 설명·감사 기록이 서버 재시작 뒤에도 남고, 감사 검색 '결재 뒤'로 찾을 수 있음", async () => {
    db = await H.startMariaDB(3319);
    if (!db) { if (process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음"); return { skipped: true }; }
    const base = "http://localhost:8134";
    let api = await H.startApi(8134, { ...LLM_ENV, ...db.env });
    try {
      await seed(base);
      const { t, seen } = await approveWhileWriting(base, "echo");
      const before = (await settle(base)).cases.find((c) => c.id === t.id);
      H.stop(api); await new Promise((r) => setTimeout(r, 500));
      api = await H.startApi(8134, { ...LLM_ENV, ...db.env });
      const c = (await snap(base)).cases.find((x) => x.id === t.id);
      const found = await (await call(base, "GET", `/api/audit?q=${encodeURIComponent("결재 뒤")}&limit=50`)).json();
      const items = found.items || found.audit || [];
      assert.equal(c.explanation, seen, "재시작 뒤 결재 서류의 설명이 다름");
      assert.equal(c.late_explanation, before.late_explanation, "재시작 뒤 늦은 AI 설명이 사라짐");
      assert.ok(items.some((a) => a.case_id === t.id), `감사 검색 '결재 뒤'로 찾지 못함(${JSON.stringify(found).slice(0, 80)})`);
    } finally { H.stop(api); }
  });
});
