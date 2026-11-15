// 23차 E2E — v1.22에 새로 넣은 것이 기존 보장을 깨뜨리지 않는가(§14 '새 기능이 기존 보장을 깨뜨림'·'새 칸의 수명') + §15 '남은 일' + §14 리스크 표 대조.
//   §15-1 남은 일: IdP가 먼저 끊는 로그아웃(Back-Channel Logout)                          → AJ02
//   §14 새 칸의 수명 × v1.22 새 저장 항목: '처음부터' 뒤에도 SSO 로그아웃·전자결재 멱등이 지켜지는가 → AJ03
//   §15-2 다시 보내기 × 동시 클릭(두 사람·두 탭)                                          → AJ04
//   §15-3 OCR × 여러 쪽·적대적 PDF(자원 고갈) — 사용자가 기다리는 시간과 서버 메모리      → AJ05
//   §15-3 남은 일: 조항 문구 변형 — 못 찾으면 '확인 필요', 틀린 값은 0(§14 계약서 추출의 약속) → AJ06
//   §15 ⑦ 남은 일: 서버 여러 대의 공동 토큰 한도                                          → AJ07
//   v1.22 새 화면(외부 채널 전송·계약서 요약·AI 설명 보관함) × 접근성·휴대폰·키보드         → AJ08
//   §14 리스크 표 대조(22차 AI01 확장): 행 ↔ 테스트, §15 '검증' 열의 테스트, '남은 일'이 이미 한 일을 적지 않는가 → AJ01(맨 끝)
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const H = require("./helpers.cjs");

const KEY = "e2e-key";
const IDP = "http://127.0.0.1:8955", ESIGN = "http://127.0.0.1:8965", LLM = "http://127.0.0.1:8910";
const CH_SECRET = "e2e-channel-secret-0123456789";
const USERS = "contract.choi:pw-co:CONTRACT_OWNER;ceo.kang:pw-ceo:GROUP_CEO";
const JWT = { AUTH_MODE: "jwt", USERS, JWT_SECRET: "e2e-secret-0123456789abcdef" };
const OIDC = (base) => ({ OIDC_ISSUER: IDP, OIDC_CLIENT_ID: "aurora-desk", OIDC_CLIENT_SECRET: "oidc-secret", OIDC_REDIRECT_URI: `${base}/` });
const LLM_ENV = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `${LLM}/v1`, LLM_TIMEOUT_S: "5" };
const CH_ENV = { CHANNEL: "webhook", CHANNEL_SECRET: CH_SECRET, ESIGN_WEBHOOK_URL: `${ESIGN}/hooks/approval`, CHANNEL_BACKOFF_S: "0.1,0.1,0.1", ESIGN_USERS: "kim.ceo:GROUP_CEO;han.masil:MASIL_CEO" };
const DIST = path.join(H.ROOT, "frontend", "dist-docker");
const SAMPLES = path.join(H.ROOT, "data", "samples", "contracts");
const AXE = require.resolve("axe-core/axe.min.js", { paths: [path.join(H.ROOT, "frontend")] });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aurora23-"));
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, { token, body } = {}) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const jobOf = async (base, id, ms = 60000, seen = [], token) => { const end = Date.now() + ms; while (Date.now() < end) { const j = await (await call(base, "GET", `/api/jobs/${id}`, { token })).json(); if (j.message) seen.push(j.message); if (j.status === "done" || j.status === "failed") return j; await new Promise((x) => setTimeout(x, 100)); } throw new Error("job timeout"); };
const waitJob = async (base, r, ms = 60000, token) => { const b = await r.json(); if (!b.job_id) return { ...b, http: r.status }; return jobOf(base, b.job_id, ms, [], token); };
const snap = async (base, token) => (await call(base, "GET", "/api/snapshot", { token })).json();
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 150)); } return null; };
const upload = (base, file, name, token) => { const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync(file)]), name ?? path.basename(file)); fd.append("actor", "CONTRACT_OWNER"); return fetch(`${base}/api/contracts`, { method: "POST", headers: { "X-API-Key": KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: fd }); };
const post = (u, body) => fetch(u, { method: "POST", body: JSON.stringify(body) });
const writing = (s) => s.cases.filter((c) => /작성 중/.test(String(c.llm)));
const settle = async (base, ms = 30000) => { const end = Date.now() + ms; let s; while (Date.now() < end) { s = await snap(base); if (!writing(s).length) return s; await new Promise((r) => setTimeout(r, 200)); } return s; };
const openApi = async (p, base) => {
  await p.goto(base); await p.waitForSelector(".top");
  await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
  await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(700);
};
/** 화면 없이 SSO 로그인(인가 코드 흐름을 그대로 — IdP 이동·콜백) → { token, refresh_token } */
const ssoLogin = async (base) => {
  const start = await (await call(base, "GET", "/api/auth/oidc/start")).json();
  const r = await fetch(start.url, { redirect: "manual" });
  const q = new URL(r.headers.get("location")).searchParams;
  return (await call(base, "POST", "/api/auth/oidc/callback", { body: { code: q.get("code"), state: q.get("state") } })).json();
};
const longScan = path.join(TMP, "long_scan_11p.pdf"), bigPage = path.join(TMP, "big_page.pdf");
let procs = [];
before(async () => {
  procs = [spawn("python3", [path.join(__dirname, "mock_oidc.py"), "8955", "aurora-desk", "oidc-secret"], { stdio: "ignore", detached: true }),
    spawn("python3", [path.join(__dirname, "mock_eapproval.py"), "8965", CH_SECRET], { stdio: "ignore", detached: true }),
    spawn("python3", [path.join(__dirname, "mock_llm.py"), "8910"], { stdio: "ignore", detached: true })];
  await H.waitHttp(`${IDP}/jwks`); await H.waitHttp(`${ESIGN}/__received`); await H.waitHttp(`${LLM}/__stats`);
  // 11쪽 스캔 계약서: 앞에 본문, 가운데 부속서(서비스 수준) 9쪽, 위약금 조항은 마지막 쪽
  const src = fs.readFileSync(path.join(SAMPLES, "logistics_3pl_renewal.md"), "utf8").split("\n");
  const filler = Array.from({ length: 230 }, (_, i) => `부속서 A-${String(i + 1).padStart(3, "0")}. 창고 운영 서비스 수준 항목 ${i + 1}: 입고 검수, 보관 온도 기록, 출고 정확도 점검을 매일 기록한다.`);
  fs.writeFileSync(path.join(TMP, "long.md"), [...src.filter((l) => !/위약/.test(l)), "", "## 부속서 A(서비스 수준)", ...filler, "", "## 해지", ...src.filter((l) => /위약/.test(l))].join("\n"));
  execFileSync("python3", [path.join(__dirname, "make_scanned_pdf.py"), path.join(TMP, "long.md"), longScan]);
  // 8KB짜리 '폭탄': 글자 없는 60인치 × 60인치 페이지 3장(200dpi로 그리면 쪽당 1억 4천만 화소)
  execFileSync("python3", ["-c", `from PIL import Image\nim=Image.new("1",(300,300),1)\nim.save(${JSON.stringify(bigPage)}, resolution=5.0, save_all=True, append_images=[im.copy(), im.copy()])`]);
});
after(() => { H.writeReport("round23", { results }); for (const p of procs) { try { process.kill(-p.pid); } catch { /* gone */ } } });

describe("§15 남은 일 · 새 기능 × 기존 보장", () => {
  T("AJ02", "§15-1 IdP가 먼저 끊는 로그아웃(Back-Channel): IdP가 보낸 서명된 logout_token이면 그 SSO 로그인의 접근·리프레시 토큰이 모두 끊기고 열린 화면은 로그인 창으로, 위조·nonce·재전송은 거부", async () => {
    const base = "http://localhost:8170";
    const api = await H.startApi(8170, { ...JWT, ...OIDC(base), SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      await post(`${IDP}/__user`, { sub: "u-3001", preferred_username: "kim.ceo@aurora.example", aurora_role: "GROUP_CEO" });
      await openApi(p, base);
      await p.locator('[data-testid="login-sso"]').click();
      await p.locator('[data-testid="whoami"]').waitFor({ timeout: 10000 });
      const pageTok = await p.evaluate(() => JSON.parse(sessionStorage.getItem("aurora-desk-session") || "{}").token);
      const other = await ssoLogin(base);   // 같은 사람의 프로그램 로그인(리프레시 토큰) — sub로 끊으면 함께 끊겨야 함
      const bc = (body) => post(`${IDP}/__backchannel`, { to: `${base}/api/auth/oidc/backchannel`, sub: "u-3001", ...body }).then((r) => r.json());
      const bad = [await bc({ mode: "bad_sig" }), await bc({ mode: "no_event" }), await bc({ mode: "with_nonce" })].map((r) => r.status);
      const stillOk = (await call(base, "GET", "/api/revision", { token: pageTok })).status;
      const ok = await bc({ mode: "ok", no_sid: true });       // sid 없이 sub만 → 그 사람의 SSO 로그인 전부(OIDC Back-Channel Logout 1.0 §2.4)
      const replay = await bc({ mode: "replay" });
      const after = (await call(base, "GET", "/api/revision", { token: pageTok })).status;
      const rt = (await call(base, "POST", "/api/auth/token", { body: { refresh_token: other.refresh_token } })).status;
      const kicked = await p.locator('[data-testid="login-sso"]').waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
      const audit = (await snap(base, (await (await call(base, "POST", "/api/auth/login", { body: { user: "ceo.kang", password: "pw-ceo" } })).json()).token)).audit.filter((a) => a.topic === "auth.backchannel_logout");
      assert.equal(ok.status, 200, `정상 logout_token을 받지 않음(${ok.status} ${ok.body})`);
      assert.deepEqual(bad, [400, 400, 400], `위조·events 없음·nonce 있는 logout_token: ${bad}`);
      assert.equal(stillOk, 200, "거부한 logout_token이 로그인을 끊음");
      assert.equal(after, 401, "IdP가 로그아웃시켰는데 접근 토큰이 계속 통함");
      assert.equal(rt, 401, "IdP가 로그아웃시켰는데 리프레시 토큰이 계속 통함");
      assert.equal(replay.status, 400, "같은 logout_token 재전송을 거부하지 않음");
      assert.ok(kicked, "열린 화면이 로그인 창으로 돌아가지 않음");
      assert.ok(audit.length >= 1, "감사 기록 없음");
      return { rejected: bad.length };
    } finally { await B.browser.close(); H.stop(api); }
  });

  T("AJ03", "§14 새 칸의 수명: '처음부터'를 해도 v1.22의 보안·연동 상태가 지켜짐 — SSO 로그아웃은 여전히 IdP까지, 이미 처리한 전자결재 콜백을 다시 받아도 새로 생긴 같은 번호의 건을 결재하지 않음", async () => {
    const base = "http://localhost:8171";
    const api = await H.startApi(8171, { ...JWT, ...OIDC(base), ...CH_ENV });
    try {
      await post(`${IDP}/__user`, { sub: "u-3002", preferred_username: "kim.ceo@aurora.example", aurora_role: "GROUP_CEO" });
      const s = await ssoLogin(base);
      await call(base, "POST", "/api/reset", { token: s.token });
      await waitJob(base, await call(base, "POST", "/api/events", { token: s.token, body: { kind: "CONTRACT_RENEWAL_NOTICE" } }), 60000, s.token);
      const c1 = (await snap(base, s.token)).cases.find((c) => c.state === "PENDING_APPROVAL");
      const cbBody = { event_id: "esign-23-001", case_id: c1.id, action: "approve", user: "kim.ceo", comment: "전자결재 승인", expected_version: c1.version };
      const first = await (await post(`${ESIGN}/__callback`, { target: `${base}/api/integrations/approval`, body: cbBody, secret: CH_SECRET })).json();
      await call(base, "POST", "/api/reset", { token: s.token });                         // 처음부터
      await waitJob(base, await call(base, "POST", "/api/events", { token: s.token, body: { kind: "CONTRACT_RENEWAL_NOTICE" } }), 60000, s.token);
      const c2 = (await snap(base, s.token)).cases.find((c) => c.id === c1.id);
      const again = await (await post(`${ESIGN}/__callback`, { target: `${base}/api/integrations/approval`, body: cbBody, secret: CH_SECRET })).json();   // 전자결재의 재시도(같은 event_id)
      const c3 = (await snap(base, s.token)).cases.find((c) => c.id === c1.id);
      const out = await (await call(base, "POST", "/api/auth/logout", { token: s.token })).json();
      assert.ok(first.status === 200 && first.body.ok, `시험 전제: 첫 콜백 ${JSON.stringify(first)}`);
      assert.equal(c2.state, "PENDING_APPROVAL", "시험 전제");
      assert.equal(c3.state, "PENDING_APPROVAL", `'처음부터' 전의 전자결재 승인이 새로 생긴 ${c1.id}를 결재함(${JSON.stringify(again.body)})`);
      assert.ok(again.body?.duplicate, "재전송을 중복으로 알아보지 못함");
      assert.ok(typeof out.logout_url === "string" && out.logout_url.includes("id_token_hint="), "'처음부터' 뒤 SSO 로그아웃이 IdP로 이어지지 않음(IdP 로그인이 남음)");
    } finally { H.stop(api); }
  });

  T("AJ04", "§15-2 다시 보내기 × 동시 클릭: 두 사람(또는 두 탭)이 같은 실패 건을 동시에 다시 보내면 한 번만 보내고, 나머지는 '이미 보내는 중'으로 안내", async () => {
    const base = "http://localhost:8172";
    const api = await H.startApi(8172, { ...CH_ENV });
    try {
      await post(`${ESIGN}/__reset`, {}); await post(`${ESIGN}/__mode`, { fail: 100 });
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { body: { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" } }));
      const failed = await until(async () => ((await (await call(base, "GET", "/api/integrations/deliveries")).json()).items || []).find(([, v]) => v.status === "failed"), 10000);
      assert.ok(failed, "시험 전제: 실패한 전송");
      const eid = failed[0];
      await post(`${ESIGN}/__reset`, {});
      const rs = await Promise.all(["CONTRACT_OWNER", "GROUP_CEO", "CONTRACT_OWNER"].map((actor) => call(base, "POST", `/api/integrations/deliveries/${eid}/retry`, { body: { actor } })));
      const codes = rs.map((r) => r.status).sort();
      const msg = (await Promise.all(rs.map((r) => r.json()))).map((b) => b.detail).filter(Boolean)[0] || "";
      await until(async () => (await (await fetch(`${ESIGN}/__received`)).json()).received.length >= 1, 5000);
      await new Promise((r) => setTimeout(r, 800));
      const got = (await (await fetch(`${ESIGN}/__received`)).json()).received.filter((r) => r.idem === eid).length;
      const audit = (await snap(base)).audit.filter((a) => a.topic === "channel.retried").length;
      assert.deepEqual(codes, [200, 409, 409], `동시 다시 보내기 응답 ${codes}`);
      assert.match(msg, /보내는 중|이미/, `나머지 사람에게 이유를 알리지 않음: ${msg}`);
      assert.equal(got, 1, `같은 결재 요청을 ${got}번 보냄`);
      assert.equal(audit, 1, `다시 보내기 감사 기록 ${audit}건`);
    } finally { H.stop(api); }
  });

  T("AJ05", "§15-3 OCR × 여러 쪽·적대적 PDF: 11쪽 스캔은 올리자마자 접수(진행 안내)되고 마지막 쪽의 위약금까지 읽으며, 쪽수 한도를 넘으면 그 사실을 남기고, 8KB짜리 초대형 페이지 PDF는 서버 자원을 쓰지 않고 빨리 거절", async () => {
    const base = "http://localhost:8173", base2 = "http://localhost:8174";
    const api = await H.startApi(8173, {}); const api2 = await H.startApi(8174, { OCR_MAX_PAGES: "8" });
    try {
      await call(base, "POST", "/api/reset"); await call(base2, "POST", "/api/reset");
      let t0 = Date.now();
      const r = await upload(base, longScan);
      const respMs = Date.now() - t0;
      const b = await r.json();
      const seen = [];
      const j = b.job_id ? await jobOf(base, b.job_id, 90000, seen) : { status: "failed", message: b.detail };
      const jobMs = Date.now() - t0;
      const t = j.result?.terms || {}, ids = (j.result?.checks || []).map((c) => c.id);
      // 쪽수 한도(8쪽)를 넘는 같은 파일
      const j2 = await waitJob(base2, await upload(base2, longScan), 90000);
      const tr = (j2.result?.checks || []).find((c) => c.id === "OCR_TRUNCATED");
      // 초대형 페이지
      t0 = Date.now();
      const rb = await upload(base, bigPage);
      const bb = await rb.json();
      const jb = bb.job_id ? await jobOf(base, bb.job_id, 120000) : { status: "failed", message: bb.detail, http: rb.status };
      const bigMs = Date.now() - t0;
      H.recordPerf("11쪽 스캔 업로드 응답", respMs, { job_ms: jobMs }); H.recordPerf("초대형 페이지 PDF", bigMs, {});
      assert.ok(respMs < 2000, `업로드 응답 ${respMs}ms — 글자 인식이 끝날 때까지 화면이 기다림(15초 넘으면 '응답 없음')`);
      assert.ok(seen.some((m) => /글자 인식/.test(m) && /\d+\s*\/\s*11/.test(m)), `진행 안내 없음: ${[...new Set(seen)].join(" | ")}`);
      assert.equal(j.status, "done", `11쪽 스캔: ${j.message}`);
      assert.equal(t.penalty_pct, 20, "마지막 쪽(11쪽)의 위약금을 읽지 못함");
      assert.ok(ids.includes("OCR_USED"));
      assert.ok(jobMs < 30000, `11쪽 글자 인식 ${jobMs}ms`);
      assert.ok(tr && /8쪽/.test(tr.text) && /11쪽/.test(tr.text), `쪽수 한도를 넘었다는 표시 없음: ${JSON.stringify((j2.result?.checks || []).map((c) => c.id))}`);
      assert.ok(bigMs < 10000, `초대형 페이지 PDF 처리 ${bigMs}ms(서버가 큰 이미지를 그리느라 자원 소모)`);
      assert.ok(/페이지|쪽|크기/.test(String(jb.message || jb.error || "")) || jb.status === "failed", `초대형 페이지 안내: ${JSON.stringify(jb).slice(0, 200)}`);
      return { resp_ms: respMs, job_ms: jobMs, big_ms: bigMs };
    } finally { H.stop(api); H.stop(api2); }
  });

  T("AJ06", "§15-3 조항 문구 변형(한국어 변형·영문 USD·영문 고정 기간·갱신 조항 없음): 값은 맞거나 '확인 필요' — 틀린 값 0, 외화 금액은 원화로 바꾸지 않고 표시", async () => {
    const base = "http://localhost:8175";
    const api = await H.startApi(8175, {});
    const V = path.join(SAMPLES, "variants");
    const EXPECT = {
      "logistics_kr_variant.md": { counterparty: /동해물류/, expiry: "2026-08-31", auto_renew: true, notice_deadline: "2026-07-02", annual_fee_krw: 9.6e8, penalty_pct: 30, monthly_day: "말일" },
      "freight_en_usd.md": { counterparty: /Pacific Freight/, expiry: "2026-09-30", auto_renew: true, notice_deadline: "2026-07-02", annual_fee_krw: null, penalty_pct: 25, monthly_day: 15, currency: "USD" },
      "service_en_fixed_term.md": { counterparty: /Northlight/, expiry: "2026-12-31", auto_renew: false, annual_fee_krw: 3e8, penalty_pct: 10 },
      "service_kr_no_clause.md": { counterparty: /하늘영상/, expiry: "2026-12-31", auto_renew: null, annual_fee_krw: 3e8, penalty_pct: 10 },
    };
    const wrong = [], missed = [], extra = [];
    try {
      await call(base, "POST", "/api/reset");
      for (const [f, exp] of Object.entries(EXPECT)) {
        const j = await waitJob(base, await upload(base, path.join(V, f)));
        const t = j.result?.terms || {}, checks = j.result?.checks || [];
        const got = { ...t, monthly_day: t.payment?.monthly_day ?? null };
        for (const [k, want] of Object.entries(exp)) {
          const v = got[k] ?? null;
          const okv = want instanceof RegExp ? want.test(String(v ?? "")) : v === want;
          if (okv) continue;
          if (v === null || v === undefined) missed.push(`${f}:${k}`); else wrong.push(`${f}:${k}=${JSON.stringify(v)}(기대 ${want})`);
        }
        if (f === "service_kr_no_clause.md") {
          if (checks.some((c) => c.id === "NO_AUTO_RENEW")) wrong.push(`${f}: 갱신 조항이 없는데 '자동 갱신 없음'으로 단정`);
          if (!checks.some((c) => c.id === "RENEWAL_MISSING" && c.level === "missing")) extra.push(`${f}: 갱신 조항 '확인 필요' 없음`);
        }
        if (f === "freight_en_usd.md" && !checks.some((c) => c.id === "FOREIGN_CURRENCY" && /USD/.test(c.text))) extra.push(`${f}: 외화(USD) 표시 없음`);
        if (JSON.stringify(j).match(/010-2222-3333|555-0147|billing@pacific/)) wrong.push(`${f}: 연락처 노출`);
      }
      assert.deepEqual(wrong, [], `틀린 값 ${wrong.length}건: ${wrong.join(" / ")}`);
      assert.deepEqual(extra, [], extra.join(" / "));
      assert.deepEqual(missed, [], `못 찾은 값 ${missed.length}건(확인 필요로 남음): ${missed.join(", ")}`);
      return { files: Object.keys(EXPECT).length };
    } finally { H.stop(api); }
  });

  T("AJ07", "§15 ⑦ 남은 일: 같은 MySQL을 쓰는 서버 2대가 한 제공자의 토큰 한도를 함께 셈(LLM_TPM_SCOPE=shared) — 두 서버가 동시에 LLM을 불러도 429 3회 이하, 모든 건 LLM 설명", async () => {
    const db = await H.startMariaDB(3323);
    if (!db) { if (process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음"); return { skipped: true }; }
    const A = "http://localhost:8176", Bs = "http://localhost:8177";
    const env = { ...db.env, ...LLM_ENV, LLM_TPM: "24000", LLM_TPM_WINDOW_S: "3", LLM_TPM_SCOPE: "shared" };
    const a = await H.startApi(8176, env), b = await H.startApi(8177, env);
    try {
      await post(`${LLM}/__mode`, { mode: "ok", tpm: 24000, window: 3 });
      await call(A, "POST", "/api/reset");
      await post(`${LLM}/__mode`, { mode: "ok", tpm: 24000, window: 3 });   // 통계 초기화
      const t0 = Date.now();
      const ja = call(A, "POST", "/api/events", { body: { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" } }).then((r) => waitJob(A, r, 120000));
      await until(async () => (await snap(Bs)).cases.length >= 25, 20000);
      await call(Bs, "POST", "/api/conditions", { body: { actor: "FINANCE", cash_assumption: "CONSERVATIVE" } });   // 다른 서버가 같은 건들을 다시 분석(LLM)
      await ja;
      const s = await settle(Bs, 120000);
      const ms = Date.now() - t0;
      const st = await (await fetch(`${LLM}/__stats`)).json();
      const bad = s.cases.filter((c) => c.decision && !/^openai/.test(String(c.llm))).map((c) => `${c.target_id}:${c.llm}`);
      H.recordPerf("서버 2대 공동 토큰 한도", ms, { r429: st.r429, calls: st.calls });
      assert.ok(st.r429 <= 3, `429 ${st.r429}회 — 두 서버가 한도를 따로 세어 합쳐서 넘김`);
      assert.deepEqual(bad, [], `LLM 설명이 아닌 건 ${bad.length}건: ${bad.slice(0, 3).join(", ")}`);
      return { r429: st.r429, ms };
    } finally { await post(`${LLM}/__mode`, { mode: "ok" }); H.stop(a); H.stop(b); H.stop(db); }
  });

  T("AJ08", "v1.22 새 화면(외부 채널 전송·계약서 요약·AI 설명 보관함)이 axe 심각·치명 0건, 390px 휴대폰에서 가로 넘침 없음, 키보드만으로 '다시 보내기'·보관함 열기 가능", async () => {
    const base = "http://localhost:8178";
    const api = await H.startApi(8178, { ...LLM_ENV, ...CH_ENV, SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const scan = async (p, where) => {
      await p.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
      await p.addScriptTag({ path: AXE });
      return (await p.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] })).violations
        .filter((v) => ["serious", "critical"].includes(v.impact)).map((v) => `${v.id}(${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")})`))).map((x) => `${where}:${x}`);
    };
    const overflow = (p) => p.evaluate(() => { const w = document.documentElement.clientWidth; return [...document.querySelectorAll('[data-testid="deliveries"] *, [data-testid="contract-summary"] *, [data-testid="explain-archive"] *')].filter((e) => e.getBoundingClientRect().right > w + 1).map((e) => e.tagName + "." + e.className).slice(0, 5); });
    const v = [], wide = [];
    let B = await H.newPage(); let p = B.page;
    try {
      await post(`${ESIGN}/__reset`, {}); await post(`${ESIGN}/__mode`, { fail: 100 });
      await post(`${LLM}/__mode`, { mode: "echo" });
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { body: { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" } }));
      await waitJob(base, await call(base, "POST", "/api/events", { body: { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" } }));
      await settle(base);
      const asIs = Object.fromEntries((await snap(base)).cases.filter((c) => c.decision).map((c) => [c.id, c.decision.approver]));
      await post(`${LLM}/__mode`, { mode: "echo", latency: 1.5 });
      await call(base, "POST", "/api/conditions", { body: { actor: "FINANCE", cash_assumption: "LEGACY45" } });
      const tc = writing(await snap(base)).find((c) => c.state === "PENDING_APPROVAL" && c.approval?.approver === "MASIL_CEO" && asIs[c.id] === "GROUP_CEO" && !c.decision?.regulation?.findings?.length);   // 30차(AP-07): 위반 카피가 남은 기안(PLAN-001)은 승인 불가라 제외
      assert.ok(tc, "시험 전제");
      await call(base, "POST", `/api/cases/${tc.id}/decision`, { body: { actor: "MASIL_CEO", action: "approve", comment: "작성 중 결재" } });
      await settle(base);
      await post(`${LLM}/__mode`, { mode: "ok" });
      const up = await waitJob(base, await upload(base, path.join(SAMPLES, "agency_media_renewal.md")));
      const rc = (await snap(base)).cases.find((c) => c.type === "RENEWAL");
      assert.ok(up.status === "done" && rc, "시험 전제: 계약서 건");
      for (const [vw, label] of [[{ width: 1280, height: 900 }, "데스크톱"], [{ width: 390, height: 844 }, "휴대폰"]]) {
        await p.setViewportSize(vw);
        await openApi(p, base);
        await p.locator('[data-testid="role-select"]').selectOption("GROUP_CEO").catch(() => {});
        await p.locator('[data-testid="deliveries"] [data-testid^="redeliver-"]').first().waitFor({ timeout: 12000 });
        await p.evaluate(() => document.querySelectorAll(".left details").forEach((d) => { d.open = true; }));
        await p.locator(`[data-testid="case-${tc.target_id}"]`).click();
        await p.locator('[data-testid="explain-archive"]').waitFor({ timeout: 8000 });
        // 키보드로 보관함 열기(summary에 초점 → Enter)
        await p.locator('[data-testid="explain-archive"] summary').focus(); await p.keyboard.press("Enter");
        const opened = await p.locator('[data-testid="explain-archive"]').evaluate((d) => d.open);
        if (!opened) v.push(`${label}: 키보드로 보관함이 열리지 않음`);
        v.push(...await scan(p, `${label} 보관함`)); wide.push(...(await overflow(p)).map((x) => `${label} 보관함 ${x}`));
        await p.locator(`[data-testid="case-${rc.target_id}"]`).click();
        await p.locator('[data-testid="contract-summary"]').waitFor({ timeout: 8000 });
        v.push(...await scan(p, `${label} 요약·전송`)); wide.push(...(await overflow(p)).map((x) => `${label} 요약·전송 ${x}`));
      }
      // 키보드만으로 다시 보내기
      await post(`${ESIGN}/__mode`, { fail: 0 });
      const btn = p.locator('[data-testid="deliveries"] [data-testid^="redeliver-"]').first();
      await btn.focus(); const focused = await btn.evaluate((e) => e === document.activeElement);
      await p.keyboard.press("Enter");
      const retried = await until(async () => (await snap(base)).audit.some((a) => a.topic === "channel.retried"), 6000);
      assert.deepEqual(v, [], `접근성 ${v.length}건: ${v.join(" / ")}`);
      assert.deepEqual(wide, [], `390px 가로 넘침: ${wide.join(", ")}`);
      assert.ok(focused && retried, "키보드로 '다시 보내기'를 할 수 없음");
      assert.deepEqual(p.errors, []);
    } finally { await post(`${LLM}/__mode`, { mode: "ok" }); await post(`${ESIGN}/__mode`, { fail: 0 }); await B.browser.close(); H.stop(api); }
  });
});

// ---------------- §14 리스크와 한계 · §15 대조 ----------------
// 행 ↔ 테스트 짝은 e2e/risk_guards.cjs(22차와 함께 씀)
// 23차보다 뒤에 실행되는 묶음(round24)의 짝은 여기서 보지 않는다
const RISK_GUARDS = Object.fromEntries(Object.entries(require("./risk_guards.cjs").RISK_GUARDS).map(([k, v]) => [k, v.filter((r) => !/^round(2[4-8]|3[02]):/.test(r))]));
// v1.23에서 한 일 — §15 '남은 일' 열에 남아 있으면 안 됨
const DONE_IN_V123 = [/back-channel|IdP가 먼저 끊는/, /서버 여러 대의 공동 한도/];
const SUITES = () => (fs.readFileSync(path.join(__dirname, "run_all.sh"), "utf8").match(/for s in ([^;]+);/) || [, ""])[1].trim().split(/\s+/);
const latestOf = (s) => { const f = path.join(__dirname, "reports", `${s}.json`); return fs.existsSync(f) ? Object.fromEntries(JSON.parse(fs.readFileSync(f, "utf8")).results.map((r) => [r.id, r.ok])) : {}; };

describe("§14 리스크와 한계 · §15 대조", () => {
  T("AJ01", "§14의 모든 행이 지키는 테스트를 가리키고 통과했으며, §15 '검증' 열의 테스트가 모두 있고 통과했고, '남은 일'에 이미 한 일이 없으며, 표의 E2E 수가 사실과 같음", async () => {
    const prd = fs.readFileSync(path.join(H.ROOT, "docs", "PRD.md"), "utf8");
    const sec = prd.split("## 14. 리스크와 한계")[1].split("\n## 15.")[0];
    const s15 = prd.split("\n## 15.")[1].split("\n## ")[0];
    const rows = sec.split("\n").filter((l) => /^\| [^-]/.test(l) && !/^\| 리스크 \|/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const unmapped = rows.filter((r) => !Object.keys(RISK_GUARDS).some((k) => r[1].startsWith(k))).map((r) => r[1]);
    const cache = {};
    const pyNames = Object.values(RISK_GUARDS).flat().filter((x) => x.startsWith("pytest:")).map((x) => x.slice(7));
    let pyOk = true;
    try { execFileSync("python3", ["-m", "pytest", "-q", "-k", pyNames.join(" or "), "backend/tests"], { cwd: H.ROOT, stdio: "pipe" }); } catch { pyOk = false; }
    const okOf = (s, id) => (s === "pytest" ? pyOk : s === "round23" ? results.find((r) => r.id === id)?.ok : (cache[s] ??= latestOf(s))[id]);
    const failing = [];
    for (const [risk, refs] of Object.entries(RISK_GUARDS)) for (const ref of refs) { const [s, id] = ref.split(/:(.+)/); const ok = okOf(s, id); if (ok !== true) failing.push(`${risk} ← ${ref}(${ok === undefined ? "없음" : "실패"})`); }
    // §15 '검증' 열: AH01~AH04 같은 범위도 펼쳐서 확인
    const s15rows = s15.split("\n").filter((l) => /^\| [0-9①-⑩]/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const vcol = s15rows.length ? s15.split("\n").find((l) => /^\| # \|/.test(l)).split("|").map((x) => x.trim()).indexOf("검증") : -1;
    const ncol = s15rows.length ? s15.split("\n").find((l) => /^\| # \|/.test(l)).split("|").map((x) => x.trim()).indexOf("남은 일") : -1;
    const verifyBad = [];
    const suiteOf = { AH: "round21", AI: "round22", AJ: "round23" };
    for (const r of s15rows) {
      const ids = [];
      for (const m of (r[vcol] || "").matchAll(/\b(A[HIJ])(\d\d)(?:~A[HIJ](\d\d))?/g)) { const a = Number(m[2]), z = Number(m[3] || m[2]); for (let i = a; i <= z; i++) ids.push(`${m[1]}${String(i).padStart(2, "0")}`); }
      for (const id of ids) { const s = suiteOf[id.slice(0, 2)]; if (okOf(s, id) !== true) verifyBad.push(`§15 ${r[1]} ← ${id}`); }
    }
    const stale = s15rows.filter((r) => DONE_IN_V123.some((re) => re.test(r[ncol] || ""))).map((r) => `${r[1]}: ${r[ncol]}`);
    const total = SUITES().filter((s) => s !== "round23").reduce((n, s) => n + Object.keys(latestOf(s)).length, 0) + results.length + 1;
    const stated = Number((sec.match(/E2E\(현재 (\d+)개\)/) || [])[1]);
    assert.deepEqual(unmapped, [], `지키는 테스트가 없는 리스크 행: ${unmapped.join(", ")}`);
    assert.deepEqual(failing, [], `대응이 지켜지지 않는 리스크 ${failing.length}건: ${failing.slice(0, 6).join(" / ")}`);
    assert.deepEqual(verifyBad, [], `§15 '검증' 열의 테스트가 없거나 실패: ${verifyBad.join(", ")}`);
    assert.deepEqual(stale, [], `§15 '남은 일'에 이미 한 일: ${stale.join(" / ")}`);
    assert.equal(stated, total, `§14가 말하는 E2E 수 ${stated} ≠ 실제 ${total}`);
    return { risks: rows.length, refs: Object.values(RISK_GUARDS).flat().length, s15_rows: s15rows.length, e2e_total: total };
  });
});
