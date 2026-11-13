// 2차 E2E — 1차에서 다루지 않은 사용 환경을 끝까지 실행한다.
//   여러 탭 동시 사용, 저장 형식 변경·손상·차단, 키보드만 사용, 모바일 전체 여정,
//   다중 사용자(서버 모드), 서버 장애·복구, 중복 접수, MCP 오류 경로, 긴 사용 성능.
// 준비: frontend/dist(브라우저 단독)와 frontend/dist-api(API 모드) 빌드 — run_all.sh가 만든다.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { devices } = require("./helpers.cjs");
const H = require("./helpers.cjs");

const LOCAL = "http://localhost:4173";
const WEB_API = "http://localhost:4174";
const API = "http://localhost:8000";
const HDR = { "X-API-Key": "e2e-key", "Content-Type": "application/json" };
let web, webApi, api, B;
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0 }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const btn = (p, name) => p.getByRole("button", { name, exact: true });
const toast = (p) => p.locator(".toast").innerText();
const caseCount = (p) => p.locator(".cases .case-item").count();
const post = (u, body = {}) => fetch(`${API}${u}`, { method: "POST", headers: HDR, body: JSON.stringify(body) });
const snap = async () => (await fetch(`${API}/api/snapshot`, { headers: HDR })).json();
const waitJob = async (r) => { const { job_id } = await r.json(); for (let i = 0; i < 100; i++) { const j = await (await fetch(`${API}/api/jobs/${job_id}`, { headers: HDR })).json(); if (j.status === "done" || j.status === "failed") return j; await new Promise((x) => setTimeout(x, 50)); } throw new Error("job timeout"); };
const apiMode = async (p) => { await p.goto(WEB_API); await p.waitForSelector(".top"); await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(300); };

before(async () => {
  web = await H.startPreview(4173, "dist");
  webApi = await H.startPreview(4174, "dist-api");
  api = await H.startApi(8000);
  B = await H.newPage();
});
after(async () => {
  H.writeReport(process.env.E2E_REPORT || "round2", { suite: "round2", results });
  await B.browser.close(); H.stop(web); H.stop(webApi); H.stop(api);
});

describe("브라우저 단독 — 저장소와 탭", () => {
  T("R01", "같은 브라우저의 두 탭: 한 탭의 처리 결과가 다른 탭의 작업으로 지워지지 않음", async () => {
    const a = B.page;
    await H.fresh(a, LOCAL);
    const b = await B.ctx.newPage();
    await b.goto(LOCAL); await b.waitForSelector(".top");          // 두 탭 모두 빈 상태로 열림
    await btn(a, "전속계약 갱신 통보 접수").click();                  // 탭 A: 계약 접수
    await a.locator(".cases .case-item", { hasText: "갱신 통보" }).waitFor();
    await btn(b, "확대 기안 25건 접수").click();                      // 탭 B: 기안 접수
    await b.waitForTimeout(200);
    await a.reload(); await a.waitForSelector(".top");
    const titles = await a.locator(".cases").innerText();
    await b.close();
    assert.match(titles, /갱신 통보/, "탭 B가 저장하면서 탭 A의 계약 접수가 사라짐");
  });
  T("R02", "다른 탭의 변경이 새로고침 없이 이 탭에 반영됨", async () => {
    const a = B.page;
    await H.fresh(a, LOCAL);
    const b = await B.ctx.newPage();
    await b.goto(LOCAL); await b.waitForSelector(".top");
    await btn(a, "전속계약 갱신 통보 접수").click();
    await b.locator(".cases .case-item", { hasText: "갱신 통보" }).waitFor({ timeout: 2000 }).finally(() => b.close());
  });
  T("R03", "이전 버전 저장 형식이 남아 있으면 이유를 알리고, 이전 기록을 따로 보관", async () => {
    const p = B.page;
    await p.goto(LOCAL);
    await p.evaluate(() => { localStorage.clear(); localStorage.setItem("aurora-desk-state", JSON.stringify({ schema: 3, cases: { "CS-0001": {} } })); });
    await p.reload(); await p.waitForSelector(".top");
    const t = await toast(p);
    const backup = await p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("aurora-desk-state.v")).length);
    assert.match(t, /저장 형식/, `안내 없음: "${t}"`);
    assert.equal(backup, 1, "이전 기록 보관 안 됨");
  });
  T("R04", "손상된 저장 데이터·저장소 차단에서도 화면이 뜨고 처리 가능", async () => {
    const p = B.page;
    await p.goto(LOCAL);
    await p.evaluate(() => localStorage.setItem("aurora-desk-state", "{깨진"));
    await p.reload(); await p.waitForSelector(".top");
    const C = await H.newPage();
    await C.page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException("blocked", "SecurityError"); }; Storage.prototype.getItem = () => { throw new DOMException("blocked", "SecurityError"); }; });
    await C.page.goto(LOCAL); await C.page.waitForSelector(".top");
    await btn(C.page, "전속계약 갱신 통보 접수").click();
    const n = await caseCount(C.page);
    const errs = C.page.errors.filter((e) => !/blocked/.test(e));
    await C.browser.close();
    assert.equal(n, 1); assert.deepEqual(errs, []);
  });
});

describe("브라우저 단독 — 접근성·모바일·긴 사용", () => {
  T("R05", "키보드만으로 접수 → 결재 서류 열기 → 역할 변경 → 승인", async () => {
    const p = B.page;
    await H.fresh(p, LOCAL);
    await btn(p, "전속계약 갱신 통보 접수").focus(); await p.keyboard.press("Enter");
    await p.locator('[data-testid="case-CT-INF001-2025"]').focus(); await p.keyboard.press("Enter");
    await p.waitForSelector(".sheet");
    await p.locator('[data-testid="role-select"]').focus();
    await p.keyboard.press("Home");                                   // 첫 항목 = 그룹 CEO
    await p.locator('[data-testid="approve"]').focus(); await p.keyboard.press("Enter");
    await p.locator(".stamp.ok").waitFor();
    const focusVisible = await p.evaluate(() => { const el = document.activeElement; return el && getComputedStyle(el).outlineStyle !== "none"; });
    assert.ok(focusVisible, "포커스 표시가 보이지 않음");
  });
  T("R06", "모바일(iPhone 13) 전체 여정: 모든 탭에서 가로 넘침 없음, 결재까지 완료", async () => {
    const M = await H.newPage({ ...devices["iPhone 13"] });
    const p = M.page;
    await H.fresh(p, LOCAL);
    const over = async () => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const o = {};
    await btn(p, "전속계약 갱신 통보 접수").tap();
    await btn(p, "확대 기안 25건 접수").tap();
    await p.getByRole("tab", { name: "확대 기안 25건" }).tap(); o.plans = await over();
    await p.getByRole("tab", { name: "판단 기준과 근거" }).tap(); o.facts = await over();
    await p.locator('[data-testid="case-CT-INF001-2025"]').tap(); await p.waitForSelector(".sheet"); o.sheet = await over();
    // 근거마다 출처(근거 자료)가 모바일에서도 보여야 함 — 데이터 계보 요구사항
    const row = p.locator(".evidence tbody tr").first();
    const src = (await row.locator("td.src").textContent()).trim();
    const srcVisible = (await row.innerText()).includes(src);
    const headCols = await p.locator(".evidence thead th").evaluateAll((ths) => ths.filter((t) => t.getBoundingClientRect().width > 0).length);
    await p.locator('[data-testid="role-select"]').selectOption("GROUP_CEO");
    await p.locator('[data-testid="approve"]').scrollIntoViewIfNeeded();
    await p.locator('[data-testid="approve"]').tap();
    await p.locator(".stamp.ok").waitFor();
    // 승인 후 사용자가 결과(도장)를 볼 수 있어야 함: 화면 안에 있는지
    const inView = await p.locator(".stamp.ok").evaluate((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; });
    await M.browser.close();
    assert.deepEqual(o, { plans: 0, facts: 0, sheet: 0 }, `가로 넘침(px): ${JSON.stringify(o)}`);
    assert.ok(inView, "승인 결과가 화면 밖");
    assert.ok(srcVisible, `모바일에서 근거 출처(${src})가 보이지 않음`);
    assert.equal(headCols, 2, "표 머리 칸 수가 본문과 다름");
  });
  T("R07", "'처음부터' 확인창에서 취소하면 기록이 그대로", async () => {
    const C = await H.newPage();
    const p = C.page;
    p.removeAllListeners("dialog"); p.on("dialog", (d) => d.dismiss());
    await H.fresh(p, LOCAL);
    await btn(p, "전속계약 갱신 통보 접수").click();
    await btn(p, "처음부터").click();
    const n = await caseCount(p);
    await C.browser.close();
    assert.equal(n, 1);
  });
  T("R08", "아주 긴 사용(기안 25건 + 시계 75일 + 조건 변경 반복) 후에도 클릭 반응 100ms 이내, 저장 크기 안정", async () => {
    const p = B.page;
    await H.fresh(p, LOCAL);
    await btn(p, "전속계약 갱신 통보 접수").click(); await btn(p, "확대 기안 25건 접수").click();
    await btn(p, "재무: 연체 채권 회수 불확실").click();
    for (let i = 0; i < 75; i++) await btn(p, "하루 진행").click();
    for (let i = 0; i < 10; i++) await btn(p, "마케팅팀 성과 보고(주장)").click();
    const ms = await H.clickTimed(p, btn(p, "하루 진행"), "아주 긴 사용 후 하루 진행");
    const size = await p.evaluate(() => (localStorage.getItem("aurora-desk-state") || "").length);
    H.recordPerf("아주 긴 사용 후 저장 크기(문자)", size);
    assert.ok(ms < 100, `${ms}ms`);
    assert.ok(size < 1_500_000, `저장 크기 ${size}`);
  });
});

describe("서버 모드 — 다중 사용자·장애·중복", () => {
  T("R09", "API·MCP로 같은 사건을 두 번 넣어도 중복 건이 생기지 않음", async () => {
    await post("/api/reset");
    await waitJob(await post("/api/events", { kind: "BUDGET_PLAN_BATCH" }));
    const j = await waitJob(await post("/api/events", { kind: "BUDGET_PLAN_BATCH" }));
    await waitJob(await post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }));
    await waitJob(await post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }));
    const s = await snap();
    assert.equal(s.cases.filter((c) => c.type === "PLAN").length, 25, `기안 ${s.cases.filter((c) => c.type === "PLAN").length}건`);
    assert.equal(s.cases.filter((c) => c.kind === "CONTRACT_RENEWAL_NOTICE").length, 1);
    assert.match(j.message, /이미/);
  });
  T("R10", "화면에서 접수 버튼을 빠르게 두 번 눌러도 한 번만 접수", async () => {
    await post("/api/reset");
    const p = B.page;
    await apiMode(p);
    await btn(p, "확대 기안 25건 접수").dblclick();
    await p.waitForTimeout(1200);
    const s = await snap();
    assert.equal(s.cases.length, 25, `${s.cases.length}건`);
  });
  T("R11", "두 결재자가 동시에 보고 있을 때: 늦은 쪽은 충돌 안내와 함께 최신 상태로 갱신", async () => {
    await post("/api/reset");
    await waitJob(await post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }));
    const A = await H.newPage(); const Bp = await H.newPage();
    for (const x of [A.page, Bp.page]) { await apiMode(x); await x.locator('[data-testid="case-CT-INF001-2025"]').click(); await x.locator('[data-testid="role-select"]').selectOption("GROUP_CEO"); }
    await A.page.locator('[data-testid="approve"]').click(); await A.page.locator(".stamp.ok").waitFor();
    await Bp.page.locator('[data-testid="reject"]').click();
    await Bp.page.waitForFunction(() => /먼저|다른 사용자/.test(document.querySelector(".toast")?.textContent || ""));
    const stale = await Bp.page.locator(".stamp.ok").count();
    await A.browser.close(); await Bp.browser.close();
    assert.equal(stale, 1, "충돌 후에도 늦은 사용자 화면이 이전 상태(승인 대기)에 머묾");
  });
  T("R12", "다른 사용자의 결정이 내 화면에 자동으로 반영(서버 모드)", async () => {
    await post("/api/reset");
    const p = B.page;
    await apiMode(p);
    const t0 = Date.now();
    await waitJob(await post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }));   // 다른 사용자(또는 MCP)가 접수
    await p.locator(".cases .case-item", { hasText: "갱신 통보" }).waitFor({ timeout: 6000 });
    H.recordPerf("다른 사용자 변경이 내 화면에 보이기까지", Date.now() - t0);
  });
  T("R18", "자동 갱신의 대기 중 네트워크 사용량이 작음(변경 없을 때 10초에 10KB 미만)", async () => {
    const p = B.page;
    let bytes = 0, n = 0;
    const on = async (r) => { if (r.url().startsWith(API)) { n++; try { bytes += (await r.body()).length; } catch { /* ignore */ } } };
    p.on("response", on);
    await p.waitForTimeout(10000);
    p.off("response", on);
    H.recordPerf("서버 모드 대기 10초 네트워크", bytes, { requests: n });
    assert.ok(bytes < 10240, `${bytes}B / ${n}회`);
  });
  T("R13", "서버가 꺼졌을 때 한국어로 원인과 할 일을 안내하고, 서버 데이터인 척 브라우저 데이터를 보여주지 않음", async () => {
    const p = B.page;
    await apiMode(p);
    H.stop(api); await new Promise((r) => setTimeout(r, 800));
    await btn(p, "마케팅팀 성과 보고(주장)").click();
    await p.waitForFunction(() => document.querySelector(".toast")?.textContent?.startsWith("⚠"));
    const t = await toast(p);
    await p.reload(); await p.waitForSelector(".top"); await p.waitForTimeout(500);
    const banner = await p.locator('[data-testid="api-offline"]').count();
    api = await H.startApi(8000);
    assert.doesNotMatch(t, /Failed to fetch|NetworkError|TypeError/, `안내 문구: ${t}`);
    assert.match(t, /서버/);
    assert.equal(banner, 1, "서버 연결 실패 상태가 화면에 표시되지 않음");
  });
  T("R14", "서버가 다시 켜지면 화면이 저절로 복구", async () => {
    const p = B.page;
    await post("/api/reset");
    await waitJob(await post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }));
    await p.locator(".cases .case-item", { hasText: "갱신 통보" }).waitFor({ timeout: 8000 });
    assert.equal(await p.locator('[data-testid="api-offline"]').count(), 0);
  });
  T("R17", "서버가 입력을 거부(422)하면 무엇이 문제인지 읽을 수 있게 안내", async () => {
    const p = B.page;
    const prev = await toast(p);
    await p.locator("#memo").fill("긴 메모 ".repeat(500));            // 서버 한도 2,000자 초과
    await btn(p, "접수").click();
    await p.waitForFunction((pv) => { const t = document.querySelector(".toast")?.textContent || ""; return t.length > 0 && t !== pv; }, prev);
    const t = await toast(p);
    assert.doesNotMatch(t, /object Object|undefined/, `안내 문구: ${t}`);
  });
  T("R15", "서버 모드 '처음부터' → 서버 기록 초기화", async () => {
    const p = B.page;
    await btn(p, "처음부터").click();
    await p.waitForTimeout(400);
    assert.equal((await snap()).cases.length, 0);
    assert.equal(await caseCount(p), 0);
  });
});

describe("MCP — 오류 경로", () => {
  T("R16", "MCP: 없는 건 조회·서버 중단 시 사람이 읽을 수 있는 안내", async () => {
    const out = JSON.parse(execFileSync("python3", [path.join(__dirname, "mcp_e2e2.py"), API, "e2e-key"], { encoding: "utf-8", timeout: 60000 }).trim().split("\n").pop());
    assert.match(out.missing, /찾을 수 없|없습니다/, out.missing);
    assert.match(out.dup, /이미/, out.dup);
    assert.match(out.down, /서버에 연결할 수 없/, out.down);
  });
});
