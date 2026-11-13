// 풀스택 E2E — React(API 모드) ↔ FastAPI ↔ LangGraph를 함께 띄워 화면 조작 결과가 서버 상태에 반영되는지 확인.
// 준비: VITE_ENABLE_API=1 VITE_API_URL=http://localhost:8000 VITE_API_KEY=e2e-key npx vite build --outDir dist-api
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const H = require("./helpers.cjs");

const URL = "http://localhost:4174";
let api, web, B, page;
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0 }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const serverSnap = async () => (await fetch("http://localhost:8000/api/snapshot", { headers: { "X-API-Key": "e2e-key" } })).json();
const btn = (name) => page.getByRole("button", { name, exact: true });

before(async () => {
  api = await H.startApi(8000);
  await fetch("http://localhost:8000/api/reset", { method: "POST", headers: { "X-API-Key": "e2e-key" } });
  web = await H.startPreview(4174, "dist-api");
  B = await H.newPage();
  page = B.page;
});
after(async () => { H.writeReport(process.env.E2E_REPORT || "fullstack", { suite: "fullstack", results, pageErrors: page.errors }); await B.browser.close(); H.stop(web); H.stop(api); });

describe("React ↔ FastAPI", () => {
  T("S01", "실행 위치를 FastAPI 서버로 전환 → 서버 스냅샷 표시", async () => {
    await H.fresh(page, URL);
    await page.locator(".role select").nth(1).selectOption("api");
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".cases .case-item").count(), 0);
  });
  T("S02", "화면에서 접수 → 서버 비동기 작업 → 화면 갱신(응답 1.5초 이내)", async () => {
    const t0 = Date.now();
    await btn("전속계약 갱신 통보 접수").click();
    await page.locator(".cases .case-item", { hasText: "갱신 통보" }).waitFor();
    const ms = Date.now() - t0;
    H.recordPerf("API 모드 접수→화면 반영", ms);
    assert.ok(ms < 1500, `${ms}ms`);
    assert.equal((await serverSnap()).cases.length, 1);
  });
  T("S03", "화면 승인(그룹 CEO) → 서버 상태 APPROVED·작업 4건", async () => {
    await page.locator(".cases .case-item", { hasText: "갱신 통보" }).click();
    await page.locator(".role select").first().selectOption("GROUP_CEO");
    await btn("승인").click();
    await page.locator(".stamp.ok").waitFor();
    const s = await serverSnap();
    assert.equal(s.cases[0].state, "APPROVED");
    assert.equal(s.tasks.length, 4);
  });
  T("S04", "권한 없는 승인 시도 → 서버 403 메시지를 화면에 표시", async () => {
    await btn("확대 기안 25건 접수").click();
    await page.getByRole("tab", { name: "확대 기안 25건" }).click();
    await page.locator(".plans tbody tr", { hasText: "PLAN-015" }).click();
    await page.locator(".role select").first().selectOption("MASIL_CEO");
    await page.getByRole("button", { name: "현재 역할로 승인 시도" }).click();
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("권한"));
  });
  T("S05", "새로고침 후에도 서버 모드·상태 유지", async () => {
    await page.reload();
    await page.locator(".cases .case-item").first().waitFor();
    assert.equal(await page.locator(".role select").nth(1).inputValue(), "api");
  });
  T("S07", "재무팀이 화면에서 현금 전망 가정을 바꾸면 서버가 전 건을 다시 판단", async () => {
    await page.locator('[data-testid="role-select"]').selectOption("FINANCE");
    await page.locator('[data-testid="cash-assumption"]').selectOption("LEGACY45");
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("조건 변경"));
    const s = await serverSnap();
    assert.equal(s.ctx.cash_assumption, "LEGACY45");
    assert.equal(s.cases.find((c) => c.target_id === "PLAN-015").approval.approver, "MASIL_CEO");
  });
  T("S06", "콘솔 오류 0건(S04에서 의도적으로 받은 403 응답 기록만 제외)", async () => {
    const unexpected = page.errors.filter((e) => !/status of 40[39]/.test(e));
    assert.deepEqual(unexpected, []);
  });
});
