// 9차 E2E — '오래 쓴 뒤'와 '운영 환경'의 경계.
//   감사 기록이 1만~5만 건 쌓인 서버(메모리·MySQL)와 브라우저, 아주 큰 요청 본문, 활동 중 로그인 만료,
//   로그인 모드의 감사 행위자 기록, 프록시(AXHub 인그레스) 뒤 접속 주소.
//   합성 데이터: e2e/seed_audit.py(서버), page.evaluate(브라우저) — 실제 운영 기록을 흉내 낸 '과거 운영 기록 #n'.
const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const H = require("./helpers.cjs");

const KEY = "e2e-key";
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async (t) => {
  const t0 = Date.now();
  try { const r = await fn(t); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, { token, body } = {}) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const timed = async (fn) => { const t0 = performance.now(); const r = await fn(); return [performance.now() - t0, r]; };
const tmp = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aurora9-")), n);
const seed = (n, env) => {
  const r = spawnSync("python3", [path.join(__dirname, "seed_audit.py"), String(n)], { encoding: "utf-8", env: { ...process.env, LLM_PROVIDER: "offline", ...env }, timeout: 120000 });
  if (r.status !== 0) throw new Error(`seed 실패: ${r.stderr.slice(-300)}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
};
const rssMB = (pid) => { try { return Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf-8"))[1]) / 1024; } catch { return NaN; } };
let db = null;
after(() => { H.writeReport("round9", { results }); H.stop(db); });

/** 승인자 역할로 승인 대기 건 하나를 승인하고, 그 뒤 스냅샷의 '최근 감사 로그' 마지막 항목을 돌려준다. */
async function approveAndTail(base, pending) {
  const c = pending.find((x) => x.approver === "MASIL_CEO") || pending[0];
  const r = await call(base, "POST", `/api/cases/${c.id}/decision`, { body: { actor: c.approver, action: "approve", comment: "9차 장기 운영 확인" } });
  assert.equal(r.status, 200, `결재 ${r.status}`);
  const [snapMs, s] = await timed(async () => (await call(base, "GET", "/api/snapshot")).json());
  return { c, s, snapMs };
}

describe("오래 쓴 서버 — 감사 기록 1만 건 넘김", () => {
  T("L01", "메모리 저장소: 감사 1만 건을 넘긴 뒤에도 방금 한 결재가 화면 '감사 로그' 맨 위에 보임", async () => {
    const file = tmp("desk.json");
    const sd = seed(10000, { REPO: "memory", REPO_PATH: file });
    const api = await H.startApi(8020, { REPO: "memory", REPO_PATH: file, SERVE_FRONTEND: "1", FRONTEND_DIST: path.join(H.ROOT, "frontend", "dist-docker"), ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      const { c, s } = await approveAndTail("http://localhost:8020", sd.pending);
      const last = s.audit[s.audit.length - 1];
      assert.ok(s.audit_total > 10000, `감사 건수 ${s.audit_total}`);
      assert.equal(last.case_id, c.id, `스냅샷 최근 항목이 ${last.id}(${last.topic}) — 방금 결재(${c.id})가 아님`);
      await p.goto("http://localhost:8020"); await p.waitForSelector(".top");
      await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
      await p.locator(".role select").nth(1).selectOption("api");
      await p.locator(".audit ol li").first().waitFor();
      const top = await p.locator(".audit ol li").first().innerText();
      assert.match(top, /9차 장기 운영 확인/, `화면 맨 위 감사 항목: ${top.slice(0, 80)}`);   // 방금 결재의 의견 문구
    } finally { await B.browser.close(); H.stop(api); }
  });

  T("L02", "MySQL 호환 DB: 감사 1만 건을 넘긴 뒤에도 최근 감사 로그가 최신 순서로 이어짐", async () => {
    db = await H.startMariaDB(3310);
    if (!db) { if (process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음"); return { skipped: true }; }
    const sd = seed(10000, db.env);
    const api = await H.startApi(8021, db.env);
    try {
      const { c, s } = await approveAndTail("http://localhost:8021", sd.pending);
      const last = s.audit[s.audit.length - 1];
      assert.equal(last.case_id, c.id, `스냅샷 최근 항목이 ${last.id}(${last.topic})`);
      assert.ok(s.audit_total > 10000);
    } finally { H.stop(api); }
  });
});

describe("오래 쓴 서버 — 감사 기록 5만 건에서의 속도", () => {
  const measure = async (base, sd, label) => {
    const { snapMs } = await approveAndTail(base, sd.pending);
    const [searchMs, sr] = await timed(async () => (await call(base, "GET", "/api/audit?q=" + encodeURIComponent("과거 운영 기록 #4999") + "&limit=50")).json());
    const [lastMs, lr] = await timed(async () => (await call(base, "GET", `/api/audit?offset=${sd.audit - 10}&limit=50`)).json());
    H.recordPerf(`${label}: 변경 후 스냅샷`, snapMs); H.recordPerf(`${label}: 감사 검색`, searchMs); H.recordPerf(`${label}: 감사 마지막 페이지`, lastMs);
    assert.equal(sr.matched, 11, `'#4999' 검색 결과 ${sr.matched}건(#4999, #49990~#49999)`);
    assert.ok(lr.items.length >= 10);
    assert.ok(snapMs < 150, `변경 후 스냅샷 ${Math.round(snapMs)}ms(목표 150ms 이하 — 감사 건수와 무관해야 함)`);
    assert.ok(searchMs < 200, `감사 검색 ${Math.round(searchMs)}ms`);
    assert.ok(lastMs < 150, `감사 마지막 페이지 ${Math.round(lastMs)}ms`);
    return { snap_ms: Math.round(snapMs), search_ms: Math.round(searchMs), last_ms: Math.round(lastMs) };
  };
  T("L03", "메모리 저장소 감사 5만 건: 결재 뒤 화면 갱신 데이터·검색·마지막 페이지가 각 0.15~0.2초 안", async () => {
    const file = tmp("desk.json");
    const sd = seed(50000, { REPO: "memory", REPO_PATH: file });
    const api = await H.startApi(8022, { REPO: "memory", REPO_PATH: file });
    try { return await measure("http://localhost:8022", sd, "메모리 5만"); } finally { H.stop(api); }
  });
  T("L04", "MySQL 호환 DB 감사 5만 건: 같은 기준", async () => {
    if (!db) { if (process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음"); return { skipped: true }; }
    const sd = seed(50000, db.env);
    // v1.8 이하 스키마로 만든 기존 DB를 흉내 — 검색용 열이 없으면 서버가 기동할 때 스스로 추가해야 함
    try { db.sql("ALTER TABLE aurora_desk.audit DROP COLUMN search_text"); } catch { /* v1.8 스키마에는 원래 없음 */ }
    const api = await H.startApi(8023, db.env);
    try { return await measure("http://localhost:8023", sd, "MySQL 5만"); } finally { H.stop(api); }
  });
});

describe("오래 쓴 브라우저 — 브라우저 단독 모드의 저장 공간", () => {
  T("L05", "감사 기록이 저장 한도(약 5MB)를 넘을 만큼 쌓여도 계속 저장되고, 새로고침 뒤 가장 오래된 기록까지 검색됨", async () => {
    const pv = await H.startPreview(4183);
    const B = await H.newPage(); const p = B.page;
    const btn = (n) => p.getByRole("button", { name: n }).first();
    const add = (N, from) => p.evaluate(([N, from]) => {
      const s = JSON.parse(localStorage.getItem("aurora-desk-state")); const k = s.seq.audit;
      for (let i = 0; i < N; i++) s.audit.push({ id: `AU-${String(k + i + 1).padStart(4, "0")}`, sim_date: "2026-07-01", at: "2026-07-01T09:00:00", topic: "seed.history", actor: "SYSTEM", case_id: null, detail: `과거 운영 기록 #${from + i} (합성 데이터)` });
      s.seq.audit = k + N; localStorage.setItem("aurora-desk-state", JSON.stringify(s));
    }, [N, from]);
    try {
      await H.fresh(p, "http://localhost:4183");
      await btn("확대 기안 25건 접수").click();
      await add(24000, 1);
      await p.reload(); await p.waitForSelector(".top");
      await H.clickTimed(p, btn("하루 진행"), "브라우저 감사 2.4만 건: 하루 진행");
      for (let i = 0; i < 150 && (await p.evaluate(() => localStorage.getItem("aurora-desk-state").length)) > 1_500_000; i++) await p.waitForTimeout(100);
      const size1 = await p.evaluate(() => localStorage.getItem("aurora-desk-state").length);
      // 다시 2만 건(합계 4.4만 건 ≈ 7MB) — 한도를 넘는 양
      let addErr = "";
      try { await add(20000, 24001); } catch (e) { addErr = String(e.message).split("\n")[0]; }
      assert.equal(addErr, "", `기록을 더 쌓을 공간이 없음(저장 크기 ${size1}자): ${addErr.slice(0, 90)}`);
      await p.reload(); await p.waitForSelector(".top");
      // 오래된 기록을 보관함으로 옮기는 작업(새로고침 직후 한 번)이 끝난 뒤의 평상시 클릭 속도를 잰다
      for (let i = 0; i < 100 && (await p.evaluate(() => localStorage.getItem("aurora-desk-state").length)) > 1_500_000; i++) await p.waitForTimeout(100);
      const ms = await H.clickTimed(p, btn("하루 진행"), "브라우저 감사 4.4만 건: 하루 진행");
      await p.waitForTimeout(600);
      assert.equal(await p.locator('[data-testid="save-warning"]').count(), 0, "저장 실패 경고가 뜸");
      await p.reload(); await p.waitForSelector(".top");
      const total = Number((await p.locator(".audit h2 .count").innerText()).replace(/[^0-9]/g, ""));
      assert.ok(total >= 44000, `새로고침 뒤 감사 건수 ${total}`);
      await p.locator('[data-testid="audit-all"]').click();
      await p.locator('[data-testid="audit-search"]').fill("과거 운영 기록 #1 ");
      let hit = "";
      for (let i = 0; i < 40 && !/과거 운영 기록 #1 \(/.test(hit); i++) { await p.waitForTimeout(100); hit = await p.locator('[data-testid="audit-results"]').innerText(); }
      assert.match(hit, /과거 운영 기록 #1 \(/, "가장 오래된 기록을 찾지 못함");
      assert.ok(ms < 150, `하루 진행 ${Math.round(ms)}ms`);
      assert.deepEqual(p.errors, []);
      return { size_after_first_chars: size1, click_ms: Math.round(ms) };
    } finally { await B.browser.close(); H.stop(pv); }
  });
});

describe("아주 큰 요청 — 서버 메모리 보호", () => {
  const post = (port, len, chunked) => new Promise((resolve) => {
    const t0 = performance.now();
    // agent:false — Node 19+ 기본 agent는 연결을 재사용해, 서버가 막 끊은(413 + connection: close) 연결에 다음 요청을 실으면 간헐적으로 '연결 끊김'(16차 실행 중 1회)
    const req = http.request({ host: "127.0.0.1", port, path: "/api/events", method: "POST", agent: false,
      headers: { "Content-Type": "application/json", "X-API-Key": KEY, ...(chunked ? { "Transfer-Encoding": "chunked" } : { "Content-Length": len }) } },
    (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, ms: performance.now() - t0, body: b })); });
    req.on("error", () => resolve({ status: 0, ms: performance.now() - t0 }));   // 서버가 먼저 끊은 경우
    const head = Buffer.from('{"kind":"FREE_TEXT","text":"'); const chunk = Buffer.alloc(1024 * 1024, 97);
    req.write(head);
    let sent = head.length;
    // v1.21: 선언한 길이(Content-Length)만큼만 보낸다. 기존에는 200KB 요청에도 1MB 덩어리를 통째로 써서, 서버가 200KB를 읽고
    // 답한 뒤 남은 바이트가 같은 연결의 '다음 요청'으로 들어가 연결이 끊겼다(부하가 있을 때 간헐 실패 — 16·21차 전체 실행)
    (function pump() { while (sent < len - 2) { const c = chunked ? chunk : chunk.subarray(0, Math.min(chunk.length, len - 2 - sent)); sent += c.length; if (!req.write(c)) { req.once("drain", pump); return; } } req.end('"}'); })();
  });
  T("L06", "60MB 본문(길이 표시·분할 전송 모두)은 413으로 바로 거절되고, 서버 메모리가 늘지 않으며 다른 사용자 응답도 느려지지 않음", async () => {
    const api = await H.startApi(8024, {});
    try {
      await call("http://localhost:8024", "GET", "/api/snapshot");
      const base = rssMB(api.pid);
      let healthMs = 0;
      const probe = (async () => { await new Promise((r) => setTimeout(r, 150)); [healthMs] = await timed(() => fetch("http://localhost:8024/api/health")); })();
      const a = await post(8024, 60 * 1024 * 1024, false);
      const b = await post(8024, 60 * 1024 * 1024, true);
      await probe;
      const grow = rssMB(api.pid) - base;
      H.recordPerf("60MB 요청 거절", a.ms, { chunked_ms: Math.round(b.ms), rss_growth_mb: Math.round(grow) });
      // 60MB를 보내는 도중 서버가 413을 보내고 연결을 끊으므로 클라이언트에 따라 413 또는 연결 종료(0)로 보인다
      assert.ok([413, 0].includes(a.status) && [413, 0].includes(b.status), `응답 ${a.status}/${b.status}`);
      const mid = await post(8024, 200 * 1024, false);   // 다 보낼 수 있는 크기(200KB) → 사람이 읽을 안내가 와야 함
      assert.equal(mid.status, 413, `200KB 응답 ${mid.status}`);
      assert.match(JSON.parse(mid.body).detail, /요청이 너무 큽니다/);
      assert.ok(grow < 40, `서버 메모리 ${Math.round(grow)}MB 증가`);
      assert.ok(healthMs < 300, `그 사이 상태 확인 ${Math.round(healthMs)}ms`);
      const ok = await call("http://localhost:8024", "POST", "/api/events", { body: { kind: "FREE_TEXT", text: "보통 크기 메모" } });
      assert.equal(ok.status, 202, "보통 요청까지 막힘");
      return { rss_growth_mb: Math.round(grow), reject_ms: Math.round(a.ms) };
    } finally { H.stop(api); }
  });
});

describe("로그인 모드 — 계속 쓰는 동안의 로그인과 감사", () => {
  const USERS = "ceo.kang:pw-ceo:GROUP_CEO;contract.choi:pw-co:CONTRACT_OWNER;masil.han:pw-masil:MASIL_CEO";
  const AUTH = { AUTH_MODE: "jwt", USERS, JWT_SECRET: "e2e-secret-0123456789abcdef" };
  const login = async (base, user, password) => (await (await call(base, "POST", "/api/auth/login", { body: { user, password } })).json()).token;

  T("L07", "활동 중이면 로그인이 자동 연장되고(토큰 4초 서버에서 10초 사용), 쉬면 만료, 최대 시간(14초)이 지나면 다시 로그인", async () => {
    const base = "http://localhost:8025";
    const api = await H.startApi(8025, { ...AUTH, TOKEN_TTL_S: "4", SESSION_MAX_S: "14", SERVE_FRONTEND: "1", FRONTEND_DIST: path.join(H.ROOT, "frontend", "dist-docker"), ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    const loginUi = async () => {
      await p.locator('[data-testid="login-user"]').fill("ceo.kang"); await p.locator('[data-testid="login-password"]').fill("pw-ceo");
      await p.locator('[data-testid="login-submit"]').click(); await p.locator('[data-testid="whoami"]').waitFor();
    };
    try {
      await p.goto(base); await p.waitForSelector(".top");
      await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
      await p.locator(".role select").nth(1).selectOption("api");
      await loginUi();
      const t0 = Date.now();
      // 1) 10초 동안 계속 사용(1초마다 탭 이동·키 입력) → 로그인 창이 한 번도 나오지 않아야 함
      let kicked = 0;
      while (Date.now() - t0 < 10000) {
        await p.getByRole("tab").nth(Math.floor((Date.now() - t0) / 1000) % 2).click().catch(() => {});
        await p.keyboard.press("Shift");
        if (await p.locator('[data-testid="login-user"]').count()) { kicked = Date.now() - t0; break; }
        await p.waitForTimeout(1000);
      }
      assert.equal(kicked, 0, `계속 쓰는 중인데 ${kicked}ms 만에 로그인 창`);
      const r = await p.evaluate(() => JSON.parse(sessionStorage.getItem("aurora-desk-session") || "{}"));
      assert.equal((await call(base, "GET", "/api/revision", { token: r.token })).status, 200, "연장된 토큰이 서버에서 거부됨");
      // 2) 최대 시간(14초) 넘기기 → 계속 써도 다시 로그인
      await p.waitForTimeout(Math.max(0, 15500 - (Date.now() - t0)));
      await p.keyboard.press("Shift");
      await p.locator('[data-testid="login-user"]').waitFor({ timeout: 8000 });
      // 3) 다시 로그인 후 아무것도 안 하면(6초) 만료 → 로그인 창
      await loginUi();
      await p.waitForTimeout(6500);
      await p.locator('[data-testid="login-user"]').waitFor({ timeout: 5000 });
      assert.deepEqual(p.errors.filter((e) => !/status of 401/.test(e)), []);
    } finally { await B.browser.close(); H.stop(api); }
  });

  T("L08", "감사 기록의 '누가'는 로그인한 역할: 계약 담당이 회신 입력 때 그룹 CEO라고 적어도 계약 담당으로 남고, 시계 진행도 기록됨", async () => {
    const base = "http://localhost:8026";
    const api = await H.startApi(8026, AUTH);
    try {
      const ceo = await login(base, "ceo.kang", "pw-ceo"); const co = await login(base, "contract.choi", "pw-co");
      const r1 = await call(base, "POST", "/api/replies", { token: co, body: { actor: "GROUP_CEO", reply_key: "agency_payment_schedule" } });
      const r2 = await call(base, "POST", "/api/clock", { token: ceo, body: { actor: "FINANCE", to: "2026-07-03" } });
      assert.equal(r2.status, 200);
      const s = await (await call(base, "GET", "/api/snapshot", { token: ceo })).json();
      const byCo = s.audit.filter((a) => a.user === "contract.choi" && !a.topic.startsWith("auth."));
      const byCeo = s.audit.filter((a) => a.user === "ceo.kang" && !a.topic.startsWith("auth."));
      assert.ok(byCo.length >= 1, `회신 입력(${r1.status}) 기록 없음`);
      assert.deepEqual([...new Set(byCo.map((a) => a.actor))], ["CONTRACT_OWNER"], `계약 담당의 기록에 남은 역할: ${byCo.map((a) => a.actor)}`);
      assert.ok(byCeo.some((a) => /시계/.test(a.detail)), `시계 진행 기록 없음: ${byCeo.map((a) => a.topic)}`);
      assert.deepEqual([...new Set(byCeo.map((a) => a.actor))], ["GROUP_CEO"], `그룹 CEO의 기록에 남은 역할: ${byCeo.map((a) => a.actor)}`);
    } finally { H.stop(api); }
  });

  T("L09", "프록시(AXHub 인그레스) 뒤: FORWARDED_ALLOW_IPS를 설정하면 실제 접속 주소로 잠그고 기록함(공격자 잠금이 CEO에게 번지지 않음)", async () => {
    const api = await H.startApi(8027, { ...AUTH, FORWARDED_ALLOW_IPS: "127.0.0.2" });
    const via = (xff, user, password) => new Promise((resolve, reject) => {
      const data = JSON.stringify({ user, password });
      const req = http.request({ host: "127.0.0.1", port: 8027, path: "/api/auth/login", method: "POST", localAddress: "127.0.0.2",
        headers: { "Content-Type": "application/json", "X-API-Key": KEY, "X-Forwarded-For": xff, "Content-Length": Buffer.byteLength(data) } }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
      req.on("error", reject); req.end(data);
    });
    try {
      const codes = []; for (let i = 0; i < 6; i++) codes.push((await via("203.0.113.7", "ceo.kang", "guess")).status);
      const mine = await via("198.51.100.9", "ceo.kang", "pw-ceo");
      assert.equal(codes[5], 429, `공격자 쪽 ${codes}`);
      assert.equal(mine.status, 200, `프록시 뒤 정당한 사용자 ${mine.status}`);
      const tokn = JSON.parse(mine.body).token;
      const a = await (await call("http://localhost:8027", "GET", "/api/audit?q=" + encodeURIComponent("로그인 실패") + "&limit=10", { token: tokn })).json();
      assert.match(a.items.map((x) => x.detail).join(" "), /203\.0\.113\.7/, "감사 기록에 실제 접속 주소가 없음(프록시 주소만 남음)");
    } finally { H.stop(api); }
  });
});
