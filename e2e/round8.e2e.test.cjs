// 8차 E2E — 로그인 모드의 '권한 경계'와 운영 조합.
//   쓰기 기능 전부 × 역할 6개 권한 매트릭스, 로그아웃 후 토큰, 로그인 실패 감사, 잠금 악용(다른 사람 계정 잠그기),
//   사용자 200명 서버 기동, MCP 토큰 만료 후 재로그인, 역할 변경 후 기존 토큰, 로그인+MySQL+단일 컨테이너 조합.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const H = require("./helpers.cjs");

const API = "http://localhost:8000";
const KEY = "e2e-key";
const ROLES = ["MARKETING_TEAM", "MASIL_CEO", "GROUP_CEO", "FINANCE", "SCM", "CONTRACT_OWNER"];
const USER_OF = { MARKETING_TEAM: "mkt.lee", MASIL_CEO: "masil.han", GROUP_CEO: "ceo.kang", FINANCE: "fin.park", SCM: "scm.yoon", CONTRACT_OWNER: "contract.choi" };
const USERS = ROLES.map((r) => `${USER_OF[r]}:pw-${USER_OF[r]}:${r}`).join(";");
const AUTH = { AUTH_MODE: "jwt", USERS, JWT_SECRET: "e2e-secret-0123456789abcdef" };
let api, B;
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0 }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, { token, body } = {}) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const login = async (base, user, password) => { const r = await call(base, "POST", "/api/auth/login", { body: { user, password } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const tokens = {};
const tok = async (role, base = API) => (tokens[`${base}|${role}`] ??= (await login(base, USER_OF[role], `pw-${USER_OF[role]}`)).body.token);
const snap = async (base = API) => (await call(base, "GET", "/api/snapshot", { token: await tok("GROUP_CEO", base) })).json();
const waitJob = async (base, token, r) => { const b = await r.json(); if (!b.job_id) return { status: "refused", http: r.status, body: b }; for (let i = 0; i < 300; i++) { const j = await (await call(base, "GET", `/api/jobs/${b.job_id}`, { token })).json(); if (j.status !== "queued" && j.status !== "running") return j; await new Promise((x) => setTimeout(x, 25)); } throw new Error("job timeout"); };
const reset = async () => call(API, "POST", "/api/reset", { token: await tok("GROUP_CEO") });
const intake = async (role, kind) => { const t = await tok(role); const r = await call(API, "POST", "/api/events", { token: t, body: { kind } }); return r.status >= 400 ? { http: r.status } : { http: r.status, job: await waitJob(API, t, r) }; };
/** 127.0.0.2 같은 다른 주소에서 로그인(다른 사람이 같은 계정에 시도하는 상황). */
const loginFrom = (localAddress, user, password) => new Promise((resolve, reject) => {
  const data = JSON.stringify({ user, password });
  const req = http.request({ host: "127.0.0.1", port: 8000, path: "/api/auth/login", method: "POST", localAddress,
    headers: { "Content-Type": "application/json", "X-API-Key": KEY, "Content-Length": Buffer.byteLength(data) } }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
  req.on("error", reject); req.end(data);
});

before(async () => { api = await H.startApi(8000, AUTH); B = await H.newPage(); });
after(async () => { H.writeReport(process.env.E2E_REPORT || "round8", { suite: "round8", results }); await B.browser.close(); H.stop(api); });

describe("권한 매트릭스 — 쓰기 기능 전부 × 역할 6개(로그인 모드)", () => {
  T("P01", "각 쓰기 기능은 정해진 역할만 성공하고, 나머지는 서버가 거부(화면에서 버튼을 숨기는 것만으로는 부족)", async () => {
    const allowed = {
      "접수:CONTRACT_RENEWAL_NOTICE": ["CONTRACT_OWNER", "GROUP_CEO"], "접수:BUDGET_PLAN_BATCH": ["MARKETING_TEAM", "MASIL_CEO"],
      "접수:AGENCY_COUNTER_OFFER": ["CONTRACT_OWNER"], "접수:MARKETING_CLAIM": ["MARKETING_TEAM"], "접수:FINANCE_OVERDUE_AR": ["FINANCE"], "접수:FREE_TEXT": ROLES,
      "조건 변경": ["FINANCE"], "카피 수정": ["MARKETING_TEAM"], "에이전시 회신 입력": ["CONTRACT_OWNER"], "시계 진행": ["GROUP_CEO"], "처음부터": ["GROUP_CEO"],
    };
    const got = {};
    const mark = (k, role, ok) => { (got[k] ||= []); if (ok) got[k].push(role); };
    // 접수
    for (const kind of ["CONTRACT_RENEWAL_NOTICE", "BUDGET_PLAN_BATCH", "AGENCY_COUNTER_OFFER", "MARKETING_CLAIM", "FINANCE_OVERDUE_AR", "FREE_TEXT"]) {
      for (const r of ROLES) {
        await reset();
        if (kind === "AGENCY_COUNTER_OFFER") await intake("GROUP_CEO", "CONTRACT_RENEWAL_NOTICE");
        const x = await intake(r, kind);
        mark(`접수:${kind}`, r, x.http < 400 && x.job?.status === "done" && !/이미/.test(x.job?.message || ""));
      }
    }
    // 조건 변경
    for (const r of ROLES) { await reset(); const x = await call(API, "POST", "/api/conditions", { token: await tok(r), body: { actor: r, cash_assumption: "LEGACY45" } }); mark("조건 변경", r, x.ok); }
    // 카피 수정(PLAN-016)
    for (const r of ROLES) {
      await reset(); await intake("MARKETING_TEAM", "BUDGET_PLAN_BATCH");
      const c = (await snap()).cases.find((x) => x.target_id === "PLAN-016");
      const x = await call(API, "POST", `/api/cases/${c.id}/fix`, { token: await tok(r), body: { actor: r } }); mark("카피 수정", r, x.ok);
    }
    // 에이전시 회신(지급 일정) — 역제안이 확인 필요 상태일 때
    for (const r of ROLES) {
      await reset(); await intake("GROUP_CEO", "CONTRACT_RENEWAL_NOTICE"); await intake("CONTRACT_OWNER", "AGENCY_COUNTER_OFFER");
      const x = await call(API, "POST", "/api/replies", { token: await tok(r), body: { reply_key: "agency_payment_schedule" } }); mark("에이전시 회신 입력", r, x.ok);
    }
    // 시계 진행
    for (const r of ROLES) { await reset(); const x = await call(API, "POST", "/api/clock", { token: await tok(r), body: { to: "2026-07-02" } }); mark("시계 진행", r, x.ok); }
    // 처음부터
    for (const r of ROLES) { const x = await call(API, "POST", "/api/reset", { token: await tok(r) }); mark("처음부터", r, x.ok); }
    const bad = Object.entries(allowed).filter(([k, v]) => JSON.stringify([...(got[k] || [])].sort()) !== JSON.stringify([...v].sort()))
      .map(([k, v]) => `${k}: 허용 [${v.join(",")}] / 실제 성공 [${(got[k] || []).join(",")}]`);
    H.recordPerf("권한 매트릭스 위반 수", bad.length, { list: bad });
    assert.deepEqual(bad, []);
  });
  T("P02", "부서 작업은 그 부서만 완료할 수 있음(다른 부서가 '통보 발송'을 대신 누르면 거부)", async () => {
    await reset(); await intake("GROUP_CEO", "CONTRACT_RENEWAL_NOTICE");
    let s = await snap();
    await call(API, "POST", `/api/cases/${s.cases[0].id}/decision`, { token: await tok("GROUP_CEO"), body: { actor: "GROUP_CEO", action: "approve" } });
    s = await snap();
    const bad = [];
    for (const t of s.tasks) {
      for (const r of ROLES.filter((x) => x !== t.dept)) {
        const x = await call(API, "POST", `/api/tasks/${t.id}/done`, { token: await tok(r), body: { actor: r } });
        if (x.ok) { bad.push(`${t.title}(${t.dept}) ← ${r}`); break; }
      }
    }
    const outbox = (await snap()).outbox.length;
    assert.deepEqual(bad, [], `다른 부서가 완료함: ${bad.join(" / ")}`);
    assert.equal(outbox, 0, "권한 없는 사람의 완료로 실제 발송(모의)이 일어남");
  });
});

describe("로그인 수명과 감사", () => {
  T("P03", "로그아웃하면 그 토큰은 서버에서도 즉시 무효(가져간 토큰으로 15분간 쓰지 못함)", async () => {
    const t = (await login(API, "mkt.lee", "pw-mkt.lee")).body.token;
    const before = (await call(API, "GET", "/api/revision", { token: t })).status;
    const out = await call(API, "POST", "/api/auth/logout", { token: t });
    const after = (await call(API, "GET", "/api/revision", { token: t })).status;
    assert.equal(before, 200); assert.equal(out.status, 200, `로그아웃 API ${out.status}`); assert.equal(after, 401, `로그아웃 뒤 토큰 사용 ${after}`);
  });
  T("P04", "로그인 실패와 잠금이 감사 로그에 남음(누가 어느 계정에 시도했는지)", async () => {
    for (let i = 0; i < 6; i++) await login(API, "masil.han", "wrong-pass");
    const r = await (await call(API, "GET", "/api/audit?q=" + encodeURIComponent("masil.han") + "&limit=50", { token: await tok("GROUP_CEO") })).json();
    const d = (r.items || []).map((a) => a.detail).join(" | ");
    assert.match(d, /로그인 실패/, `감사 로그: ${d.slice(0, 120)}`);
    assert.match(d, /잠금/);
    assert.doesNotMatch(d, /wrong-pass/, "비밀번호가 감사 로그에 남음");
  });
  T("P05", "다른 사람이 일부러 틀려도 정당한 사용자의 로그인은 막히지 않음(잠금 악용 방지)", async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await loginFrom("127.0.0.2", "ceo.kang", "attacker-guess")).status);
    const mine = await login(API, "ceo.kang", "pw-ceo.kang");          // 127.0.0.1(정당한 사용자)
    assert.equal(codes[5], 429, `공격자 쪽 잠금 ${codes.join(",")}`);
    assert.equal(mine.status, 200, `정당한 사용자가 잠김(${mine.status})`);
  });
  T("P06", "MCP: 토큰이 만료돼도 다시 로그인해 이어서 동작(토큰 2초 서버)", async () => {
    const short = await H.startApi(8002, { ...AUTH, TOKEN_TTL_S: "2" });
    try {
      const r = spawnSync("python3", [path.join(__dirname, "mcp_e2e8.py"), "http://localhost:8002", KEY, "ceo.kang", "pw-ceo.kang"], { encoding: "utf-8", timeout: 60000 });
      const j = JSON.parse((r.stdout || "{}").trim().split("\n").pop() || "{}");
      assert.match(j.first || "", /승인 대기|없습니다|CS-/, j.first);
      assert.doesNotMatch(j.second || "", /로그인|401/, `만료 뒤: ${j.second}`);
    } finally { H.stop(short); }
  });
  T("P07", "관리자가 계정의 역할을 바꾸면 그 사람이 들고 있던 이전 역할 토큰은 거부", async () => {
    const s1 = await H.startApi(8003, AUTH);
    const t = (await login("http://localhost:8003", "mkt.lee", "pw-mkt.lee")).body.token;
    H.stop(s1); await new Promise((r) => setTimeout(r, 800));
    const s2 = await H.startApi(8003, { ...AUTH, USERS: USERS.replace("mkt.lee:pw-mkt.lee:MARKETING_TEAM", "mkt.lee:pw-mkt.lee:FINANCE") });
    try { assert.equal((await call("http://localhost:8003", "GET", "/api/revision", { token: t })).status, 401); } finally { H.stop(s2); }
  });
  T("P08", "사용자 200명을 등록해도 서버가 3초 안에 뜨고 로그인은 1초 안에 됨", async () => {
    const many = Array.from({ length: 200 }, (_, i) => `user${i}:pw-${i}:${ROLES[i % 6]}`).join(";");
    const t0 = Date.now();
    const p = H.startProc("python3", ["-m", "uvicorn", "app.main:app", "--port", "8004", "--log-level", "warning"], { cwd: path.join(H.ROOT, "backend"), env: { ...process.env, ...AUTH, USERS: many, API_KEYS: KEY } });
    try {
      let up = false;
      while (Date.now() - t0 < 60000) { try { if ((await fetch("http://localhost:8004/api/health")).ok) { up = true; break; } } catch { /* 기동 중 */ } await new Promise((r) => setTimeout(r, 100)); }
      const boot = Date.now() - t0;
      const t1 = Date.now(); const l = await login("http://localhost:8004", "user77", "pw-77"); const lms = Date.now() - t1;
      H.recordPerf("사용자 200명 서버 기동", boot, { login_ms: lms });
      assert.ok(up); assert.equal(l.status, 200);
      assert.ok(boot < 3000, `기동 ${boot}ms`); assert.ok(lms < 1000, `로그인 ${lms}ms`);
    } finally { H.stop(p); }
  });
});

describe("운영 조합 — 로그인 모드 + MySQL 호환 DB + 단일 컨테이너", () => {
  T("P09", "화면 로그인 → 결재 → 서버 재시작 후에도 결과·감사(사용자)가 DB에 남고, 화면에서 다시 로그인해 이어서 봄", async (t) => {
    const db = await H.startMariaDB(3308);
    if (!db) { if (process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음"); results.push({ id: "P09", skipped: true }); return; }
    const env = { ...AUTH, ...db.env, SERVE_FRONTEND: "1", FRONTEND_DIST: path.join(H.ROOT, "frontend", "dist-docker"), API_KEYS: KEY, ALLOWED_ORIGINS: "" };
    let one = await H.startApi(8010, env);
    const C = await H.newPage(); const p = C.page;
    try {
      const ceo = (await login("http://localhost:8010", "ceo.kang", "pw-ceo.kang")).body.token;
      await call("http://localhost:8010", "POST", "/api/reset", { token: ceo });
      await waitJob("http://localhost:8010", ceo, await call("http://localhost:8010", "POST", "/api/events", { token: ceo, body: { kind: "CONTRACT_RENEWAL_NOTICE" } }));
      await p.goto("http://localhost:8010"); await p.waitForSelector(".top");
      await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
      await p.locator(".role select").nth(1).selectOption("api");
      await p.locator('[data-testid="login-user"]').fill("ceo.kang"); await p.locator('[data-testid="login-password"]').fill("pw-ceo.kang");
      await p.locator('[data-testid="login-submit"]').click();
      await p.locator('[data-testid="case-CT-INF001-2025"]').click();
      await p.locator('[data-testid="approve"]').click(); await p.locator(".stamp.ok").waitFor();
      H.stop(one); await new Promise((r) => setTimeout(r, 800));
      one = await H.startApi(8010, env);    // 재시작(비밀값이 같으면 기존 로그인 유지)
      await p.reload(); await p.waitForSelector(".top");
      await p.locator('[data-testid="case-CT-INF001-2025"]').waitFor({ timeout: 8000 });
      const audit = await p.locator(".audit").innerText();
      const s = await (await call("http://localhost:8010", "GET", "/api/snapshot", { token: ceo })).json();
      assert.equal(s.cases[0].state, "APPROVED");
      assert.match(audit, /ceo\.kang/);
      assert.deepEqual(p.errors.filter((e) => !/status of 40[13]/.test(e)), []);
    } finally { await C.browser.close(); H.stop(one); H.stop(db); }
  });
});
