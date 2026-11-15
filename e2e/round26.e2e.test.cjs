// 26차 E2E — v1.25 운영 DB 기능 × 기존 보장(재시작·무중단 배포·연결 한도·다른 화면·검색 규칙) + §15 ⑧ 남은 일 + §14·§15 표 대조 + 시연 영상.
//   커넥션 풀 × DB 재시작: 쉬던 연결이 죽어도 다시 켜진 DB에 바로 붙는가(503 0건)                          → AM02
//   정규화 × 무중단 배포: 아직 안 바꾼 v1.24 서버가 kv 'renewals'에 쓴 계약도 v1.25 서버가 처리하는가         → AM03
//   §15 ⑧ 감사 기록 위변조: 트리거를 우회(@aurora_reset·DROP TRIGGER)해 고치거나 지워도 찾아내는가(해시 체인) → AM04
//   §15 ⑧ summary_feedback도 행으로: 요약 평가 2만 건이 쌓여도 평가·집계가 빠르고 문서가 커지지 않는가       → AM05
//   커넥션 풀 × 서버 여러 대 × DB 최대 연결 수: 동시 요청이 몰려도 'Too many connections' 0건               → AM06
//   일관 읽기 × 감사 기록 전체 보기: 쓰는 중에도 '전체 n건 / 찾은 m건'이 같은 시점인가                       → AM07
//   문자셋 × 정렬 규칙(collation): 같은 검색어가 MySQL과 메모리 저장소에서 같은 결과인가(10차 규칙)            → AM08
//   시연 영상: 5분 미만, AI 음성 해설, v1.26 장면(위변조 탐지)                                               → AM09
//   §14·§15 표 대조                                                                                          → AM01(맨 끝)
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const H = require("./helpers.cjs");
const RISK_GUARDS = Object.fromEntries(Object.entries(require("./risk_guards.cjs").RISK_GUARDS).map(([k, v]) => [k, v.filter((r) => !/^round(2[78]|30):/.test(r))]));   // 27차는 26차 뒤에 돈다

const KEY = "e2e-key";
const SAMPLES = path.join(H.ROOT, "data", "samples", "contracts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aurora26-"));
const PORT = 3326, SOCK = `/tmp/aurora-e2e-${PORT}.sock`, DATADIR = path.join(H.ROOT, "e2e", ".mariadb");
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
const upload = (base, file) => { const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync(file)]), path.basename(file)); fd.append("actor", "CONTRACT_OWNER"); return fetch(`${base}/api/contracts`, { method: "POST", headers: { "X-API-Key": KEY }, body: fd }); };
const timed = async (fn) => { const t0 = Date.now(); const v = await fn(); return [Date.now() - t0, v]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 결과를 표로 받는 SQL(탭 구분, 머리글 없음) — 한글·이모지가 깨지지 않게 utf8mb4(25차의 교훈)
const sqlRows = (q, dbname = "aurora_desk") => execFileSync("mariadb", ["-uroot", `--socket=${SOCK}`, "--default-character-set=utf8mb4", "-N", "-B", dbname, "-e", q], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
const sqlFile = (f) => execFileSync("mariadb", ["-uroot", `--socket=${SOCK}`, "--default-character-set=utf8mb4", "--max-allowed-packet=256M", "aurora_desk"], { input: fs.readFileSync(f) });
const asApp = (q) => { try { execFileSync("mariadb", ["-uaurora", "-pe2e-pass", "-h127.0.0.1", `-P${PORT}`, "--default-character-set=utf8mb4", "aurora_desk", "-e", q], { stdio: "pipe" }); return "ok"; } catch (e) { return String(e.stderr || e.message); } };
const sqlStr = (s) => "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

let db;
before(async () => {
  db = await H.startMariaDB(PORT);
  if (!db && process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음");
});
after(() => { H.writeReport("round26", { results }); H.stop(db); });
const need = () => { if (!db || db.env?.REPO !== "mysql") throw new Error("MariaDB 없음(또는 접속 정보 없음)"); };

/** 같은 데이터 폴더로 DB를 껐다 켠다(운영의 DB 재시작·장애 조치와 같음). */
async function restartDB() {
  const { env, sql } = db;   // 다시 켠 프로세스에도 접속 정보를 이어 붙인다(빠뜨리면 뒤 시험이 메모리 저장소로 돎)
  H.stop(db);
  for (let i = 0; i < 80 && db.exitCode === null; i++) await sleep(100);
  db = H.startProc("mariadbd", ["--user=root", `--datadir=${DATADIR}`, `--socket=${SOCK}`, `--pid-file=${DATADIR}/m.pid`, `--port=${PORT}`, "--bind-address=127.0.0.1", "--skip-name-resolve"], {});
  Object.assign(db, { env, sql });
  for (let i = 0; i < 100; i++) { try { execFileSync("mariadb", ["-uroot", `--socket=${SOCK}`, "-e", "SELECT 1"], { stdio: "ignore" }); return; } catch { await sleep(150); } }
  throw new Error("DB가 다시 켜지지 않음");
}

describe("v1.25 운영 DB × 기존 보장", () => {
  T("AM02", "커넥션 풀 × DB 재시작: 풀에 쉬던 연결이 DB 재시작으로 모두 죽어도, DB가 다시 켜진 직후의 요청 20개(화면·검색·접수)가 모두 성공(503 0건)", async () => {
    need();
    const base = "http://localhost:8200";
    const api = await H.startApi(8200, { ...db.env });
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      // 동시에 몰아 풀에 쉬는 연결을 여러 개 만든다
      await Promise.all(Array.from({ length: 12 }, (_, i) => call(base, "GET", `/api/audit?limit=5&q=${i}`)));
      await restartDB();
      const codes = [];
      for (let i = 0; i < 20; i++) {
        const r = i === 10 ? await call(base, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: `재시작 뒤 메모 ${i}` })
          : await call(base, "GET", i % 2 ? `/api/audit?limit=3&q=${i}` : "/api/snapshot");
        codes.push(r.status);
      }
      const bad = codes.filter((c) => c >= 500).length;
      H.recordPerf("DB 재시작 직후 요청 20개", 0, { failed: bad, codes: codes.join(",") });
      assert.equal(bad, 0, `DB가 다시 켜진 뒤에도 ${bad}개가 503(죽은 연결을 그대로 빌려줌): ${codes.join(",")}`);
      return { failed: bad };
    } finally { H.stop(api); }
  });

  T("AM03", "정규화 × 무중단 배포: v1.25 서버가 뜬 뒤 아직 안 바꾼 v1.24 서버가 계약 기록을 kv 'renewals'에 써도, v1.25 서버에서 그 계약의 확인한 값 넣기가 되고 기록은 표로 옮겨짐", async () => {
    need();
    const base = "http://localhost:8201";
    const api = await H.startApi(8201, { ...db.env });
    try {
      await call(base, "POST", "/api/reset");
      const uj = await upload(base, path.join(SAMPLES, "logistics_3pl_renewal.md")).then((r) => r.json()).then((b) => jobOf(base, b.job_id));
      assert.equal(uj.status, "done", uj.message);
      const rc = (await snap(base)).cases.find((c) => c.type === "RENEWAL");
      const rid = rc.target_id;
      // v1.24 서버가 한 일과 같은 상태: 계약 기록이 표가 아니라 kv 'renewals' 문서에 있음
      sqlRows(`SET @d = (SELECT JSON_REMOVE(doc, '$.id') FROM renewals WHERE id='${rid}'); INSERT INTO kv (id, doc) VALUES ('renewals', JSON_OBJECT('id', 'renewals', 'items', JSON_OBJECT('${rid}', JSON_EXTRACT(@d, '$')))); DELETE FROM renewals WHERE id='${rid}'; SELECT 1`);
      const r = await call(base, "POST", `/api/contracts/${rid}/facts`, { actor: "FINANCE", notice_days: 60, note: "구 서버에서 올린 계약 확인" });
      const body = await r.text();
      const row = Number(sqlRows(`SELECT COUNT(*) FROM renewals WHERE id='${rid}'`)[0][0]);
      const kvLeft = Number(sqlRows("SELECT COUNT(*) FROM kv WHERE id='renewals'")[0][0]);
      assert.equal(r.status, 200, `구 서버가 쓴 계약을 v1.25 서버가 못 찾음: ${body.slice(0, 120)}`);
      assert.equal(row, 1, "계약 기록이 표로 옮겨지지 않음");
      assert.equal(kvLeft, 0, "kv 'renewals'가 남아 있음(두 곳에 나뉨)");
      return { contract: rid };
    } finally { H.stop(api); }
  });

  T("AM07", "일관 읽기 × 감사 기록 전체 보기: 다른 사용자가 계속 접수하는 동안 '전체 기록 보기'를 150번 열어도 '전체 n건'과 '찾은 m건'(검색어 없음)이 늘 같음", async () => {
    need();
    const base = "http://localhost:8202";
    const api = await H.startApi(8202, { ...db.env });
    try {
      await call(base, "POST", "/api/reset");
      let stop = false;
      const writer = (async () => { let i = 0; while (!stop) { await call(base, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: `동시 메모 ${i++}` }).then((x) => x.json()); } return i; })();
      let bad = 0, n = 0;
      while (n < 150) { const a = await (await call(base, "GET", "/api/audit?limit=1&offset=0")).json(); n++; if (a.matched !== a.total) bad++; }
      stop = true; const written = await writer;
      H.recordPerf("쓰는 중 감사 전체 보기 150회", 0, { mismatched: bad, written });
      assert.equal(bad, 0, `'전체 n건'과 '찾은 m건'이 다른 시점 ${bad}/150번(두 조회가 다른 트랜잭션)`);
      return { mismatched: bad, written };
    } finally { H.stop(api); }
  });

  T("AM08", "문자셋 × 정렬 규칙: 'Café·ＡＢＣ·Straße'가 든 감사 기록을 MySQL 서버와 메모리 서버에서 같은 검색어로 찾으면 결과 수가 같음(검색 규칙은 한 가지 — 10차)", async () => {
    need();
    const bm = "http://localhost:8203", bs = "http://localhost:8204";
    const mem = await H.startApi(8203, {});
    const sql = await H.startApi(8204, { ...db.env });
    try {
      const Q = ["cafe", "café", "abc", "ａｂｃ", "strasse", "straße"];
      const got = {};
      for (const [label, base] of [["memory", bm], ["mysql", bs]]) {
        await call(base, "POST", "/api/reset");
        const uj = await upload(base, path.join(SAMPLES, "logistics_3pl_renewal.md")).then((r) => r.json()).then((b) => jobOf(base, b.job_id));
        assert.equal(uj.status, "done", uj.message);
        const rc = (await snap(base)).cases.find((c) => c.type === "RENEWAL");
        const fr = await call(base, "POST", `/api/contracts/${rc.target_id}/facts`, { actor: "FINANCE", notice_days: 60, note: "Café ＡＢＣ Straße 확인" });
        assert.equal(fr.status, 200, await fr.text());
        got[label] = {};
        for (const q of Q) got[label][q] = (await (await call(base, "GET", `/api/audit?limit=1&q=${encodeURIComponent(q)}`)).json()).matched;
      }
      const diff = Q.filter((q) => got.memory[q] !== got.mysql[q]).map((q) => `'${q}' 메모리 ${got.memory[q]} · MySQL ${got.mysql[q]}`);
      assert.deepEqual(diff, [], `저장소마다 검색 결과가 다름: ${diff.join(" / ")}`);
      return got;
    } finally { H.stop(mem); H.stop(sql); }
  });

  T("AM06", "커넥션 풀 × 서버 2대 × DB 최대 연결 수(30): 두 서버에 동시 요청 160개가 몰려도 'Too many connections'로 실패한 요청 0건, DB가 본 최대 동시 연결 30 이하", async () => {
    need();
    const b1 = "http://localhost:8205", b2 = "http://localhost:8206";
    sqlRows("SET GLOBAL max_connections = 30; SELECT 1");
    const a1 = await H.startApi(8205, { ...db.env });
    const a2 = await H.startApi(8206, { ...db.env });
    try {
      await call(b1, "POST", "/api/reset");
      await waitJob(b1, await call(b1, "POST", "/api/events", { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" }));
      sqlRows("FLUSH STATUS; SELECT 1");
      const fire = (base, i) => (i % 8 === 0 ? call(base, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: `몰림 ${i}` })
        : call(base, "GET", i % 2 ? `/api/audit?limit=20&q=${encodeURIComponent("기안 " + (i % 25))}` : "/api/snapshot")).then((r) => r.status).catch(() => 0);
      const [ms, codes] = await timed(() => Promise.all([...Array.from({ length: 80 }, (_, i) => fire(b1, i)), ...Array.from({ length: 80 }, (_, i) => fire(b2, i))]));
      const failed = codes.filter((c) => c !== 200 && c !== 202).length;
      const maxUsed = Number(sqlRows("SHOW GLOBAL STATUS LIKE 'Max_used_connections'")[0][1]);
      H.recordPerf("서버 2대 동시 160요청(max_connections 30)", ms, { failed, max_used: maxUsed });
      assert.equal(failed, 0, `실패한 요청 ${failed}/160(DB 연결 한도 초과 503) — 최대 동시 연결 ${maxUsed}`);
      assert.ok(maxUsed <= 30, `DB 최대 동시 연결 ${maxUsed}`);
      return { failed, max_used: maxUsed, ms };
    } finally { H.stop(a1); H.stop(a2); sqlRows("SET GLOBAL max_connections = 151; SELECT 1"); }
  });
});

describe("§15 ⑧ 남은 일", () => {
  T("AM04", "감사 기록 위변조 탐지: 앱 계정 비밀번호로 트리거를 우회해 기록 하나를 고치고(DROP TRIGGER) 하나를 지워도(@aurora_reset) 검증 API가 그 자리를 짚고, 고치기 전에는 '이상 없음'", async () => {
    need();
    const base = "http://localhost:8207";
    const api = await H.startApi(8207, { ...db.env });
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" }));
      const v0r = await call(base, "GET", "/api/audit/verify");
      assert.equal(v0r.status, 200, "감사 기록을 검증할 방법이 없음(검증 API 없음)");
      const [ms0, v0] = await timed(async () => (await call(base, "GET", "/api/audit/verify")).json());
      const ids = sqlRows("SELECT id FROM audit ORDER BY seq").map((r) => r[0]);
      const [mod, del, next] = [ids[2], ids[5], ids[6]];
      const t1 = asApp(`DROP TRIGGER IF EXISTS audit_no_update; UPDATE audit SET doc=JSON_SET(doc,'$.detail','조작된 내용') WHERE id='${mod}'`);
      const t2 = asApp(`SET @aurora_reset = 1; DELETE FROM audit WHERE id='${del}'`);
      const v1 = await (await call(base, "GET", "/api/audit/verify")).json();
      const hit = (v1.broken || []).map((b) => b.id);
      assert.ok(v0.ok === true && v0.checked >= ids.length, `고치기 전 검증: ${JSON.stringify(v0).slice(0, 160)}`);
      assert.ok(t1 === "ok" && t2 === "ok", `시험 준비(우회) 실패: ${t1} ${t2}`);
      assert.equal(v1.ok, false, "고치고 지웠는데 '이상 없음'");
      assert.ok(hit.includes(mod), `고친 기록(${mod})을 짚지 못함: ${hit.join(",")}`);
      assert.ok(hit.includes(next), `지운 자리(${del} 다음 ${next})를 짚지 못함: ${hit.join(",")}`);
      H.recordPerf("감사 기록 체인 검증", ms0, { records: v0.checked });
      return { checked: v0.checked, verify_ms: ms0, broken: hit };
    } finally { H.stop(api); }
  });

  T("AM05", "요약 평가를 행으로: 평가 2만 건이 쌓여도 평가 한 번 150ms·집계 800ms 이하, 집계 건수가 정확하고, kv 문서 하나가 1MB를 넘지 않음", async () => {
    need();
    const base = "http://localhost:8208";
    const api = await H.startApi(8208, { ...db.env });
    try {
      await call(base, "POST", "/api/reset");
      const uj = await upload(base, path.join(SAMPLES, "agency_media_renewal.md")).then((r) => r.json()).then((b) => jobOf(base, b.job_id));
      assert.equal(uj.status, "done", uj.message);
      const rc = (await snap(base)).cases.find((c) => c.type === "RENEWAL");
      assert.ok(rc?.decision?.contract_summary, "계약서 요약이 없음(시험 준비)");
      const hasTable = sqlRows("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='aurora_desk' AND TABLE_NAME='feedback'")[0][0] === "1";
      const N = 20000, f = path.join(TMP, "fb.sql");
      const rows = Array.from({ length: N }, (_, i) => ({ c: `CS-SYN${String(Math.floor(i / 10)).padStart(5, "0")}`, u: `user${i % 10}@aurora.example`, r: i % 3 ? "up" : "down" }));
      if (hasTable) {
        const chunks = [];
        for (let i = 0; i < N; i += 1000) chunks.push("INSERT INTO feedback (id, doc) VALUES " + rows.slice(i, i + 1000).map((x) => `(${sqlStr(`${x.c}|${x.u}`)}, ${sqlStr(JSON.stringify({ id: `${x.c}|${x.u}`, case_id: x.c, key: x.u, rating: x.r, note: "", role: "GROUP_CEO", user: x.u, at: "2026-07-01", llm: "offline" }))})`).join(",") + ";");
        fs.writeFileSync(f, chunks.join("\n"));
      } else {
        const items = {};
        for (const x of rows) (items[x.c] ??= {})[x.u] = { rating: x.r, note: "", role: "GROUP_CEO", user: x.u, at: "2026-07-01", llm: "offline" };
        fs.writeFileSync(f, `INSERT INTO kv (id, doc) VALUES ('summary_feedback', ${sqlStr(JSON.stringify({ id: "summary_feedback", items }))}) ON DUPLICATE KEY UPDATE doc=VALUES(doc), version=version+1;`);
      }
      sqlFile(f);
      const [vms, vr] = await timed(() => call(base, "POST", `/api/cases/${rc.id}/summary-feedback`, { actor: "GROUP_CEO", rating: "up", note: "정확함" }));
      assert.equal(vr.status, 200, await vr.text());
      const [ems, ev] = await timed(async () => (await call(base, "GET", "/api/eval/summary-feedback")).json());
      const kvMax = Number(sqlRows("SELECT IFNULL(MAX(LENGTH(doc)),0) FROM kv")[0][0]);
      H.recordPerf("요약 평가 2만 건에서 평가 1번", vms, { eval_ms: ems, kv_max_bytes: kvMax, total: ev.total });
      assert.equal(ev.total, N + 1, `집계 ${ev.total}건(맞는 값 ${N + 1})`);
      const slow = [vms > 150 && `평가 ${vms}ms`, ems > 800 && `집계 ${ems}ms`].filter(Boolean);
      assert.deepEqual(slow, [], `평가 2만 건에서 느림: ${slow.join(", ")}`);
      assert.ok(kvMax < 1e6, `kv 문서 하나가 ${(kvMax / 1e6).toFixed(1)}MB — 평가마다 통째로 읽고 씀`);
      return { vote_ms: vms, eval_ms: ems, kv_max_bytes: kvMax };
    } finally { H.stop(api); }
  });
});

describe("시연 영상", () => {
  T("AM09", "시연 영상: 5분 미만, AI 음성 해설 트랙, 해설이 모두 영상 안에서 재생되고 v1.26 장면(감사 기록 위변조 탐지)이 들어 있음", async () => {
    const mp4 = path.join(H.ROOT, "demo", "aurora_demo.mp4"), nar = path.join(H.ROOT, "demo", "narration.json");
    if (!fs.existsSync(mp4)) return { skipped: "영상 파일 없음(zip에는 영상이 빠짐)" };
    const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", mp4], { encoding: "utf8" }));
    const dur = Number(info.format.duration);
    const lines = JSON.parse(fs.readFileSync(nar, "utf8"));
    assert.ok(dur < 300, `영상 ${dur.toFixed(1)}초 — 5분 미만이 아님`);
    assert.ok(info.streams.some((s) => s.codec_type === "audio"), "음성 트랙 없음");
    assert.ok(lines.every((l) => l.at + l.dur <= dur + 0.5), "영상 밖 해설");
    assert.ok(lines.some((l) => /위변조|해시|체인/.test(l.title + l.text)), "v1.26(위변조 탐지) 장면 없음");
    return { seconds: Math.round(dur * 10) / 10, lines: lines.length };
  });
});

// ---------------- §14 · §15 대조 ----------------
const DONE_IN_V126 = [/summary_feedback.{0,4}행으로/, /감사 기록을 별도 보관소/];
const SUITES = () => (fs.readFileSync(path.join(__dirname, "run_all.sh"), "utf8").match(/for s in ([^;]+);/) || [, ""])[1].trim().split(/\s+/);
const latestOf = (s) => { const f = path.join(__dirname, "reports", `${s}.json`); return fs.existsSync(f) ? Object.fromEntries(JSON.parse(fs.readFileSync(f, "utf8")).results.map((r) => [r.id, r.ok])) : {}; };

describe("§14 리스크와 한계 · §15 대조", () => {
  T("AM01", "§14의 모든 행이 지키는 테스트를 가리키고 통과했으며, §15 '검증' 열의 테스트가 모두 있고 통과했고, '남은 일'에 이미 한 일이 없으며, 표의 E2E 수가 사실과 같음", async () => {
    const prd = fs.readFileSync(path.join(H.ROOT, "docs", "PRD.md"), "utf8");
    const sec = prd.split("## 14. 리스크와 한계")[1].split("\n## 15.")[0];
    const s15 = prd.split("\n## 15.")[1].split("\n## ")[0];
    const rows = sec.split("\n").filter((l) => /^\| [^-]/.test(l) && !/^\| 리스크 \|/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const unmapped = rows.filter((r) => !Object.keys(RISK_GUARDS).some((k) => r[1].startsWith(k))).map((r) => r[1]);
    const cache = {};
    const pyNames = Object.values(RISK_GUARDS).flat().filter((x) => x.startsWith("pytest:")).map((x) => x.slice(7));
    let pyOk = true;
    try { execFileSync("python3", ["-m", "pytest", "-q", "-k", pyNames.join(" or "), "backend/tests"], { cwd: H.ROOT, stdio: "pipe" }); } catch { pyOk = false; }
    const okOf = (s, id) => (s === "pytest" ? pyOk : s === "round26" ? results.find((r) => r.id === id)?.ok : (cache[s] ??= latestOf(s))[id]);
    const failing = [];
    for (const [risk, refs] of Object.entries(RISK_GUARDS)) for (const ref of refs) { const [s, id] = ref.split(/:(.+)/); const ok = okOf(s, id); if (ok !== true) failing.push(`${risk} ← ${ref}(${ok === undefined ? "없음" : "실패"})`); }
    const head = s15.split("\n").find((l) => /^\| # \|/.test(l)).split("|").map((x) => x.trim());
    const vcol = head.indexOf("검증"), ncol = head.indexOf("남은 일");
    const s15rows = s15.split("\n").filter((l) => /^\| [0-9①-⑩]/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const suiteOf = { AH: "round21", AI: "round22", AJ: "round23", AK: "round24", AL: "round25", AM: "round26" };
    const verifyBad = [];
    for (const r of s15rows) {
      const ids = [];
      for (const m of (r[vcol] || "").matchAll(/\b(A[HIJKLM])(\d\d)(?:~A[HIJKLM](\d\d))?/g)) { const x = Number(m[2]), z = Number(m[3] || m[2]); for (let i = x; i <= z; i++) ids.push(`${m[1]}${String(i).padStart(2, "0")}`); }
      for (const id of ids) if (okOf(suiteOf[id.slice(0, 2)], id) !== true) verifyBad.push(`§15 ${r[1]} ← ${id}`);
    }
    const stale = s15rows.filter((r) => DONE_IN_V126.some((re) => re.test(r[ncol] || ""))).map((r) => `${r[1]}: ${r[ncol]}`);
    const total = SUITES().filter((s) => s !== "round26").reduce((n, s) => n + Object.keys(latestOf(s)).length, 0) + results.length + 1;
    const stated = Number((sec.match(/E2E\(현재 (\d+)개\)/) || [])[1]);
    assert.deepEqual(unmapped, [], `지키는 테스트가 없는 리스크 행: ${unmapped.join(", ")}`);
    assert.deepEqual(failing, [], `대응이 지켜지지 않는 리스크 ${failing.length}건: ${failing.slice(0, 6).join(" / ")}`);
    assert.deepEqual(verifyBad, [], `§15 '검증' 열의 테스트가 없거나 실패: ${verifyBad.join(", ")}`);
    assert.deepEqual(stale, [], `§15 '남은 일'에 이미 한 일: ${stale.join(" / ")}`);
    assert.equal(stated, total, `§14가 말하는 E2E 수 ${stated} ≠ 실제 ${total}`);
    return { risks: rows.length, refs: Object.values(RISK_GUARDS).flat().length, e2e_total: total };
  });
});
