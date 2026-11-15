// 28차 E2E — 기능 고정(feature freeze): v1.27에 넣은 기능 × 기존 보장만 시험하고, 결함·성능 문제만 고친다(새 기능 없음).
//   머리값 정기 기록 × DB 재시작: 장애가 지나간 뒤에도 정기 기록이 이어지는가                                  → AO02
//   머리값 × '처음부터': 처음부터 이전에 받은 머리값으로 검증해도 '위조'라고 잘못 말하지 않는가                 → AO03
//   머리값 메시지 × 메신저 장애: 못 보낸 머리값을 '보냄'으로 기록하지 않고, 다시 보내면 도착하는가               → AO04
//   verify?anchor 입력 검증: 잘못된 값에 '위조'라고 답하거나 500이 나지 않는가                                   → AO05
//   체인 검증 버튼 × 로그인 모드 × 390px 휴대폰 × 브라우저 단독 모드                                             → AO06
//   검색 COLLATE × 특수 문자(%·_·\) × 감사 12만 건 속도                                                          → AO07
//   체인 검증 × 서버 2대 동시 검증 × 쓰기                                                                         → AO08
//   시연 영상(5분 미만)·문서의 영상 길이                                                                          → AO09
//   §14·§15 표 대조 + 기능 고정 확인(§15에 'v1.28 추가' 열 없음)                                                  → AO01(맨 끝)
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const H = require("./helpers.cjs");
const RISK_GUARDS = Object.fromEntries(Object.entries(require("./risk_guards.cjs").RISK_GUARDS).map(([k, v]) => [k, v.filter((r) => !/^round3[02]:/.test(r))]));   // 30차는 28차 뒤에 돈다

const KEY = "e2e-key";
const PORT = 3328, SOCK = `/tmp/aurora-e2e-${PORT}.sock`, DATADIR = path.join(H.ROOT, "e2e", ".mariadb");
const DIST = path.join(H.ROOT, "frontend", "dist-docker");
const AXE = require.resolve("axe-core/axe.min.js", { paths: [path.join(H.ROOT, "frontend")] });
const SAMPLES = path.join(H.ROOT, "data", "samples", "contracts");
const MSG = 8976, SECRET = "e2e-channel-secret-0123456789abcdef";
const USERS = "contract.choi:pw-co:CONTRACT_OWNER;ceo.kang:pw-ceo:GROUP_CEO;mk.park:pw-mk:MARKETING_TEAM";
const JWT = { AUTH_MODE: "jwt", USERS, JWT_SECRET: "e2e-secret-0123456789abcdef" };
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, body, h = {}) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...h }, body: body ? JSON.stringify(body) : undefined });
const jobOf = async (base, id, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { const j = await (await call(base, "GET", `/api/jobs/${id}`)).json(); if (j.status === "done" || j.status === "failed") return j; await new Promise((x) => setTimeout(x, 80)); } throw new Error("job timeout"); };
const waitJob = async (base, r, ms) => { const b = await r.json(); return b.job_id ? jobOf(base, b.job_id, ms) : { ...b, http: r.status }; };
const snap = async (base) => (await call(base, "GET", "/api/snapshot")).json();
const timed = async (fn) => { const t0 = Date.now(); const v = await fn(); return [Date.now() - t0, v]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p95 = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))]; };
const sqlRows = (q, dbname = "aurora_desk") => execFileSync("mariadb", ["-uroot", `--socket=${SOCK}`, "--default-character-set=utf8mb4", "-N", "-B", dbname, "-e", q], { encoding: "utf8", maxBuffer: 1 << 28 }).trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
const verify = async (base, anchors = []) => call(base, "GET", `/api/audit/verify${anchors.length ? "?" + anchors.map((a) => `anchor=${encodeURIComponent(a)}`).join("&") : ""}`);
const anchorsInDb = () => sqlRows("SELECT seq, JSON_UNQUOTE(JSON_EXTRACT(doc,'$.detail')) FROM audit WHERE JSON_UNQUOTE(JSON_EXTRACT(doc,'$.topic'))='audit.anchor' ORDER BY seq");
const upload = (base, file) => { const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync(file)]), path.basename(file)); fd.append("actor", "CONTRACT_OWNER"); return fetch(`${base}/api/contracts`, { method: "POST", headers: { "X-API-Key": KEY }, body: fd }); };
const seed = (n, extra = {}) => {
  const r = spawnSync("python3", [path.join(__dirname, "seed_audit.py"), String(n)], { encoding: "utf-8", env: { ...process.env, LLM_PROVIDER: "offline", ...db.env, ...extra }, timeout: 300000 });
  if (r.status !== 0) throw new Error(`합성 데이터 실패: ${r.stderr.slice(-300)}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
};

let db, msg;
before(async () => {
  db = await H.startMariaDB(PORT);
  if (!db && process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음");
  msg = spawn("python3", [path.join(__dirname, "mock_eapproval.py"), String(MSG)], { stdio: "ignore", detached: true, env: { ...process.env, CHANNEL_SECRET: SECRET } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${MSG}/__received`)).ok) break; } catch { /* not yet */ } await sleep(150); }
});
after(() => { H.writeReport("round28", { results }); H.stop(db); try { process.kill(-msg.pid); } catch { /* gone */ } });
const need = () => { if (!db || db.env?.REPO !== "mysql") throw new Error("MariaDB 없음(또는 접속 정보 없음)"); };

async function restartDB(downMs = 1500) {
  const { env, sql } = db;
  H.stop(db);
  for (let i = 0; i < 80 && db.exitCode === null; i++) await sleep(100);
  await sleep(downMs);
  db = H.startProc("mariadbd", ["--user=root", `--datadir=${DATADIR}`, `--socket=${SOCK}`, `--pid-file=${DATADIR}/m.pid`, `--port=${PORT}`, "--bind-address=127.0.0.1", "--skip-name-resolve"], {});
  Object.assign(db, { env, sql });
  for (let i = 0; i < 100; i++) { try { execFileSync("mariadb", ["-uroot", `--socket=${SOCK}`, "-e", "SELECT 1"], { stdio: "ignore" }); return; } catch { await sleep(150); } }
  throw new Error("DB가 다시 켜지지 않음");
}

describe("v1.27 기능 × 기존 보장(기능 고정)", () => {
  T("AO02", "머리값 정기 기록 × DB 재시작: AUDIT_ANCHOR_S=1로 도는 중 DB가 1.5초 꺼졌다 켜져도, 그 뒤 쓰기가 이어지면 4초 안에 정기 기록이 다시 생김(타이머가 죽지 않음)", async () => {
    need();
    const base = "http://localhost:8220";
    const api = await H.startApi(8220, { ...db.env, AUDIT_ANCHOR_S: "1" });
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: "재시작 전 메모" }));
      await sleep(1500);
      const before = anchorsInDb().length;
      await restartDB(1500);
      const t0 = Date.now(); let after = 0;
      while (Date.now() - t0 < 4000) { await call(base, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: "재시작 뒤 메모" }).then((r) => r.text()).catch(() => {}); await sleep(300); after = anchorsInDb().length; if (after > before) break; }
      assert.ok(before >= 1, "재시작 전 정기 기록이 없음(시험 준비)");
      assert.ok(after > before, `DB 재시작 뒤 4초 동안 정기 기록이 다시 생기지 않음(${before} → ${after})`);
      return { before, after, ms: Date.now() - t0 };
    } finally { H.stop(api); }
  });

  T("AO03", "머리값 × '처음부터': 처음부터 이전에 메신저로 받은 머리값으로, 처음부터 뒤 같은 번호의 기록이 다시 생긴 체인을 검증해도 '위조'라고 하지 않고 '처음부터 이전 머리값'임을 알려 줌", async () => {
    need();
    const base = "http://localhost:8221";
    const api = await H.startApi(8221, { ...db.env });
    try {
      const journey = async () => { await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" })); await waitJob(base, await call(base, "POST", "/api/events", { kind: "FINANCE_OVERDUE_AR", actor: "FINANCE" })); };
      await call(base, "POST", "/api/reset"); await journey();
      const a = (await (await call(base, "POST", "/api/audit/anchor", { actor: "GROUP_CEO" })).json()).anchor;
      await call(base, "POST", "/api/reset"); await journey(); await journey();
      const same = sqlRows(`SELECT JSON_UNQUOTE(JSON_EXTRACT(doc,'$.hash')) FROM audit WHERE id='${a.id}'`)[0]?.[0];
      const r = await verify(base, [`${a.id}:${a.hash}`]);
      const v = await r.json();
      const text = JSON.stringify(v);
      assert.ok(same && same !== a.hash, "시험 준비: 처음부터 뒤 같은 번호의 다른 기록이 있어야 함");
      assert.equal(r.status, 200);
      assert.ok(!/위조/.test(text), `정당한 '처음부터' 뒤 옛 머리값을 '위조'로 판정: ${text.slice(0, 220)}`);
      assert.equal(v.ok, true, `처음부터 뒤 체인은 이상이 없어야 함: ${text.slice(0, 220)}`);
      assert.ok(/처음부터/.test(text), `옛 머리값이 처음부터 이전 것이라는 안내가 없음: ${text.slice(0, 220)}`);
      return { anchor: a.id };
    } finally { H.stop(api); }
  });

  T("AO04", "머리값 메시지 × 메신저 장애: 메신저가 계속 실패하면 감사 기록이 '보냄'이라고 하지 않고 전송 목록에 실패로 남으며, 다시 보내면 메신저에 전체 해시가 도착함", async () => {
    need();
    const base = "http://localhost:8222", M = `http://127.0.0.1:${MSG}`;
    const api = await H.startApi(8222, { ...db.env, CHANNEL: "webhook", CHANNEL_SECRET: SECRET, MESSENGER_WEBHOOK_URL: `${M}/hooks/messenger`, CHANNEL_BACKOFF_S: "0.1" });
    try {
      await call(base, "POST", "/api/reset");
      await fetch(`${M}/__reset`, { method: "POST" }); await fetch(`${M}/__mode`, { method: "POST", body: JSON.stringify({ fail: 100 }) });
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      const a = (await (await call(base, "POST", "/api/audit/anchor", { actor: "GROUP_CEO" })).json()).anchor;
      let d; for (let i = 0; i < 40; i++) { d = await (await call(base, "GET", "/api/integrations/deliveries")).json(); if (d.failed >= 1) break; await sleep(150); }
      const detail = anchorsInDb().pop()?.[1] || "";
      assert.ok(d.failed >= 1, "메신저 장애인데 실패한 전송이 없음");
      assert.ok(!/보냄/.test(detail), `메신저가 받지 못했는데 감사 기록이 '보냄': ${detail}`);
      await fetch(`${M}/__mode`, { method: "POST", body: JSON.stringify({ fail: 0 }) });
      const eid = d.items.find((x) => x[1].status === "failed")[0];
      const rr = await call(base, "POST", `/api/integrations/deliveries/${eid}/retry`, { actor: "GROUP_CEO" });
      let got = []; for (let i = 0; i < 40; i++) { got = (await (await fetch(`${M}/__received`)).json()).received; if (got.length) break; await sleep(150); }
      assert.ok(rr.status < 300, `다시 보내기 ${rr.status}`);
      assert.ok(got.some((x) => JSON.stringify(x).includes(a.hash)), "다시 보낸 뒤에도 메신저에 머리값(전체 해시)이 없음");
      return { anchor: a.id };
    } finally { H.stop(api); await fetch(`http://127.0.0.1:${MSG}/__mode`, { method: "POST", body: JSON.stringify({ fail: 0 }) }).catch(() => {}); }
  });

  T("AO05", "verify?anchor 입력 검증: 잘못된 형식(콜론 없음·짧은 해시·16진수 아님·10KB)과 51개는 422로 거절하고, '위조'라고 답하거나 500이 나지 않음", async () => {
    need();
    const base = "http://localhost:8223";
    const api = await H.startApi(8223, { ...db.env });
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      const id = sqlRows("SELECT id FROM audit ORDER BY seq LIMIT 1")[0][0];
      const good = `${id}:${"a".repeat(64)}`;
      const cases = { "콜론 없음": id, "빈 해시": `${id}:`, "짧은 해시": `${id}:abc`, "16진수 아님": `${id}:${"g".repeat(64)}`, "10KB": `${id}:${"a".repeat(10000)}`, "SQL 문자": `${id}' OR 1=1 --:${"a".repeat(64)}` };
      const bad = [];
      for (const [k, v] of Object.entries(cases)) { const r = await verify(base, [v]); const t = await r.text(); if (r.status !== 422) bad.push(`${k}→${r.status}${/위조/.test(t) ? "(위조라고 답함)" : ""}`); }
      const many = await verify(base, Array.from({ length: 51 }, () => good));
      if (many.status !== 422) bad.push(`51개→${many.status}`);
      const ok1 = await verify(base, [good]);
      assert.deepEqual(bad, [], `잘못된 머리값 입력 처리: ${bad.join(", ")}`);
      assert.equal(ok1.status, 200, "올바른 형식은 받아야 함");
      return { checked: Object.keys(cases).length + 1 };
    } finally { H.stop(api); }
  });

  T("AO06", "체인 검증 버튼 × 로그인 모드 × 390px 휴대폰: 마케팅팀으로 로그인해도 검증할 수 있고, 버튼·결과가 화면 안에 보이며 가로 스크롤이 없고 axe 심각·치명 0건, 브라우저 단독 모드에는 버튼이 없음", async () => {
    need();
    const base = "http://localhost:8224";
    const api = await H.startApi(8224, { ...db.env, ...JWT, SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage({ viewport: { width: 390, height: 844 } }); const p = B.page;
    try {
      const tok = (await (await call(base, "POST", "/api/auth/login", { user: "ceo.kang", password: "pw-ceo" })).json()).token;
      await call(base, "POST", "/api/reset", null, { Authorization: `Bearer ${tok}` });
      await p.goto(base); await p.waitForSelector(".top");
      await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
      const localBtn = await p.locator('[data-testid="audit-verify"]').count();
      await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(600);
      await p.locator('[data-testid="login-user"]').fill("mk.park"); await p.locator('[data-testid="login-password"]').fill("pw-mk"); await p.locator('[data-testid="login-submit"]').click();
      const btn = p.locator('[data-testid="audit-verify"]');
      await btn.waitFor({ timeout: 6000 });
      await btn.scrollIntoViewIfNeeded(); await btn.click();
      const out = p.locator('[data-testid="audit-verify-result"]');
      await out.filter({ hasText: /이상 없음/ }).waitFor({ timeout: 6000 });
      const geo = await p.evaluate(() => {
        const b = document.querySelector('[data-testid="audit-verify"]').getBoundingClientRect(), o = document.querySelector('[data-testid="audit-verify-result"]');
        return { right: Math.max(b.right, o.getBoundingClientRect().right), page: document.scrollingElement.scrollWidth, vw: innerWidth, overflow: o.scrollWidth - o.clientWidth };
      });
      await p.addScriptTag({ path: AXE });
      const v = await p.evaluate(async () => (await window.axe.run({ include: [[".audit"]] }, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] })).violations.filter((x) => ["serious", "critical"].includes(x.impact)).map((x) => x.id));
      assert.equal(localBtn, 0, "브라우저 단독 모드에 체인 검증 버튼이 보임(단독 기록에는 체인이 없음)");
      assert.ok(geo.right <= geo.vw + 1 && geo.page <= geo.vw + 1 && geo.overflow <= 1, `390px에서 넘침: ${JSON.stringify(geo)}`);
      assert.deepEqual(v, [], `axe: ${v.join(",")}`);
      assert.deepEqual(p.errors, []);
      return geo;
    } finally { await B.browser.close().catch(() => {}); H.stop(api); }
  });

  T("AO07", "검색 COLLATE × 특수 문자 × 감사 12만 건: '%'·'_'·'\\'·'100%'를 글자 그대로 찾아 메모리 저장소와 결과가 같고, 감사 12만 건에서 검색 p95 800ms 이하", async () => {
    need();
    const bm = "http://localhost:8225", bs = "http://localhost:8226";
    const mem = await H.startApi(8225, {});
    let sql;
    try {
      const Q = ["%", "_", "\\", "100%", "a_b", "할인%"];
      const got = { memory: {}, mysql: {} };
      seed(120000);
      sql = await H.startApi(8226, { ...db.env });
      for (const [label, base] of [["memory", bm], ["mysql", bs]]) {
        if (label === "memory") await call(base, "POST", "/api/reset");
        const base0 = {};   // 합성 데이터 스크립트가 넣는 기본 시나리오 기록(역할 코드 GROUP_CEO 등)은 빼고, 이번 업로드·확인값으로 늘어난 건수만 비교
        for (const q of Q) base0[q] = (await (await call(base, "GET", `/api/audit?limit=1&q=${encodeURIComponent(q)}`)).json()).matched;
        const uj = await upload(base, path.join(SAMPLES, "logistics_3pl_renewal.md")).then((r) => r.json()).then((b) => jobOf(base, b.job_id));
        assert.equal(uj.status, "done", uj.message);
        const rc = (await snap(base)).cases.filter((c) => c.type === "RENEWAL").pop();
        const fr = await call(base, "POST", `/api/contracts/${rc.target_id}/facts`, { actor: "FINANCE", notice_days: 60, note: "할인 100% 코드 a_b 경로 c:\\x" });
        assert.equal(fr.status, 200, await fr.text());
        for (const q of Q) got[label][q] = (await (await call(base, "GET", `/api/audit?limit=1&q=${encodeURIComponent(q)}`)).json()).matched - base0[q];
      }
      const diff = Q.filter((q) => got.memory[q] !== got.mysql[q]).map((q) => `'${q}' 메모리 ${got.memory[q]} · MySQL ${got.mysql[q]}`);
      const lat = [];
      for (let i = 0; i < 10; i++) { const [ms] = await timed(() => call(bs, "GET", `/api/audit?limit=50&q=${encodeURIComponent(i % 2 ? "과거 운영 기록 #11999" : "없는검색어" + i)}`).then((r) => r.json())); lat.push(ms); }
      H.recordPerf("감사 12만 건 검색(COLLATE)", p95(lat), {});
      assert.deepEqual(diff, [], `특수 문자 검색이 저장소마다 다름: ${diff.join(" / ")}`);
      assert.ok(p95(lat) <= 800, `감사 12만 건 검색 p95 ${p95(lat)}ms`);
      return { search_p95: p95(lat), counts: got.mysql };
    } finally { H.stop(mem); H.stop(sql); }
  });

  T("AO08", "체인 검증 × 서버 2대 × 쓰기: 감사 5만 건에서 두 서버가 동시에 검증을 3번씩 하는 동안 다른 사람의 접수가 모두 성공하고 p95 300ms 이하, 검증 결과 모두 '이상 없음'", async () => {
    need();
    const b1 = "http://localhost:8227", b2 = "http://localhost:8228";
    seed(50000, { SEED_CHAIN: "1" });
    const a1 = await H.startApi(8227, { ...db.env }), a2 = await H.startApi(8228, { ...db.env });
    try {
      let stop = false; const lat = [], codes = [];
      const writer = (async () => { let i = 0; while (!stop) { const [ms, r] = await timed(() => call(i % 2 ? b1 : b2, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: `동시 검증 중 ${i++}` })); lat.push(ms); codes.push(r.status); await r.text(); } })();
      const runs = await Promise.all([b1, b1, b1, b2, b2, b2].map((b) => verify(b).then((r) => r.json())));
      stop = true; await writer;
      const bad = codes.filter((c) => c >= 500).length, notOk = runs.filter((v) => v.ok !== true).length;
      H.recordPerf("서버 2대 동시 검증 6회 중 접수", p95(lat), { failed: bad, writes: codes.length, verify_not_ok: notOk });
      assert.equal(notOk, 0, `동시 검증 중 '이상' 판정 ${notOk}/6: ${JSON.stringify(runs.find((v) => !v.ok) || {}).slice(0, 160)}`);
      assert.equal(bad, 0, `동시 검증 중 접수 실패 ${bad}`);
      assert.ok(p95(lat) <= 300, `동시 검증 중 접수 p95 ${p95(lat)}ms`);
      return { write_p95: p95(lat), writes: codes.length };
    } finally { H.stop(a1); H.stop(a2); }
  });
});

describe("시연 영상", () => {
  T("AO09", "시연 영상: 5분 미만, AI 음성 해설 트랙, 해설이 모두 영상 안이고, PRD·README에 적은 영상 길이가 실제와 같음", async () => {
    const mp4 = path.join(H.ROOT, "demo", "aurora_demo.mp4"), nar = path.join(H.ROOT, "demo", "narration.json");
    if (!fs.existsSync(mp4)) return { skipped: "영상 파일 없음(zip에는 영상이 빠짐)" };
    const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", mp4], { encoding: "utf8" }));
    const dur = Number(info.format.duration);
    const lines = JSON.parse(fs.readFileSync(nar, "utf8"));
    const mmss = `${Math.floor(dur / 60)}분 ${Math.floor(dur % 60)}초`;
    const prd = fs.readFileSync(path.join(H.ROOT, "docs", "PRD.md"), "utf8").match(/## 10\. 시연 시나리오 \(영상: `demo\/aurora_demo\.mp4`, (\d분 \d+초)/)?.[1];
    const readme = fs.readFileSync(path.join(H.ROOT, "README.md"), "utf8").match(/\((\d분 \d+초), \*\*AI 음성 해설 포함\*\*/)?.[1];
    assert.ok(dur < 300, `영상 ${dur.toFixed(1)}초 — 5분 미만이 아님`);
    assert.ok(info.streams.some((s) => s.codec_type === "audio"), "음성 트랙 없음");
    assert.ok(lines.every((l) => l.at + l.dur <= dur + 0.5), "영상 밖 해설");
    assert.equal(prd, mmss, `PRD §10의 영상 길이 ${prd} ≠ 실제 ${mmss}`);
    assert.equal(readme, mmss, `README의 영상 길이 ${readme} ≠ 실제 ${mmss}`);
    return { seconds: Math.round(dur * 10) / 10, lines: lines.length };
  });
});

// ---------------- §14 · §15 대조 + 기능 고정 확인 ----------------
const DONE_IN_V128 = [];
const SUITES = () => (fs.readFileSync(path.join(__dirname, "run_all.sh"), "utf8").match(/for s in ([^;]+);/) || [, ""])[1].trim().split(/\s+/);
const latestOf = (s) => { const f = path.join(__dirname, "reports", `${s}.json`); return fs.existsSync(f) ? Object.fromEntries(JSON.parse(fs.readFileSync(f, "utf8")).results.map((r) => [r.id, r.ok])) : {}; };

describe("§14 리스크와 한계 · §15 대조", () => {
  T("AO01", "§14의 모든 행이 지키는 테스트를 가리키고 통과했으며, §15 '검증' 열의 테스트가 모두 있고 통과했고, 표의 E2E 수가 사실과 같고, 기능 고정(§15에 'v1.28 추가' 열 없음)", async () => {
    const prd = fs.readFileSync(path.join(H.ROOT, "docs", "PRD.md"), "utf8");
    const sec = prd.split("## 14. 리스크와 한계")[1].split("\n## 15.")[0];
    const s15 = prd.split("\n## 15.")[1].split("\n## ")[0];
    const rows = sec.split("\n").filter((l) => /^\| [^-]/.test(l) && !/^\| 리스크 \|/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const unmapped = rows.filter((r) => !Object.keys(RISK_GUARDS).some((k) => r[1].startsWith(k))).map((r) => r[1]);
    const cache = {};
    const pyNames = Object.values(RISK_GUARDS).flat().filter((x) => x.startsWith("pytest:")).map((x) => x.slice(7));
    let pyOk = true;
    try { execFileSync("python3", ["-m", "pytest", "-q", "-k", pyNames.join(" or "), "backend/tests"], { cwd: H.ROOT, stdio: "pipe" }); } catch { pyOk = false; }
    const okOf = (s, id) => (s === "pytest" ? pyOk : s === "round28" ? results.find((r) => r.id === id)?.ok : (cache[s] ??= latestOf(s))[id]);
    const failing = [];
    for (const [risk, refs] of Object.entries(RISK_GUARDS)) for (const ref of refs) { const [s, id] = ref.split(/:(.+)/); const ok = okOf(s, id); if (ok !== true) failing.push(`${risk} ← ${ref}(${ok === undefined ? "없음" : "실패"})`); }
    const headLine = s15.split("\n").find((l) => /^\| # \|/.test(l));
    const head = headLine.split("|").map((x) => x.trim());
    const vcol = head.indexOf("검증"), ncol = head.indexOf("남은 일");
    const s15rows = s15.split("\n").filter((l) => /^\| [0-9①-⑩]/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const suiteOf = { AH: "round21", AI: "round22", AJ: "round23", AK: "round24", AL: "round25", AM: "round26", AN: "round27", AO: "round28" };
    const verifyBad = [];
    for (const r of s15rows) {
      const ids = [];
      for (const m of (r[vcol] || "").matchAll(/\b(A[H-O])(\d\d)(?:~A[H-O](\d\d))?/g)) { const x = Number(m[2]), z = Number(m[3] || m[2]); for (let i = x; i <= z; i++) ids.push(`${m[1]}${String(i).padStart(2, "0")}`); }
      for (const id of ids) if (okOf(suiteOf[id.slice(0, 2)], id) !== true) verifyBad.push(`§15 ${r[1]} ← ${id}`);
    }
    const stale = s15rows.filter((r) => DONE_IN_V128.some((re) => re.test(r[ncol] || ""))).map((r) => `${r[1]}: ${r[ncol]}`);
    const total = SUITES().filter((s) => s !== "round28").reduce((n, s) => n + Object.keys(latestOf(s)).length, 0) + results.length + 1;
    const stated = Number((sec.match(/E2E\(현재 (\d+)개\)/) || [])[1]);
    assert.deepEqual(unmapped, [], `지키는 테스트가 없는 리스크 행: ${unmapped.join(", ")}`);
    assert.deepEqual(failing, [], `대응이 지켜지지 않는 리스크 ${failing.length}건: ${failing.slice(0, 6).join(" / ")}`);
    assert.deepEqual(verifyBad, [], `§15 '검증' 열의 테스트가 없거나 실패: ${verifyBad.join(", ")}`);
    assert.deepEqual(stale, []);
    assert.ok(!/v1\.28 추가/.test(headLine), "기능 고정인데 §15에 'v1.28 추가' 열이 있음");
    assert.equal(stated, total, `§14가 말하는 E2E 수 ${stated} ≠ 실제 ${total}`);
    return { risks: rows.length, refs: Object.values(RISK_GUARDS).flat().length, e2e_total: total };
  });
});
