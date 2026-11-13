// 15차 E2E — 서버 여러 대(같은 MySQL 공유). 1~14차는 서버 한 대만 띄웠다.
//   AXHub에서 복제본을 늘리거나 무중단 배포 중 옛·새 서버가 함께 뜨면, 사용자 요청은 아무 서버로나 간다.
//   A에서 바뀐 것을 B가 보여 주는가, A에 맡긴 작업을 B에서 조회할 수 있는가, 로그인 잠금·로그아웃이 서버를 넘어 지켜지는가,
//   두 서버로 같은 건을 동시에 결재하면 한 번만 되는가.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const H = require("./helpers.cjs");

const KEY = "e2e-key";
const A = "http://localhost:8090", B = "http://localhost:8091";
const USERS = "ceo.kang:pw-ceo:GROUP_CEO;masil.han:pw-masil:MASIL_CEO;fin.park:pw-fin:FINANCE;contract.choi:pw-co:CONTRACT_OWNER;mkt.lee:pw-mkt:MARKETING_TEAM";
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, { token, body } = {}) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const login = async (base, user, password) => (await (await call(base, "POST", "/api/auth/login", { body: { user, password } })).json()).token;
const snap = async (base, token) => (await call(base, "GET", "/api/snapshot", { token })).json();
const until = async (fn, ms) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return v; };
let db = null, apiA = null, apiB = null, ENV = null;
before(async () => {
  db = await H.startMariaDB(3315);
  if (!db) { if (process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음"); return; }
  ENV = { ...db.env, AUTH_MODE: "jwt", USERS, JWT_SECRET: "e2e-secret-0123456789abcdef", SERVE_FRONTEND: "1", FRONTEND_DIST: path.join(H.ROOT, "frontend", "dist-docker"), ALLOWED_ORIGINS: "" };
  apiA = await H.startApi(8090, ENV); apiB = await H.startApi(8091, ENV);
});
after(() => { H.writeReport("round15", { results }); H.stop(apiA); H.stop(apiB); H.stop(db); });
const fresh = async () => { const ceo = await login(A, "ceo.kang", "pw-ceo"); await call(A, "POST", "/api/reset", { token: ceo }); return ceo; };
const waitJob = async (base, token, r) => { const b = await r.json(); for (let i = 0; i < 400; i++) { const j = await (await call(base, "GET", `/api/jobs/${b.job_id}`, { token })).json(); if (j.status === "done" || j.status === "failed") return j; await new Promise((x) => setTimeout(x, 25)); } throw new Error("job timeout"); };

describe("서버 2대(같은 MySQL)", () => {
  T("AB01", "A에서 접수·결재·조건 변경을 하면 B의 화면 데이터(스냅샷)와 변경 번호에 3초 안에 반영됨", async () => {
    if (!db) return { skipped: true };
    const ceo = await fresh();
    const tB = await login(B, "ceo.kang", "pw-ceo");
    await snap(B, tB);                                        // B가 빈 상태를 한 번 캐시해 둔다(실제로 누가 보고 있던 상황)
    const rev0 = (await (await call(B, "GET", "/api/revision", { token: tB })).json()).rev;
    const co = await login(A, "contract.choi", "pw-co");
    await waitJob(A, co, await call(A, "POST", "/api/events", { token: co, body: { kind: "CONTRACT_RENEWAL_NOTICE" } }));
    const t0 = Date.now();
    const seen = await until(async () => (await snap(B, tB)).cases.length === 1, 3000);
    const rev1 = (await (await call(B, "GET", "/api/revision", { token: tB })).json()).rev;
    const c = (await snap(A, ceo)).cases[0];
    await call(A, "POST", `/api/cases/${c.id}/decision`, { token: ceo, body: { actor: "GROUP_CEO", action: "approve", comment: "A에서 승인" } });
    const approved = await until(async () => (await snap(B, tB)).cases[0]?.state !== "PENDING_APPROVAL", 3000);
    assert.ok(seen, "A의 접수가 B 스냅샷에 3초 넘게 안 보임(B는 자기 캐시를 계속 보냄)");
    assert.notEqual(rev1, rev0, "B의 변경 번호가 그대로 → B에 붙은 화면은 자동 갱신하지 않음");
    assert.ok(approved, "A의 결재가 B에 반영되지 않음");
    return { seen_ms: Date.now() - t0 };
  });

  T("AB02", "B에 붙은 화면(로그인 모드)에서, A로 들어온 접수가 6초 안에 목록에 나타남", async () => {
    if (!db) return { skipped: true };
    await fresh();
    const Bp = await H.newPage(); const p = Bp.page;
    try {
      await p.goto(B); await p.waitForSelector(".top");
      await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
      await p.locator(".role select").nth(1).selectOption("api");
      await p.locator('[data-testid="login-user"]').fill("ceo.kang"); await p.locator('[data-testid="login-password"]').fill("pw-ceo");
      await p.locator('[data-testid="login-submit"]').click(); await p.locator('[data-testid="whoami"]').waitFor();
      await p.waitForTimeout(1500);
      const co = await login(A, "contract.choi", "pw-co");
      await waitJob(A, co, await call(A, "POST", "/api/events", { token: co, body: { kind: "CONTRACT_RENEWAL_NOTICE" } }));
      const t0 = Date.now();
      const ok = await p.locator('[data-testid="case-CT-INF001-2025"]').waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
      assert.ok(ok, "B 화면에 A의 접수가 6초 넘게 나타나지 않음");
      return { shown_ms: Date.now() - t0 };
    } finally { await Bp.browser.close(); }
  });

  T("AB03", "A에 맡긴 접수 작업의 진행 상태를 B에 물어도 404가 아니라 진행 상태·결과가 나옴", async () => {
    if (!db) return { skipped: true };
    await fresh();
    const mkt = await login(A, "mkt.lee", "pw-mkt"); const mB = await login(B, "mkt.lee", "pw-mkt");
    const job = await (await call(A, "POST", "/api/events", { token: mkt, body: { kind: "BUDGET_PLAN_BATCH" } })).json();
    const first = await call(B, "GET", `/api/jobs/${job.job_id}`, { token: mB });
    const done = await until(async () => { const r = await call(B, "GET", `/api/jobs/${job.job_id}`, { token: mB }); return r.status === 200 && (await r.json()).status === "done"; }, 8000);
    assert.equal(first.status, 200, `B에 바로 물으면 ${first.status}(${(await first.text()).slice(0, 60)})`);
    assert.ok(done, "B에서 끝난 결과를 받지 못함");
  });

  T("AB04", "A와 B를 번갈아 비밀번호를 틀려도 5번 넘으면 잠김(서버마다 5번씩 = 10번 시도 불가)", async () => {
    if (!db) return { skipped: true };
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await call(i % 2 ? B : A, "POST", "/api/auth/login", { body: { user: "fin.park", password: "guess" } })).status);
    const right = (await call(A, "POST", "/api/auth/login", { body: { user: "fin.park", password: "pw-fin" } })).status;
    assert.equal(codes[5], 429, `번갈아 6번 틀림 → ${codes}`);
    assert.equal(right, 429);
  });

  T("AB05", "A에서 로그아웃하면 B에서도 그 토큰이 6초 안에 무효", async () => {
    if (!db) return { skipped: true };
    const t = await login(A, "ceo.kang", "pw-ceo");
    assert.equal((await call(B, "GET", "/api/revision", { token: t })).status, 200);
    await call(A, "POST", "/api/auth/logout", { token: t });
    const off = await until(async () => (await call(B, "GET", "/api/revision", { token: t })).status === 401, 6000);
    assert.ok(off, "B에서는 로그아웃한 토큰이 계속 통함");
  });

  T("AB06", "같은 결재 건을 A와 B로 동시에 승인·거절하면 하나만 성공하고 다른 쪽은 409, 기록도 한 번", async () => {
    if (!db) return { skipped: true };
    await fresh();
    const co = await login(A, "contract.choi", "pw-co");
    await waitJob(A, co, await call(A, "POST", "/api/events", { token: co, body: { kind: "CONTRACT_RENEWAL_NOTICE" } }));
    const ceoA = await login(A, "ceo.kang", "pw-ceo"), ceoB = await login(B, "ceo.kang", "pw-ceo");
    const c = (await snap(A, ceoA)).cases[0];
    const [r1, r2] = await Promise.all([
      call(A, "POST", `/api/cases/${c.id}/decision`, { token: ceoA, body: { actor: "GROUP_CEO", action: "approve", comment: "A", version: c.version } }),
      call(B, "POST", `/api/cases/${c.id}/decision`, { token: ceoB, body: { actor: "GROUP_CEO", action: "reject", comment: "B", version: c.version } })]);
    const codes = [r1.status, r2.status].sort();
    const s = await snap(A, ceoA);
    const decided = s.audit.filter((a) => a.case_id === c.id && /^case\.(approved|rejected)$/.test(a.topic));
    assert.deepEqual(codes, [200, 409], `동시 결재 응답 ${codes}`);
    assert.equal(decided.length, 1, `결재 기록 ${decided.length}건(${decided.map((a) => a.topic)})`);
    assert.ok(["APPROVED", "REJECTED", "EXECUTED", "DONE"].some((x) => s.cases[0].state.includes(x)) || s.cases[0].state !== "PENDING_APPROVAL", s.cases[0].state);
    return { states: s.cases[0].state, decided: decided.length };
  });
});
