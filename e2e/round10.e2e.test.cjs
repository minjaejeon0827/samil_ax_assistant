// 10차 E2E — 9차에서 새로 넣은 기능(로그인 연장·감사 보관함·검색 열)이 기존 기능과 만날 때.
//   로그인 연장 × 로그아웃, 감사 검색 × 화면 표기(역할 한국어명·사용자·날짜)·세 저장 모드 일치, 검색 × 느린 응답,
//   보관함 × 전체 기록 열기 속도·두 탭, 기존 MySQL DB × 검색 열 갱신, 9차 이후 생긴 화면(대화상자·안내)의 접근성.
const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const H = require("./helpers.cjs");

const KEY = "e2e-key";
const AXE = require.resolve("axe-core/axe.min.js", { paths: [path.join(H.ROOT, "frontend")] });
const DIST_DOCKER = path.join(H.ROOT, "frontend", "dist-docker");
const USERS = "ceo.kang:pw-ceo:GROUP_CEO;fin.park:pw-fin:FINANCE;mkt.lee:pw-mkt:MARKETING_TEAM";
const AUTH = { AUTH_MODE: "jwt", USERS, JWT_SECRET: "e2e-secret-0123456789abcdef" };
const ROLE_KO = { MARKETING_TEAM: "마케팅팀", MASIL_CEO: "Masil 대표", GROUP_CEO: "그룹 CEO/이사회", FINANCE: "재무팀", SCM: "SCM", CONTRACT_OWNER: "계약 담당", AGENCY: "에이전시(모의)", SYSTEM: "시스템" };
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, { token, body } = {}) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const login = async (base, user, password) => (await (await call(base, "POST", "/api/auth/login", { body: { user, password } })).json()).token;
const waitJob = async (base, token, r) => { const b = await r.json(); for (let i = 0; i < 200; i++) { const j = await (await call(base, "GET", `/api/jobs/${b.job_id}`, { token })).json(); if (j.status === "done" || j.status === "failed") return j; await new Promise((x) => setTimeout(x, 25)); } throw new Error("job timeout"); };
let db = null;
after(() => { H.writeReport("round10", { results }); H.stop(db); });

/** 검색 규칙(사양): 화면에 보이는 것으로 찾는다(메모 본문은 감사 기록에 남지 않으므로 대상 아님) — 내용, 역할(코드·한국어명), 로그인 사용자, 건 ID, 주제, 날짜(2026-07-02·7월 2일).
 *  값이 없는 칸(건 ID 없음 등)은 빈칸이다('None'·'null'로 찾아지면 안 됨). 대소문자 무시, %·_는 글자 그대로. */
const fmt = (d) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
const visible = (a) => [a.detail, a.actor, ROLE_KO[a.actor] ?? "", a.user ?? "", a.case_id ?? "", a.topic, a.sim_date, fmt(a.sim_date)].join(" ").toLowerCase();
const expected = (items, q) => items.filter((a) => visible(a).includes(q.toLowerCase())).length;
// "c%o"·"o_p"는 글자 그대로는 어디에도 없지만, %·_를 와일드카드로 잘못 해석하면 "ceo"·"group"에 걸린다
const QUERIES = ["재무팀", "그룹 CEO", "7월 2일", "no", "null", "c%o", "o_p", "CLOCK.ADVANCED"];

/** 서버(로그인 모드)에서 같은 여정: 재무팀이 연체 채권 사건 접수, 그룹 CEO가 하루 진행, 마케팅팀이 메모 2건. */
async function serverJourney(base) {
  const fin = await login(base, "fin.park", "pw-fin"); const ceo = await login(base, "ceo.kang", "pw-ceo"); const mkt = await login(base, "mkt.lee", "pw-mkt");
  await waitJob(base, fin, await call(base, "POST", "/api/events", { token: fin, body: { kind: "FINANCE_OVERDUE_AR" } }));
  await call(base, "POST", "/api/clock", { token: ceo, body: { to: "2026-07-02" } });
  for (const text of ["할인율 100% 표기 확인 a_b", "1000건 표기 axb"]) await waitJob(base, mkt, await call(base, "POST", "/api/events", { token: mkt, body: { kind: "FREE_TEXT", text } }));
  const all = [];
  for (let off = 0; ; off += 500) { const p = await (await call(base, "GET", `/api/audit?offset=${off}&limit=500`, { token: ceo })).json(); all.push(...p.items); if (all.length >= p.total) break; }
  const got = {};
  for (const q of QUERIES) got[q] = (await (await call(base, "GET", `/api/audit?limit=1&q=${encodeURIComponent(q)}`, { token: ceo })).json()).matched;
  return { all, got };
}
const compare = (label, all, got) => {
  const want = Object.fromEntries(QUERIES.map((q) => [q, expected(all, q)]));
  const bad = QUERIES.filter((q) => got[q] !== want[q]).map((q) => `'${q}' ${got[q]}건(맞는 값 ${want[q]}건)`);
  assert.deepEqual(bad, [], `${label}: ${bad.join(", ")}`);
  const wild = { "c%o": all.filter((a) => /c.*o/.test(visible(a))).length, "o_p": all.filter((a) => /o.p/.test(visible(a))).length };
  assert.ok(want["재무팀"] >= 1 && want["7월 2일"] >= 1 && want["c%o"] === 0 && want["o_p"] === 0 && wild["c%o"] > 0 && wild["o_p"] > 0, `시험 데이터 확인 ${JSON.stringify({ want, wild })}`);
  return want;
};

describe("로그인 연장 × 로그아웃", () => {
  T("N01", "자동 연장을 거친 뒤 로그아웃하면 연장 전에 받은 토큰도 즉시 무효(쓰기·연장 모두 401)", async () => {
    const base = "http://localhost:8030";
    const api = await H.startApi(8030, AUTH);
    try {
      const t0 = await login(base, "ceo.kang", "pw-ceo");
      const t1 = (await (await call(base, "POST", "/api/auth/refresh", { token: t0 })).json()).token;
      const t2 = (await (await call(base, "POST", "/api/auth/refresh", { token: t1 })).json()).token;
      assert.equal((await call(base, "POST", "/api/auth/logout", { token: t2 })).status, 200);
      const codes = { t0: (await call(base, "GET", "/api/revision", { token: t0 })).status, t1: (await call(base, "GET", "/api/revision", { token: t1 })).status,
        t2: (await call(base, "GET", "/api/revision", { token: t2 })).status, refreshT0: (await call(base, "POST", "/api/auth/refresh", { token: t0 })).status };
      assert.deepEqual(codes, { t0: 401, t1: 401, t2: 401, refreshT0: 401 }, `로그아웃 뒤 응답 ${JSON.stringify(codes)}`);
    } finally { H.stop(api); }
  });
  T("N02", "다른 기기의 로그인은 그대로: 한 기기에서 로그아웃해도 같은 계정의 다른 로그인은 계속 쓸 수 있음", async () => {
    const base = "http://localhost:8031";
    const api = await H.startApi(8031, AUTH);
    try {
      const laptop = await login(base, "ceo.kang", "pw-ceo"); const phone = await login(base, "ceo.kang", "pw-ceo");
      const phone2 = (await (await call(base, "POST", "/api/auth/refresh", { token: phone })).json()).token;
      await call(base, "POST", "/api/auth/logout", { token: laptop });
      assert.equal((await call(base, "GET", "/api/revision", { token: phone2 })).status, 200, "다른 기기 로그인까지 끊김");
      assert.equal((await call(base, "POST", "/api/auth/refresh", { token: phone2 })).status, 200);
    } finally { H.stop(api); }
  });
});

describe("감사 검색 — 화면에 보이는 대로, 세 저장 모드에서 같게", () => {
  T("N03", "브라우저 단독·메모리 서버: 역할 한국어명·날짜 표기로 찾아지고, 없는 값('no'·'null')은 걸리지 않으며 %·_는 글자 그대로", async () => {
    // 1) 메모리 저장소 서버(로그인 모드 — 사용자 이름까지)
    const api = await H.startApi(8032, AUTH);
    let mem;
    try { const { all, got } = await serverJourney("http://localhost:8032"); mem = compare("메모리 서버", all, got); } finally { H.stop(api); }
    // 2) 브라우저 단독 — 같은 여정을 화면에서
    const pv = await H.startPreview(4185);
    const B = await H.newPage(); const p = B.page;
    const btn = (n) => p.getByRole("button", { name: n, exact: true }).first();
    try {
      await H.fresh(p, "http://localhost:4185");
      await p.locator('[data-testid="role-select"]').selectOption("FINANCE"); await btn("재무: 연체 채권 회수 불확실").click();
      await p.locator('[data-testid="role-select"]').selectOption("GROUP_CEO"); await btn("하루 진행").click();
      for (const text of ["할인율 100% 표기 확인 a_b", "1000건 표기 axb"]) { await p.locator("#memo").fill(text); await p.locator("#memo").press("Enter"); await p.waitForTimeout(150); }
      const all = await p.evaluate(() => JSON.parse(localStorage.getItem("aurora-desk-state")).audit);
      await p.locator('[data-testid="audit-all"]').click();
      const got = {};
      for (const q of QUERIES) {
        await p.locator('[data-testid="audit-search"]').fill(q);
        await p.waitForFunction((q) => document.querySelector('[data-testid="audit-search"]').value === q && /검색 결과 \d+건/.test(document.querySelector(".dialog .hint")?.textContent || ""), q);
        await p.waitForTimeout(350);
        got[q] = Number(/검색 결과 (\d+)건/.exec(await p.locator(".dialog .hint").innerText())[1]);
      }
      compare("브라우저 단독", all, got);
      assert.deepEqual(p.errors, []);
    } finally { await B.browser.close(); H.stop(pv); }
    return { memory: mem };
  });

  T("N04", "MySQL 호환 DB(v1.9 검색 열이 있는 기존 DB, 감사 2만 건): 서버가 기동하며 검색 열을 새 규칙으로 바꾸고(5초 안), 같은 검색 결과", async () => {
    db = await H.startMariaDB(3311);
    if (!db) { if (process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음"); return { skipped: true }; }
    const r = spawnSync("python3", [path.join(__dirname, "seed_audit.py"), "20000"], { encoding: "utf-8", env: { ...process.env, LLM_PROVIDER: "offline", ...db.env } });
    assert.equal(r.status, 0, r.stderr.slice(-200));
    // v1.9 스키마의 검색 열(역할 코드만, 빈 값이 'null')로 되돌려 기존 운영 DB를 흉내
    const V19 = "LOWER(CONCAT_WS(' ', JSON_UNQUOTE(JSON_EXTRACT(doc, '$.detail')), JSON_UNQUOTE(JSON_EXTRACT(doc, '$.actor')), JSON_UNQUOTE(JSON_EXTRACT(doc, '$.case_id')), JSON_UNQUOTE(JSON_EXTRACT(doc, '$.topic')), JSON_UNQUOTE(JSON_EXTRACT(doc, '$.sim_date'))))";
    try { db.sql("ALTER TABLE aurora_desk.audit DROP COLUMN search_text"); } catch { /* 없으면 통과 */ }
    db.sql(`ALTER TABLE aurora_desk.audit ADD COLUMN search_text TEXT GENERATED ALWAYS AS (${V19}) STORED`);
    const t0 = Date.now();
    const api = await H.startApi(8033, { ...AUTH, ...db.env });
    const boot = Date.now() - t0;
    H.recordPerf("MySQL 감사 2만 건 + 검색 열 갱신 기동", boot);
    try {
      const { all, got } = await serverJourney("http://localhost:8033");
      compare("MySQL", all, got);
      assert.ok(boot < 5000, `기동 ${boot}ms`);
      return { boot_ms: boot };
    } finally { H.stop(api); }
  });

  T("N05", "검색어를 빠르게 바꾸는 사이 늦게 도착한 이전 검색 응답이 결과를 덮어쓰지 않음(서버 모드, 응답 1.2초 지연)", async () => {
    const base = "http://localhost:8034";
    const api = await H.startApi(8034, { SERVE_FRONTEND: "1", FRONTEND_DIST: DIST_DOCKER, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      await waitJob(base, null, await call(base, "POST", "/api/events", { body: { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" } }));
      await p.goto(base); await p.waitForSelector(".top");
      await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector(".top");
      await p.locator(".role select").nth(1).selectOption("api");
      await p.locator(".audit ol li").first().waitFor();
      // 첫 검색(빈 검색어)만 느리게 — 느린 망·바쁜 서버에서 응답 순서가 뒤바뀌는 상황
      await p.route(/\/api\/audit\?offset=0&limit=50&q=$/, async (route) => { await new Promise((r) => setTimeout(r, 1200)); await route.continue(); });
      await p.locator('[data-testid="audit-all"]').click();
      await p.waitForTimeout(400);                                   // 빈 검색어 요청이 나간 뒤
      await p.locator('[data-testid="audit-search"]').fill("PLAN-016");
      await p.waitForTimeout(2200);                                  // 두 응답이 모두 도착한 뒤
      const hint = await p.locator(".dialog .hint").innerText();
      const items = await p.locator('[data-testid="audit-results"] li').allInnerTexts();
      assert.match(hint, /검색 결과/, `검색어 'PLAN-016'인데 안내: ${hint}`);
      assert.ok(items.length > 0 && items.every((t) => /PLAN-016/.test(t)), `결과에 다른 기록이 섞임: ${items.find((t) => !/PLAN-016/.test(t))?.slice(0, 60)}`);
    } finally { await B.browser.close(); H.stop(api); }
  });
});

describe("감사 보관함(브라우저 단독) — 많이 쌓인 뒤 열기와 두 탭", () => {
  const seed = (p, N, from) => p.evaluate(([N, from]) => {
    const s = JSON.parse(localStorage.getItem("aurora-desk-state")); const k = s.seq.audit;
    for (let i = 0; i < N; i++) s.audit.push({ id: `AU-${String(k + i + 1).padStart(4, "0")}`, sim_date: "2026-07-01", at: "2026-07-01T09:00:00", topic: "seed.history", actor: "SYSTEM", case_id: null, detail: `과거 운영 기록 #${from + i} (합성 데이터)` });
    s.seq.audit = k + N; localStorage.setItem("aurora-desk-state", JSON.stringify(s));
  }, [N, from]);
  const settled = async (p) => { for (let i = 0; i < 200 && (await p.evaluate(() => localStorage.getItem("aurora-desk-state").length)) > 1_500_000; i++) await p.waitForTimeout(100); };

  T("N06", "감사 4.4만 건(보관함 4.2만): '전체 기록 보기'를 누르고 첫 목록까지 0.4초, 검색 결과까지 0.6초 안", async () => {
    const pv = await H.startPreview(4186);
    const B = await H.newPage(); const p = B.page;
    try {
      await H.fresh(p, "http://localhost:4186");
      await p.getByRole("button", { name: "확대 기안 25건 접수" }).click();
      await seed(p, 24000, 1); await p.reload(); await p.waitForSelector(".top"); await settled(p);
      await seed(p, 20000, 24001); await p.reload(); await p.waitForSelector(".top"); await settled(p);
      const t0 = Date.now();
      await p.locator('[data-testid="audit-all"]').click();
      await p.locator('[data-testid="audit-results"] li').first().waitFor();
      const openMs = Date.now() - t0;
      const t1 = Date.now();
      await p.locator('[data-testid="audit-search"]').fill("과거 운영 기록 #43999 ");
      await p.waitForFunction(() => /검색 결과 1건/.test(document.querySelector(".dialog .hint")?.textContent || ""), null, { timeout: 5000 });
      const searchMs = Date.now() - t1;
      const hint = await p.locator(".dialog .hint").innerText();
      H.recordPerf("보관함 4.2만: 전체 기록 열기", openMs, { search_ms: searchMs });
      assert.match(hint, /전체 4\d,\d{3}건|전체 4\d{4}건/, hint);
      assert.ok(openMs < 400, `전체 기록 열기 ${openMs}ms`);
      assert.ok(searchMs < 600, `검색 ${searchMs}ms(입력 멈춤 대기 0.25초 포함)`);
      return { open_ms: openMs, search_ms: searchMs };
    } finally { await B.browser.close(); H.stop(pv); }
  });

  T("N07", "두 탭이 동시에 오래된 기록을 보관함으로 옮겨도 건수가 맞고 중복·누락이 없음", async () => {
    const pv = await H.startPreview(4187);
    const B = await H.newPage(); const a = B.page; const b = await B.ctx.newPage();
    try {
      await H.fresh(a, "http://localhost:4187");
      await a.getByRole("button", { name: "확대 기안 25건 접수" }).click();
      const before = await a.evaluate(() => JSON.parse(localStorage.getItem("aurora-desk-state")).audit.length);
      await seed(a, 8000, 1);
      await Promise.all([a.reload(), b.goto("http://localhost:4187")]);
      await Promise.all([a.waitForSelector(".top"), b.waitForSelector(".top")]);
      await settled(a); await a.waitForTimeout(800);
      await a.getByRole("button", { name: "하루 진행" }).click(); await a.waitForTimeout(600);
      const total = 8000 + before + 1;   // 하루 진행 = 시계 진행 기록 1건(그 밖의 기록이 생기면 아래 비교가 알려 줌)
      const shown = await Promise.all([a, b].map(async (p) => Number((await p.locator(".audit h2 .count").innerText()).replace(/[^0-9]/g, ""))));
      await b.locator('[data-testid="audit-all"]').click();
      const hint = await b.locator(".dialog .hint").innerText({ timeout: 5000 }).catch(() => "");
      await b.waitForFunction(() => /전체 [\d,]+건/.test(document.querySelector(".dialog .hint")?.textContent || ""));
      const full = Number(/전체 ([\d,]+)건/.exec(await b.locator(".dialog .hint").innerText())[1].replace(/,/g, ""));
      assert.ok(shown[0] === shown[1] && shown[0] >= total, `탭별 건수 ${shown} (최소 ${total})`);
      assert.equal(full, shown[0], `전체 기록 보기 ${full}건 ≠ 화면 건수 ${shown[0]}(${hint})`);
    } finally { await B.browser.close(); H.stop(pv); }
  });
});

describe("9차 이후 생긴 화면의 접근성", () => {
  const scan = async (p) => { await p.addScriptTag({ path: AXE }); return p.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] })).violations.filter((v) => ["serious", "critical"].includes(v.impact)).map((v) => `${v.id}(${v.nodes.length}) ${v.nodes[0].target}`)); };
  T("N08", "감사 전체 기록 대화상자·로그인 창(오류 상태)·처리 안내·서버 연결 안내에서 심각·치명 위반 0건", async () => {
    const base = "http://localhost:8035";
    const api = await H.startApi(8035, { ...AUTH, SERVE_FRONTEND: "1", FRONTEND_DIST: DIST_DOCKER, ALLOWED_ORIGINS: "" });
    const B = await H.newPage({ reducedMotion: "reduce" }); const p = B.page;
    const found = {};
    try {
      await p.goto(base); await p.waitForSelector(".top");
      await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
      await p.getByRole("button", { name: "하루 진행" }).click(); await p.waitForTimeout(300);
      found["처리 안내(브라우저)"] = await scan(p);
      await p.locator('[data-testid="audit-all"]').click(); await p.locator('[data-testid="audit-results"] li').first().waitFor();
      found["감사 전체 기록"] = await scan(p);
      await p.keyboard.press("Escape");
      await p.locator(".role select").nth(1).selectOption("api");
      await p.locator('[data-testid="login-user"]').fill("ceo.kang"); await p.locator('[data-testid="login-password"]').fill("wrong");
      await p.locator('[data-testid="login-submit"]').click(); await p.waitForTimeout(400);
      found["로그인 창(오류)"] = await scan(p);
      H.stop(api); await p.waitForTimeout(3500);
      found["서버 연결 안내"] = await scan(p);
      const bad = Object.entries(found).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.join(", ")}`);
      assert.deepEqual(bad, []);
    } finally { await B.browser.close(); H.stop(api); }
  });
});
