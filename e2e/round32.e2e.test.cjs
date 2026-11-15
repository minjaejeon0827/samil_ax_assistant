// 32차 E2E — 31차(재배포 주소·실제 Chrome)에서 기록한 결함 6건·관찰 4건을 이 작업 공간에서 자동화로 다시 일으키고, 고친 뒤 같은 시험으로 확인한다.
// 기능 고정(28차부터): v1.27까지 넣은 기능만 시험하고 결함·성능 문제만 고친다. 새 화면·새 API·새 설정 없음.
//   AR-01 로그인 칸 예시 글자(test.aurora)·공용 비밀번호 재발 · AR-02 문서에 없는 역할(TEST_AURORA)            → AS02(빌드·서버가 막는가)
//   AR-03 업로드 계약서의 '확인 필요'가 INF-001 에이전시 회신 요청으로 · AR-04 통보 기한 미확인인데 기한이 만료일 · O-7 → AS03
//   AR-05 기한 경과(자동 갱신) 뒤에도 '기한 전 미갱신 통보' 작업이 열려 있고 완료하면 상태가 되돌아감                → AS04
//   AR-06 로그인 상태 새로고침 CLS 0.106                                                                          → AS05
//   O-8 사람이 건 확인 요청 작업 기한 · O-9 출력 단계 마스킹 0건 문구 · O-10 잠긴 회신 버튼 설명                    → AS06
//   MySQL(MariaDB) 저장소에서 AS03·AS04 규칙                                                                       → AS07
//   배포 확인 스크립트(읽기 전용)가 AR-01·AR-02 모양의 번들을 잡는가                                              → AS08
//   시연 영상(제출 장면 순서·실제/모의 표시·빨리 감기 표시·1080p·5분 미만·AI 음성)                                → AS09
//   설계 설명(결과물 제출) 문항 7개 · 문항당 1,000자 미만 · A04와 다른 문서                                       → AS10
//   §14·§15 표 대조 + 기능 고정 확인                                                                             → AS01(맨 끝)
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const H = require("./helpers.cjs");
const RISK_GUARDS = require("./risk_guards.cjs").RISK_GUARDS;

const KEY = "e2e-key";
const PORT = 3332;
const DIST = path.join(H.ROOT, "frontend", "dist-docker");
const C29 = path.join(__dirname, "fixtures", "round29");
const USERS = "contract.choi:pw-co:CONTRACT_OWNER;ceo.kang:pw-ceo:GROUP_CEO;mk.park:pw-mk:MARKETING_TEAM;masil.han:pw-ms:MASIL_CEO;fin.choi:pw-fi:FINANCE";
const JWT = { AUTH_MODE: "jwt", USERS, JWT_SECRET: "e2e-secret-0123456789abcdef" };
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (base, hdr = {}) => {
  const call = (method, u, body) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...hdr }, body: body ? JSON.stringify(body) : undefined });
  const jobOf = async (id, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { const j = await (await call("GET", `/api/jobs/${id}`)).json(); if (j.status === "done" || j.status === "failed") return j; await sleep(80); } throw new Error("job timeout"); };
  return {
    call,
    snap: async () => (await call("GET", "/api/snapshot")).json(),
    reset: () => call("POST", "/api/reset"),
    event: async (kind, actor, text) => { const r = await call("POST", "/api/events", { kind, actor, text }); const b = await r.json(); return b.job_id ? jobOf(b.job_id) : { http: r.status, ...b }; },
    decide: (id, actor, action, comment = "") => call("POST", `/api/cases/${id}/decision`, { actor, action, comment }),
    reply: () => call("POST", "/api/replies", { actor: "CONTRACT_OWNER", reply_key: "agency_payment_schedule" }),
    done: (id, actor) => call("POST", `/api/tasks/${id}/done`, { actor }),
    clock: (to, actor = "GROUP_CEO") => call("POST", "/api/clock", { actor, to }),
    facts: (cid, body) => call("POST", `/api/contracts/${encodeURIComponent(cid)}/facts`, body),
    upload: async (file, actor = "CONTRACT_OWNER") => {
      const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync(file)]), path.basename(file)); fd.append("actor", actor);
      const r = await fetch(`${base}/api/contracts`, { method: "POST", headers: { "X-API-Key": KEY, ...hdr }, body: fd });
      const b = await r.json().catch(() => ({}));
      return b.job_id ? { http: r.status, ...(await jobOf(b.job_id)) } : { http: r.status, ...b };
    },
  };
};
const byKind = (s, k) => s.cases.filter((c) => c.kind === k);
const caseOf = (s, id) => s.cases.find((c) => c.id === id);
const tasksOf = (s, id) => s.tasks.filter((t) => t.case_id === id);

let db;
before(async () => { db = await H.startMariaDB(PORT); if (!db && process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음"); });
after(() => { H.writeReport("round32", { results }); H.stop(db); });
const needDb = () => { if (!db || db.env?.REPO !== "mysql") throw new Error("MariaDB 없음(또는 접속 정보 없음)"); };

/** AR-03·AR-04·O-7: 스캔 계약서(통보 일수를 OCR이 못 읽음) → 확인 필요. 기한은 '미확인', 확인 작업은 내부(외부 발송 없음)·짧은 기한, 값 입력 뒤 근거 출처는 사람 입력. */
async function uploadNeedsInfoRules(A, problems) {
  await A.reset();
  const up = await A.upload(path.join(C29, "e2e29_adagency_contract_scan.pdf"));
  if (up.status !== "done") { problems.push(`업로드 실패: ${up.http} ${up.status} ${up.error ?? ""}`); return {}; }
  let s = await A.snap();
  const rc = s.cases.find((c) => c.type === "RENEWAL");
  const d = rc.decision || {};
  if (d.terms?.notice_days != null) return { skipped: `OCR이 통보 일수(${d.terms.notice_days})를 읽음 — 이 환경에서는 미확인 경로가 생기지 않음` };
  if (rc.state !== "NEEDS_INFO") problems.push(`상태 ${rc.state}(확인 필요여야 함)`);
  if (d.subject?.deadline) problems.push(`AR-04 통보 기한을 모르는데 기한 = ${d.subject.deadline}(비어 있어야 함 — 만료일을 기한으로 쓰지 않음)`);
  if (/통보 기한 2026-12-31|기한 2026-12-31/.test(d.proposal || "")) problems.push(`AR-04 결재 요청에 만료일을 통보 기한처럼: '${d.proposal}'`);
  const t = tasksOf(s, rc.id).find((x) => x.kind === "INFO_REQUEST" && x.status === "OPEN");
  if (!t) problems.push("확인 작업 없음");
  else {
    if (t.channel || /에이전시|지급 일정/.test(t.title)) problems.push(`AR-03 업로드 계약서 확인 작업이 에이전시 회신 요청: '${t.title}' · 채널 ${t.channel ?? "-"}`);
    if (t.dept !== "CONTRACT_OWNER") problems.push(`AR-03 확인 작업 부서 ${t.dept}`);
    if (!t.due || t.due > "2026-07-08") problems.push(`AR-04 확인 작업 기한 ${t.due}(접수 뒤 며칠 안이어야 함 — 만료일 기준이면 12/24)`);
    const out0 = s.outbox.length;
    const r = await A.done(t.id, "CONTRACT_OWNER");
    s = await A.snap();
    if (s.outbox.length !== out0) problems.push(`AR-03 확인 작업 완료가 외부로 발송: ${s.outbox.at(-1)?.body?.slice(0, 60)}`);
    if (r.status === 200 && caseOf(s, rc.id).state !== "NEEDS_INFO") problems.push(`AR-03 값 없이 확인 작업만 끝냈는데 상태 ${caseOf(s, rc.id).state}(여전히 확인 필요여야 함)`);
  }
  const fr = await A.facts(rc.target_id, { actor: "CONTRACT_OWNER", notice_days: 60, note: "원문 제3조 60일 확인(32차)" });
  s = await A.snap();
  const after = caseOf(s, rc.id);
  if (fr.status !== 200 || after.decision?.subject?.deadline !== "2026-11-01") problems.push(`값 입력 뒤 기한 ${after.decision?.subject?.deadline}(2026-11-01이어야 함)`);
  const evn = (after.decision?.evidence || []).find((e) => /통보 기한 2026-11-01/.test(e.text) && !/^사람 입력/.test(e.text));
  if (evn && !/사람/.test(evn.source)) problems.push(`O-7 사람이 넣은 통보 기한의 출처 = '${evn.source}'('사람 입력'이어야 함)`);
  return { state: rc.state, deadline: d.subject?.deadline ?? null, task: t?.title, due: t?.due };
}

/** AR-05: INF-001 통보 기한이 지나 자동 갱신으로 기록되면 '기한 전' 통보·현금 계획 작업은 닫히고, 자동 갱신 상태에서는 통보 작업을 완료할 수 없으며, 법무 확인·현금 계획 다시 세우기 작업이 생긴다. */
async function autoRenewRules(A, problems) {
  await A.reset();
  await A.event("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER");
  let s = await A.snap();
  const n = byKind(s, "CONTRACT_RENEWAL_NOTICE")[0];
  await A.decide(n.id, "GROUP_CEO", "approve");
  s = await A.snap();
  const send = tasksOf(s, n.id).find((t) => t.effect === "CONTRACT_NOTICE_SENT");
  await A.done(send.id, send.dept);
  await A.event("AGENCY_COUNTER_OFFER", "CONTRACT_OWNER"); await A.reply();
  s = await A.snap();
  const co = byKind(s, "AGENCY_COUNTER_OFFER")[0];
  await A.decide(co.id, "GROUP_CEO", "reject", "역제안 거절");
  s = await A.snap();
  const term = tasksOf(s, co.id).find((t) => t.effect === "CONTRACT_TERMINATION_SENT" && t.status === "OPEN");
  const fin = tasksOf(s, co.id).find((t) => t.dept === "FINANCE" && t.status === "OPEN");
  await A.clock("2026-07-18");
  s = await A.snap();
  const term2 = s.tasks.find((t) => t.id === term?.id), fin2 = s.tasks.find((t) => t.id === fin?.id);
  if (s.ctx.contract_status !== "AUTO_RENEWED") problems.push(`기한 경과 뒤 계약 상태 ${s.ctx.contract_status}`);
  if (term2?.status === "OPEN") problems.push(`AR-05 자동 갱신 뒤에도 '${term2.title}' 열림`);
  if (fin2?.status === "OPEN") problems.push(`AR-05 자동 갱신 뒤에도 '${fin2.title}' 열림(고정 피 28억이 생겼는데)`);
  const out0 = s.outbox.length;
  if (term2) {
    const r = await A.done(term2.id, term2.dept);
    s = await A.snap();
    if (r.status === 200) problems.push(`AR-05 기한 경과 뒤 미갱신 통보 작업 완료 → 200, 계약 상태 ${s.ctx.contract_status}, 발송 ${s.outbox.length - out0}건`);
  }
  s = await A.snap();
  const follow = s.tasks.filter((t) => t.status === "OPEN" && /기한 경과/.test(t.title));
  if (!follow.some((t) => t.dept === "CONTRACT_OWNER" && /법무/.test(t.title))) problems.push("AR-05 법무 확인 작업 없음");
  if (!follow.some((t) => t.dept === "FINANCE" && /28억/.test(t.title))) problems.push("AR-05 자동 갱신 반영 현금 계획 작업 없음");
  if (s.ctx.contract_status !== "AUTO_RENEWED") problems.push(`AR-05 자동 갱신 기록 뒤 상태가 ${s.ctx.contract_status}로 바뀜`);
  return { cancelled: [term2?.status, fin2?.status], follow: follow.map((t) => `${t.dept}: ${t.title.slice(0, 40)}`) };
}

describe("31차 결함 × v1.30", () => {
  T("AS02", "AR-01·AR-02: 로그인 칸에 예시 글자를 넣었거나 문서에 없는 역할 이름표(TEST_AURORA)를 넣은 화면 번들은 빌드(npm run build·Dockerfile)에서 멈추고, 서버는 권한표에 없는 역할의 계정으로 기동하지 않음", async () => {
    const chk = path.join(H.ROOT, "frontend", "scripts", "check-bundle.cjs");
    const bad = [];
    if (!fs.existsSync(chk)) bad.push("빌드 확인 스크립트(frontend/scripts/check-bundle.cjs) 없음");
    const pkg = JSON.parse(fs.readFileSync(path.join(H.ROOT, "frontend", "package.json"), "utf8"));
    if (!/check-bundle/.test(pkg.scripts.build)) bad.push(`npm run build가 번들을 확인하지 않음: ${pkg.scripts.build}`);
    if (!/check-bundle/.test(fs.readFileSync(path.join(H.ROOT, "Dockerfile"), "utf8"))) bad.push("Dockerfile이 번들을 확인하지 않음");
    let good = null, ph = null, role = null;
    if (fs.existsSync(chk)) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "as02-"));
      const mkBad = (name, fn) => { const d = path.join(tmp, name); fs.cpSync(DIST, d, { recursive: true }); for (const f of fs.readdirSync(path.join(d, "assets")).filter((x) => x.endsWith(".js"))) { const p = path.join(d, "assets", f); fs.writeFileSync(p, fn(fs.readFileSync(p, "utf8"))); } return d; };
      const dPh = mkBad("ph", (s) => s.replace(/"data-testid":"login-user"/g, '"data-testid":"login-user",placeholder:"test.aurora"'));
      const dRole = mkBad("role", (s) => s.replace(/MARKETING_TEAM:"마케팅팀"/, 'UNKNOWN_ROLE:"미등록 역할",MARKETING_TEAM:"마케팅팀"'));
      const run = (d) => spawnSync("node", [chk, d], { encoding: "utf8" });
      good = run(DIST); ph = run(dPh); role = run(dRole);
      if (good.status !== 0) bad.push(`정상 번들인데 실패: ${good.stdout}${good.stderr}`);
      if (ph.status === 0) bad.push("로그인 칸 예시 글자를 넣은 번들을 못 잡음");
      if (role.status === 0) bad.push("문서에 없는 역할 이름표를 넣은 번들을 못 잡음");
      if (/test\.aurora/.test(ph.stdout + ph.stderr)) bad.push("확인 결과에 예시 글자 값이 그대로 찍힘");
    }
    // 서버: 권한표에 없는 역할의 계정으로는 기동하지 않음(31차 배포는 이 소스와 다른 사본)
    const p = spawnSync("python3", ["-c", "import os; os.environ.update(AUTH_MODE='jwt', JWT_SECRET='x'*32, USERS='guest.user:Strong-pass-123:UNKNOWN_ROLE'); from app.api.auth import Auth; Auth()"], { cwd: path.join(H.ROOT, "backend"), encoding: "utf8" });
    if (p.status === 0 || !/역할이 올바르지 않습니다/.test(p.stderr)) bad.push(`권한표에 없는 역할 계정으로 서버가 기동됨: ${p.stderr.slice(-160)}`);
    assert.deepEqual(bad, []);
    return { good: (good?.stdout || "").trim().slice(0, 120), placeholder: (ph?.stdout || "").trim().slice(0, 120), role: (role?.stdout || "").trim().slice(0, 120) };
  });

  T("AS03", "AR-03·AR-04·O-7: 업로드한 스캔 계약서가 통보 기한 미확인으로 멈추면 기한은 '미확인'(만료일을 쓰지 않음), 확인 작업은 계약 담당의 내부 작업(원문 확인 → 확인한 값 넣기, 외부 발송 없음, 접수 뒤 며칠 안), 화면 안내도 '확인한 값 넣기'이고, 값 입력 뒤 통보 기한의 출처는 '사람 입력'", async () => {
    const port = 8320, base = `http://localhost:${port}`;
    const api = await H.startApi(port, { SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const pg = B.page;
    const problems = [];
    try {
      const A = mk(base);
      // 화면: 확인 필요 상태의 안내와 기한 표시 — 값을 넣기 전에 본다
      await A.reset();
      await A.upload(path.join(C29, "e2e29_adagency_contract_scan.pdf"));
      await pg.goto(base); await pg.waitForSelector(".top");
      await pg.evaluate(() => { localStorage.setItem("aurora-desk-ui", JSON.stringify({ role: "CONTRACT_OWNER", selected: null, tab: "case", mode: "api" })); sessionStorage.clear(); });
      await pg.reload(); await pg.waitForSelector(".top");
      await pg.locator(".cases .case-item", { hasText: "새솔애드" }).first().click(); await pg.waitForSelector(".sheet");
      const meta = await pg.locator(".sheet-meta").innerText();
      const hint = await pg.locator(".decide .hint").first().innerText().catch(() => "");
      if (/기한 12월 31일|D-183/.test(meta) || !/미확인/.test(meta)) problems.push(`AR-04 결재 서류 머리 = '${meta}'`);
      if (/에이전시/.test(hint)) problems.push(`AR-03 안내 = '${hint}'`);
      const out = await uploadNeedsInfoRules(A, problems);
      assert.deepEqual(problems, []);
      assert.deepEqual(pg.errors, []);
      return { ...out, meta };
    } finally { await B.browser.close().catch(() => {}); H.stop(api); }
  });

  T("AS04", "AR-05: INF-001이 통보 기한 경과로 자동 갱신 기록되면 '기한 전' 미갱신 통보·고정 피 제외 현금 계획 작업이 닫히고(완료 불가 — 상태가 되돌아가지 않음, 사실과 다른 통보 없음), 법무 확인·고정 피 28억 반영 현금 계획 작업이 생김 — 서버·브라우저 엔진", async () => {
    const port = 8321, base = `http://localhost:${port}`;
    const api = await H.startApi(port, { SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const pg = B.page;
    const problems = [];
    try {
      const out = await autoRenewRules(mk(base), problems);
      // 브라우저 엔진: 같은 흐름
      await pg.goto(base); await pg.waitForSelector(".top");
      await pg.evaluate(() => { localStorage.setItem("aurora-desk-ui", JSON.stringify({ role: "CONTRACT_OWNER", selected: null, tab: "case", mode: "local" })); sessionStorage.clear(); });
      await pg.reload(); await pg.waitForSelector(".top");
      const btn = (n) => pg.getByRole("button", { name: n, exact: true });
      const role = (r) => pg.locator('[data-testid="role-select"]').selectOption(r);
      await btn("전속계약 갱신 통보 접수").click();
      await pg.locator(".cases .case-item", { hasText: "갱신 통보" }).first().click(); await pg.waitForSelector(".sheet");
      await role("GROUP_CEO"); await pg.locator('[data-testid="approve"]').click(); await pg.waitForTimeout(200);
      await role("CONTRACT_OWNER");
      await pg.locator(".dept li", { hasText: "조건변경 통보 발송" }).first().getByRole("button").click();
      await btn("에이전시 역제안 수신").click(); await btn("에이전시 지급 일정 회신").click();
      await pg.locator(".cases .case-item", { hasText: "역제안" }).last().click(); await pg.waitForSelector(".sheet");
      await role("GROUP_CEO"); await pg.locator('[data-testid="reject"]').click(); await pg.waitForTimeout(200);
      await btn("통보 기한 다음 날로").click(); await pg.waitForTimeout(300);
      await role("CONTRACT_OWNER");
      const termLi = pg.locator(".dept li", { hasText: "미갱신(해지) 통보 발송" });
      const stillOpen = (await termLi.count()) ? await termLi.first().getByRole("button").isEnabled().catch(() => false) : false;
      if (stillOpen) problems.push("AR-05 브라우저 엔진: 자동 갱신 뒤에도 미갱신 통보 작업 완료 버튼이 켜짐");
      const legal = await pg.locator(".dept li", { hasText: "법무" }).count();
      if (!legal) problems.push("AR-05 브라우저 엔진: 법무 확인 작업 없음");
      assert.deepEqual(problems, []);
      assert.deepEqual(pg.errors, []);
      return out;
    } finally { await B.browser.close().catch(() => {}); H.stop(api); }
  });

  T("AS05", "AR-06: 로그인한 채 새로고침해도 데이터가 들어올 때 오른쪽 칸·기한 표시가 밀리지 않음(CLS < 0.1, 31차 창 크기 1299×881) — 로그인 전 첫 화면도 그대로", async () => {
    const port = 8322, base = `http://localhost:${port}`;
    const api = await H.startApi(port, { ...JWT, SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage({ viewport: { width: 1299, height: 881 } }); const pg = B.page;
    try {
      const tok = (await (await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "X-API-Key": KEY, "Content-Type": "application/json" }, body: JSON.stringify({ user: "ceo.kang", password: "pw-ceo" }) })).json()).token;
      const A = mk(base, { Authorization: `Bearer ${tok}` });
      await A.reset();
      await A.event("CONTRACT_RENEWAL_NOTICE", "GROUP_CEO");
      const s0 = await A.snap();
      await A.decide(byKind(s0, "CONTRACT_RENEWAL_NOTICE")[0].id, "GROUP_CEO", "approve");
      await A.event("FREE_TEXT", "GROUP_CEO", "에이전시 담당자 연락처 010-1234-5678");
      await A.event("BUDGET_PLAN_BATCH", "GROUP_CEO");   // 31차와 비슷한 양(처리 건 30여 건·감사 수십 건)
      await A.clock("2026-07-02"); await A.clock("2026-07-03");
      await pg.addInitScript(() => {
        window.__cls = 0; window.__shifts = [];
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; window.__shifts.push({ v: +e.value.toFixed(4), who: (e.sources || []).map((x) => x.node?.className || x.node?.nodeName || "?").join(",").slice(0, 120) }); } }).observe({ type: "layout-shift", buffered: true });
      });
      await pg.goto(base); await pg.waitForSelector(".top");
      await pg.evaluate(() => { localStorage.setItem("aurora-desk-ui", JSON.stringify({ role: "GROUP_CEO", selected: null, tab: "facts", mode: "api" })); sessionStorage.clear(); });
      await pg.reload(); await pg.locator('[data-testid="login-user"]').waitFor();
      const before = await pg.evaluate(() => window.__cls);
      await pg.locator('[data-testid="login-user"]').fill("ceo.kang"); await pg.locator('[data-testid="login-password"]').fill("pw-ceo"); await pg.locator('[data-testid="login-submit"]').click();
      await pg.locator('[data-testid="whoami"]').waitFor({ timeout: 8000 });
      const cls = [];
      for (let i = 0; i < 2; i++) {
        await pg.reload(); await pg.locator('[data-testid="whoami"]').waitFor({ timeout: 8000 }); await pg.waitForTimeout(2500);
        cls.push(await pg.evaluate(() => ({ v: +window.__cls.toFixed(4), shifts: window.__shifts })));
      }
      // 31차 실제 Chrome 0.106 ≈ 이 환경(Chromium·글꼴 차이) 0.099 — 같은 원인(데이터가 들어올 때 오른쪽 칸이 밀림)을 잡으려고 기준을 0.05로 둔다
      for (const c of cls) assert.ok(c.v < 0.05, `로그인 상태 새로고침 CLS ${c.v} — ${JSON.stringify(c.shifts).slice(0, 400)}`);
      assert.ok(before < 0.1, `로그인 전 CLS ${before}`);
      assert.deepEqual(pg.errors, []);
      return { cls_logged_in: cls.map((c) => c.v), cls_login_screen: before, shifts: cls[0].shifts.slice(0, 6) };
    } finally { await B.browser.close().catch(() => {}); H.stop(api); }
  });

  T("AS06", "O-8·O-9·O-10: 사람이 건 확인 요청 작업 기한은 확정기한 7일 전(확인 요청서 원칙, 오늘보다 앞이면 오늘), 판단 파이프라인의 출력 단계 기록은 접수 단계에서 이미 가린 것을 함께 알리고, 잠긴 회신 버튼은 이유를 보여 줌", async () => {
    const port = 8323, base = `http://localhost:${port}`;
    const api = await H.startApi(port, { SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const pg = B.page;
    const problems = [];
    try {
      const A = mk(base);
      await A.reset();
      await A.event("BUDGET_PLAN_BATCH", "MARKETING_TEAM");
      let s = await A.snap();
      const p19 = s.cases.find((c) => c.target_id === "PLAN-019");
      await A.decide(p19.id, p19.approval.approver, "request_info", "정산일 근거 확인");
      s = await A.snap();
      const t = tasksOf(s, p19.id).find((x) => x.kind === "INFO_REQUEST" && x.status === "OPEN");
      if (t?.due !== "2026-09-04") problems.push(`O-8 사람이 건 확인 요청 작업 기한 ${t?.due}(확정기한 9/11의 7일 전 9/4여야 함)`);
      await A.event("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER");
      await A.event("AGENCY_COUNTER_OFFER", "CONTRACT_OWNER");
      await A.reply();
      s = await A.snap();
      const co = byKind(s, "AGENCY_COUNTER_OFFER")[0];
      const so = (co.trace || []).filter((x) => x.node === "security_output").pop();
      if (!so || !/접수 단계/.test(so.note)) problems.push(`O-9 출력 단계 기록 = '${so?.note}'(접수 단계에서 가린 사실을 함께 알려야 함)`);
      await pg.goto(base); await pg.waitForSelector(".top");
      await pg.evaluate(() => { localStorage.setItem("aurora-desk-ui", JSON.stringify({ role: "CONTRACT_OWNER", selected: null, tab: "case", mode: "api" })); sessionStorage.clear(); });
      await pg.reload(); await pg.waitForSelector(".top"); await pg.waitForTimeout(800);
      const rb = pg.getByRole("button", { name: "에이전시 지급 일정 회신", exact: true });
      const dis = await rb.isDisabled(), title = await rb.getAttribute("title");
      if (!dis) problems.push("회신을 받은 뒤에도 회신 버튼이 켜짐");
      if (!title) problems.push("O-10 잠긴 회신 버튼에 이유(title)가 없음");
      assert.deepEqual(problems, []);
      assert.deepEqual(pg.errors, []);
      return { due: t?.due, trace: so?.note, title };
    } finally { await B.browser.close().catch(() => {}); H.stop(api); }
  });

  T("AS07", "MySQL(MariaDB) 저장소: 업로드 계약서 통보 기한 미확인(AS03)·자동 갱신 뒤 작업 정리(AS04)가 메모리 저장소와 같고, 감사 체인 이상 없음", async () => {
    needDb();
    const port = 8324, base = `http://localhost:${port}`;
    const api = await H.startApi(port, { ...db.env });
    const problems = [];
    try {
      const A = mk(base);
      const t0 = Date.now();
      const u = await uploadNeedsInfoRules(A, problems);
      const r = await autoRenewRules(A, problems);
      const ms = Date.now() - t0;
      const v = await (await A.call("GET", "/api/audit/verify")).json();
      if (!v.ok) problems.push(`감사 체인 ${JSON.stringify(v).slice(0, 120)}`);
      assert.deepEqual(problems, []);
      return { upload: u.task, auto_renew: r.follow, ms, audit_checked: v.checked };
    } finally { H.stop(api); }
  });

  T("AS08", "배포 확인 스크립트(읽기 전용): 로그인 칸 예시 글자(U04)와 문서에 없는 역할 이름표(B05)를 넣은 번들을 실패로 잡고, 정상 번들은 실패 0 — 보낸 요청은 GET·HEAD·OPTIONS뿐", async () => {
    const port = 8325, base = `http://localhost:${port}/`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "as08-"));
    const bad = path.join(tmp, "dist-bad");
    fs.cpSync(DIST, bad, { recursive: true });
    for (const f of fs.readdirSync(path.join(bad, "assets")).filter((x) => x.endsWith(".js"))) {
      const fp = path.join(bad, "assets", f);
      fs.writeFileSync(fp, fs.readFileSync(fp, "utf8").replace(/"data-testid":"login-user"/g, '"data-testid":"login-user",placeholder:"test.aurora"').replace(/MARKETING_TEAM:"마케팅팀"/, 'UNKNOWN_ROLE:"미등록 역할",MARKETING_TEAM:"마케팅팀"'));
    }
    const run = async (dist) => {
      const api = await H.startApi(port, { ...JWT, SERVE_FRONTEND: "1", FRONTEND_DIST: dist, ALLOWED_ORIGINS: "" });
      try {
        const rep = path.join(tmp, `r-${path.basename(dist)}.json`);
        const r = spawnSync("node", [path.join(__dirname, "smoke_remote.cjs"), base, "--browser", "--report", rep, "--expect-version", "1.30.0"], { cwd: tmp, encoding: "utf8", timeout: 180000 });
        return { code: r.status, j: JSON.parse(fs.readFileSync(rep, "utf8")) };
      } finally { H.stop(api); await sleep(400); }
    };
    const good = await run(DIST), evil = await run(bad);
    const get = (j, id) => j.results.find((x) => x.id === id);
    assert.deepEqual(good.j.results.filter((x) => x.level === "FAIL").map((x) => `${x.id} ${x.detail}`), []);
    assert.equal(get(good.j, "B05")?.level, "PASS", `B05 = ${JSON.stringify(get(good.j, "B05"))}`);
    assert.equal(get(evil.j, "B05")?.level, "FAIL", `역할 이름표를 못 잡음: ${JSON.stringify(get(evil.j, "B05"))}`);
    assert.equal(get(evil.j, "U04")?.level, "FAIL");
    assert.equal(evil.code, 1);
    assert.deepEqual(Object.keys(good.j.sent || {}).filter((m) => !["GET", "HEAD", "OPTIONS"].includes(m)), []);
    return { good: good.j.summary, b05_bad: get(evil.j, "B05").detail.slice(0, 120) };
  });

  T("AS09", "시연 영상: 제출 장면 순서(소개 → 정상 → 조건 변경 → 정보 부족·승인 거절 → 필수 확장·다른 부서 영향 → 추가 확장), 장면마다 해설이 실제 작동/모의 처리를 밝히고, 빨리 감은 구간(시계 이동)을 화면에 표시, 1080p·5분 미만·1GB 이하·AI 음성, 문서의 영상 길이와 같음", async () => {
    const mp4 = path.join(H.ROOT, "demo", "aurora_demo.mp4"), nar = path.join(H.ROOT, "demo", "narration.json");
    if (!fs.existsSync(mp4)) return { skipped: "영상 파일 없음(zip에는 영상이 빠짐)" };
    const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size:stream=codec_type,width,height", "-of", "json", mp4], { encoding: "utf8" }));
    const dur = Number(info.format.duration), size = Number(info.format.size);
    const v = info.streams.find((s) => s.codec_type === "video");
    const lines = JSON.parse(fs.readFileSync(nar, "utf8"));
    const order = ["소개", "정상", "조건 변경", "정보 부족", "필수 확장", "추가 확장"];
    const heads = lines.map((l) => l.title || "");
    const idx = order.map((k) => heads.findIndex((h) => h.includes(k)));
    const src = JSON.parse(fs.readFileSync(path.join(H.ROOT, "demo", "narration_src.json"), "utf8"));
    const sceneSays = order.map((k) => { const keys = Object.keys(src).filter((t) => t.includes(k)); return keys.length && keys.every((t) => /실제 작동|모의/.test(src[t])); });
    const script = fs.readFileSync(path.join(H.ROOT, "demo", "record_demo.cjs"), "utf8") + fs.readFileSync(path.join(H.ROOT, "demo", "record_next.cjs"), "utf8");
    const mmss = `${Math.floor(dur / 60)}분 ${Math.floor(dur % 60)}초`;
    const prd = fs.readFileSync(path.join(H.ROOT, "docs", "PRD.md"), "utf8").match(/## 10\. 시연 시나리오 \(영상: `demo\/aurora_demo\.mp4`, (\d분 \d+초)/)?.[1];
    const readme = fs.readFileSync(path.join(H.ROOT, "README.md"), "utf8").match(/\((\d분 \d+초), \*\*AI 음성 해설 포함\*\*/)?.[1];
    assert.ok(dur < 300, `영상 ${dur.toFixed(1)}초 — 5분 미만이 아님`);
    assert.ok(size <= 1024 ** 3, "1GB 초과");
    assert.ok(v.width >= 1920 && v.height >= 1080, `해상도 ${v.width}×${v.height}(1080p 권장)`);
    assert.ok(info.streams.some((s) => s.codec_type === "audio"), "음성 트랙 없음");
    assert.ok(idx.every((i) => i >= 0) && idx.every((x, i) => i === 0 || x > idx[i - 1]), `장면 순서 ${JSON.stringify(Object.fromEntries(order.map((k, i) => [k, idx[i]])))}`);
    assert.deepEqual(order.filter((k, i) => !sceneSays[i]), [], "실제 작동/모의 처리를 밝히지 않는 장면");
    assert.ok(/빨리 감기/.test(script), "빨리 감은 구간 표시 없음");
    assert.ok(lines.every((l) => l.at + l.dur <= dur + 0.5), "영상 밖 해설");
    assert.equal(prd, mmss, `PRD §10 ${prd} ≠ 실제 ${mmss}`);
    assert.equal(readme, mmss, `README ${readme} ≠ 실제 ${mmss}`);
    return { seconds: Math.round(dur * 10) / 10, size_mb: +(size / 1e6).toFixed(1), res: `${v.width}x${v.height}`, lines: lines.length };
  });

  T("AS10", "설계 설명(결과물 제출): A04와 다른 문서로 7문항(1~6 필수·7 선택)이 모두 있고 문항마다 1,000자 미만, 숫자가 시스템과 같음(기안 25건·그룹 CEO 12건·Masil 대표 13건, 고정 피 28억, 위약금 50%, 통보 기한 7/17)", async () => {
    const f = path.join(H.ROOT, "docs", "DESIGN_SUBMISSION.md");
    assert.ok(fs.existsSync(f), "docs/DESIGN_SUBMISSION.md 없음");
    const md = fs.readFileSync(f, "utf8");
    const a04 = fs.readFileSync(path.join(H.ROOT, "docs", "DESIGN_A04.md"), "utf8");
    const qs = ["1. 고른 업무와 돕는 결정", "2. 시작과 끝", "3. 필수 확장", "4. 다른 부서 영향", "5. 데이터", "6. 작동 범위", "7. 추가 확장"];
    const parts = md.split(/\n## /).slice(1);
    const lens = {};
    for (const q of qs) {
      const p = parts.find((x) => x.startsWith(q));
      assert.ok(p, `문항 없음: ${q}`);
      const body = p.split("\n").slice(1).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
      lens[q.slice(0, 2)] = [...body].length;
      assert.ok(lens[q.slice(0, 2)] < 1000, `${q} ${lens[q.slice(0, 2)]}자 — 1,000자 미만이어야 함`);
      assert.ok(lens[q.slice(0, 2)] > 300, `${q} ${lens[q.slice(0, 2)]}자 — 너무 짧음`);
    }
    assert.notEqual(md.trim(), a04.trim());
    for (const n of ["25건", "12건", "13건", "28억", "50%", "7/17"]) assert.ok(md.includes(n), `숫자 없음: ${n}`);
    return { chars: lens };
  });
});

// ---------------- §14 · §15 대조 + 기능 고정 확인 ----------------
const SUITES = () => (fs.readFileSync(path.join(__dirname, "run_all.sh"), "utf8").match(/for s in ([^;]+);/) || [, ""])[1].trim().split(/\s+/);
const latestOf = (s) => { const f = path.join(__dirname, "reports", `${s}.json`); return fs.existsSync(f) ? Object.fromEntries(JSON.parse(fs.readFileSync(f, "utf8")).results.map((r) => [r.id, r.ok])) : {}; };

describe("§14 리스크와 한계 · §15 대조", () => {
  T("AS01", "§14의 모든 행이 지키는 테스트를 가리키고 통과했으며, §15 '검증' 열의 테스트가 모두 있고 통과했고, 표의 E2E 수가 사실과 같고, 기능 고정(§15에 'v1.28~v1.30 추가' 열 없음), 31차 결함 6건이 E2E 보고서 32차 절에 모두 있음", async () => {
    const prd = fs.readFileSync(path.join(H.ROOT, "docs", "PRD.md"), "utf8");
    const rep = fs.readFileSync(path.join(H.ROOT, "docs", "E2E_REPORT.md"), "utf8");
    const sec = prd.split("## 14. 리스크와 한계")[1].split("\n## 15.")[0];
    const s15 = prd.split("\n## 15.")[1].split("\n## ")[0];
    const rows = sec.split("\n").filter((l) => /^\| [^-]/.test(l) && !/^\| 리스크 \|/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const unmapped = rows.filter((r) => !Object.keys(RISK_GUARDS).some((k) => r[1].startsWith(k))).map((r) => r[1]);
    const cache = {};
    const pyNames = Object.values(RISK_GUARDS).flat().filter((x) => x.startsWith("pytest:")).map((x) => x.slice(7));
    let pyOk = true;
    try { execFileSync("python3", ["-m", "pytest", "-q", "-k", pyNames.join(" or "), "backend/tests"], { cwd: H.ROOT, stdio: "pipe" }); } catch { pyOk = false; }
    const okOf = (s, id) => (s === "pytest" ? pyOk : s === "round32" ? results.find((r) => r.id === id)?.ok : (cache[s] ??= latestOf(s))[id]);
    const failing = [];
    for (const [risk, refs] of Object.entries(RISK_GUARDS)) for (const ref of refs) { const [s, id] = ref.split(/:(.+)/); const ok = okOf(s, id); if (ok !== true) failing.push(`${risk} ← ${ref}(${ok === undefined ? "없음" : "실패"})`); }
    const headLine = s15.split("\n").find((l) => /^\| # \|/.test(l));
    const head = headLine.split("|").map((x) => x.trim());
    const vcol = head.indexOf("검증");
    const s15rows = s15.split("\n").filter((l) => /^\| [0-9①-⑩]/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const suiteOf = { AH: "round21", AI: "round22", AJ: "round23", AK: "round24", AL: "round25", AM: "round26", AN: "round27", AO: "round28", AQ: "round30", AS: "round32" };
    const verifyBad = [];
    for (const r of s15rows) {
      const ids = [];
      for (const m of (r[vcol] || "").matchAll(/\b(A[H-S])(\d\d)(?:~A[H-S](\d\d))?/g)) { const x = Number(m[2]), z = Number(m[3] || m[2]); for (let i = x; i <= z; i++) ids.push(`${m[1]}${String(i).padStart(2, "0")}`); }
      for (const id of ids) if (suiteOf[id.slice(0, 2)] && okOf(suiteOf[id.slice(0, 2)], id) !== true) verifyBad.push(`§15 ${r[1]} ← ${id}`);
    }
    const total = SUITES().filter((s) => s !== "round32").reduce((n, s) => n + Object.keys(latestOf(s)).length, 0) + results.length + 1;
    const stated = Number((sec.match(/E2E\(현재 (\d+)개\)/) || [])[1]);
    const ar = Array.from({ length: 6 }, (_, i) => `AR-${String(i + 1).padStart(2, "0")}`);
    const r32 = rep.split(/\n## \d+\. 32차 E2E/)[1] || "";
    const untracked = ar.filter((id) => !r32.includes(id));
    assert.deepEqual(unmapped, [], `지키는 테스트가 없는 리스크 행: ${unmapped.join(", ")}`);
    assert.deepEqual(failing, [], `대응이 지켜지지 않는 리스크 ${failing.length}건: ${failing.slice(0, 6).join(" / ")}`);
    assert.deepEqual(verifyBad, [], `§15 '검증' 열의 테스트가 없거나 실패: ${verifyBad.join(", ")}`);
    assert.ok(!/v1\.(2[89]|30) 추가/.test(headLine), "기능 고정인데 §15에 'v1.28~v1.30 추가' 열이 있음");
    assert.equal(stated, total, `§14가 말하는 E2E 수 ${stated} ≠ 실제 ${total}`);
    assert.deepEqual(untracked, [], `32차 절에 없는 31차 결함: ${untracked.join(", ")}`);
    return { risks: rows.length, refs: Object.values(RISK_GUARDS).flat().length, e2e_total: total };
  });
});
