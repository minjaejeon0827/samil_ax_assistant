// 7차 E2E — '누가' 결정했는가. 로그인 모드(AUTH_MODE=jwt)에서 역할 사칭·무단 조회·무차별 대입·토큰 만료,
//           화면 로그인 흐름, 감사 로그의 실제 사용자 기록, MCP 계정 권한, 대화상자 키보드 접근성.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const H = require("./helpers.cjs");

const API = "http://localhost:8000";
const SHORT = "http://localhost:8002";          // 토큰 수명 2초 서버(만료 시험)
const WEB_API = "http://localhost:4174";
const LOCAL = "http://localhost:4173";
const KEY = "e2e-key";
const USERS = "ceo.kang:pw-ceo-1:GROUP_CEO;masil.han:pw-masil-1:MASIL_CEO;mkt.lee:pw-mkt-1:MARKETING_TEAM;fin.park:pw-fin-1:FINANCE;contract.choi:pw-con-1:CONTRACT_OWNER";
const AUTH = { AUTH_MODE: "jwt", USERS, JWT_SECRET: "e2e-secret-0123456789abcdef" };
let api, short, web, webApi, B;
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0 }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, { token, body } = {}) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const login = async (base, user, password) => { const r = await call(base, "POST", "/api/auth/login", { body: { user, password } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const waitJob = async (base, token, r) => { const { job_id } = await r.json(); for (let i = 0; i < 300; i++) { const j = await (await call(base, "GET", `/api/jobs/${job_id}`, { token })).json(); if (j.status !== "queued" && j.status !== "running") return j; await new Promise((x) => setTimeout(x, 30)); } throw new Error("job timeout"); };

before(async () => {
  api = await H.startApi(8000, AUTH);
  short = await H.startApi(8002, { ...AUTH, TOKEN_TTL_S: "2" });
  web = await H.startPreview(4173, "dist");
  webApi = await H.startPreview(4174, "dist-api");
  B = await H.newPage();
});
after(async () => {
  H.writeReport(process.env.E2E_REPORT || "round7", { suite: "round7", results });
  await B.browser.close(); H.stop(api); H.stop(short); H.stop(web); H.stop(webApi);
});

describe("로그인 모드 — API", () => {
  T("J01", "역할 사칭 차단: 마케팅팀 계정으로 그룹 CEO 결재를 보내면 403, 그룹 CEO 계정은 승인되고 결정자가 기록됨", async () => {
    const ceo = await login(API, "ceo.kang", "pw-ceo-1");
    assert.equal(ceo.status, 200, `로그인 ${ceo.status} ${JSON.stringify(ceo.body).slice(0, 80)}`);
    const mkt = await login(API, "mkt.lee", "pw-mkt-1");
    await call(API, "POST", "/api/reset", { token: ceo.body.token });
    await waitJob(API, ceo.body.token, await call(API, "POST", "/api/events", { token: ceo.body.token, body: { kind: "CONTRACT_RENEWAL_NOTICE" } }));
    const c = (await (await call(API, "GET", "/api/snapshot", { token: ceo.body.token })).json()).cases[0];
    const spoof = await call(API, "POST", `/api/cases/${c.id}/decision`, { token: mkt.body.token, body: { actor: "GROUP_CEO", action: "approve" } });
    const keyOnly = await call(API, "POST", `/api/cases/${c.id}/decision`, { body: { actor: "GROUP_CEO", action: "approve" } });
    const ok = await call(API, "POST", `/api/cases/${c.id}/decision`, { token: ceo.body.token, body: { actor: "GROUP_CEO", action: "approve" } });
    const s = await (await call(API, "GET", "/api/snapshot", { token: ceo.body.token })).json();
    assert.equal(spoof.status, 403, `사칭 요청 ${spoof.status}`);
    assert.equal(keyOnly.status, 401, `API 키만으로 결재 ${keyOnly.status}`);
    assert.equal(ok.status, 200);
    assert.equal(s.cases[0].approval.decided_by, "GROUP_CEO");
    assert.ok(s.audit.some((a) => a.user === "ceo.kang" && /승인/.test(a.detail)), "감사 로그에 실제 사용자(ceo.kang)가 없음");
    assert.ok(s.audit.some((a) => a.user === "mkt.lee" && /거부|사칭|역할/.test(a.detail)), "사칭 시도가 감사 로그에 남지 않음");
  });
  T("J02", "로그인 없이 API 키만으로는 처리 건·감사 기록을 볼 수 없음(401), 상태 확인만 공개", async () => {
    const snap = await call(API, "GET", "/api/snapshot");
    const audit = await call(API, "GET", "/api/audit");
    const health = await fetch(`${API}/api/health`);
    assert.equal(snap.status, 401); assert.equal(audit.status, 401); assert.equal(health.status, 200);
    assert.equal((await health.json()).auth, "jwt");
  });
  T("J03", "비밀번호를 5번 틀리면 잠시 잠기고(429) 한국어로 안내, 존재 여부는 드러내지 않음", async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await login(API, "fin.park", "wrong")).status);
    const locked = await login(API, "fin.park", "pw-fin-1");
    const nobody = await login(API, "no.such.user", "x");
    const wrong = await login(API, "masil.han", "x");
    assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.equal(codes[5], 429);
    assert.equal(locked.status, 429, "잠긴 동안 올바른 비밀번호로도 들어가짐");
    assert.match(String(locked.body.detail), /분|잠시|시도/);
    assert.equal(nobody.body.detail, wrong.body.detail, "없는 계정과 틀린 비밀번호의 안내가 달라 계정 존재가 드러남");
  });
  T("J04", "토큰이 만료되면 401과 '다시 로그인' 안내(조용히 실패하지 않음)", async () => {
    const t = await login(SHORT, "ceo.kang", "pw-ceo-1");
    assert.equal(t.status, 200);
    assert.equal((await call(SHORT, "GET", "/api/snapshot", { token: t.body.token })).status, 200);
    await new Promise((r) => setTimeout(r, 3200));
    const r = await call(SHORT, "GET", "/api/snapshot", { token: t.body.token });
    const b = await r.json();
    assert.equal(r.status, 401); assert.match(String(b.detail), /다시 로그인/);
  });
  T("J05", "위조·변조한 토큰(역할을 GROUP_CEO로 바꾼 것)은 거부", async () => {
    const t = (await login(API, "mkt.lee", "pw-mkt-1")).body.token || "";
    const [h, p, s] = t.split(".");
    const payload = JSON.parse(Buffer.from((p || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString() || "{}");
    payload.role = "GROUP_CEO";
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
    const r = await call(API, "GET", "/api/snapshot", { token: forged });
    assert.ok(t, "로그인 토큰 없음");
    assert.equal(r.status, 401);
  });
});

describe("로그인 모드 — 화면·MCP", () => {
  T("J06", "화면: 서버 모드로 바꾸면 로그인 창 → 로그인한 역할로 고정 → 결재 → 감사 로그에 사용자 이름", async () => {
    const ceo = (await login(API, "ceo.kang", "pw-ceo-1")).body.token;
    await call(API, "POST", "/api/reset", { token: ceo });
    await waitJob(API, ceo, await call(API, "POST", "/api/events", { token: ceo, body: { kind: "CONTRACT_RENEWAL_NOTICE" } }));
    const C = await H.newPage(); const p = C.page;
    await p.goto(WEB_API); await p.waitForSelector(".top");
    await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
    await p.locator(".role select").nth(1).selectOption("api");
    await p.locator('[data-testid="login-user"]').fill("mkt.lee");
    await p.locator('[data-testid="login-password"]').fill("pw-mkt-1");
    await p.locator('[data-testid="login-submit"]').click();
    await p.locator('[data-testid="whoami"]').waitFor();
    const who = await p.locator('[data-testid="whoami"]').innerText();
    const locked = await p.locator('[data-testid="role-select"]').isDisabled();
    await p.locator('[data-testid="logout"]').click();
    await p.locator('[data-testid="login-user"]').fill("ceo.kang");
    await p.locator('[data-testid="login-password"]').fill("pw-ceo-1");
    await p.locator('[data-testid="login-submit"]').click();
    await p.locator('[data-testid="case-CT-INF001-2025"]').click();
    await p.locator('[data-testid="approve"]').click();
    await p.locator(".stamp.ok").waitFor();
    const audit = await p.locator(".audit").innerText();
    const errs = p.errors.filter((e) => !/status of 40[13]/.test(e));
    await C.browser.close();
    assert.match(who, /mkt\.lee/); assert.match(who, /마케팅팀/);
    assert.ok(locked, "로그인했는데 역할을 마음대로 바꿀 수 있음");
    assert.match(audit, /ceo\.kang/);
    assert.deepEqual(errs, []);
  });
  T("J07", "MCP 계정: 마케팅팀 계정으로 연 MCP는 그룹 CEO 결재를 할 수 없고, 그룹 CEO 계정 MCP는 승인 가능", async () => {
    const ceo = (await login(API, "ceo.kang", "pw-ceo-1")).body.token;
    await call(API, "POST", "/api/reset", { token: ceo });
    await waitJob(API, ceo, await call(API, "POST", "/api/events", { token: ceo, body: { kind: "CONTRACT_RENEWAL_NOTICE" } }));
    const run = (user, pw) => { const r = spawnSync("python3", [path.join(__dirname, "mcp_e2e7.py"), API, KEY, user, pw], { encoding: "utf-8", timeout: 60000 });
      try { return JSON.parse((r.stdout || "").trim().split("\n").pop()); } catch { return { error: (r.stderr || "").slice(-300) }; } };
    const m = run("mkt.lee", "pw-mkt-1");
    const c = run("ceo.kang", "pw-ceo-1");
    assert.equal(m.error ?? null, null, m.error);
    assert.match(m.decide || "", /거부/, `마케팅팀 MCP 결과: ${m.decide}`);
    assert.match(c.decide || "", /APPROVED/, `CEO MCP 결과: ${c.decide}`);
  });
});

describe("대화상자 키보드 접근성", () => {
  T("J08", "감사 로그 대화상자: Tab을 계속 눌러도 대화상자 밖으로 나가지 않고, Esc로 닫으면 연 버튼으로 돌아옴", async () => {
    const p = B.page;
    await H.fresh(p, LOCAL);
    await p.getByRole("button", { name: "전속계약 갱신 통보 접수", exact: true }).click();
    await p.locator('[data-testid="audit-all"]').focus(); await p.keyboard.press("Enter");
    await p.locator('[data-testid="audit-search"]').waitFor();
    const outside = [];
    for (let i = 0; i < 12; i++) { await p.keyboard.press("Tab"); if (!(await p.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))) outside.push(i); }
    await p.keyboard.press("Escape");
    const back = await p.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    assert.deepEqual(outside, [], `Tab ${outside.length}번이 대화상자 밖으로 나감`);
    assert.equal(back, "audit-all");
  });
});
