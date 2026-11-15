// 4차 E2E — '결과가 어디서 봐도 같은가'를 끝까지 확인한다.
//   운영 저장소(MySQL 호환 DB: MariaDB 10.11)로 전체 여정, 브라우저 모드와 서버 모드의 결과·안내 일치,
//   문서·시연 영상에 적힌 수치와 실제 시스템 값의 일치, DB 장애, 감사 로그 순서,
//   저장 공간 부족, MCP 원격 전송(streamable-http), 아주 긴 입력, 오래 켜 둔 서버.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const H = require("./helpers.cjs");

const LOCAL = "http://localhost:4173";
const WEB_API = "http://localhost:4174";
const API = "http://localhost:8000";
const HDR = { "X-API-Key": "e2e-key", "Content-Type": "application/json" };
let web, webApi, db, api, B;
const results = [];
// MariaDB가 없는 개발 PC에서는 운영 DB 테스트(M*)를 '건너뜀'으로 표시하고 나머지는 그대로 실행한다.
// CI처럼 반드시 DB로 검증해야 하면 REQUIRE_DB=1 → DB가 없으면 실패.
const T = (id, name, fn) => test(`${id} ${name}`, async (t) => {
  if (id.startsWith("M") && !db && process.env.REQUIRE_DB !== "1") { results.push({ id, name, ok: true, skipped: true, ms: 0 }); t.skip("MariaDB(mariadbd) 없음 — 설치하면 실행"); return; }
  const t0 = Date.now();
  try { await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0 }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const post = (u, body = {}) => fetch(`${API}${u}`, { method: "POST", headers: HDR, body: JSON.stringify(body) });
const snap = async () => (await fetch(`${API}/api/snapshot`, { headers: HDR })).json();
const waitJob = async (r) => { const { job_id } = await r.json(); for (let i = 0; i < 400; i++) { const j = await (await fetch(`${API}/api/jobs/${job_id}`, { headers: HDR })).json(); if (j.status !== "queued" && j.status !== "running") return j; await new Promise((x) => setTimeout(x, 25)); } throw new Error("job timeout"); };
const read = (f) => fs.readFileSync(path.join(H.ROOT, f), "utf-8");

/** API 서버 재시작 — 이전 프로세스가 포트를 놓을 때까지 기다린다. */
async function restartApi() {
  H.stop(api);
  for (let i = 0; i < 40; i++) { try { await fetch(`${API}/api/health`); await new Promise((r) => setTimeout(r, 150)); } catch { break; } }
  api = await H.startApi(8000, db ? db.env : {});
}
/** 시연과 같은 여정을 화면에서 실행하고, 단계마다 사용자에게 보인 안내 문구를 모은다(브라우저·서버 모드 공용). */
async function journey(p) {
  const toasts = [];
  const btn = (n) => p.getByRole("button", { name: n, exact: true });
  const role = (r) => p.locator('[data-testid="role-select"]').selectOption(r);
  const step = async (label, fn) => {
    const prev = await p.locator(".toast").innerText();
    await fn();
    await p.waitForFunction((pv) => { const t = document.querySelector(".toast")?.textContent || ""; return t && t !== pv; }, prev, { timeout: 8000 }).catch(() => {});
    // v1.19(AF-03): 처리 상태 영역(.busy)은 비어 있어도 남아 있음 → 글자가 없을 때를 '처리 끝'으로 본다
    await p.waitForFunction(() => !(document.querySelector(".busy")?.textContent || "").trim(), null, { timeout: 8000 });
    toasts.push([label, await p.locator(".toast").innerText()]);
  };
  const plan = async (id) => { await p.getByRole("tab", { name: "확대 기안 25건" }).click(); await p.locator(".plans tr", { hasText: id }).click(); await p.waitForSelector(".sheet"); };
  await step("계약 접수", () => btn("전속계약 갱신 통보 접수").click());
  await p.locator('[data-testid="case-CT-INF001-2025"]').click();
  await role("GROUP_CEO");
  await step("계약 승인", () => p.locator('[data-testid="approve"]').click());
  await role("CONTRACT_OWNER");
  await step("통보 발송", () => p.locator(".dept li", { hasText: "조건변경 통보 발송" }).getByRole("button").click());
  await step("기안 25건 접수", () => btn("확대 기안 25건 접수").click());
  await role("MARKETING_TEAM");
  await plan("PLAN-016");
  await step("카피 수정", () => btn("수정안 반영하고 재검증").click());
  await plan("PLAN-024"); await role("MASIL_CEO");
  await step("PLAN-024 승인", () => p.locator('[data-testid="approve"]').click());
  await step("재무 조건 변경", () => btn("재무: 연체 채권 회수 불확실").click());
  await step("역제안 접수", () => btn("에이전시 역제안 수신").click());
  await role("CONTRACT_OWNER");
  await step("확인 요청 발송", () => p.locator(".dept li", { hasText: "확인 요청" }).first().getByRole("button").click());
  await step("지급 일정 회신", () => btn("에이전시 지급 일정 회신").click());
  await p.locator(".cases .case-item", { hasText: "역제안" }).last().click();
  await role("GROUP_CEO");
  await step("역제안 거절", () => p.locator('[data-testid="reject"]').click());
  return toasts;
}
/** 결과 요약(모드와 무관하게 비교할 수 있는 형태). */
function summarize(s) {
  const cases = s.cases.map((c) => `${c.target_id}|${c.kind}|${c.state}|${c.approval?.approver ?? "-"}`).sort();
  const tasks = s.tasks.map((t) => `${t.dept}|${t.status}|${t.title}`).sort();
  return { cases, tasks, contract: s.ctx.contract_status, cash: s.ctx.cash_assumption, outbox: s.outbox.length };
}

before(async () => {
  db = await H.startMariaDB(3307);
  web = await H.startPreview(4173, "dist");
  webApi = await H.startPreview(4174, "dist-api");
  api = await H.startApi(8000, db ? db.env : {});
  B = await H.newPage();
});
after(async () => {
  H.writeReport(process.env.E2E_REPORT || "round4", { suite: "round4", results, db: db ? "mariadb-10.11" : "none" });
  await B.browser.close(); H.stop(api); H.stop(webApi); H.stop(web); H.stop(db);
});

describe("운영 저장소(MySQL 호환 DB)", () => {
  T("M00", "저장소 스키마(schema.sql)가 MySQL 호환 DB에 그대로 적용됨", async () => {
    assert.ok(db, "mariadbd 없음");
    assert.equal(db.schemaError, null, db.schemaError);
  });
  T("M01", "MySQL 저장소 서버 모드와 브라우저 모드에서 같은 시연 여정 → 처리 건·결재자·작업·계약 상태·발송함이 같음", async () => {
    // 브라우저 모드
    const L = await H.newPage(); await H.fresh(L.page, LOCAL);
    const tLocal = await journey(L.page);
    const local = await L.page.evaluate(() => { const s = JSON.parse(localStorage.getItem("aurora-desk-state")); return { cases: Object.values(s.cases), tasks: Object.values(s.tasks), ctx: s.ctx, outbox: s.outbox }; });
    await L.browser.close();
    // 서버 모드(MySQL)
    await post("/api/reset");
    const S = await H.newPage(); await S.page.goto(WEB_API); await S.page.waitForSelector(".top");
    await S.page.locator(".role select").nth(1).selectOption("api"); await S.page.waitForTimeout(300);
    const tServer = await journey(S.page);
    await S.browser.close();
    const a = summarize(local), b = summarize(await snap());
    fs.writeFileSync(path.join(__dirname, "reports", "round4-toasts.json"), JSON.stringify({ local: tLocal, server: tServer }, null, 1));
    assert.deepEqual(b, a);
  });
  T("M02", "같은 동작이면 두 모드의 안내 문구가 같은 사실을 알려 줌(처리 건 수·생성 작업 수)", async () => {
    const t = JSON.parse(fs.readFileSync(path.join(__dirname, "reports", "round4-toasts.json"), "utf-8"));
    const diff = t.local.map(([k, v], i) => [k, v, t.server[i]?.[1]]).filter(([, v, w]) => v.replace(/CS-\d+|TK-\d+/g, "#") !== String(w).replace(/CS-\d+|TK-\d+/g, "#"));
    assert.deepEqual(diff, [], diff.map(([k, v, w]) => `${k}: 브라우저 "${v}" / 서버 "${w}"`).join(" | "));
  });
  T("M03", "MySQL 저장소: 기안 25건 일괄 판단·조건 변경 재검증이 각각 1초 이내(화면 반영 1.5초 예산 안)", async () => {
    await post("/api/reset");
    let t = performance.now(); await waitJob(await post("/api/events", { kind: "BUDGET_PLAN_BATCH" })); const batch = performance.now() - t;
    t = performance.now(); await post("/api/conditions", { actor: "FINANCE", cash_assumption: "CONSERVATIVE" }); const cond = performance.now() - t;
    t = performance.now(); await snap(); const sn = performance.now() - t;
    H.recordPerf("MySQL 기안 25건 일괄", batch); H.recordPerf("MySQL 조건 변경 재검증", cond); H.recordPerf("MySQL 스냅샷", sn);
    assert.ok(batch < 1000 && cond < 1000, `일괄 ${Math.round(batch)}ms · 조건 변경 ${Math.round(cond)}ms`);
  });
  T("M04", "MySQL 저장소: 두 결재자가 같은 건을 동시에 결정하면 하나만 반영되고 서버를 다시 켜도 그대로", async () => {
    await post("/api/reset");
    await waitJob(await post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }));
    const c = (await snap()).cases[0];
    const rs = await Promise.all([1, 2, 3].map(() => post(`/api/cases/${c.id}/decision`, { actor: "GROUP_CEO", action: "approve", expected_version: c.version })));
    const ok = rs.filter((r) => r.ok).length;
    await restartApi();
    const s = await snap();
    assert.equal(ok, 1, `성공 ${ok}건`);
    assert.equal(s.cases[0].state, "APPROVED");
    assert.equal(s.tasks.length, 4, `작업 ${s.tasks.length}건(중복 생성 여부)`);
  });
  T("M05", "감사 로그가 일어난 순서대로 보임(빠르게 연속된 30건)", async () => {
    await post("/api/reset");
    for (let i = 0; i < 30; i++) await waitJob(await post("/api/events", { kind: "FREE_TEXT", text: `순서 확인 메모 ${String(i).padStart(2, "0")}` }));
    const s = await snap();
    const seq = s.audit.filter((a) => /순서 확인 메모/.test(a.detail || "")).map((a) => Number((a.detail.match(/메모 (\d\d)/) || [])[1]));
    const sorted = [...seq].sort((x, y) => x - y);
    assert.deepEqual(seq, sorted, `순서: ${seq.join(",")}`);
  });
  T("M06", "DB가 멈추면 서버가 내부 오류(500) 대신 503과 원인을 알려 주고, 화면 안내도 한국어", async () => {
    const p = B.page;
    await p.goto(WEB_API); await p.waitForSelector(".top"); await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(300);
    H.stop(db); await new Promise((r) => setTimeout(r, 1200));
    const h = await fetch(`${API}/api/health`);
    const w = await post("/api/conditions", { actor: "FINANCE", cash_assumption: "LEGACY45" });
    const wb = await w.text();
    await p.locator('[data-testid="role-select"]').selectOption("FINANCE");
    await p.getByRole("button", { name: "마케팅팀 성과 보고(주장)", exact: true }).click();
    await p.waitForFunction(() => (document.querySelector(".toast")?.textContent || "").startsWith("⚠"), null, { timeout: 8000 });
    const t = await p.locator(".toast").innerText();
    db = await H.startMariaDB(3307); await restartApi();
    assert.equal(h.status, 503, `health HTTP ${h.status}`);
    assert.equal(w.status, 503, `쓰기 HTTP ${w.status} ${wb.slice(0, 80)}`);
    assert.match(wb, /저장소|데이터베이스/);
    assert.match(t, /저장소|데이터베이스/, t);
  });
});

describe("문서·영상과 시스템의 일치", () => {
  T("V01", "PRD·A04·리더 가이드·데이터 계보·시연 자막의 핵심 수치가 실제 계산값과 같음", async () => {
    await post("/api/reset");
    const f = await (await fetch(`${API}/api/facts`, { headers: HDR })).json();
    await waitJob(await post("/api/events", { kind: "BUDGET_PLAN_BATCH" }));
    const s = await snap();
    const plans = s.cases.filter((c) => c.type === "PLAN");
    const ceo = plans.filter((c) => c.approval?.approver === "GROUP_CEO").length;
    const reco = (r) => plans.filter((c) => c.decision.recommendation === r).length;
    const cons = await (await post("/api/conditions", { actor: "FINANCE", cash_assumption: "CONSERVATIVE" })).json();
    const s2 = await snap();
    const ceo2 = s2.cases.filter((c) => c.type === "PLAN" && c.approval?.approver === "GROUP_CEO").length;
    const inf = f.influencers?.find?.((x) => x.influencer_id === "INF-001") ?? {};
    const cash = f.cash ?? {};
    // [문서에 적힌 문구, 시스템에서 계산한 값으로 만든 같은 문구]
    const claims = [
      ["12건", `${ceo}건`, "CEO 결재로 바뀌는 기안 수"],
      ["14건", `${ceo2}건`, "보수 가정에서 CEO 결재 기안 수"],
      ["부결·재배분 권고 6건", `부결·재배분 권고 ${reco("REJECT")}건`, "A04 개선 효과"],
      ["카피 보류 3건", `카피 보류 ${reco("HOLD_COPY")}건`, "A04 개선 효과"],   // 30차(AP-07): PLAN-011도 카피 수정이 먼저
      ["공급 제약 1건", `공급 제약 ${plans.filter((c) => c.decision.supply?.constrained).length}건`, "A04 개선 효과"],
      ["7/21~8/21", cash.window ? `${Number(cash.window[0].slice(5, 7))}/${Number(cash.window[0].slice(8))}~${Number(cash.window[1].slice(5, 7))}/${Number(cash.window[1].slice(8))}` : "?", "하회 구간"],
      ["16.48억", cash.min_balance != null ? `${(cash.min_balance / 1e8).toFixed(2)}억` : "?", "재전망 최저"],
      ["16.48억(7/27)", cash.min_date ? `${(cash.min_balance / 1e8).toFixed(2)}억(${Number(cash.min_date.slice(5, 7))}/${Number(cash.min_date.slice(8))})` : "?", "재전망 최저일"],
      ["54.7억", cash.official_min != null ? `${(cash.official_min / 1e8).toFixed(1)}억` : "?", "재무팀 공식 전망 최저"],
      ["24영업일", cash.breach_days ? `${cash.breach_days.length}영업일` : (cash.breachDays ? `${cash.breachDays.length}영업일` : "?"), "하회 영업일"],
    ];
    const docs = ["docs/PRD.md", "docs/DESIGN_A04.md", "docs/LEADER_GUIDE.md", "docs/DATA_LINEAGE.md", "demo/record_demo.cjs"].map(read).join("\n");
    const bad = claims.filter(([doc, sys]) => !docs.includes(doc) || doc.replace(/[^\d.~/]/g, "") !== sys.replace(/[^\d.~/]/g, "")).map(([d, sy, w]) => `${w}: 문서 ${d} / 시스템 ${sy}`);
    H.recordPerf("문서 수치 대조", claims.length, { mismatches: bad, reanalyzed_on_conservative: cons.reanalyzed });
    assert.deepEqual(bad, []);
  });
  T("V02", "문서에 적힌 실행 명령·테스트 수가 실제와 같음(README·리더 가이드·A04)", async () => {
    const docs = { README: read("README.md"), GUIDE: read("docs/LEADER_GUIDE.md"), A04: read("docs/DESIGN_A04.md"), PRD: read("docs/PRD.md") };
    const py = Number(execFileSync("python3", ["-m", "pytest", "--collect-only", "-q"], { cwd: path.join(H.ROOT, "backend"), encoding: "utf-8" }).match(/(\d+) tests? collected/)[1]);
    const e2eFiles = fs.readdirSync(__dirname).filter((f) => f.endsWith(".e2e.test.cjs"));
    // 묶음별 테스트 수: 마지막 실행 보고서(reports/<묶음>.json)의 결과 수, 없으면 파일의 T( 개수. 이 파일(round4)은 직접 셈.
    const countOf = (f) => { const name = f.replace(".e2e.test.cjs", ""); const rp = path.join(__dirname, "reports", `${name}.json`);
      if (name !== "round4" && fs.existsSync(rp)) { try { return JSON.parse(fs.readFileSync(rp, "utf-8")).results.length; } catch { /* 아래로 */ } }
      return (fs.readFileSync(path.join(__dirname, f), "utf-8").match(/^\s*T\(`?"?[A-Z]\d/gm) || []).length; };
    const e2e = e2eFiles.reduce((n, f) => n + countOf(f), 0);
    const bad = [];
    for (const [k, v] of Object.entries(docs)) {
      for (const m of v.matchAll(/pytest[^\n]*?(\d+) passed|# (\d+) passed \(계약/g)) if (Number(m[1] || m[2]) !== py) bad.push(`${k}: pytest ${m[1] || m[2]} ≠ ${py}`);
      for (const m of v.matchAll(/E2E (\d+) passed/g)) if (Number(m[1]) !== e2e) bad.push(`${k}: E2E ${m[1]} ≠ ${e2e}`);
    }
    for (const f of ["e2e/run_all.sh", "demo/encode.sh", "demo/record_demo.cjs", "backend/app/repo/schema.sql"]) if (!fs.existsSync(path.join(H.ROOT, f))) bad.push(`없는 파일: ${f}`);
    H.recordPerf("문서 수치(테스트 수)", py, { e2e, mismatches: bad });
    assert.deepEqual(bad, []);
  });
});

describe("저장·채널·입력·장시간", () => {
  T("S01", "브라우저 저장 공간이 가득 차 저장에 실패하면 사용자에게 알림(조용히 잃지 않음)", async () => {
    const C = await H.newPage();
    const p = C.page;
    await H.fresh(p, LOCAL);
    await p.evaluate(() => { const orig = Storage.prototype.setItem; window.__restore = () => { Storage.prototype.setItem = orig; };
      Storage.prototype.setItem = function (k, v) { if (k === "aurora-desk-state") throw new DOMException("quota", "QuotaExceededError"); return orig.call(this, k, v); }; });
    await p.getByRole("button", { name: "전속계약 갱신 통보 접수", exact: true }).click();
    await p.waitForTimeout(400);
    const warned = await p.locator('[data-testid="save-warning"]').count();
    await p.evaluate(() => window.__restore());
    await p.getByRole("button", { name: "확대 기안 25건 접수", exact: true }).click();   // 공간이 생기면 다시 저장되고 경고가 사라져야 함
    await p.waitForTimeout(400);
    const after = await p.locator('[data-testid="save-warning"]').count();
    const saved = await p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("aurora-desk-state")).cases).length);
    await C.browser.close();
    assert.equal(warned, 1, "저장 실패를 알리지 않음");
    assert.equal(after, 0); assert.equal(saved, 26);
  });
  T("S02", "MCP 원격 전송(streamable-http)으로 서버를 띄워 승인 대기 조회가 동작(API 서버와 포트가 겹치지 않음)", async () => {
    await post("/api/reset");
    await waitJob(await post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }));
    const out = execFileSync("python3", [path.join(__dirname, "mcp_http_e2e.py"), API, "e2e-key"], { encoding: "utf-8", timeout: 60000 }).trim().split("\n").pop();
    const j = JSON.parse(out);
    assert.equal(j.error ?? null, null, j.error);
    assert.match(j.pending || "", /CS-\d{4} \| INF-001/);
  });
  T("S03", "공백 없는 아주 긴 메모(URL 등)를 접수해도 목록·결재 서류가 화면 밖으로 넘치지 않음(데스크톱·휴대폰)", async () => {
    const long = "https://example.com/" + "a".repeat(400) + " PLAN-001 근거 링크";
    const res = {};
    for (const [name, opts] of [["desktop", {}], ["mobile", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
      const C = await H.newPage(opts);
      const p = C.page;
      await H.fresh(p, LOCAL);
      await p.locator("#memo").fill(long); await p.getByRole("button", { name: "접수", exact: true }).click();
      await p.locator(".cases .case-item").first().click(); await p.waitForSelector(".sheet");
      res[name] = await p.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth,
        sheet: (() => { const s = document.querySelector(".sheet"); return s.scrollWidth - s.clientWidth; })() }));
      await C.browser.close();
    }
    assert.deepEqual(res, { desktop: { page: 0, sheet: 0 }, mobile: { page: 0, sheet: 0 } }, JSON.stringify(res));
  });
  T("S04", "오래 켜 둔 서버(요청 3,000건: 자동 갱신·스냅샷·결재·시계)에서도 메모리·응답 시간이 늘지 않음", async () => {
    await post("/api/reset");
    await waitJob(await post("/api/events", { kind: "BUDGET_PLAN_BATCH" }));
    const rss = () => Number(execFileSync("ps", ["-o", "rss=", "-p", String(api.pid)], { encoding: "utf-8" }).trim() || 0) / 1024;
    const pid = execFileSync("pgrep", ["-f", "uvicorn app.main:app --port 8000"], { encoding: "utf-8" }).trim().split("\n")[0];
    const mem = () => Number(execFileSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf-8" }).trim()) / 1024;
    const lat = async (n) => { const a = []; for (let i = 0; i < n; i++) { const t = performance.now(); await fetch(`${API}/api/snapshot`, { headers: HDR }).then((r) => r.text()); a.push(performance.now() - t); } return a.sort((x, y) => x - y)[Math.floor(n * 0.95)]; };
    const m0 = mem(); const l0 = await lat(20);
    let day = "2026-07-01";
    for (let i = 0; i < 600; i++) {
      await Promise.all([fetch(`${API}/api/revision`, { headers: HDR }), fetch(`${API}/api/revision`, { headers: HDR }), fetch(`${API}/api/snapshot`, { headers: HDR }).then((r) => r.text())]);
      if (i % 10 === 0) { await post("/api/events", { kind: "MARKETING_CLAIM" }); }
      if (i % 30 === 0) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); day = d.toISOString().slice(0, 10); await post("/api/clock", { to: day }); }
    }
    const m1 = mem(); const l1 = await lat(20);
    void rss;
    H.recordPerf("장시간 서버 메모리(MB)", Math.round(m1), { before_mb: Math.round(m0), p95_before_ms: Math.round(l0), p95_after_ms: Math.round(l1) });
    assert.ok(m1 - m0 < 80, `메모리 ${Math.round(m0)}→${Math.round(m1)}MB`);
    assert.ok(l1 < Math.max(200, l0 * 3), `스냅샷 p95 ${Math.round(l0)}→${Math.round(l1)}ms`);
  });
});
