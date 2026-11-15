// 25차 E2E — 운영 데이터베이스(MySQL 호환 MariaDB) 기능을 SQL·DB 설계의 기본 원칙으로 끝까지 시험 + §14·§15 표 대조 + 시연 영상.
//   서버에서 DB 쓰기(연결 재사용·커넥션 풀)                                       → AL02
//   정규화: 계약 기록을 kv 문서 하나(JSON 덩어리)에 몰아 둔 설계 — 계약 3,000건에서도 빠른가   → AL03
//   제약·트리거: 감사 기록 append only를 DB가 지키는가(UPDATE·DELETE 거부, '처음부터'만 허용) → AL04
//   VIEW·JOIN: 사람이 SQL(DBeaver 등)로 운영 데이터를 볼 수 있고, 작업 ↔ 처리 건 참조가 깨지지 않는가 → AL05
//   트랜잭션 격리: 다른 서버의 명령이 커밋되는 순간에도 화면(스냅샷)이 반쯤 반영된 상태를 보지 않는가 → AL06
//   데이터 타입·문자셋(utf8mb4): 이모지·확장 한자·보이지 않는 문자가 MySQL을 거쳐도 그대로이고 검색되는가 → AL07
//   백업·복구 리허설(mysqldump --single-transaction, 쓰기 중) → 복구한 DB로 서버를 띄워 이어서 일할 수 있는가 → AL08
//   시연 영상: 5분 이내, AI 음성 해설                                               → AL09
//   §14·§15 표 대조                                                                  → AL01(맨 끝)
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const H = require("./helpers.cjs");
const RISK_GUARDS = Object.fromEntries(Object.entries(require("./risk_guards.cjs").RISK_GUARDS).map(([k, v]) => [k, v.filter((r) => !/^round(2[6-8]|3[02]):/.test(r))]));   // 26차는 25차 뒤에 돈다

const KEY = "e2e-key";
const SAMPLES = path.join(H.ROOT, "data", "samples", "contracts");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aurora25-"));
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
const p95 = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))]; };

let db, sqlRows;
before(async () => {
  db = await H.startMariaDB(3325);
  if (!db) { if (process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음"); return; }
  const sock = "/tmp/aurora-e2e-3325.sock";
  // 결과를 표로 받는 SQL(탭 구분, 머리글 없음)
  sqlRows = (q, dbname = "aurora_desk") => execFileSync("mariadb", ["-uroot", `--socket=${sock}`, "--default-character-set=utf8mb4", "-N", "-B", dbname, "-e", q], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
  db.sock = sock;
});
after(() => { H.writeReport("round25", { results }); H.stop(db); });
const need = () => { if (!db) throw new Error("MariaDB 없음"); };

describe("운영 DB(MySQL 호환) — 연결·정규화·제약·VIEW·트랜잭션·문자셋·백업", () => {
  T("AL02", "서버의 DB 연결 재사용(커넥션 풀): 화면 갱신 100번 동안 DB에 새로 맺는 연결이 20개 이하, 스냅샷 응답 p95 60ms 이하", async () => {
    need();
    const base = "http://localhost:8190";
    const api = await H.startApi(8190, { ...db.env });
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" }));
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      const conn0 = Number(sqlRows("SHOW GLOBAL STATUS LIKE 'Connections'")[0][1]);
      const lat = [];
      for (let i = 0; i < 50; i++) {
        await (await call(base, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: `메모 ${i}` })).json();   // 변경 번호를 올려 매번 DB를 읽게
        await new Promise((r) => setTimeout(r, 60));
        const [ms] = await timed(() => snap(base)); lat.push(ms);
        await call(base, "GET", "/api/revision");
      }
      const opened = Number(sqlRows("SHOW GLOBAL STATUS LIKE 'Connections'")[0][1]) - conn0;
      H.recordPerf("MySQL 스냅샷 p95", p95(lat), { new_connections: opened });
      assert.ok(opened <= 20, `화면 갱신 100번에 DB 연결 ${opened}개를 새로 맺음(요청마다 연결·해제)`);
      assert.ok(p95(lat) <= 60, `스냅샷 p95 ${p95(lat)}ms`);
      return { new_connections: opened, p95: p95(lat) };
    } finally { H.stop(api); }
  });

  T("AL03", "정규화: 계약서 3,000건이 쌓여도(계약 기록 = 행 하나씩) 관계없는 결재 300ms·계약서 올리기 2초·화면 갱신 300ms 이하, 명령 하나가 DB에 쓰는 양이 계약 수에 비례하지 않음", async () => {
    need();
    const base = "http://localhost:8191";
    const api = await H.startApi(8191, { ...db.env });
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" }));
      // 합성 계약 기록 3,000건(실제 업로드 결과와 같은 모양) — v1.24는 kv 'renewals' 한 문서, 정규화했다면 renewals 표의 행
      const one = await waitJob(base, await upload(base, path.join(SAMPLES, "agency_media_renewal.md")));
      const base_rec = one.result;
      const hasTable = sqlRows("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='aurora_desk' AND TABLE_NAME='renewals'")[0][0] === "1";
      const rows = [];
      for (let i = 0; i < 3000; i++) rows.push({ id: `RC-SYN${String(i).padStart(5, "0")}`, terms: { ...base_rec.terms, contract_id: `RC-SYN${String(i).padStart(5, "0")}`, counterparty: `합성 거래처 ${i}` }, checks: base_rec.checks, citations: Object.fromEntries(Object.keys(base_rec.terms).slice(0, 6).map((k) => [k, { ref: "제1조", text: "합성 인용 ".repeat(20) }])), status: "UNDER_REVIEW", uploaded_on: "2026-07-01" });
      const f = path.join(TMP, "seed.sql");
      if (hasTable) fs.writeFileSync(f, rows.map((r) => `INSERT INTO renewals (id, doc) VALUES ('${r.id}', ${sqlStr(JSON.stringify(r))});`).join("\n"));
      else {
        const cur = JSON.parse(sqlRows("SELECT doc FROM kv WHERE id='renewals'")[0][0]);
        for (const r of rows) cur.items[r.id] = r;
        fs.writeFileSync(f, `UPDATE kv SET doc=${sqlStr(JSON.stringify(cur))}, version=version+1 WHERE id='renewals';`);
      }
      execFileSync("mariadb", ["-uroot", `--socket=${db.sock}`, "--default-character-set=utf8mb4", "--max-allowed-packet=256M", "aurora_desk"], { input: fs.readFileSync(f) });
      const kvBytes = Number(sqlRows("SELECT IFNULL(MAX(LENGTH(doc)),0) FROM kv")[0][0]);
      const plan = (await snap(base)).cases.find((c) => c.type === "PLAN" && c.state === "PENDING_APPROVAL" && !c.decision?.regulation?.findings?.length);   // 30차(AP-07): 위반 카피 기안은 승인 불가라 제외
      const [dms, dr] = await timed(() => call(base, "POST", `/api/cases/${plan.id}/decision`, { actor: plan.approval.approver, action: "approve", comment: "정규화 시험" }));
      assert.equal(dr.status, 200, await dr.text());
      const [ums, uj] = await timed(() => upload(base, path.join(SAMPLES, "logistics_3pl_renewal.md")).then((r) => r.json()).then((b) => jobOf(base, b.job_id)));
      await call(base, "POST", "/api/clock", { to: "2026-07-02", actor: "GROUP_CEO" });
      const [sms] = await timed(() => snap(base));
      H.recordPerf("계약 3,000건에서 관계없는 결재", dms, { upload_ms: ums, snapshot_ms: sms, kv_max_bytes: kvBytes });
      assert.equal(uj.status, "done", uj.message);
      const slow = [dms > 300 && `관계없는 기안 결재 ${dms}ms`, ums > 2000 && `계약서 올리기 ${ums}ms`, sms > 300 && `화면 갱신 ${sms}ms`].filter(Boolean);
      assert.deepEqual(slow, [], `계약 3,000건에서 느림: ${slow.join(", ")} (kv 문서 최대 ${(kvBytes / 1e6).toFixed(1)}MB)`);
      assert.ok(kvBytes < 1e6, `kv 문서 하나가 ${(kvBytes / 1e6).toFixed(1)}MB — 명령마다 통째로 읽고 씀`);
      return { decision_ms: dms, upload_ms: ums, snapshot_ms: sms };
    } finally { H.stop(api); }
  });

  T("AL04", "제약·트리거: 감사 기록은 DB가 append only를 지킴 — 앱 계정으로 UPDATE·DELETE 하면 거부되고, '처음부터'(그룹 CEO)만 지울 수 있으며 그 사실이 새 감사 기록에 남음", async () => {
    need();
    const base = "http://localhost:8192";
    const api = await H.startApi(8192, { ...db.env });
    const app = (q) => { try { execFileSync("mariadb", ["-uaurora", "-pe2e-pass", "-h127.0.0.1", "-P3325", "aurora_desk", "-e", q], { stdio: "pipe" }); return "ok"; } catch (e) { return String(e.stderr || e.message); } };
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      const id = sqlRows("SELECT id FROM audit ORDER BY seq LIMIT 1")[0][0];
      const up = app(`UPDATE audit SET doc=JSON_SET(doc,'$.detail','조작') WHERE id='${id}'`);
      const del = app(`DELETE FROM audit WHERE id='${id}'`);
      const still = sqlRows(`SELECT JSON_UNQUOTE(JSON_EXTRACT(doc,'$.detail')) FROM audit WHERE id='${id}'`)[0]?.[0] || "";
      const r = await call(base, "POST", "/api/reset");
      const after = await snap(base);
      assert.notEqual(up, "ok", "앱 계정으로 감사 기록을 고칠 수 있음(UPDATE)");
      assert.notEqual(del, "ok", "앱 계정으로 감사 기록을 지울 수 있음(DELETE)");
      assert.ok(/append|추가만|감사/.test(up + del), `거부 이유가 없음: ${(up + del).slice(0, 160)}`);
      assert.ok(still && still !== "조작", "감사 기록이 바뀜");
      assert.equal(r.status, 200, "'처음부터'가 트리거에 막힘");
      assert.ok(after.audit.some((a) => /처음부터|초기화/.test(a.detail)), "'처음부터'로 감사 기록을 지운 사실이 남지 않음");
    } finally { H.stop(api); }
  });

  T("AL05", "VIEW·JOIN: 운영자가 SQL로 볼 수 있는 보기(v_cases·v_tasks·v_audit·v_renewals)가 있고, 작업 → 처리 건 참조가 끊긴 행 0, 보기의 건수·상태가 화면(API)과 같음", async () => {
    need();
    const base = "http://localhost:8193";
    const api = await H.startApi(8193, { ...db.env });
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" }));
      await waitJob(base, await upload(base, path.join(SAMPLES, "agency_media_renewal.md")));
      let s = await snap(base);
      const c = s.cases.find((x) => x.type === "CONTRACT" && x.state === "PENDING_APPROVAL");
      await call(base, "POST", `/api/cases/${c.id}/decision`, { actor: "GROUP_CEO", action: "approve", comment: "보기 시험" });
      s = await snap(base);
      const views = sqlRows("SELECT TABLE_NAME FROM information_schema.VIEWS WHERE TABLE_SCHEMA='aurora_desk' ORDER BY TABLE_NAME").map((r) => r[0]);
      assert.deepEqual(["v_audit", "v_cases", "v_renewals", "v_tasks"].filter((v) => !views.includes(v)), [], `보기 없음(있는 것: ${views.join(", ")})`);
      const byState = Object.fromEntries(sqlRows("SELECT state, COUNT(*) FROM v_cases GROUP BY state"));
      const apiState = {}; for (const x of s.cases) apiState[x.state] = String((Number(apiState[x.state] || 0)) + 1);
      const orphans = sqlRows("SELECT COUNT(*) FROM v_tasks t LEFT JOIN v_cases c ON c.id = t.case_id WHERE c.id IS NULL")[0][0];
      const joined = sqlRows(`SELECT c.approver, COUNT(t.id) FROM v_cases c JOIN v_tasks t ON t.case_id = c.id WHERE c.id='${c.id}' GROUP BY c.approver`);
      const ren = sqlRows("SELECT counterparty, annual_fee_krw FROM v_renewals");
      assert.deepEqual(byState, apiState, "보기의 상태별 건수가 화면과 다름");
      assert.equal(orphans, "0", `처리 건이 없는 작업 ${orphans}건`);
      assert.ok(joined.length === 1 && joined[0][0] === "GROUP_CEO" && Number(joined[0][1]) === s.tasks.filter((t) => t.case_id === c.id).length, `JOIN 결과 ${JSON.stringify(joined)}`);
      assert.ok(ren.some((r) => /블루웨이브/.test(r[0]) && Number(r[1]) === 1.08e9), `v_renewals ${JSON.stringify(ren)}`);
      return { views: views.length };
    } finally { H.stop(api); }
  });

  T("AL06", "트랜잭션 격리: 다른 서버가 '처리 건 + 작업'을 한 트랜잭션으로 바꾸는 동안 화면을 300번 갱신해도, 작업은 있는데 그 처리 건은 바뀌기 전인 '반쯤 반영된' 화면 0번", async () => {
    need();
    const base = "http://localhost:8194";
    const api = await H.startApi(8194, { ...db.env });
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      const cid = (await snap(base)).cases[0].id;
      // 다른 서버의 명령을 흉내: 한 트랜잭션에서 처리 건 제목 번호(n)와 작업 TK-ISO-n을 함께 쓰고, 전역 변경 번호(kv rev)도 올림
      const N = 400;
      const script = ["SET autocommit=0;"];
      for (let n = 1; n <= N; n++) script.push(`START TRANSACTION; SELECT id FROM kv WHERE id='ctx' FOR UPDATE; UPDATE cases SET doc=JSON_SET(doc,'$.title','격리 시험 ${n}'), version=version+1 WHERE id='${cid}'; INSERT INTO tasks (id, doc) VALUES ('TK-ISO-${n}', JSON_OBJECT('id','TK-ISO-${n}','case_id','${cid}','dept','FINANCE','title','격리 시험 ${n}','due',NULL,'kind','INFO','status','OPEN','created_on','2026-07-01')); UPDATE kv SET doc=JSON_SET(doc,'$.n',JSON_EXTRACT(doc,'$.n')+1) WHERE id='rev'; COMMIT; DO SLEEP(0.004);`);
      const w = require("node:child_process").spawn("mariadb", ["-uroot", `--socket=${db.sock}`, "--default-character-set=utf8mb4", "aurora_desk"], { stdio: ["pipe", "ignore", "ignore"] });
      const closed = new Promise((r) => w.on("close", r));   // 끝나는 순간을 놓치지 않게 먼저 듣는다
      w.stdin.end(script.join("\n"));
      let bad = 0, seen = 0;
      const t0 = Date.now();
      while (seen < 300 && Date.now() - t0 < 30000) {
        const s = await snap(base);
        seen++;
        const n = Number(((s.cases.find((x) => x.id === cid)?.title || "").match(/격리 시험 (\d+)/) || [0, 0])[1]);   // 원래 제목의 숫자(INF-001)는 0으로
        const maxTask = Math.max(0, ...s.tasks.filter((t) => t.id.startsWith("TK-ISO-")).map((t) => Number(t.id.slice(7))));
        if (maxTask !== n) bad++;
      }
      await closed;
      H.recordPerf("다른 서버 커밋 중 스냅샷 300회", Date.now() - t0, { inconsistent: bad });
      assert.equal(bad, 0, `반쯤 반영된 화면 ${bad}/${seen}번(처리 건·작업을 서로 다른 시점에 읽음)`);
      return { snapshots: seen, inconsistent: bad };
    } finally { H.stop(api); }
  });

  T("AL07", "문자셋(utf8mb4): 이모지·확장 한자(4바이트)·결합 문자가 든 메모가 MySQL을 거쳐도 그대로 저장·표시되고, 이모지로 감사 기록을 찾을 수 있음", async () => {
    need();
    const base = "http://localhost:8195";
    const api = await H.startApi(8195, { ...db.env });
    try {
      await call(base, "POST", "/api/reset");
      const text = "현장 메모 🚚📦 납품 지연 — 𠀀𪚥 협력사 · 가́ 표기";
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text }));
      const m = (await snap(base)).cases.find((c) => c.type === "MEMO");
      const raw = sqlRows(`SELECT JSON_UNQUOTE(JSON_EXTRACT(doc,'$.event_text')) FROM cases WHERE id='${m.id}'`)[0][0];
      // 감사 기록에 사람이 쓴 글이 남는 곳: 확인한 값의 근거 메모(메모 본문은 감사 기록에 '자유 입력 메모'로만 남음 — 설계)
      const uj = await upload(base, path.join(SAMPLES, "logistics_3pl_renewal.md")).then((r) => r.json()).then((b) => jobOf(base, b.job_id));
      assert.equal(uj.status, "done", uj.message);
      const rc = (await snap(base)).cases.find((c) => c.type === "RENEWAL" && !["APPROVED", "REJECTED", "SUPERSEDED", "DONE"].includes(c.state));
      const note = "재무팀 확인 🚚📦 𠀀𪚥 협력사";
      const fr = await call(base, "POST", `/api/contracts/${rc.target_id}/facts`, { actor: "FINANCE", notice_days: 60, note });
      assert.equal(fr.status, 200, await fr.text());
      const q = async (s) => (await (await call(base, "GET", `/api/audit?q=${encodeURIComponent(s)}&limit=5`)).json()).matched;
      const [hit, hit2, miss] = [await q("🚚"), await q("𪚥"), await q("🛳")];
      const col = sqlRows("SELECT CHARACTER_SET_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='aurora_desk' AND TABLE_NAME='audit' AND COLUMN_NAME='search_text'")[0]?.[0];
      assert.equal(m.event_text, text, `화면 표시: ${m.event_text}`);
      assert.equal(raw, text, `DB 저장: ${raw}`);
      assert.equal(col, "utf8mb4");
      assert.ok(hit >= 1 && hit2 >= 1, `이모지·확장 한자로 감사 기록을 못 찾음(🚚 ${hit}건, 𪚥 ${hit2}건)`);
      assert.equal(miss, 0, `다른 이모지(🛳)도 걸림 ${miss}건 — 4바이트 글자를 같은 글자로 보는 정렬 규칙`);
    } finally { H.stop(api); }
  });

  T("AL08", "백업·복구 리허설: 쓰기가 계속되는 중에 mysqldump --single-transaction으로 백업 → 새 DB로 복구 → 그 DB로 서버를 띄우면 번호 충돌 없이 이어서 접수·결재·검색되고 트리거·보기도 살아 있음", async () => {
    need();
    const base = "http://localhost:8196", base2 = "http://localhost:8197";
    const api = await H.startApi(8196, { ...db.env });
    let api2;
    try {
      await call(base, "POST", "/api/reset");
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      let stop = false;
      const writer = (async () => { let i = 0; while (!stop) { await waitJob(base, await call(base, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: `백업 중 메모 ${i++}` })); } return i; })();
      await new Promise((r) => setTimeout(r, 800));
      const dumpFile = path.join(TMP, "backup.sql");
      const [dumpMs] = await timed(async () => fs.writeFileSync(dumpFile, execFileSync("mariadb-dump", ["-uroot", `--socket=${db.sock}`, "--single-transaction", "--routines", "--triggers", "aurora_desk"], { maxBuffer: 1 << 28 })));
      stop = true; const written = await writer;
      db.sql("DROP DATABASE IF EXISTS aurora_restore; CREATE DATABASE aurora_restore DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;");
      execFileSync("mariadb", ["-uroot", `--socket=${db.sock}`, "aurora_restore"], { input: fs.readFileSync(dumpFile) });
      // 복구 직후, 앱 계정 권한을 주기 전에 관리자(root)가 보기로 확인할 수 있어야 함(보기가 만든 계정의 권한에 묶이면 안 됨)
      const viewErr = [];
      for (const v of ["v_cases", "v_tasks", "v_audit", "v_renewals"]) { try { sqlRows(`SELECT COUNT(*) FROM ${v}`, "aurora_restore"); } catch (e) { viewErr.push(`${v}: ${String(e.stderr || e.message).split("\n")[0].slice(0, 90)}`); } }
      db.sql("GRANT ALL ON aurora_restore.* TO 'aurora'@'127.0.0.1';");
      api2 = await H.startApi(8197, { ...db.env, MYSQL_DB: "aurora_restore" });
      const before = await snap(base2);
      const r1 = await waitJob(base2, await call(base2, "POST", "/api/events", { kind: "FREE_TEXT", actor: "MARKETING_TEAM", text: "복구 뒤 첫 메모" }));
      const c = before.cases.find((x) => x.type === "CONTRACT" && x.state === "PENDING_APPROVAL");
      const d = c ? await call(base2, "POST", `/api/cases/${c.id}/decision`, { actor: "GROUP_CEO", action: "approve", comment: "복구 뒤 결재" }) : { status: 0 };
      const q = await (await call(base2, "GET", `/api/audit?q=${encodeURIComponent("복구 뒤")}&limit=5`)).json();
      const trig = sqlRows("SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='aurora_restore'")[0][0];
      const views = sqlRows("SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA='aurora_restore'")[0][0];
      const ids = sqlRows("SELECT id FROM audit", "aurora_restore").map((r) => r[0]);
      H.recordPerf("백업(쓰기 중)", dumpMs, { written_during: written });
      assert.equal(r1.status, "done", `복구 뒤 접수 실패(번호 충돌?): ${r1.message}`);
      assert.equal(d.status, 200, "복구 뒤 결재 실패");
      assert.ok(q.matched >= 1, "복구 뒤 감사 검색 안 됨");
      assert.equal(new Set(ids).size, ids.length, "감사 기록 번호 중복");
      assert.ok(Number(trig) >= 2, `복구한 DB에 감사 기록 보호 트리거 ${trig}개`);
      assert.ok(Number(views) >= 4, `복구한 DB에 보기 ${views}개`);
      assert.deepEqual(viewErr, [], `복구한 DB의 보기를 관리자가 조회하지 못함: ${viewErr.join(" / ")}`);
      return { dump_ms: dumpMs, written_during: written };
    } finally { H.stop(api); H.stop(api2); }
  });
});

function sqlStr(s) { return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'"; }

describe("시연 영상", () => {
  T("AL09", "시연 영상: 5분 이내, AI 음성 해설 트랙, 해설 대본의 모든 줄이 영상 안에서 재생되고 v1.25 장면(운영 DB)이 들어 있음", async () => {
    const mp4 = path.join(H.ROOT, "demo", "aurora_demo.mp4"), nar = path.join(H.ROOT, "demo", "narration.json");
    if (!fs.existsSync(mp4)) return { skipped: "영상 파일 없음(zip에는 영상이 빠짐)" };
    const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", mp4], { encoding: "utf8" }));
    const dur = Number(info.format.duration);
    const lines = JSON.parse(fs.readFileSync(nar, "utf8"));
    assert.ok(dur <= 300, `영상 ${dur.toFixed(1)}초`);
    assert.ok(info.streams.some((s) => s.codec_type === "audio"), "음성 트랙 없음");
    assert.ok(lines.every((l) => l.at + l.dur <= dur + 0.5), "영상 밖 해설");
    assert.ok(lines.some((l) => /데이터베이스|DB/.test(l.title + l.text)), "v1.25(운영 DB) 장면 없음");
    return { seconds: Math.round(dur), lines: lines.length };
  });
});

// ---------------- §14 · §15 대조 ----------------
const DONE_IN_V125 = [];
const SUITES = () => (fs.readFileSync(path.join(__dirname, "run_all.sh"), "utf8").match(/for s in ([^;]+);/) || [, ""])[1].trim().split(/\s+/);
const latestOf = (s) => { const f = path.join(__dirname, "reports", `${s}.json`); return fs.existsSync(f) ? Object.fromEntries(JSON.parse(fs.readFileSync(f, "utf8")).results.map((r) => [r.id, r.ok])) : {}; };

describe("§14 리스크와 한계 · §15 대조", () => {
  T("AL01", "§14의 모든 행이 지키는 테스트를 가리키고 통과했으며, §15 '검증' 열의 테스트가 모두 있고 통과했고, '남은 일'에 이미 한 일이 없으며, 표의 E2E 수가 사실과 같음", async () => {
    const prd = fs.readFileSync(path.join(H.ROOT, "docs", "PRD.md"), "utf8");
    const sec = prd.split("## 14. 리스크와 한계")[1].split("\n## 15.")[0];
    const s15 = prd.split("\n## 15.")[1].split("\n## ")[0];
    const rows = sec.split("\n").filter((l) => /^\| [^-]/.test(l) && !/^\| 리스크 \|/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const unmapped = rows.filter((r) => !Object.keys(RISK_GUARDS).some((k) => r[1].startsWith(k))).map((r) => r[1]);
    const cache = {};
    const pyNames = Object.values(RISK_GUARDS).flat().filter((x) => x.startsWith("pytest:")).map((x) => x.slice(7));
    let pyOk = true;
    try { execFileSync("python3", ["-m", "pytest", "-q", "-k", pyNames.join(" or "), "backend/tests"], { cwd: H.ROOT, stdio: "pipe" }); } catch { pyOk = false; }
    const okOf = (s, id) => (s === "pytest" ? pyOk : s === "round25" ? results.find((r) => r.id === id)?.ok : (cache[s] ??= latestOf(s))[id]);
    const failing = [];
    for (const [risk, refs] of Object.entries(RISK_GUARDS)) for (const ref of refs) { const [s, id] = ref.split(/:(.+)/); const ok = okOf(s, id); if (ok !== true) failing.push(`${risk} ← ${ref}(${ok === undefined ? "없음" : "실패"})`); }
    const head = s15.split("\n").find((l) => /^\| # \|/.test(l)).split("|").map((x) => x.trim());
    const vcol = head.indexOf("검증"), ncol = head.indexOf("남은 일");
    const s15rows = s15.split("\n").filter((l) => /^\| [0-9①-⑩]/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const suiteOf = { AH: "round21", AI: "round22", AJ: "round23", AK: "round24", AL: "round25" };
    const verifyBad = [];
    for (const r of s15rows) {
      const ids = [];
      for (const m of (r[vcol] || "").matchAll(/\b(A[HIJKL])(\d\d)(?:~A[HIJKL](\d\d))?/g)) { const x = Number(m[2]), z = Number(m[3] || m[2]); for (let i = x; i <= z; i++) ids.push(`${m[1]}${String(i).padStart(2, "0")}`); }
      for (const id of ids) if (okOf(suiteOf[id.slice(0, 2)], id) !== true) verifyBad.push(`§15 ${r[1]} ← ${id}`);
    }
    const stale = s15rows.filter((r) => DONE_IN_V125.some((re) => re.test(r[ncol] || ""))).map((r) => `${r[1]}: ${r[ncol]}`);
    const total = SUITES().filter((s) => s !== "round25").reduce((n, s) => n + Object.keys(latestOf(s)).length, 0) + results.length + 1;
    const stated = Number((sec.match(/E2E\(현재 (\d+)개\)/) || [])[1]);
    assert.deepEqual(unmapped, [], `지키는 테스트가 없는 리스크 행: ${unmapped.join(", ")}`);
    assert.deepEqual(failing, [], `대응이 지켜지지 않는 리스크 ${failing.length}건: ${failing.slice(0, 6).join(" / ")}`);
    assert.deepEqual(verifyBad, [], `§15 '검증' 열의 테스트가 없거나 실패: ${verifyBad.join(", ")}`);
    assert.deepEqual(stale, [], `§15 '남은 일'에 이미 한 일: ${stale.join(" / ")}`);
    assert.equal(stated, total, `§14가 말하는 E2E 수 ${stated} ≠ 실제 ${total}`);
    return { risks: rows.length, refs: Object.values(RISK_GUARDS).flat().length, e2e_total: total };
  });
});
