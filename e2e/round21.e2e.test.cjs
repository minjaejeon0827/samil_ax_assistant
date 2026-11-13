// 21차 E2E — PRD §15 '다음 단계'를 실제로 만들고(v1.21) 처음부터 끝까지 시험한다.
//   §15-1 사내 SSO(OIDC)·리프레시 토큰·비밀번호 변경 — 모의 IdP(e2e/mock_oidc.py, RS256·JWKS·PKCE)
//   §15-2 전자결재·메신저 실제 연동(채널 어댑터 교체) — 모의 전자결재(e2e/mock_eapproval.py, HMAC 서명·재시도·콜백)
//   §15-3 계약서 업로드 → 조항 추출(RAG) → 위약금·지급 조건 자동 확인
//   §15-4 같은 엔진을 다른 자동 갱신 계약(물류·대행사)에 적용 — 합성 견본 계약서(data/samples/contracts, 가정 A-22)
// v1.20에는 이 기능이 없었다(새 엔드포인트 전부 404 — e2e/reports/round21-before.txt).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const H = require("./helpers.cjs");

const KEY = "e2e-key";
const IDP = "http://127.0.0.1:8951", ESIGN = "http://127.0.0.1:8961";
const CH_SECRET = "e2e-channel-secret-0123456789";
const USERS = "fin.park:pw-fin:FINANCE;contract.choi:pw-co:CONTRACT_OWNER;ceo.kang:pw-ceo:GROUP_CEO";
const JWT = { AUTH_MODE: "jwt", USERS, JWT_SECRET: "e2e-secret-0123456789abcdef" };
const DIST = path.join(H.ROOT, "frontend", "dist-docker");
const SAMPLES = path.join(H.ROOT, "data", "samples", "contracts");
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, { token, body } = {}) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const login = async (base, user, password) => (await call(base, "POST", "/api/auth/login", { body: { user, password } })).json();
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aurora21-")), "desk.json");
const waitJob = async (base, r, token, ms = 30000) => { const b = await r.json(); if (!b.job_id) return b; const end = Date.now() + ms; while (Date.now() < end) { const j = await (await call(base, "GET", `/api/jobs/${b.job_id}`, { token })).json(); if (j.status === "done" || j.status === "failed") return j; await new Promise((x) => setTimeout(x, 50)); } throw new Error("job timeout"); };
const snap = async (base, token) => (await call(base, "GET", "/api/snapshot", { token })).json();
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
const upload = (base, file, { actor = "CONTRACT_OWNER", token, name, bytes } = {}) => {
  const fd = new FormData();
  fd.append("file", new Blob([bytes ?? fs.readFileSync(path.join(SAMPLES, file))]), name ?? file);
  fd.append("actor", actor);
  return fetch(`${base}/api/contracts`, { method: "POST", headers: { "X-API-Key": KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: fd });
};
const idp = (p, body) => fetch(`${IDP}${p}`, { method: "POST", body: JSON.stringify(body) });
const esign = (p, body) => fetch(`${ESIGN}${p}`, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const OIDC_ENV = (port) => ({ OIDC_ISSUER: IDP, OIDC_CLIENT_ID: "aurora-desk", OIDC_CLIENT_SECRET: "oidc-secret", OIDC_REDIRECT_URI: `http://localhost:${port}/` });
let pIdp = null, pEsign = null;
before(async () => {
  pIdp = spawn("python3", [path.join(__dirname, "mock_oidc.py"), "8951", "aurora-desk", "oidc-secret"], { stdio: "ignore", detached: true });
  pEsign = spawn("python3", [path.join(__dirname, "mock_eapproval.py"), "8961", CH_SECRET], { stdio: "ignore", detached: true });
  await H.waitHttp(`${IDP}/.well-known/openid-configuration`); await H.waitHttp(`${ESIGN}/__received`);
});
after(() => { H.writeReport("round21", { results }); for (const p of [pIdp, pEsign]) { try { process.kill(-p.pid); } catch { /* gone */ } } });

describe("§15-1 사내 SSO(OIDC)·리프레시 토큰·비밀번호 변경", () => {
  T("AH01", "화면의 '사내 SSO로 로그인' → IdP → 돌아오면 SSO 계정·역할로 로그인되고, 주소창에 인가 코드가 남지 않으며 감사 기록에 SSO 로그인이 남음", async () => {
    const base = "http://localhost:8150";
    const api = await H.startApi(8150, { ...JWT, ...OIDC_ENV(8150), SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      await idp("/__mode", { mode: "ok" }); await idp("/__user", { sub: "u-1001", preferred_username: "kim.ceo@aurora.example", aurora_role: "GROUP_CEO" });
      await p.goto(base); await p.waitForSelector(".top");
      await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
      await p.locator(".role select").nth(1).selectOption("api");
      await p.locator('[data-testid="login-sso"]').click();
      await p.locator('[data-testid="whoami"]').waitFor({ timeout: 10000 });
      const who = await p.locator('[data-testid="whoami"]').innerText();
      const url = p.url();
      const t = await login(base, "ceo.kang", "pw-ceo");
      const audit = (await snap(base, t.token)).audit.filter((a) => /SSO 로그인\(/.test(a.detail));
      assert.match(who, /kim\.ceo@aurora\.example/); assert.match(who, /그룹 CEO/); assert.match(who, /SSO/);
      assert.doesNotMatch(url, /code=|state=/, `주소창에 인가 코드가 남음: ${url}`);
      assert.ok(audit.length >= 1, "감사 기록에 SSO 로그인이 없음");
      assert.equal(await p.locator('[data-testid="pw-open"]').count(), 0, "SSO 계정에 비밀번호 변경 버튼이 보임");
      assert.deepEqual(p.errors, []);
    } finally { await B.browser.close(); H.stop(api); }
  });

  T("AH02", "SSO 공격·오류: 다른 키 서명·대상(aud)·발급자(iss)·만료·nonce 불일치는 401, 역할 없는 계정은 403, state 재사용·위조는 400 — 모두 로그인되지 않고 감사 기록이 남음", async () => {
    const base = "http://localhost:8151";
    const api = await H.startApi(8151, { ...JWT, ...OIDC_ENV(8151) });
    const go = async (mode, tamper) => {
      await idp("/__mode", { mode });
      const { url } = await (await call(base, "GET", "/api/auth/oidc/start")).json();
      const loc = (await fetch(url, { redirect: "manual" })).headers.get("location");
      const q = Object.fromEntries(new URL(loc).searchParams);
      if (tamper) q.state = "forged-" + q.state;
      const r = await call(base, "POST", "/api/auth/oidc/callback", { body: q });
      return { q, status: r.status, body: await r.json() };
    };
    try {
      await idp("/__user", { sub: "u-1001", preferred_username: "kim.ceo@aurora.example", aurora_role: "GROUP_CEO" });
      const got = {};
      for (const m of ["bad_sig", "wrong_aud", "wrong_iss", "expired", "wrong_nonce", "no_role"]) got[m] = (await go(m)).status;
      const ok = await go("ok");
      const replay = (await call(base, "POST", "/api/auth/oidc/callback", { body: ok.q })).status;
      got.forged = (await go("ok", true)).status;
      const t = await login(base, "ceo.kang", "pw-ceo");
      const fails = (await snap(base, t.token)).audit.filter((a) => /SSO 로그인 실패/.test(a.detail)).length;
      assert.deepEqual(got, { bad_sig: 401, wrong_aud: 401, wrong_iss: 401, expired: 401, wrong_nonce: 401, no_role: 403, forged: 400 });
      assert.equal(ok.status, 200, `정상 SSO ${ok.status}`);
      assert.equal(replay, 400, "같은 인가 응답(state)으로 다시 로그인됨");
      assert.ok(fails >= 8, `SSO 실패 감사 ${fails}건`);
      return { fails };
    } finally { await idp("/__mode", { mode: "ok" }); H.stop(api); }
  });

  T("AH03", "리프레시 토큰: 회전(새 쌍) → 옛 토큰 재사용은 401이고 그 로그인 전체가 끊김, 로그아웃하면 리프레시도 무효, 서버를 다시 켜도 유효한 리프레시는 계속 쓰임", async () => {
    const base = "http://localhost:8152";
    const env = { ...JWT, REPO: "memory", REPO_PATH: tmpFile() };
    let api = await H.startApi(8152, env);
    try {
      const a = await login(base, "fin.park", "pw-fin");
      const r1 = await (await call(base, "POST", "/api/auth/token", { body: { refresh_token: a.refresh_token } })).json();
      const reuse = await call(base, "POST", "/api/auth/token", { body: { refresh_token: a.refresh_token } });
      const afterReuse = { access: (await call(base, "GET", "/api/revision", { token: r1.token })).status,
        refresh: (await call(base, "POST", "/api/auth/token", { body: { refresh_token: r1.refresh_token } })).status };
      const b = await login(base, "fin.park", "pw-fin");
      H.stop(api); await new Promise((r) => setTimeout(r, 600));
      api = await H.startApi(8152, env);
      const b2 = await call(base, "POST", "/api/auth/token", { body: { refresh_token: b.refresh_token } });
      const nb = await b2.json();
      await call(base, "POST", "/api/auth/logout", { token: nb.token });
      const afterLogout = (await call(base, "POST", "/api/auth/token", { body: { refresh_token: nb.refresh_token } })).status;
      assert.ok(r1.token && r1.refresh_token && r1.refresh_token !== a.refresh_token, "회전하지 않음");
      assert.equal(reuse.status, 401, "쓴 리프레시 토큰을 다시 받아 줌");
      assert.deepEqual(afterReuse, { access: 401, refresh: 401 }, "재사용 감지 뒤에도 그 로그인이 살아 있음");
      assert.equal(b2.status, 200, "재시작 뒤 유효한 리프레시가 거부됨");
      assert.equal(afterLogout, 401, "로그아웃 뒤에도 리프레시가 통함");
    } finally { H.stop(api); }
  });

  T("AH04", "화면에서 비밀번호 변경: 약한 비밀번호는 이유와 함께 거부, 바꾸면 이 화면은 계속 쓰고 다른 기기 로그인·옛 비밀번호는 무효, 재시작 뒤에도 새 비밀번호", async () => {
    const base = "http://localhost:8153";
    const env = { ...JWT, REPO: "memory", REPO_PATH: tmpFile(), SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" };
    let api = await H.startApi(8153, env);
    const B = await H.newPage(); const p = B.page;
    try {
      const other = await login(base, "contract.choi", "pw-co");                 // 다른 기기의 로그인
      await p.goto(base); await p.waitForSelector(".top");
      await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
      await p.locator(".role select").nth(1).selectOption("api");
      await p.locator('[data-testid="login-user"]').fill("contract.choi"); await p.locator('[data-testid="login-password"]').fill("pw-co");
      await p.locator('[data-testid="login-submit"]').click(); await p.locator('[data-testid="whoami"]').waitFor();
      await p.locator('[data-testid="pw-open"]').click();
      await p.locator('[data-testid="pw-current"]').fill("pw-co"); await p.locator('[data-testid="pw-new"]').fill("aaaaaaaaaa"); await p.locator('[data-testid="pw-again"]').fill("aaaaaaaaaa");
      await p.locator('[data-testid="pw-submit"]').click();
      const weak = await p.locator(".dialog [role=alert]").innerText();
      await p.locator('[data-testid="pw-new"]').fill("Contract#2026x"); await p.locator('[data-testid="pw-again"]').fill("Contract#2026x");
      await p.locator('[data-testid="pw-submit"]').click();
      await p.locator('[data-testid="pw-current"]').waitFor({ state: "detached", timeout: 5000 });
      await p.getByRole("button", { name: "전속계약 갱신 통보 접수" }).click();    // 바꾼 뒤에도 이 화면은 계속 일함
      const listed = await p.locator('[data-testid="case-CT-INF001-2025"]').waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
      const st = { other: (await call(base, "GET", "/api/revision", { token: other.token })).status,
        oldPw: (await call(base, "POST", "/api/auth/login", { body: { user: "contract.choi", password: "pw-co" } })).status };
      H.stop(api); await new Promise((r) => setTimeout(r, 600));
      api = await H.startApi(8153, env);
      st.newPwAfterRestart = (await call(base, "POST", "/api/auth/login", { body: { user: "contract.choi", password: "Contract#2026x" } })).status;
      assert.match(weak, /두 종류 이상/, `약한 비밀번호 안내: ${weak}`);
      assert.ok(listed, "비밀번호를 바꾼 뒤 이 화면의 작업이 실패함(로그인이 끊김)");
      assert.deepEqual(st, { other: 401, oldPw: 401, newPwAfterRestart: 200 });
      // 약한 비밀번호를 서버가 422로 거부할 때 브라우저가 스스로 남기는 '리소스 422' 한 줄은 의도한 결과라 뺀다
      assert.deepEqual(p.errors.filter((e) => !/status of 422/.test(e)), []);
    } finally { await B.browser.close(); H.stop(api); }
  });
});

describe("§15-2 전자결재·메신저 연동(채널 어댑터)", () => {
  const ENV = { CHANNEL: "webhook", CHANNEL_SECRET: CH_SECRET, ESIGN_WEBHOOK_URL: `${ESIGN}/hooks/approval`, MESSENGER_WEBHOOK_URL: `${ESIGN}/hooks/messenger`,
    ESIGN_USERS: "kim.ceo:GROUP_CEO;han.masil:MASIL_CEO", CHANNEL_BACKOFF_S: "0.3,0.6,1" };
  T("AH05", "결재 요청이 서명과 함께 전자결재로 가고(일시 장애 2회는 재시도로 전달), 느린 전자결재가 결재 응답을 늦추지 않으며, 통보 발송은 메신저로도 감", async () => {
    const base = "http://localhost:8154";
    const api = await H.startApi(8154, ENV);
    try {
      await esign("/__reset", {}); await esign("/__mode", { fail: 2 });
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { body: { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" } }));
      const req = await until(async () => (await esign("/__received")).received.find((r) => r.event === "approval.requested"), 8000);
      const del = (await (await call(base, "GET", "/api/integrations/deliveries")).json()).items.map(([, v]) => v).find((v) => v.type === "approval.requested");
      const c = (await snap(base)).cases[0];
      await esign("/__mode", { fail: 0, delay: 3 });                       // 전자결재가 3초씩 걸림
      const t0 = performance.now();
      const r = await call(base, "POST", `/api/cases/${c.id}/decision`, { body: { actor: "GROUP_CEO", action: "approve", comment: "화면 결재", expected_version: c.version } });
      const ms = performance.now() - t0;
      await esign("/__mode", { delay: 0 });
      const task = (await snap(base)).tasks.find((x) => x.channel && x.status === "OPEN");
      await call(base, "POST", `/api/tasks/${task.id}/done`, { body: { actor: task.dept } });
      const msg = await until(async () => (await esign("/__received")).received.find((x) => x.event === "message"), 8000);
      const closed = await until(async () => (await esign("/__received")).received.find((x) => x.event === "approval.closed"), 8000);
      H.recordPerf("느린 전자결재(3초) 중 결재 응답", ms);
      assert.ok(req, "결재 요청이 전자결재로 가지 않음");
      assert.ok(req.sig_ok, "서명이 맞지 않음");
      assert.equal(req.body.case_id, c.id); assert.equal(req.body.approver_role, "GROUP_CEO");
      assert.equal(del.status, "sent"); assert.equal(del.attempts, 3, `재시도 ${del.attempts}회`);
      assert.equal(r.status, 200);
      assert.ok(ms < 500, `결재 응답 ${Math.round(ms)}ms — 전자결재를 기다림`);
      assert.ok(closed && closed.body.state === "APPROVED", "결재 종료가 전자결재로 가지 않음");
      assert.ok(msg && msg.sig_ok && /조건변경 통보/.test(msg.body.body), "통보 발송이 메신저로 가지 않음");
      return { decide_ms: Math.round(ms), attempts: del.attempts };
    } finally { H.stop(api); }
  });

  T("AH06", "전자결재 콜백: 서명 위조·5분 지난 서명은 401, 등록되지 않은 결재자는 403, 정상은 결재되고 감사 사용자 '아이디(전자결재)', 같은 event_id 재전송은 한 번만, 옛 판 번호는 409", async () => {
    const base = "http://localhost:8155";
    const api = await H.startApi(8155, ENV);
    try {
      await esign("/__reset", {});
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { body: { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" } }));
      await waitJob(base, await call(base, "POST", "/api/events", { body: { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" } }));
      const s = await snap(base);
      const c = s.cases.find((x) => x.type === "CONTRACT");
      const pl = s.cases.find((x) => x.type === "PLAN" && x.state === "PENDING_APPROVAL" && x.approval.approver === "MASIL_CEO");
      const cb = (body, o = {}) => esign("/__callback", { target: `${base}/api/integrations/approval`, body, secret: CH_SECRET, ...o });
      const st = {
        bad: (await cb({ event_id: "e-1", case_id: c.id, action: "approve", user: "kim.ceo" }, { bad_sig: true })).status,
        stale: (await cb({ event_id: "e-1", case_id: c.id, action: "approve", user: "kim.ceo" }, { ts_offset: -600 })).status,
        unknown: (await cb({ event_id: "e-2", case_id: c.id, action: "approve", user: "intruder" })).status,
        wrongRole: (await cb({ event_id: "e-3", case_id: c.id, action: "approve", user: "han.masil" })).status,
      };
      const ok = await cb({ event_id: "e-4", case_id: c.id, action: "approve", user: "kim.ceo", expected_version: c.version, comment: "전자결재 승인" });
      const dup = await cb({ event_id: "e-4", case_id: c.id, action: "approve", user: "kim.ceo", expected_version: c.version });
      const stale = await cb({ event_id: "e-5", case_id: pl.id, action: "approve", user: "han.masil", expected_version: pl.version - 1 });
      const after = await snap(base);
      const decided = after.audit.filter((a) => a.case_id === c.id && a.topic === "case.approved");
      assert.deepEqual(st, { bad: 401, stale: 401, unknown: 403, wrongRole: 403 });
      assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.state, "APPROVED");
      assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true);
      assert.equal(decided.length, 1, `결재 기록 ${decided.length}건`);
      assert.equal(decided[0].user, "kim.ceo(전자결재)");
      assert.equal(stale.status, 409); assert.match(String(stale.body.detail), /바뀌었/);
    } finally { H.stop(api); }
  });
});

describe("§15-3·4 계약서 업로드 → 조항 추출 → 다른 자동 갱신 계약", () => {
  T("AH07", "화면에서 광고 대행 계약서를 올리면 '다른 자동 갱신 계약'에 건이 생기고, 서류에 위약금 60%·선급 50%·통보 기한 위험과 조항 출처가 보이며 연락처·계좌는 가려짐", async () => {
    const base = "http://localhost:8156";
    const api = await H.startApi(8156, { SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      await call(base, "POST", "/api/reset");
      await p.goto(base); await p.waitForSelector(".top");
      await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector(".top");
      await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(600);
      await p.locator('[data-testid="role-select"]').selectOption("CONTRACT_OWNER");
      const t0 = Date.now();
      await p.locator('[data-testid="contract-file"]').setInputFiles(path.join(SAMPLES, "agency_media_renewal.md"));
      const item = p.locator(".cases h2", { hasText: "다른 자동 갱신 계약" });
      await item.waitFor({ timeout: 8000 });
      const shown = Date.now() - t0;
      await p.locator(".cases .case-item", { hasText: "블루웨이브미디어" }).click();
      await p.locator('[data-testid="contract-checks"]').waitFor();
      const checks = await p.locator('[data-testid="contract-checks"]').innerText();
      const sheet = await p.locator(".sheet").innerText();
      const raw = JSON.stringify(await snap(base));
      assert.match(checks, /위약금 60%/); assert.match(checks, /50% 선급/);
      assert.match(sheet, /제6조/, "조항 출처(제6조)가 서류에 없음");
      assert.match(sheet, /그룹 CEO/, "결재자가 그룹 CEO가 아님");
      assert.doesNotMatch(raw, /110-234-567890|ad@bluewave/, "계좌·이메일이 그대로 저장·노출됨");
      assert.deepEqual(p.errors, []);
      return { shown_ms: shown };
    } finally { await B.browser.close(); H.stop(api); }
  });

  T("AH08", "업로드 검증·정확도: 실행 파일 415, 3MB 413, 같은 계약서는 한 번만, 마케팅팀은 403 — INF-001 통보서를 올리면 뽑은 값(28억·위약금 50%·통보 기한·만료일)이 판단 엔진의 기존 값과 같음", async () => {
    const base = "http://localhost:8157";
    const api = await H.startApi(8157, {});
    try {
      await call(base, "POST", "/api/reset");
      const st = { exe: (await upload(base, "x", { name: "evil.exe", bytes: Buffer.from("MZ") })).status,
        big: (await upload(base, "x", { name: "big.md", bytes: Buffer.alloc(3 * 1024 * 1024, 97) })).status,
        mkt: (await upload(base, "agency_media_renewal.md", { actor: "MARKETING_TEAM" })).status };
      const j1 = await waitJob(base, await upload(base, "agency_media_renewal.md"));
      const j2 = await waitJob(base, await upload(base, "agency_media_renewal.md"));
      const inf = await waitJob(base, await upload(base, "x", { name: "inf001_notice.md", bytes: fs.readFileSync(path.join(H.ROOT, "data", "raw", "02_masil", "marketing", "inf001_exclusive_contract_notice.md")) }));
      const facts = await (await call(base, "GET", "/api/facts")).json().catch(() => ({}));
      const t = inf.result.terms;
      assert.deepEqual(st, { exe: 415, big: 413, mkt: 403 });
      assert.match(j1.message, /분석 완료/);
      assert.match(j2.message, /이미 올라와/);
      assert.equal(t.annual_fee_krw, 2.8e9); assert.equal(t.penalty_pct, 50); assert.equal(t.notice_deadline, "2026-07-17"); assert.equal(t.expiry, "2026-08-31");
      assert.equal(t.auto_renew, true);
      assert.ok(inf.result.checks.some((c) => c.id === "PAYMENT_MISSING"), "지급 조건이 없는데 '확인 필요'가 없음(지어냄)");
      return { facts_keys: Object.keys(facts).length };
    } finally { H.stop(api); }
  });

  T("AH09", "같은 엔진으로 물류·대행 계약: 결재자는 금액·covenant로 정해지고, 대행 계약을 승인해 통보를 보내면 그 계약만 '통보 완료'(INF-001 상태는 그대로), 미결정 물류 계약은 기한이 지나면 자동 갱신 경고", async () => {
    const base = "http://localhost:8158";
    const api = await H.startApi(8158, {});
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await upload(base, "logistics_3pl_renewal.md"));
      await waitJob(base, await upload(base, "agency_media_renewal.md"));
      let s = await snap(base);
      const logi = s.cases.find((c) => c.title.includes("한빛로지스")), ag = s.cases.find((c) => c.title.includes("블루웨이브"));
      const before = s.ctx.contract_status;
      const r = await call(base, "POST", `/api/cases/${ag.id}/decision`, { body: { actor: "GROUP_CEO", action: "approve", comment: "조건변경 통보", expected_version: ag.version } });
      s = await snap(base);
      const notice = s.tasks.find((x) => x.case_id === ag.id && x.kind === "NOTIFY");
      const done = await call(base, "POST", `/api/tasks/${notice.id}/done`, { body: { actor: "CONTRACT_OWNER" } });
      const afterNotice = (await snap(base)).ctx.contract_status;          // 시계를 옮기기 전(INF-001 자체 기한 7/17이 지나면 INF-001은 원래 규칙대로 자동 갱신)
      await call(base, "POST", "/api/clock", { body: { to: "2026-08-02", actor: "SYSTEM" } });
      s = await snap(base);
      const logi2 = s.cases.find((c) => c.id === logi.id);
      const warn = s.audit.filter((a) => a.topic === "deadline.expired" && /한빛로지스/.test(a.detail));
      const agWarn = s.audit.filter((a) => a.topic === "deadline.expired" && /블루웨이브/.test(a.detail));
      assert.equal(logi.approval.approver, "MASIL_CEO", "물류 9.6억 → Masil 대표");
      assert.equal(ag.approval.approver, "GROUP_CEO", "대행 10.8억·covenant → 그룹 CEO");
      assert.equal(r.status, 200); assert.equal(done.status, 200);
      assert.ok(s.outbox.some((m) => /블루웨이브/.test(m.body)), "상대방 통보가 발송함에 없음");
      assert.equal(afterNotice, before, "다른 계약 통보가 INF-001 상태를 바꿈");
      assert.equal(logi2.state, "AUTO_COMMITTED", `미결정 물류 계약: ${logi2.state}`);
      assert.ok(warn.length >= 1, "물류 계약 자동 갱신 경고 없음");
      assert.equal(agWarn.length, 0, "통보를 보낸 대행 계약에 자동 갱신 경고");
    } finally { H.stop(api); }
  });
});
