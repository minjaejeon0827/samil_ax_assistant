// 22차 E2E — PRD §14 리스크 대응이 실제로 지켜지는가 + §15 '남은 일' 중 이 환경에서 할 수 있는 것 + 다음 후보 ⑤⑥⑦.
//   §15-1 남은 일: SSO 로그아웃(RP-initiated)                       → AI02
//   §15-2 남은 일: 실패한 전송을 다시 보내는 화면                     → AI03
//   §15-3 남은 일: 스캔 PDF 글자 인식(OCR) · 영문 계약서              → AI04 · AI05
//   ⑤ 실제 LLM으로 계약서 요약(값 추출은 계속 규칙)                  → AI06
//   ⑥ 결재 뒤 AI 설명 별도 보관함                                     → AI07
//   ⑦ 분당 토큰 한도 대응                                             → AI08
//   §14 리스크와 한계: 표의 모든 행이 지키는 테스트를 가리키고, 그 테스트가 최근 실행에서 통과했는가, 표의 숫자가 사실인가 → AI01(맨 끝)
//   실제 사내 IdP·전자결재 연결, 권한표 정식 개정(§15-4)은 이 환경에서 할 수 없어 '남은 한계'로 둔다.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const H = require("./helpers.cjs");

const KEY = "e2e-key";
const IDP = "http://127.0.0.1:8953", ESIGN = "http://127.0.0.1:8963", LLM = "http://127.0.0.1:8908";
const CH_SECRET = "e2e-channel-secret-0123456789";
const USERS = "contract.choi:pw-co:CONTRACT_OWNER;ceo.kang:pw-ceo:GROUP_CEO";
const JWT = { AUTH_MODE: "jwt", USERS, JWT_SECRET: "e2e-secret-0123456789abcdef" };
const LLM_ENV = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `${LLM}/v1`, LLM_TIMEOUT_S: "5" };
const DIST = path.join(H.ROOT, "frontend", "dist-docker");
const SAMPLES = path.join(H.ROOT, "data", "samples", "contracts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aurora22-"));
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, { token, body } = {}) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const waitJob = async (base, r, ms = 60000) => { const b = await r.json(); if (!b.job_id) return { ...b, http: r.status }; const end = Date.now() + ms; while (Date.now() < end) { const j = await (await call(base, "GET", `/api/jobs/${b.job_id}`)).json(); if (j.status === "done" || j.status === "failed") return j; await new Promise((x) => setTimeout(x, 50)); } throw new Error("job timeout"); };
const snap = async (base) => (await call(base, "GET", "/api/snapshot")).json();
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); } return null; };
const upload = (base, file, name) => { const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync(file)]), name ?? path.basename(file)); fd.append("actor", "CONTRACT_OWNER"); return fetch(`${base}/api/contracts`, { method: "POST", headers: { "X-API-Key": KEY }, body: fd }); };
const post = (u, body) => fetch(u, { method: "POST", body: JSON.stringify(body) });
const writing = (s) => s.cases.filter((c) => /작성 중/.test(String(c.llm)));
const settle = async (base, ms = 30000) => { const end = Date.now() + ms; let s; while (Date.now() < end) { s = await snap(base); if (!writing(s).length) return s; await new Promise((r) => setTimeout(r, 200)); } return s; };
const openApi = async (p, base) => {
  await p.goto(base); await p.waitForSelector(".top");
  await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
  await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(700);
};
let procs = [];
before(async () => {
  procs = [spawn("python3", [path.join(__dirname, "mock_oidc.py"), "8953", "aurora-desk", "oidc-secret"], { stdio: "ignore", detached: true }),
    spawn("python3", [path.join(__dirname, "mock_eapproval.py"), "8963", CH_SECRET], { stdio: "ignore", detached: true }),
    spawn("python3", [path.join(__dirname, "mock_llm.py"), "8908"], { stdio: "ignore", detached: true })];
  await H.waitHttp(`${IDP}/jwks`); await H.waitHttp(`${ESIGN}/__received`); await H.waitHttp(`${LLM}/__stats`);
  execFileSync("python3", [path.join(__dirname, "make_scanned_pdf.py"), path.join(SAMPLES, "logistics_3pl_renewal.md"), path.join(TMP, "scanned_logistics.pdf")]);
});
after(() => { H.writeReport("round22", { results }); for (const p of procs) { try { process.kill(-p.pid); } catch { /* gone */ } } });

describe("§15 남은 일", () => {
  T("AI02", "§15-1 SSO 로그아웃: SSO로 들어온 사람이 로그아웃하면 IdP의 로그아웃(id_token_hint 확인)까지 거쳐 화면으로 돌아오고, 그 토큰은 서버에서도 무효", async () => {
    const base = "http://localhost:8160";
    const api = await H.startApi(8160, { ...JWT, OIDC_ISSUER: IDP, OIDC_CLIENT_ID: "aurora-desk", OIDC_CLIENT_SECRET: "oidc-secret", OIDC_REDIRECT_URI: `${base}/`, SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      await post(`${IDP}/__user`, { sub: "u-2001", preferred_username: "lee.fin@aurora.example", aurora_role: "FINANCE" });
      await openApi(p, base);
      await p.locator('[data-testid="login-sso"]').click();
      await p.locator('[data-testid="whoami"]').waitFor({ timeout: 10000 });
      const token = await p.evaluate(() => JSON.parse(sessionStorage.getItem("aurora-desk-session") || "{}").token);
      const before = (await (await fetch(`${IDP}/__stats`)).json()).logouts.length;
      await p.locator('[data-testid="logout"]').click();
      // 로그인 창은 IdP로 이동하기 전에도 잠깐 보이므로(세션을 먼저 지움), IdP 기록이 생길 때까지 기다린 뒤 돌아온 화면을 본다
      const st = (await until(async () => { const l = (await (await fetch(`${IDP}/__stats`)).json()).logouts.slice(before); return l.length ? l : null; }, 10000)) ?? [];
      await p.waitForLoadState("load").catch(() => {});
      const back = await p.locator('[data-testid="login-sso"]').waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
      const tok = (await call(base, "GET", "/api/revision", { token })).status;
      assert.equal(st.length, 1, "IdP 로그아웃을 거치지 않음(IdP에는 로그인이 남아 있음)");
      assert.ok(st[0].ok, "IdP가 id_token_hint를 확인하지 못함");
      assert.equal(st[0].sub, "u-2001");
      assert.ok(back && p.url().startsWith(base), `화면으로 돌아오지 않음: ${p.url()}`);
      assert.equal(tok, 401, "로그아웃한 SSO 토큰이 서버에서 계속 통함");
    } finally { await B.browser.close(); H.stop(api); }
  });

  T("AI03", "§15-2 실패한 전송 다시 보내기: 전자결재가 계속 실패하면 화면의 '외부 채널 전송'에 실패로 보이고, 복구 뒤 '다시 보내기'를 누르면 같은 event_id로 전달되며 감사 기록이 남음", async () => {
    const base = "http://localhost:8161";
    const api = await H.startApi(8161, { CHANNEL: "webhook", CHANNEL_SECRET: CH_SECRET, ESIGN_WEBHOOK_URL: `${ESIGN}/hooks/approval`, CHANNEL_BACKOFF_S: "0.1,0.1,0.1",
      SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      await post(`${ESIGN}/__reset`, {}); await post(`${ESIGN}/__mode`, { fail: 100 });
      await call(base, "POST", "/api/reset");
      await openApi(p, base);
      await p.locator('[data-testid="role-select"]').selectOption("CONTRACT_OWNER");
      await waitJob(base, await call(base, "POST", "/api/events", { body: { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" } }));
      const failed = p.locator('[data-testid="deliveries"] [data-testid^="redeliver-"]');
      const shown = await failed.first().waitFor({ timeout: 12000 }).then(() => true).catch(() => false);
      assert.ok(shown, "실패한 전송이 화면에 보이지 않음(다시 보낼 방법이 없음)");
      const eid = (await failed.first().getAttribute("data-testid")).replace("redeliver-", "");
      await post(`${ESIGN}/__mode`, { fail: 0 });
      await failed.first().click();
      const got = await until(async () => (await (await fetch(`${ESIGN}/__received`)).json()).received.find((r) => r.event === "approval.requested"), 8000);
      const sent = await p.locator(`[data-testid="delivery-${eid}"]`).filter({ hasText: "보냄" }).waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
      const audit = (await snap(base)).audit.filter((a) => a.topic === "channel.retried");
      assert.ok(got && got.sig_ok, "다시 보내기로 전달되지 않음");
      assert.equal(got.idem, eid, "다시 보낼 때 event_id(Idempotency-Key)가 바뀜 — 받는 쪽이 중복을 거를 수 없음");
      assert.ok(sent, "화면의 상태가 '보냄'으로 바뀌지 않음");
      assert.equal(audit.length, 1, "다시 보내기 감사 기록 없음");
      assert.deepEqual(p.errors, []);
    } finally { await B.browser.close(); H.stop(api); }
  });

  T("AI04", "§15-3 스캔 PDF: 글자층이 없는 계약서 PDF도 글자 인식(OCR)으로 기간·통보 기한·금액·위약금을 뽑고, 'OCR로 읽음 — 숫자 확인' 표시를 남김", async () => {
    const base = "http://localhost:8162";
    const api = await H.startApi(8162, {});
    try {
      await call(base, "POST", "/api/reset");
      const j = await waitJob(base, await upload(base, path.join(TMP, "scanned_logistics.pdf")), 90000);
      const t = j.result?.terms || {};
      assert.equal(j.status, "done", `스캔 PDF 처리: ${j.http ?? ""} ${j.detail ?? j.message}`);
      assert.equal(t.notice_deadline, "2026-08-01"); assert.equal(t.expiry, "2026-08-31");
      assert.equal(t.annual_fee_krw, 9.6e8); assert.equal(t.penalty_pct, 20);
      assert.ok((j.result.checks || []).some((c) => c.id === "OCR_USED"), "OCR로 읽었다는 표시가 없음");
      return { ocr: true };
    } finally { H.stop(api); }
  });

  T("AI05", "§15-3 영문 계약서: 만료일·자동 갱신·'60일 전' 통보 기한·KRW 금액·조기 해지 위약금·월 지급일을 뽑고, 결재자는 같은 엔진으로 정해짐(연 15억 → 그룹 CEO)", async () => {
    const base = "http://localhost:8163";
    const api = await H.startApi(8163, {});
    try {
      await call(base, "POST", "/api/reset");
      const j = await waitJob(base, await upload(base, path.join(SAMPLES, "logistics_en_renewal.md")));
      const t = j.result?.terms || {};
      const c = (await snap(base)).cases.find((x) => x.type === "RENEWAL");
      const raw = JSON.stringify(await snap(base));
      assert.deepEqual({ exp: t.expiry, renew: t.auto_renew, nd: t.notice_deadline, fee: t.annual_fee_krw, pen: t.penalty_pct, day: t.payment?.monthly_day },
        { exp: "2026-09-30", renew: true, nd: "2026-08-01", fee: 1.5e9, pen: 40, day: 25 });
      assert.equal(t.counterparty, "Harbor Fulfillment Inc.");
      assert.equal(c?.approval?.approver, "GROUP_CEO");
      assert.doesNotMatch(raw, /ops@harbor-fulfillment|010-3456-7890/, "영문 계약서의 연락처가 그대로 노출됨");
    } finally { H.stop(api); }
  });
});

describe("다음 후보 ⑤⑥⑦", () => {
  T("AI06", "⑤ 계약서 요약: LLM이 계약서 요약을 쓰고(값은 규칙 추출 그대로) 화면에 'LLM 요약'으로 보이며, LLM이 지어낸 수치를 쓰면 근거 기반 요약으로 바뀜", async () => {
    const base = "http://localhost:8164";
    const api = await H.startApi(8164, { ...LLM_ENV, SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      await post(`${LLM}/__mode`, { mode: "ok" });
      await call(base, "POST", "/api/reset");
      const a = await waitJob(base, await upload(base, path.join(SAMPLES, "agency_media_renewal.md")));
      await post(`${LLM}/__mode`, { mode: "hallucinate" });
      const b = await waitJob(base, await upload(base, path.join(SAMPLES, "logistics_3pl_renewal.md")));
      const s = await snap(base);
      const ag = s.cases.find((c) => c.title.includes("블루웨이브")), lg = s.cases.find((c) => c.title.includes("한빛로지스"));
      const sa = ag?.decision?.contract_summary || {}, sb = lg?.decision?.contract_summary || {};
      await openApi(p, base);
      await p.locator(".cases .case-item", { hasText: "블루웨이브" }).click();
      const ui = await p.locator('[data-testid="contract-summary"]').innerText().catch(() => "");
      assert.match(String(sa.llm), /^openai/, `대행 계약 요약: ${JSON.stringify(sa).slice(0, 80)}`);
      assert.ok(sa.text, "요약 글 없음");
      assert.match(String(sb.llm), /대체문/, `지어낸 수치를 쓴 요약이 그대로: ${sb.llm}`);
      assert.doesNotMatch(String(sb.text), /37\.5억|99\.9%/, "지어낸 수치가 요약에 남음");
      assert.equal(a.result.terms.annual_fee_krw, 1.08e9); assert.equal(b.result.terms.annual_fee_krw, 9.6e8);   // 값은 LLM과 무관
      assert.match(ui, /요약/); assert.match(ui, /LLM/);
    } finally { await post(`${LLM}/__mode`, { mode: "ok" }); await B.browser.close(); H.stop(api); }
  });

  T("AI07", "⑥ AI 설명 보관함: 결재 뒤 도착한 AI 설명은 재상신으로 결재 서류에서 빠져도 그 건의 보관함에 결재 정보와 함께 남고, 화면에서 볼 수 있음", async () => {
    const base = "http://localhost:8165";
    const api = await H.startApi(8165, { ...LLM_ENV, SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      await post(`${LLM}/__mode`, { mode: "echo" });
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { body: { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" } }));
      await waitJob(base, await call(base, "POST", "/api/events", { body: { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" } }));
      const asIs = Object.fromEntries((await snap(base)).cases.filter((c) => c.decision).map((c) => [c.id, c.decision.approver]));
      await post(`${LLM}/__mode`, { mode: "echo", latency: 1.5 });
      await call(base, "POST", "/api/conditions", { body: { actor: "FINANCE", cash_assumption: "LEGACY45" } });
      const t = writing(await snap(base)).find((c) => c.state === "PENDING_APPROVAL" && c.approval?.approver === "MASIL_CEO" && asIs[c.id] === "GROUP_CEO" && !c.decision?.regulation?.findings?.length);   // 30차(AP-07): 위반 카피가 남은 기안(PLAN-001)은 승인 불가라 제외
      assert.ok(t, "시험 전제");
      await call(base, "POST", `/api/cases/${t.id}/decision`, { body: { actor: "MASIL_CEO", action: "approve", comment: "작성 중 결재" } });
      await settle(base);
      await post(`${LLM}/__mode`, { mode: "echo" });
      await call(base, "POST", "/api/conditions", { body: { actor: "FINANCE", cash_assumption: "AS_IS" } });   // 재상신 → 결재 서류에서 늦은 설명은 빠짐
      const c = (await settle(base)).cases.find((x) => x.id === t.id);
      const arc = c.explain_archive || [];
      await openApi(p, base);
      await p.locator('[data-testid="role-select"]').selectOption("GROUP_CEO");
      await p.locator(`[data-testid="case-${t.target_id}"]`).click();
      const box = await p.locator('[data-testid="explain-archive"]').innerText().catch(() => "");
      assert.equal(c.late_explanation ?? null, null, "재상신 서류에 옛 설명이 남음(19차 회귀)");
      assert.equal(arc.length, 1, `보관함 ${arc.length}건`);
      assert.match(arc[0].text, /■ 결론/); assert.equal(arc[0].approval?.decided_by, "MASIL_CEO");
      assert.match(box, /보관함/); assert.match(box, /Masil 대표/);
    } finally { await post(`${LLM}/__mode`, { mode: "ok" }); await B.browser.close(); H.stop(api); }
  });

  T("AI08", "⑦ 분당 토큰 한도: 제공자가 토큰 한도(시험: 3초당)를 두면, 서버가 미리 속도를 맞춰 429를 거의 받지 않고 기안 25건 모두 LLM 설명", async () => {
    const base = "http://localhost:8166";
    const api = await H.startApi(8166, { ...LLM_ENV, LLM_TPM: "24000", LLM_TPM_WINDOW_S: "3" });
    try {
      await post(`${LLM}/__mode`, { mode: "ok", tpm: 24000, window: 3 });
      await call(base, "POST", "/api/reset");
      const t0 = Date.now();
      await waitJob(base, await call(base, "POST", "/api/events", { body: { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" } }), 90000);
      const ms = Date.now() - t0;
      const st = await (await fetch(`${LLM}/__stats`)).json();
      const bad = (await snap(base)).cases.filter((c) => !/^openai/.test(String(c.llm))).map((c) => `${c.target_id}:${c.llm}`);
      H.recordPerf("분당 토큰 한도에서 25건", ms, { r429: st.r429, tokens: st.tok_total });
      assert.deepEqual(bad, [], `LLM 설명이 아닌 건 ${bad.length}건: ${bad.slice(0, 3).join(", ")}`);
      assert.ok(st.r429 <= 3, `429 ${st.r429}회 — 한도를 넘겨 보내고 거절당함(제공자에 따라 계정 제한 위험)`);
      assert.ok(ms < 15000, `작업 ${ms}ms — 오프라인 단계까지 토큰 한도에 세면 18.6s(22차에서 찾은 결함)`);
      return { r429: st.r429, job_ms: ms, tokens: st.tok_total };
    } finally { await post(`${LLM}/__mode`, { mode: "ok" }); H.stop(api); }
  });
});

// ---------------- §14 리스크와 한계 ----------------
// 행 이름(앞부분) → 그 위험을 지키는 테스트. 'suite:ID'는 e2e/reports/<suite>.json, 'pytest:이름'은 단위 테스트, 'round22:ID'는 이번 실행.
// 행 ↔ 테스트 짝은 e2e/risk_guards.cjs(23차와 함께 씀). 22차보다 뒤에 실행되는 묶음(round23)의 짝은 여기서 보지 않는다.
const RISK_GUARDS = Object.fromEntries(Object.entries(require("./risk_guards.cjs").RISK_GUARDS).map(([k, v]) => [k, v.filter((r) => !/^round(2[3-8]|30):/.test(r))]));
const SUITES = () => (fs.readFileSync(path.join(__dirname, "run_all.sh"), "utf8").match(/for s in ([^;]+);/) || [, ""])[1].trim().split(/\s+/);

describe("§14 리스크와 한계", () => {
  T("AI01", "§14의 모든 리스크 행이 그것을 지키는 테스트를 가리키고 그 테스트가 최근 실행에서 통과했으며, 표에 적힌 E2E 수와 '앞으로 할 일'이 사실과 같음", async () => {
    const prd = fs.readFileSync(path.join(H.ROOT, "docs", "PRD.md"), "utf8");
    const sec = prd.split("## 14. 리스크와 한계")[1].split("\n## 15.")[0];
    const rows = sec.split("\n").filter((l) => /^\| [^-]/.test(l) && !/^\| 리스크 \|/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const unmapped = rows.filter((r) => !Object.keys(RISK_GUARDS).some((k) => r[1].startsWith(k))).map((r) => r[1]);
    const latest = {};
    for (const s of new Set(Object.values(RISK_GUARDS).flat().map((x) => x.split(":")[0]).filter((x) => x !== "pytest" && x !== "round22"))) {
      const f = path.join(__dirname, "reports", `${s}.json`);
      latest[s] = fs.existsSync(f) ? Object.fromEntries(JSON.parse(fs.readFileSync(f, "utf8")).results.map((r) => [r.id, r.ok])) : {};
    }
    const pyNames = Object.values(RISK_GUARDS).flat().filter((x) => x.startsWith("pytest:")).map((x) => x.slice(7));
    let pyOk = true;
    try { execFileSync("python3", ["-m", "pytest", "-q", "-k", pyNames.join(" or "), "backend/tests"], { cwd: H.ROOT, stdio: "pipe" }); } catch { pyOk = false; }
    const failing = [];
    for (const [risk, refs] of Object.entries(RISK_GUARDS)) {
      for (const ref of refs) {
        const [s, id] = ref.split(/:(.+)/);
        const ok = s === "pytest" ? pyOk : s === "round22" ? results.find((r) => r.id === id)?.ok : latest[s]?.[id];
        if (ok !== true) failing.push(`${risk} ← ${ref}(${ok === undefined ? "없음" : "실패"})`);
      }
    }
    // 전체 E2E 수 = run_all.sh의 다른 묶음(최근 실행 보고서) + 이번 22차(지금 실행 중인 결과 + 이 테스트)
    const total = SUITES().filter((s) => s !== "round22").reduce((n, s) => { const f = path.join(__dirname, "reports", `${s}.json`); return n + (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).results.length : 0); }, 0) + results.length + 1;
    const stated = Number((sec.match(/E2E\(현재 (\d+)개\)/) || [])[1]);
    const stale = rows.filter((r) => /늘릴 때는 변경 번호를 MySQL로 옮김/.test(r[3])).map((r) => r[1]);   // v1.15에서 이미 구현
    assert.deepEqual(unmapped, [], `지키는 테스트가 없는 리스크 행: ${unmapped.join(", ")}`);
    assert.deepEqual(failing, [], `대응이 지켜지지 않는 리스크 ${failing.length}건`);
    assert.equal(stated, total, `§14가 말하는 E2E 수 ${stated} ≠ 실제 ${total}`);
    assert.deepEqual(stale, [], `이미 한 일을 '대응 예정'으로 적은 행: ${stale.join(", ")}`);
    return { risks: rows.length, refs: Object.values(RISK_GUARDS).flat().length, e2e_total: total };
  });
});
