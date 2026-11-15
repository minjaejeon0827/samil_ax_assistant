// 24차 E2E — v1.23에 새로 넣은 것 × 기존 보장(서버 여러 대·다른 사용자의 속도) + §14 '확인 필요로 정지하고 확인 요청'의 끝맺음 + §15 남은 일 + 시연 영상.
//   §15 ⑦ 남은 일: 제공자 응답 헤더(남은 토큰)로 한도 자동 조정(LLM_TPM을 몰라도)                     → AK02
//   §15 ⑤ 남은 일: 계약서 요약 품질 평가(사람 평점)                                                 → AK03
//   §14 '계약 원문·성과 피 조건 없음 — 확인 필요로 정지하고 확인 요청' × v1.23 RENEWAL 확인 필요(외화·갱신 미확인) → AK04
//   §15-1 v1.23 백채널 로그아웃 × 서버 2대                                                          → AK05
//   §15-3 v1.23 글자 인식 진행 표시 × 서버 2대(다른 서버에 물어도 진행이 보이는가)                    → AK06
//   §15-3 v1.23 글자 인식 × 다른 사용자의 응답 속도(동시 업로드 2건)                                  → AK07
//   §15 ⑦ v1.23 공동 토큰 한도 × 다른 사용자의 결재 속도                                             → AK08
//   시연 영상: 5분 이내, AI 음성 해설 트랙, 해설 대본과 장면 일치                                      → AK09
//   §14·§15 표 대조(23차 AJ01 확장)                                                                  → AK01(맨 끝)
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const H = require("./helpers.cjs");
const RISK_GUARDS = Object.fromEntries(Object.entries(require("./risk_guards.cjs").RISK_GUARDS).map(([k, v]) => [k, v.filter((r) => !/^round(2[5-8]|30):/.test(r))]));   // 25차는 24차 뒤에 돈다

const KEY = "e2e-key";
const IDP = "http://127.0.0.1:8956", LLM = "http://127.0.0.1:8911";
const USERS = "contract.choi:pw-co:CONTRACT_OWNER;ceo.kang:pw-ceo:GROUP_CEO;fin.park:pw-fin:FINANCE;mkt.lee:pw-mkt:MARKETING_TEAM";
const JWT = { AUTH_MODE: "jwt", USERS, JWT_SECRET: "e2e-secret-0123456789abcdef" };
const OIDC = (base) => ({ OIDC_ISSUER: IDP, OIDC_CLIENT_ID: "aurora-desk", OIDC_CLIENT_SECRET: "oidc-secret", OIDC_REDIRECT_URI: `${base}/` });
const LLM_ENV = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `${LLM}/v1`, LLM_TIMEOUT_S: "5" };
const DIST = path.join(H.ROOT, "frontend", "dist-docker");
const SAMPLES = path.join(H.ROOT, "data", "samples", "contracts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aurora24-"));
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, { token, body } = {}) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const jobOf = async (base, id, ms = 60000, seen = [], token) => { const end = Date.now() + ms; while (Date.now() < end) { const j = await (await call(base, "GET", `/api/jobs/${id}`, { token })).json(); if (j.message) seen.push(j.message); if (j.status === "done" || j.status === "failed") return j; await new Promise((x) => setTimeout(x, 150)); } throw new Error("job timeout"); };
const waitJob = async (base, r, ms = 60000, token) => { const b = await r.json(); if (!b.job_id) return { ...b, http: r.status }; return jobOf(base, b.job_id, ms, [], token); };
const snap = async (base, token) => (await call(base, "GET", "/api/snapshot", { token })).json();
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); } return null; };
const upload = (base, file, token) => { const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync(file)]), path.basename(file)); fd.append("actor", "CONTRACT_OWNER"); return fetch(`${base}/api/contracts`, { method: "POST", headers: { "X-API-Key": KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: fd }); };
const post = (u, body) => fetch(u, { method: "POST", body: JSON.stringify(body) });
const writing = (s) => s.cases.filter((c) => /작성 중/.test(String(c.llm)));
const settle = async (base, ms = 60000, token) => { const end = Date.now() + ms; let s; while (Date.now() < end) { s = await snap(base, token); if (s.cases && !writing(s).length) return s; await new Promise((r) => setTimeout(r, 250)); } return s; };
const login = async (base, user, password) => (await (await call(base, "POST", "/api/auth/login", { body: { user, password } })).json()).token;
const ssoLogin = async (base) => {
  const start = await (await call(base, "GET", "/api/auth/oidc/start")).json();
  const r = await fetch(start.url, { redirect: "manual" });
  const q = new URL(r.headers.get("location")).searchParams;
  return (await call(base, "POST", "/api/auth/oidc/callback", { body: { code: q.get("code"), state: q.get("state") } })).json();
};
const p95 = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))]; };
const timed = async (fn) => { const t0 = Date.now(); await fn(); return Date.now() - t0; };
const openApi = async (p, base) => {
  await p.goto(base); await p.waitForSelector(".top");
  await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
  await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(700);
};
const longScan = path.join(TMP, "long_scan_11p.pdf");
let procs = [];
before(async () => {
  procs = [spawn("python3", [path.join(__dirname, "mock_oidc.py"), "8956", "aurora-desk", "oidc-secret"], { stdio: "ignore", detached: true }),
    spawn("python3", [path.join(__dirname, "mock_llm.py"), "8911"], { stdio: "ignore", detached: true })];
  await H.waitHttp(`${IDP}/jwks`); await H.waitHttp(`${LLM}/__stats`);
  const src = fs.readFileSync(path.join(SAMPLES, "logistics_3pl_renewal.md"), "utf8").split("\n");
  const filler = Array.from({ length: 230 }, (_, i) => `부속서 A-${String(i + 1).padStart(3, "0")}. 창고 운영 서비스 수준 항목 ${i + 1}: 입고 검수, 보관 온도 기록, 출고 정확도 점검을 매일 기록한다.`);
  fs.writeFileSync(path.join(TMP, "long.md"), [...src.filter((l) => !/위약/.test(l)), "", "## 부속서 A(서비스 수준)", ...filler, "", "## 해지", ...src.filter((l) => /위약/.test(l))].join("\n"));
  execFileSync("python3", [path.join(__dirname, "make_scanned_pdf.py"), path.join(TMP, "long.md"), longScan]);
  // 같은 스캔이지만 내용이 조금 다른 두 번째 파일(동시 업로드 시험용 — 같은 계약서 중복으로 걸러지지 않게)
  fs.writeFileSync(path.join(TMP, "long2.md"), fs.readFileSync(path.join(TMP, "long.md"), "utf8").replace("부속서 A-001.", "부속서 A-001(개정)."));
  execFileSync("python3", [path.join(__dirname, "make_scanned_pdf.py"), path.join(TMP, "long2.md"), path.join(TMP, "long_scan_11p_b.pdf")]);
});
after(() => { H.writeReport("round24", { results }); for (const p of procs) { try { process.kill(-p.pid); } catch { /* gone */ } } });

describe("§15 남은 일 · §14 확인 필요의 끝맺음", () => {
  T("AK02", "§15 ⑦ 남은 일: 토큰 한도를 설정하지 않아도 제공자 응답 헤더(남은 토큰·초기화 시각)를 보고 속도를 맞춤 — 429 3회 이하, 25건 모두 LLM 설명", async () => {
    const base = "http://localhost:8180";
    const api = await H.startApi(8180, { ...LLM_ENV });   // LLM_TPM 없음
    try {
      await post(`${LLM}/__mode`, { mode: "ok", tpm: 24000, window: 3, headers: true });
      await call(base, "POST", "/api/reset");
      await post(`${LLM}/__mode`, { mode: "ok", tpm: 24000, window: 3, headers: true });
      const t0 = Date.now();
      await waitJob(base, await call(base, "POST", "/api/events", { body: { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" } }), 120000);
      const s = await settle(base, 60000);
      const ms = Date.now() - t0;
      const st = await (await fetch(`${LLM}/__stats`)).json();
      const bad = s.cases.filter((c) => c.decision && !/^openai/.test(String(c.llm))).map((c) => `${c.target_id}:${c.llm}`);
      H.recordPerf("응답 헤더로 한도 맞춤 25건", ms, { r429: st.r429 });
      assert.ok(st.r429 <= 3, `429 ${st.r429}회 — 제공자가 알려 준 남은 토큰을 보지 않고 보냄`);
      assert.deepEqual(bad, [], `LLM 설명이 아닌 건 ${bad.length}건: ${bad.slice(0, 3).join(", ")}`);
      assert.ok(ms < 30000, `${ms}ms`);
      return { r429: st.r429, ms };
    } finally { await post(`${LLM}/__mode`, { mode: "ok" }); H.stop(api); }
  });

  T("AK03", "§15 ⑤ 남은 일: 계약서 요약 품질 평가 — 결재 서류에서 '도움됨·부정확함'(사유)을 누르면 한 사람당 한 표로 남고, 평가 집계(API·화면)와 감사 기록에 반영", async () => {
    const base = "http://localhost:8181";
    const api = await H.startApi(8181, { ...LLM_ENV, SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      await post(`${LLM}/__mode`, { mode: "ok" });
      await call(base, "POST", "/api/reset");
      await waitJob(base, await upload(base, path.join(SAMPLES, "agency_media_renewal.md")));
      const rc = (await snap(base)).cases.find((c) => c.type === "RENEWAL");
      await openApi(p, base);
      const vote = async (role, sel, note) => {
        await p.locator('[data-testid="role-select"]').selectOption(role); await p.waitForTimeout(300);
        await p.locator(`[data-testid="case-${rc.target_id}"]`).click();
        await p.locator('[data-testid="contract-summary"]').waitFor({ timeout: 8000 });
        if (note) await p.locator('[data-testid="summary-note"]').fill(note);
        await p.locator(`[data-testid="${sel}"]`).click();
        await p.waitForTimeout(600);
      };
      await vote("GROUP_CEO", "summary-up");
      await vote("FINANCE", "summary-down", "위약금 기준(잔여 보수)을 요약에서 빠뜨림");
      await vote("FINANCE", "summary-up");                 // 같은 사람은 표를 바꿈(한 표)
      await vote("CONTRACT_OWNER", "summary-down", "선급 조건 설명이 모호함");
      const score = await p.locator('[data-testid="summary-score"]').innerText().catch(() => "");
      const ev = await (await call(base, "GET", "/api/eval/summary-feedback")).json();
      const audit = (await snap(base)).audit.filter((a) => a.topic === "summary.feedback");
      assert.equal(ev.total, 3, `평가 ${ev.total}건(한 사람 한 표가 아님)`);
      assert.deepEqual([ev.up, ev.down], [2, 1]);
      assert.ok((ev.notes || []).some((n) => /선급/.test(n.note)), "사유가 남지 않음");
      assert.match(score, /3건/); assert.match(score, /67%|66%/);
      assert.ok(audit.length >= 4, `감사 기록 ${audit.length}건`);
      assert.deepEqual(p.errors, []);
      return { up_rate: ev.up_rate };
    } catch (e) { throw e; } finally { await B.browser.close(); H.stop(api); }
  });

  T("AK04", "§14 '확인 필요로 정지하고 확인 요청'의 끝맺음: 외화(USD) 계약은 재무팀이, 갱신 조항을 못 찾은 계약은 계약 담당이 화면에서 확인한 값을 넣으면 근거('사람 입력')와 함께 다시 판단되어 결재로 올라감", async () => {
    const base = "http://localhost:8182";
    const api = await H.startApi(8182, { SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await upload(base, path.join(SAMPLES, "variants", "freight_en_usd.md")));
      await waitJob(base, await upload(base, path.join(SAMPLES, "variants", "service_kr_no_clause.md")));
      let s = await snap(base);
      const usd = s.cases.find((c) => c.type === "RENEWAL" && /Pacific/.test(c.title));
      const nc = s.cases.find((c) => c.type === "RENEWAL" && /하늘영상/.test(c.title));
      assert.equal(usd.state, "NEEDS_INFO", "시험 전제: 외화 계약은 확인 필요");
      assert.equal(nc.state, "NEEDS_INFO", "시험 전제: 갱신 미확인 계약은 확인 필요");
      // 권한 없는 사람(마케팅)은 값을 넣을 수 없음
      const deny = await call(base, "POST", `/api/contracts/${usd.target_id}/facts`, { body: { actor: "MARKETING_TEAM", annual_fee_krw: 1, note: "x" } });
      await openApi(p, base);
      // 재무팀: 외화 → 원화
      await p.locator('[data-testid="role-select"]').selectOption("FINANCE"); await p.waitForTimeout(300);
      await p.evaluate(() => document.querySelectorAll(".left details").forEach((d) => { d.open = true; }));
      await p.locator(`[data-testid="case-${usd.target_id}"]`).click();
      await p.locator('[data-testid="contract-facts"]').waitFor({ timeout: 8000 });
      await p.locator('[data-testid="facts-fee"]').fill("1324800000");
      await p.locator('[data-testid="facts-note"]').fill("USD 80,000 × 12 × 1,380원(재무팀 7/1 기준 환율)");
      await p.locator('[data-testid="facts-save"]').click();
      await until(async () => (await snap(base)).cases.find((c) => c.id === usd.id)?.state !== "NEEDS_INFO", 8000);
      // 계약 담당: 원문 확인 → 자동 갱신 있음, 만료 30일 전 통보
      await p.locator('[data-testid="role-select"]').selectOption("CONTRACT_OWNER"); await p.waitForTimeout(300);
      await p.locator(`[data-testid="case-${nc.target_id}"]`).click();
      await p.locator('[data-testid="contract-facts"]').waitFor({ timeout: 8000 });
      await p.locator('[data-testid="facts-renew"]').selectOption("yes");
      await p.locator('[data-testid="facts-notice"]').fill("30");
      await p.locator('[data-testid="facts-note"]').fill("원문 부속서 2쪽 '자동 연장' 조항 확인");
      await p.locator('[data-testid="facts-save"]').click();
      await until(async () => (await snap(base)).cases.find((c) => c.id === nc.id)?.state !== "NEEDS_INFO", 8000);
      s = await snap(base);
      const u2 = s.cases.find((c) => c.id === usd.id), n2 = s.cases.find((c) => c.id === nc.id);
      const ev = (c) => (c.decision?.evidence || []).map((e) => e.text || e.claim || JSON.stringify(e)).join(" | ");
      const audit = s.audit.filter((a) => a.topic === "contract.facts");
      assert.equal(deny.status, 403, `마케팅팀이 계약 값을 넣을 수 있음(${deny.status})`);
      assert.equal(u2.state, "PENDING_APPROVAL", `외화 계약: ${u2.state} — ${JSON.stringify(u2.decision?.needs_info)}`);
      assert.equal(u2.approval?.approver, "GROUP_CEO", "연 13.2억 → 그룹 CEO");
      assert.match(ev(u2), /사람 입력/, "근거에 사람이 넣은 값이라는 표시 없음");
      assert.equal(n2.state, "PENDING_APPROVAL", `갱신 미확인 계약: ${n2.state} — ${JSON.stringify(n2.decision?.needs_info)}`);
      assert.match(ev(n2), /2026-12-01/, "통보 기한(만료 12/31 − 30일)을 다시 계산하지 않음");
      assert.ok(audit.length >= 2, "감사 기록 없음");
      assert.deepEqual(p.errors, []);
    } finally { await B.browser.close(); H.stop(api); }
  });
});

describe("v1.23 새 기능 × 서버 여러 대·다른 사용자", () => {
  let db, A, Bs, a, b;
  const SA = "http://localhost:8183", SB = "http://localhost:8184";
  before(async () => {
    db = await H.startMariaDB(3324);
    if (!db) { if (process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음"); return; }
    const env = { ...db.env, ...JWT, ...OIDC(SA), ...LLM_ENV, LLM_TPM: "24000", LLM_TPM_WINDOW_S: "3", LLM_TPM_SCOPE: "shared" };
    a = await H.startApi(8183, env); b = await H.startApi(8184, env); A = SA; Bs = SB;
  });
  after(() => { H.stop(a); H.stop(b); H.stop(db); });

  T("AK05", "v1.23 백채널 로그아웃 × 서버 2대: IdP가 B 서버로 알려도 A 서버의 그 SSO 로그인이 6초 안에 끊기고, 같은 logout_token을 A로 다시 보내면 거부", async () => {
    await post(`${IDP}/__user`, { sub: "u-4001", preferred_username: "kim.ceo@aurora.example", aurora_role: "GROUP_CEO" });
    const s = await ssoLogin(A);
    const ok0 = (await call(A, "GET", "/api/revision", { token: s.token })).status;
    const r = await (await post(`${IDP}/__backchannel`, { to: `${Bs}/api/auth/oidc/backchannel`, sub: "u-4001", no_sid: true })).json();
    const t0 = Date.now();
    const cut = await until(async () => (await call(A, "GET", "/api/revision", { token: s.token })).status === 401, 8000);
    const ms = Date.now() - t0;
    const replay = await (await post(`${IDP}/__backchannel`, { to: `${A}/api/auth/oidc/backchannel`, mode: "replay" })).json();
    const rt = (await call(A, "POST", "/api/auth/token", { body: { refresh_token: s.refresh_token } })).status;
    assert.equal(ok0, 200, "시험 전제");
    assert.equal(r.status, 200, `B 서버가 logout_token을 받지 않음: ${r.body}`);
    assert.ok(cut && ms <= 6000, `A 서버에서 ${ms}ms 동안 계속 통함`);
    assert.equal(replay.status, 400, "다른 서버로 재전송한 logout_token을 받아들임(jti를 서버마다 따로 셈)");
    assert.equal(rt, 401, "A 서버의 리프레시 토큰이 계속 통함");
    return { cut_ms: ms };
  });

  T("AK06", "v1.23 글자 인식 진행 × 서버 2대: A 서버에 올린 11쪽 스캔의 진행을 B 서버에 물어도 '글자 인식 중 n/11쪽'이 바뀌어 보이고, 끝난 결과도 B에서 보임", async () => {
    const ceo = await login(A, "ceo.kang", "pw-ceo");
    await call(A, "POST", "/api/reset", { token: ceo });
    const r = await (await upload(A, longScan, ceo)).json();
    assert.ok(r.job_id, `시험 전제: ${JSON.stringify(r)}`);
    const seen = [];
    const j = await jobOf(Bs, r.job_id, 90000, seen, ceo);
    const prog = [...new Set(seen.filter((m) => /글자 인식 중 \d+\/11/.test(m)))];
    assert.ok(prog.length >= 3, `B 서버에서 본 진행 ${prog.length}단계: ${[...new Set(seen)].slice(0, 6).join(" | ")}`);
    assert.equal(j.status, "done", j.message);
    assert.equal(j.result?.terms?.penalty_pct, 20, "B 서버에서 결과를 볼 수 없음");
    return { steps: prog.length };
  });

  T("AK07", "v1.23 글자 인식 × 다른 사용자: 11쪽 스캔 2건을 동시에 올리는 동안 다른 사람의 조회·결재 응답 p95 500ms 이하, 두 건 모두 45초 안에 끝남", async () => {
    const ceo = await login(A, "ceo.kang", "pw-ceo"), co = await login(A, "contract.choi", "pw-co");
    await call(A, "POST", "/api/reset", { token: ceo });
    await post(`${LLM}/__mode`, { mode: "ok" });
    await waitJob(A, await call(A, "POST", "/api/events", { token: co, body: { kind: "CONTRACT_RENEWAL_NOTICE" } }), 60000, co);
    const t0 = Date.now();
    const jobs = await Promise.all([upload(A, longScan, ceo), upload(A, path.join(TMP, "long_scan_11p_b.pdf"), ceo)].map((x) => x.then((r) => r.json())));
    const lat = [];
    let done = false;
    const all = Promise.all(jobs.map((jb) => jobOf(A, jb.job_id, 120000, [], ceo))).then((v) => { done = true; return v; });
    while (!done && Date.now() - t0 < 120000) {
      lat.push(await timed(() => call(A, "GET", "/api/snapshot", { token: co }).then((r) => r.json())));
      lat.push(await timed(() => call(A, "GET", "/api/revision", { token: co }).then((r) => r.json())));
      await new Promise((r) => setTimeout(r, 200));
    }
    const js = await all;
    const ms = Date.now() - t0;
    H.recordPerf("글자 인식 2건 중 다른 사용자 응답 p95", p95(lat), { n: lat.length, ocr_ms: ms });
    assert.ok(js.every((j) => j.status === "done"), js.map((j) => j.message).join(" | "));
    assert.ok(p95(lat) <= 500, `다른 사용자 응답 p95 ${p95(lat)}ms(최대 ${Math.max(...lat)}ms)`);
    assert.ok(ms <= 45000, `글자 인식 2건 ${ms}ms`);
    return { p95: p95(lat), ocr_ms: ms };
  });

  T("AK08", "v1.23 공동 토큰 한도 × 다른 사용자: 서버 2대가 한도를 함께 세며 LLM을 기다리는 동안에도 다른 사람의 결재·조회 응답 p95 1초 이하", async () => {
    const ceo = await login(A, "ceo.kang", "pw-ceo"), co = await login(Bs, "contract.choi", "pw-co"), mkt = await login(A, "mkt.lee", "pw-mkt");
    await call(A, "POST", "/api/reset", { token: ceo });
    await post(`${LLM}/__mode`, { mode: "ok" });
    await waitJob(Bs, await call(Bs, "POST", "/api/events", { token: co, body: { kind: "CONTRACT_RENEWAL_NOTICE" } }), 60000, co);
    await settle(Bs, 60000, co);
    await post(`${LLM}/__mode`, { mode: "ok", tpm: 24000, window: 3 });
    const ja = call(A, "POST", "/api/events", { token: mkt, body: { kind: "BUDGET_PLAN_BATCH" } }).then((r) => waitJob(A, r, 120000, mkt));
    await until(async () => writing(await snap(Bs, co)).length > 5, 20000);
    const lat = [];
    for (let i = 0; i < 12; i++) { lat.push(await timed(() => call(Bs, "GET", "/api/snapshot", { token: co }).then((r) => r.json()))); await new Promise((r) => setTimeout(r, 250)); }
    const c = (await snap(Bs, co)).cases.find((x) => x.type === "CONTRACT" && x.state === "PENDING_APPROVAL");
    const ceoB = await login(Bs, "ceo.kang", "pw-ceo");
    const dms = await timed(async () => { const r = await call(Bs, "POST", `/api/cases/${c.id}/decision`, { token: ceoB, body: { actor: "GROUP_CEO", action: "approve", comment: "결재" } }); assert.equal(r.status, 200, await r.text()); });
    lat.push(dms);
    await ja;
    H.recordPerf("공동 토큰 한도 대기 중 다른 사용자 응답 p95", p95(lat), { decision_ms: dms });
    assert.ok(p95(lat) <= 1000 && dms <= 1000, `p95 ${p95(lat)}ms, 결재 ${dms}ms`);
    return { p95: p95(lat), decision_ms: dms };
  });
});

describe("시연 영상", () => {
  T("AK09", "시연 영상: 5분 이내, AI 음성 해설 트랙이 있고, 해설 대본(demo/narration.json)의 모든 줄이 영상 안에서 재생됨", async () => {
    const mp4 = path.join(H.ROOT, "demo", "aurora_demo.mp4"), nar = path.join(H.ROOT, "demo", "narration.json");
    if (!fs.existsSync(mp4)) return { skipped: "영상 파일 없음(zip에는 영상이 빠짐)" };
    const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", mp4], { encoding: "utf8" }));
    const dur = Number(info.format.duration);
    const audio = info.streams.some((s) => s.codec_type === "audio");
    assert.ok(dur <= 300, `영상 ${dur.toFixed(1)}초 — 5분 초과`);
    assert.ok(audio, "음성 트랙 없음");
    assert.ok(fs.existsSync(nar), "해설 대본 없음");
    const lines = JSON.parse(fs.readFileSync(nar, "utf8"));
    const placed = lines.filter((l) => typeof l.at === "number" && l.at + (l.dur || 0) <= dur + 0.5);
    assert.ok(lines.length >= 20 && placed.length === lines.length, `해설 ${lines.length}줄 중 영상 안 ${placed.length}줄`);
    return { seconds: Math.round(dur), lines: lines.length };
  });
});

// ---------------- §14 · §15 대조 ----------------
// v1.24에서 한 일의 원래 문구(§15 v1.23판 '남은 일' 그대로) — 다른 제공자의 헤더 읽기 같은 새 남은 일까지 걸리지 않게 정확히 맞춘다
const DONE_IN_V124 = [/제공자 응답 헤더\(남은 토큰\)로 한도 자동 조정/, /요약 품질 평가\(사람 평점\)/];
const SUITES = () => (fs.readFileSync(path.join(__dirname, "run_all.sh"), "utf8").match(/for s in ([^;]+);/) || [, ""])[1].trim().split(/\s+/);
const latestOf = (s) => { const f = path.join(__dirname, "reports", `${s}.json`); return fs.existsSync(f) ? Object.fromEntries(JSON.parse(fs.readFileSync(f, "utf8")).results.map((r) => [r.id, r.ok])) : {}; };

describe("§14 리스크와 한계 · §15 대조", () => {
  T("AK01", "§14의 모든 행이 지키는 테스트를 가리키고 통과했으며, §15 '검증' 열의 테스트가 모두 있고 통과했고, '남은 일'에 이미 한 일이 없으며, 표의 E2E 수가 사실과 같음", async () => {
    const prd = fs.readFileSync(path.join(H.ROOT, "docs", "PRD.md"), "utf8");
    const sec = prd.split("## 14. 리스크와 한계")[1].split("\n## 15.")[0];
    const s15 = prd.split("\n## 15.")[1].split("\n## ")[0];
    const rows = sec.split("\n").filter((l) => /^\| [^-]/.test(l) && !/^\| 리스크 \|/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const unmapped = rows.filter((r) => !Object.keys(RISK_GUARDS).some((k) => r[1].startsWith(k))).map((r) => r[1]);
    const cache = {};
    const pyNames = Object.values(RISK_GUARDS).flat().filter((x) => x.startsWith("pytest:")).map((x) => x.slice(7));
    let pyOk = true;
    try { execFileSync("python3", ["-m", "pytest", "-q", "-k", pyNames.join(" or "), "backend/tests"], { cwd: H.ROOT, stdio: "pipe" }); } catch { pyOk = false; }
    const okOf = (s, id) => (s === "pytest" ? pyOk : s === "round24" ? results.find((r) => r.id === id)?.ok : (cache[s] ??= latestOf(s))[id]);
    const failing = [];
    for (const [risk, refs] of Object.entries(RISK_GUARDS)) for (const ref of refs) { const [s, id] = ref.split(/:(.+)/); const ok = okOf(s, id); if (ok !== true) failing.push(`${risk} ← ${ref}(${ok === undefined ? "없음" : "실패"})`); }
    const head = s15.split("\n").find((l) => /^\| # \|/.test(l)).split("|").map((x) => x.trim());
    const vcol = head.indexOf("검증"), ncol = head.indexOf("남은 일");
    const s15rows = s15.split("\n").filter((l) => /^\| [0-9①-⑩]/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const suiteOf = { AH: "round21", AI: "round22", AJ: "round23", AK: "round24" };
    const verifyBad = [];
    for (const r of s15rows) {
      const ids = [];
      for (const m of (r[vcol] || "").matchAll(/\b(A[HIJK])(\d\d)(?:~A[HIJK](\d\d))?/g)) { const x = Number(m[2]), z = Number(m[3] || m[2]); for (let i = x; i <= z; i++) ids.push(`${m[1]}${String(i).padStart(2, "0")}`); }
      for (const id of ids) if (okOf(suiteOf[id.slice(0, 2)], id) !== true) verifyBad.push(`§15 ${r[1]} ← ${id}`);
    }
    const stale = s15rows.filter((r) => DONE_IN_V124.some((re) => re.test(r[ncol] || ""))).map((r) => `${r[1]}: ${r[ncol]}`);
    const total = SUITES().filter((s) => s !== "round24").reduce((n, s) => n + Object.keys(latestOf(s)).length, 0) + results.length + 1;
    const stated = Number((sec.match(/E2E\(현재 (\d+)개\)/) || [])[1]);
    assert.deepEqual(unmapped, [], `지키는 테스트가 없는 리스크 행: ${unmapped.join(", ")}`);
    assert.deepEqual(failing, [], `대응이 지켜지지 않는 리스크 ${failing.length}건: ${failing.slice(0, 6).join(" / ")}`);
    assert.deepEqual(verifyBad, [], `§15 '검증' 열의 테스트가 없거나 실패: ${verifyBad.join(", ")}`);
    assert.deepEqual(stale, [], `§15 '남은 일'에 이미 한 일: ${stale.join(" / ")}`);
    assert.equal(stated, total, `§14가 말하는 E2E 수 ${stated} ≠ 실제 ${total}`);
    return { risks: rows.length, refs: Object.values(RISK_GUARDS).flat().length, e2e_total: total };
  });
});
