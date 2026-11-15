// 27차 E2E — v1.26 기능(해시 체인·연결 상한·검색 정렬 규칙) × 기존 보장 + §15 ⑧ 남은 일(머리값을 밖에 정기 기록) + §14·§15 표 대조 + 시연 영상.
//   해시 체인 × 서버 2대 × 늦게 도착하는 AI 설명: 두 서버가 동시에 기록해도 체인이 갈라지지 않는가(거짓 경보 0)     → AN02
//   해시 체인 × 감사 5만 건(9차 장기 운영): 검증이 빠르고, 검증하는 동안 다른 사람의 화면이 느려지지 않는가        → AN03
//   검색 정렬 규칙 이전 × 무중단 배포 × 감사 12만 건: 새 서버가 뜨며 표를 고치는 동안 옛 서버의 쓰기가 멈추지 않는가 → AN04
//   해시 체인 × 백업·복구(25차 AL08): 쓰는 중 백업 → 복구한 DB에서도 체인이 이어지는가                               → AN05
//   해시 체인 × 화면: 감사 담당이 화면에서 검증할 수 있는가(키보드·화면 낭독기·axe)                                   → AN06
//   §15 ⑧ 남은 일: 머리값을 밖(메신저)에 기록 — 체인 전체를 다시 계산한 위조도 드러나는가, 권한                         → AN07
//   머리값 정기 기록 × 서버 2대: 두 서버가 같은 주기로 돌아도 한 번씩만 보내는가                                     → AN08
//   시연 영상: 5분 미만, AI 음성 해설, v1.27 장면                                                                   → AN09
//   §14·§15 표 대조                                                                                                 → AN01(맨 끝)
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const H = require("./helpers.cjs");
const RISK_GUARDS = Object.fromEntries(Object.entries(require("./risk_guards.cjs").RISK_GUARDS).map(([k, v]) => [k, v.filter((r) => !/^round(28|30):/.test(r))]));   // 28차는 27차 뒤에 돈다

const KEY = "e2e-key";
const PORT = 3327, SOCK = `/tmp/aurora-e2e-${PORT}.sock`;
const DIST = path.join(H.ROOT, "frontend", "dist-docker");
const AXE = require.resolve("axe-core/axe.min.js", { paths: [path.join(H.ROOT, "frontend")] });
const LLM = 8975;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aurora27-"));
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, body) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const jobOf = async (base, id, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { const j = await (await call(base, "GET", `/api/jobs/${id}`)).json(); if (j.status === "done" || j.status === "failed") return j; await new Promise((x) => setTimeout(x, 80)); } throw new Error("job timeout"); };
const waitJob = async (base, r, ms) => { const b = await r.json(); return b.job_id ? jobOf(base, b.job_id, ms) : { ...b, http: r.status }; };
const snap = async (base) => (await call(base, "GET", "/api/snapshot")).json();
const timed = async (fn) => { const t0 = Date.now(); const v = await fn(); return [Date.now() - t0, v]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p95 = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))]; };
const sqlRows = (q, dbname = "aurora_desk") => execFileSync("mariadb", ["-uroot", `--socket=${SOCK}`, "--default-character-set=utf8mb4", "-N", "-B", dbname, "-e", q], { encoding: "utf8", maxBuffer: 1 << 28 }).trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
const asApp = (q) => { try { execFileSync("mariadb", ["-uaurora", "-pe2e-pass", "-h127.0.0.1", `-P${PORT}`, "--default-character-set=utf8mb4", "aurora_desk", "-e", q], { stdio: "pipe" }); return "ok"; } catch (e) { return String(e.stderr || e.message); } };
const verify = async (base, anchors = []) => (await call(base, "GET", `/api/audit/verify${anchors.length ? "?" + anchors.map((a) => `anchor=${encodeURIComponent(a)}`).join("&") : ""}`)).json();
const seed = (n, extra = {}) => {
  const r = spawnSync("python3", [path.join(__dirname, "seed_audit.py"), String(n)], { encoding: "utf-8", env: { ...process.env, LLM_PROVIDER: "offline", ...db.env, ...extra }, timeout: 300000 });
  if (r.status !== 0) throw new Error(`합성 데이터 실패: ${r.stderr.slice(-300)}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
};

let db, llm;
before(async () => {
  db = await H.startMariaDB(PORT);
  if (!db && process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음");
  llm = spawn("python3", [path.join(__dirname, "mock_llm.py"), String(LLM)], { stdio: "ignore", detached: true });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${LLM}/__stats`)).ok) break; } catch { /* not yet */ } await sleep(150); }
});
after(() => { H.writeReport("round27", { results }); H.stop(db); try { process.kill(-llm.pid); } catch { /* gone */ } });
const need = () => { if (!db || db.env?.REPO !== "mysql") throw new Error("MariaDB 없음(또는 접속 정보 없음)"); };

describe("v1.26 기능 × 기존 보장", () => {
  T("AN02", "해시 체인 × 서버 2대 × 늦게 도착하는 AI 설명: 두 서버에서 6초 동안 동시에 접수·결재·메모를 하고 AI 설명이 뒤늦게 기록돼도, 검증 결과 '이상 없음'(체인이 갈라지지 않음)", async () => {
    need();
    const b1 = "http://localhost:8210", b2 = "http://localhost:8211";
    await fetch(`http://127.0.0.1:${LLM}/__mode`, { method: "POST", body: JSON.stringify({ mode: "ok", latency: 0.3 }) });
    const env = { ...db.env, LLM_PROVIDER: "openai", OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `http://127.0.0.1:${LLM}/v1`, LLM_TIMEOUT_S: "8" };
    const a1 = await H.startApi(8210, env), a2 = await H.startApi(8211, env);
    try {
      await call(b1, "POST", "/api/reset");
      await waitJob(b1, await call(b1, "POST", "/api/events", { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" }));
      const end = Date.now() + 6000;
      const loop = async (base, k) => { let i = 0; while (Date.now() < end) { await call(base, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: `서버${k} 메모 ${i++}` }).then((r) => r.json()).catch(() => {}); } return i; };
      const decide = async (base) => { for (const c of (await snap(base)).cases.filter((x) => x.state === "PENDING_APPROVAL").slice(0, 6)) await call(base, "POST", `/api/cases/${c.id}/decision`, { actor: c.approval.approver, action: "approve", comment: "동시 결재" }).catch(() => {}); };
      const [n1, n2] = await Promise.all([loop(b1, 1), loop(b2, 2), decide(b2), call(b1, "POST", "/api/clock", { to: "2026-07-02", actor: "GROUP_CEO" })]);
      await sleep(3000);   // 늦은 AI 설명까지 기다림
      const total = Number(sqlRows("SELECT COUNT(*) FROM audit")[0][0]);
      const v = await verify(b2);
      H.recordPerf("서버 2대 동시 기록 뒤 체인 검증", v.ms ?? 0, { records: total, broken: v.broken_total, written: n1 + n2 });
      assert.equal(v.ok, true, `동시 기록 뒤 거짓 경보(체인 갈라짐): ${JSON.stringify(v.broken || v).slice(0, 200)}`);
      assert.equal(v.checked, total, `검증 ${v.checked}건 ≠ 감사 기록 ${total}건`);
      return { records: total, written: n1 + n2 };
    } finally { H.stop(a1); H.stop(a2); }
  });

  T("AN03", "해시 체인 × 감사 5만 건: 검증 3초 이하·이상 없음, 검증하는 동안 다른 사람의 화면 갱신 p95 150ms 이하", async () => {
    need();
    const base = "http://localhost:8212";
    const info = seed(50000, { SEED_CHAIN: "1" });
    const api = await H.startApi(8212, { ...db.env });
    try {
      const lat = []; let stop = false;
      const viewer = (async () => { let i = 0; while (!stop) { await call(base, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: `검증 중 메모 ${i++}` }).then((r) => r.json()); const [ms] = await timed(() => snap(base)); lat.push(ms); } })();
      await sleep(200);
      const [ms, v] = await timed(() => verify(base));
      stop = true; await viewer;
      H.recordPerf("감사 5만 건 체인 검증", ms, { records: v.checked, viewer_p95: p95(lat) });
      assert.equal(v.ok, true, `5만 건 검증 결과: ${JSON.stringify(v).slice(0, 160)}`);
      assert.ok(v.checked >= info.audit - 5, `검증 ${v.checked}건(감사 ${info.audit}건)`);
      assert.ok(ms <= 3000, `감사 5만 건 검증 ${ms}ms`);
      assert.ok(p95(lat) <= 150, `검증 중 다른 사람의 화면 갱신 p95 ${p95(lat)}ms`);
      return { verify_ms: ms, records: v.checked, viewer_p95: p95(lat) };
    } finally { H.stop(api); }
  });

  T("AN04", "검색 정렬 규칙 이전 × 무중단 배포 × 감사 12만 건: v1.25 모양(unicode_ci) 검색 열이 있는 DB에 새 서버가 뜨는 동안 옛 서버의 접수가 모두 성공하고 1초를 넘지 않으며, 새 서버는 8초 안에 떠서 검색도 맞음", async () => {
    need();
    const b1 = "http://localhost:8213", b2 = "http://localhost:8214";
    seed(120000);
    const a1 = await H.startApi(8213, { ...db.env });
    let a2;
    try {
      // v1.25까지의 모양으로 되돌림: 검색 열의 정렬 규칙 = 표 기본값(utf8mb4_unicode_ci)
      const expr = sqlRows("SELECT GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='aurora_desk' AND TABLE_NAME='audit' AND COLUMN_NAME='search_text'")[0][0];
      const f = path.join(TMP, "old_col.sql");
      fs.writeFileSync(f, `ALTER TABLE audit DROP COLUMN search_text, ADD COLUMN search_text TEXT COLLATE utf8mb4_unicode_ci GENERATED ALWAYS AS (${expr}) STORED;`);
      execFileSync("mariadb", ["-uroot", `--socket=${SOCK}`, "--default-character-set=utf8mb4", "aurora_desk"], { input: fs.readFileSync(f) });
      const coll0 = sqlRows("SELECT COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='aurora_desk' AND TABLE_NAME='audit' AND COLUMN_NAME='search_text'")[0][0];
      assert.equal(coll0, "utf8mb4_unicode_ci", "시험 준비(옛 모양) 실패");
      const lat = [], codes = []; let stop = false;
      const writer = (async () => { let i = 0; while (!stop) { const [ms, r] = await timed(() => call(b1, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: `배포 중 메모 ${i++}` })); lat.push(ms); codes.push(r.status); await r.text(); await sleep(30); } })();
      await sleep(300);
      const [ready] = await timed(async () => { a2 = await H.startApi(8214, { ...db.env }); });
      await sleep(800);
      stop = true; await writer;
      const bad = codes.filter((c) => c >= 500).length, max = Math.max(...lat);
      const q = await (await call(b2, "GET", `/api/audit?limit=1&q=${encodeURIComponent("과거 운영 기록 #119999")}`)).json();
      H.recordPerf("새 서버 기동 중 옛 서버 접수(감사 12만 건)", max, { failed: bad, writes: codes.length, new_server_ready_ms: ready });
      assert.equal(bad, 0, `새 서버가 뜨는 동안 옛 서버 접수 ${bad}/${codes.length}건 실패`);
      assert.ok(max <= 1000, `새 서버가 뜨는 동안 옛 서버 접수 최대 ${max}ms(표를 고치는 동안 쓰기가 멈춤)`);
      assert.ok(ready <= 8000, `새 서버 기동 ${ready}ms`);
      assert.ok(q.matched >= 1, "새 서버의 검색이 옛 열에서 동작하지 않음");
      return { max_write_ms: max, failed: bad, new_server_ready_ms: ready };
    } finally { H.stop(a1); H.stop(a2); }
  });

  T("AN05", "해시 체인 × 백업·복구: 쓰는 중에 백업해 새 DB로 복구한 서버에서도 검증 '이상 없음', 이어서 쓴 기록도 체인에 이어짐", async () => {
    need();
    const base = "http://localhost:8215", base2 = "http://localhost:8216";
    const api = await H.startApi(8215, { ...db.env });
    let api2;
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      let stop = false;
      const writer = (async () => { let i = 0; while (!stop) await call(base, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: `백업 중 메모 ${i++}` }).then((r) => r.json()); })();
      await sleep(600);
      const dump = execFileSync("mariadb-dump", ["-uroot", `--socket=${SOCK}`, "--single-transaction", "--routines", "--triggers", "aurora_desk"], { maxBuffer: 1 << 28 });
      stop = true; await writer;
      sqlRows("DROP DATABASE IF EXISTS aurora_restore; CREATE DATABASE aurora_restore DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON aurora_restore.* TO 'aurora'@'127.0.0.1'; SELECT 1");
      execFileSync("mariadb", ["-uroot", `--socket=${SOCK}`, "aurora_restore"], { input: dump });
      api2 = await H.startApi(8216, { ...db.env, MYSQL_DB: "aurora_restore" });
      const v1 = await verify(base2);
      await waitJob(base2, await call(base2, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: "복구 뒤 첫 메모" }));
      const v2 = await verify(base2);
      assert.equal(v1.ok, true, `복구한 DB 검증: ${JSON.stringify(v1).slice(0, 160)}`);
      assert.ok(v2.ok === true && v2.checked === v1.checked + 1, `복구 뒤 이어 쓴 기록: ${JSON.stringify(v2).slice(0, 160)}`);
      return { checked: v2.checked };
    } finally { H.stop(api); H.stop(api2); }
  });
});

describe("§15 ⑧ 남은 일 · 화면", () => {
  T("AN06", "해시 체인 × 화면: 감사 로그의 '체인 검증' 버튼(키보드로 누름)이 '이상 없음'을 보여 주고, 기록을 지운 뒤 다시 누르면 지운 자리를 보여 주며, 결과는 화면 낭독기가 읽는 상태 영역이고 axe 심각·치명 0건", async () => {
    need();
    const base = "http://localhost:8217";
    const api = await H.startApi(8217, { ...db.env, SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "FINANCE_OVERDUE_AR", actor: "FINANCE" }));   // 지울 기록이 '중간'에 오게 기록을 더 쌓음
      await p.goto(base); await p.waitForSelector(".top");
      await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
      await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(800);
      const btn = p.locator('[data-testid="audit-verify"]');
      const has = await btn.waitFor({ timeout: 4000 }).then(() => true).catch(() => false);
      assert.ok(has, "화면에 감사 기록 검증 버튼이 없음(검증은 API로만 — 감사 담당이 쓸 수 없음)");
      await btn.focus(); await p.keyboard.press("Enter");
      const out = p.locator('[data-testid="audit-verify-result"]');
      await out.filter({ hasText: /이상 없음/ }).waitFor({ timeout: 5000 });
      const role = await out.getAttribute("role");
      const ids = sqlRows("SELECT id FROM audit ORDER BY seq").map((r) => r[0]);
      assert.ok(ids.length >= 5, `시험 준비: 감사 기록 ${ids.length}건`);
      assert.equal(asApp(`SET @aurora_reset = 1; DELETE FROM audit WHERE id='${ids[2]}'`), "ok");
      await btn.click();
      await out.filter({ hasText: ids[3] }).waitFor({ timeout: 5000 });
      const text = await out.innerText();
      await p.addScriptTag({ path: AXE });
      const v = await p.evaluate(async () => (await window.axe.run({ include: [[".audit"]] }, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] })).violations.filter((x) => ["serious", "critical"].includes(x.impact)).map((x) => x.id));
      assert.equal(role, "status", "검증 결과가 상태 영역(role=status)이 아님");
      assert.ok(/이상/.test(text) && text.includes(ids[3]), `지운 자리 표시: ${text}`);
      assert.deepEqual(v, [], `axe: ${v.join(",")}`);
      assert.deepEqual(p.errors, []);
      return { result: text.slice(0, 80) };
    } finally { await B.browser.close().catch(() => {}); H.stop(api); }
  });

  T("AN07", "머리값을 밖에 기록: 그룹 CEO가 머리값을 메신저로 보내고(다른 역할은 403), 누군가 체인 전체를 다시 계산해 기록을 고치면 — 머리값 없이 검증하면 '이상 없음'이지만, 메신저에 남은 머리값으로 검증하면 고친 것을 짚음", async () => {
    need();
    const base = "http://localhost:8218";
    const api = await H.startApi(8218, { ...db.env });
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "FINANCE_OVERDUE_AR", actor: "FINANCE" }));
      const deny = await call(base, "POST", "/api/audit/anchor", { actor: "MARKETING_TEAM" });
      const r = await call(base, "POST", "/api/audit/anchor", { actor: "GROUP_CEO" });
      assert.equal(r.status, 200, `머리값 기록 API: ${r.status} ${(await r.clone().text()).slice(0, 100)}`);
      const a = (await r.json()).anchor;
      const msg = (await snap(base)).outbox.find((m) => m.channel === "messenger" && m.body.includes(a.hash));
      // 공격자: 트리거를 지우고, 기록 하나를 고친 뒤 그 뒤의 체인을 전부 다시 계산(머리값까지)
      const py = `
import json, sys, pymysql
sys.path.insert(0, ${JSON.stringify(path.join(H.ROOT, "backend"))})
from app.workflow.service import audit_hash
c = pymysql.connect(unix_socket=${JSON.stringify(SOCK)}, user="root", database="aurora_desk", charset="utf8mb4", autocommit=True)
cur = c.cursor()
cur.execute("DROP TRIGGER IF EXISTS audit_no_update")
cur.execute("SELECT id, doc FROM audit ORDER BY seq")
rows = [(i, json.loads(d)) for i, d in cur.fetchall()]
rows[1][1]["detail"] = "조작된 내용(체인 다시 계산)"
head = ""
for i, d in rows:
    d["prev"] = head
    d["hash"] = head = audit_hash(d)
    cur.execute("UPDATE audit SET doc=%s WHERE id=%s", (json.dumps(d, ensure_ascii=False), i))
cur.execute("SELECT doc FROM kv WHERE id='seq'")
s = json.loads(cur.fetchone()[0]); s["audit_head"] = head
cur.execute("UPDATE kv SET doc=%s WHERE id='seq'", (json.dumps(s, ensure_ascii=False),))
print(rows[1][0])`;
      const tampered = execFileSync("python3", ["-c", py], { encoding: "utf8" }).trim();
      const plain = await verify(base);
      const anchored = await verify(base, [`${a.id}:${a.hash}`]);
      assert.equal(deny.status, 403, `마케팅팀이 머리값을 기록함(${deny.status})`);
      assert.ok(msg, "메신저로 보낸 머리값이 없음(전체 해시가 메시지에 그대로 있어야 함)");
      assert.equal(plain.ok, true, "체인 전체를 다시 계산했는데 머리값 없이도 찾음(시험 전제 확인)");
      assert.equal(anchored.ok, false, `메신저의 머리값으로 검증해도 '이상 없음' — 고친 기록 ${tampered}을 놓침`);
      return { anchor: a.id, tampered };
    } finally { H.stop(api); }
  });

  T("AN08", "머리값 정기 기록 × 서버 2대: 두 서버 모두 AUDIT_ANCHOR_S=2로 7초 동안 돌아도 머리값은 주기마다 한 번씩만(2~5번) 보내고, 보낸 머리값은 모두 실제 기록의 해시와 같음", async () => {
    need();
    const b1 = "http://localhost:8219", b2 = "http://localhost:8209";
    const env = { ...db.env, AUDIT_ANCHOR_S: "2" };
    const a1 = await H.startApi(8219, env), a2 = await H.startApi(8209, env);
    try {
      await call(b1, "POST", "/api/reset");
      const end = Date.now() + 7000;
      const loop = async (base, k) => { let i = 0; while (Date.now() < end) { await call(base, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: `주기 시험 ${k}-${i++}` }).then((r) => r.json()); await sleep(100); } };
      await Promise.all([loop(b1, 1), loop(b2, 2)]);
      const anchors = sqlRows("SELECT JSON_UNQUOTE(JSON_EXTRACT(doc,'$.detail')) FROM audit WHERE JSON_UNQUOTE(JSON_EXTRACT(doc,'$.topic'))='audit.anchor' ORDER BY seq").map((r) => r[0]);
      const pairs = anchors.map((d) => (d.match(/(AU-\d+)\D+([0-9a-f]{64})/) || []).slice(1));
      const wrong = [];
      for (const [id, h] of pairs) { const real = id && sqlRows(`SELECT JSON_UNQUOTE(JSON_EXTRACT(doc,'$.hash')) FROM audit WHERE id='${id}'`)[0]?.[0]; if (!id || real !== h) wrong.push(`${id}:${(h || "").slice(0, 8)}`); }
      H.recordPerf("서버 2대 머리값 정기 기록 7초", 0, { anchors: anchors.length });
      assert.ok(anchors.length >= 2 && anchors.length <= 5, `7초 동안 머리값 기록 ${anchors.length}번(주기 2초, 서버 2대)`);
      assert.deepEqual(wrong, [], `실제 기록과 다른 머리값: ${wrong.join(", ")}`);
      return { anchors: anchors.length };
    } finally { H.stop(a1); H.stop(a2); }
  });
});

describe("시연 영상", () => {
  T("AN09", "시연 영상: 5분 미만, AI 음성 해설 트랙, 해설이 모두 영상 안에서 재생되고 v1.27 장면(화면에서 체인 검증·머리값 기록)이 들어 있음", async () => {
    const mp4 = path.join(H.ROOT, "demo", "aurora_demo.mp4"), nar = path.join(H.ROOT, "demo", "narration.json");
    if (!fs.existsSync(mp4)) return { skipped: "영상 파일 없음(zip에는 영상이 빠짐)" };
    const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", mp4], { encoding: "utf8" }));
    const dur = Number(info.format.duration);
    const lines = JSON.parse(fs.readFileSync(nar, "utf8"));
    assert.ok(dur < 300, `영상 ${dur.toFixed(1)}초 — 5분 미만이 아님`);
    assert.ok(info.streams.some((s) => s.codec_type === "audio"), "음성 트랙 없음");
    assert.ok(lines.every((l) => l.at + l.dur <= dur + 0.5), "영상 밖 해설");
    assert.ok(lines.some((l) => /머리값/.test(l.title + l.text)), "v1.27(머리값 기록·화면 검증) 장면 없음");
    return { seconds: Math.round(dur * 10) / 10, lines: lines.length };
  });
});

// ---------------- §14 · §15 대조 ----------------
const DONE_IN_V127 = [/머리값\(`head`\)을 밖/];
const SUITES = () => (fs.readFileSync(path.join(__dirname, "run_all.sh"), "utf8").match(/for s in ([^;]+);/) || [, ""])[1].trim().split(/\s+/);
const latestOf = (s) => { const f = path.join(__dirname, "reports", `${s}.json`); return fs.existsSync(f) ? Object.fromEntries(JSON.parse(fs.readFileSync(f, "utf8")).results.map((r) => [r.id, r.ok])) : {}; };

describe("§14 리스크와 한계 · §15 대조", () => {
  T("AN01", "§14의 모든 행이 지키는 테스트를 가리키고 통과했으며, §15 '검증' 열의 테스트가 모두 있고 통과했고, '남은 일'에 이미 한 일이 없으며, 표의 E2E 수가 사실과 같음", async () => {
    const prd = fs.readFileSync(path.join(H.ROOT, "docs", "PRD.md"), "utf8");
    const sec = prd.split("## 14. 리스크와 한계")[1].split("\n## 15.")[0];
    const s15 = prd.split("\n## 15.")[1].split("\n## ")[0];
    const rows = sec.split("\n").filter((l) => /^\| [^-]/.test(l) && !/^\| 리스크 \|/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const unmapped = rows.filter((r) => !Object.keys(RISK_GUARDS).some((k) => r[1].startsWith(k))).map((r) => r[1]);
    const cache = {};
    const pyNames = Object.values(RISK_GUARDS).flat().filter((x) => x.startsWith("pytest:")).map((x) => x.slice(7));
    let pyOk = true;
    try { execFileSync("python3", ["-m", "pytest", "-q", "-k", pyNames.join(" or "), "backend/tests"], { cwd: H.ROOT, stdio: "pipe" }); } catch { pyOk = false; }
    const okOf = (s, id) => (s === "pytest" ? pyOk : s === "round27" ? results.find((r) => r.id === id)?.ok : (cache[s] ??= latestOf(s))[id]);
    const failing = [];
    for (const [risk, refs] of Object.entries(RISK_GUARDS)) for (const ref of refs) { const [s, id] = ref.split(/:(.+)/); const ok = okOf(s, id); if (ok !== true) failing.push(`${risk} ← ${ref}(${ok === undefined ? "없음" : "실패"})`); }
    const head = s15.split("\n").find((l) => /^\| # \|/.test(l)).split("|").map((x) => x.trim());
    const vcol = head.indexOf("검증"), ncol = head.indexOf("남은 일");
    const s15rows = s15.split("\n").filter((l) => /^\| [0-9①-⑩]/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const suiteOf = { AH: "round21", AI: "round22", AJ: "round23", AK: "round24", AL: "round25", AM: "round26", AN: "round27" };
    const verifyBad = [];
    for (const r of s15rows) {
      const ids = [];
      for (const m of (r[vcol] || "").matchAll(/\b(A[H-N])(\d\d)(?:~A[H-N](\d\d))?/g)) { const x = Number(m[2]), z = Number(m[3] || m[2]); for (let i = x; i <= z; i++) ids.push(`${m[1]}${String(i).padStart(2, "0")}`); }
      for (const id of ids) if (okOf(suiteOf[id.slice(0, 2)], id) !== true) verifyBad.push(`§15 ${r[1]} ← ${id}`);
    }
    const stale = s15rows.filter((r) => DONE_IN_V127.some((re) => re.test(r[ncol] || ""))).map((r) => `${r[1]}: ${r[ncol]}`);
    const total = SUITES().filter((s) => s !== "round27").reduce((n, s) => n + Object.keys(latestOf(s)).length, 0) + results.length + 1;
    const stated = Number((sec.match(/E2E\(현재 (\d+)개\)/) || [])[1]);
    assert.deepEqual(unmapped, [], `지키는 테스트가 없는 리스크 행: ${unmapped.join(", ")}`);
    assert.deepEqual(failing, [], `대응이 지켜지지 않는 리스크 ${failing.length}건: ${failing.slice(0, 6).join(" / ")}`);
    assert.deepEqual(verifyBad, [], `§15 '검증' 열의 테스트가 없거나 실패: ${verifyBad.join(", ")}`);
    assert.deepEqual(stale, [], `§15 '남은 일'에 이미 한 일: ${stale.join(" / ")}`);
    assert.equal(stated, total, `§14가 말하는 E2E 수 ${stated} ≠ 실제 ${total}`);
    return { risks: rows.length, refs: Object.values(RISK_GUARDS).flat().length, e2e_total: total };
  });
});
