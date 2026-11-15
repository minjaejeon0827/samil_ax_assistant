// 30차 E2E — 29차(배포 주소·실제 Chrome)에서 기록한 결함 12건·관찰 6건을 이 작업 공간에서 자동화로 다시 일으키고, 고친 뒤 같은 시험으로 확인한다.
// 기능 고정(28차부터): v1.27까지 넣은 기능만 시험하고 결함·성능 문제만 고친다. 새 화면·새 API·새 설정 없음.
//   AP-01 배포 컨테이너에서 PDF 업로드 422(ModuleNotFoundError) — requirements.txt만 깐 '깨끗한 환경'으로 재현          → AQ02
//   AP-02 로그인 창 예시 글자에 계정·비밀번호 — 로그인 칸 예시 글자·번들·약한 공용 비밀번호 경고                    → AQ03
//   AP-03 결재권자가 아닌 역할의 '확인 요청' · AP-04 확인 작업이 늘 마케팅팀 · AP-08 확인 요청 감사 문구 · AP-10 로그인 모드 안내 → AQ04
//   AP-05 같은 회신 두 번 → 사람이 건 보류가 풀림 · AP-06 그 뒤 재검증에서 빠짐 · O-5 회신·결과 감사 순서             → AQ05
//   AP-07 카피 위반 + 공급 제약 → 공급 권고가 카피 게이트를 덮음(PLAN-011) + 부결 권고 건의 위반 카피 승인(PLAN-001)   → AQ06
//   AP-09 체인 검증 결과가 로그아웃·다른 사람 로그인 뒤에도 남음 · AP-11 로그인 창에서 브라우저 모드로 못 감 · AP-12 역할 고정 → AQ07
//   O-4 조건변경 통보를 보냈는데 '통보 미발송' · O-6 결재권자가 아닌데 'AI 설명 도착' 안내                              → AQ08
//   MySQL(MariaDB) 저장소에서 AQ04·AQ05·AQ06의 규칙 + 계약서 3종 업로드(행·감사)                                     → AQ09
//   배포 확인 스크립트(읽기 전용)가 AP-01·AP-02를 잡는가                                                              → AQ10
//   시연 영상(5분 미만, AI 음성)                                                                                     → AQ11
//   §14·§15 표 대조 + 기능 고정 확인                                                                                → AQ01(맨 끝)
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const H = require("./helpers.cjs");
const RISK_GUARDS = require("./risk_guards.cjs").RISK_GUARDS;

const KEY = "e2e-key";
const PORT = 3330;
const DIST = path.join(H.ROOT, "frontend", "dist-docker");
const C29 = path.join(__dirname, "fixtures", "round29");     // 29차 합성 계약서 3종(사용자가 배포 주소에서 쓴 것과 같은 파일)
const VENV = path.join(__dirname, ".venv-clean");              // requirements.txt만 깐 파이썬 — Docker 이미지와 같은 의존성
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
  const call = (method, u, body, h = {}) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...hdr, ...h }, body: body ? JSON.stringify(body) : undefined });
  const jobOf = async (id, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { const j = await (await call("GET", `/api/jobs/${id}`)).json(); if (j.status === "done" || j.status === "failed") return j; await sleep(80); } throw new Error("job timeout"); };
  const o = {
    call, jobOf,
    snap: async () => (await call("GET", "/api/snapshot")).json(),
    event: async (kind, actor, text) => { const r = await call("POST", "/api/events", { kind, actor, text }); const b = await r.json(); return b.job_id ? jobOf(b.job_id) : { http: r.status, ...b }; },
    decide: (id, actor, action, comment = "") => call("POST", `/api/cases/${id}/decision`, { actor, action, comment }),
    reply: (key = "agency_payment_schedule", actor = "CONTRACT_OWNER") => call("POST", "/api/replies", { actor, reply_key: key }),
    done: (id, actor) => call("POST", `/api/tasks/${id}/done`, { actor }),
    cond: (cash, actor = "FINANCE") => call("POST", "/api/conditions", { actor, cash_assumption: cash }),
    clock: (to, actor = "GROUP_CEO") => call("POST", "/api/clock", { actor, to }),
    fix: (id, actor = "MARKETING_TEAM") => call("POST", `/api/cases/${id}/fix`, { actor }),
    facts: (cid, body) => call("POST", `/api/contracts/${encodeURIComponent(cid)}/facts`, body),
    upload: async (file, actor = "CONTRACT_OWNER") => {
      const fd = new FormData(); fd.append("file", new Blob([fs.readFileSync(file)]), path.basename(file)); fd.append("actor", actor);
      const r = await fetch(`${base}/api/contracts`, { method: "POST", headers: { "X-API-Key": KEY, ...hdr }, body: fd });
      const b = await r.json().catch(() => ({}));
      return b.job_id ? { http: r.status, ...(await jobOf(b.job_id)) } : { http: r.status, ...b };
    },
  };
  o.reset = () => call("POST", "/api/reset");
  return o;
};
const byKind = (s, k) => s.cases.filter((c) => c.kind === k);
const caseOf = (s, id) => s.cases.find((c) => c.id === id);
const planOf = (s, pid) => s.cases.find((c) => c.type === "PLAN" && c.target_id === pid);
const tasksOf = (s, id) => s.tasks.filter((t) => t.case_id === id);
const login = async (base, user, password) => (await (await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "X-API-Key": KEY, "Content-Type": "application/json" }, body: JSON.stringify({ user, password }) })).json()).token;

let db;
before(async () => { db = await H.startMariaDB(PORT); if (!db && process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음"); });
after(() => { H.writeReport("round30", { results }); H.stop(db); });
const needDb = () => { if (!db || db.env?.REPO !== "mysql") throw new Error("MariaDB 없음(또는 접속 정보 없음)"); };

/** 계약 역제안까지(상황 2): 통보 접수 → 역제안(지급 일정 없음 → 확인 필요) → 회신 → 승인 대기. 역제안 건을 돌려준다. */
async function counterReady(A) {
  await A.reset();
  await A.event("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER");
  await A.event("AGENCY_COUNTER_OFFER", "CONTRACT_OWNER");
  const s0 = await A.snap();
  const co = byKind(s0, "AGENCY_COUNTER_OFFER")[0];
  const n0 = s0.audit_total ?? s0.audit.length;
  const r = await A.reply();
  const s1 = await A.snap();
  return { co: caseOf(s1, co.id), firstReply: r.status, audit: s1.audit, n0, s1 };
}

/** AP-03·AP-04·AP-08: 확인 요청은 결재권자만, 확인 작업은 그 건의 기안 부서로, 감사에는 '건 제목 확인 요청 — 의견'. */
async function infoRequestRules(A, problems) {
  const { co } = await counterReady(A);
  if (co.state !== "PENDING_APPROVAL" || co.approval?.approver !== "GROUP_CEO") { problems.push(`준비 실패: 역제안 ${co.state}/${co.approval?.approver}`); return {}; }
  const deny = await A.decide(co.id, "CONTRACT_OWNER", "request_info", "");
  const sDeny = await A.snap();
  if (deny.status !== 403) problems.push(`AP-03 계약 담당이 그룹 CEO 건에 확인 요청 → HTTP ${deny.status}(403이어야 함), 상태 ${caseOf(sDeny, co.id).state}`);
  else if (!sDeny.audit.slice(-3).some((a) => a.topic === "command.refused" || /권한/.test(a.detail))) problems.push("AP-03 거부가 감사에 남지 않음");
  if (deny.status === 403) {
    const ok = await A.decide(co.id, "GROUP_CEO", "request_info", "지급 일정 근거 재확인");
    if (ok.status !== 200) problems.push(`그룹 CEO 확인 요청 → HTTP ${ok.status}`);
  }
  const s = await A.snap();
  const c = caseOf(s, co.id);
  const t = tasksOf(s, co.id).find((x) => x.kind === "INFO_REQUEST" && x.status === "OPEN");
  if (!t) problems.push("확인 요청 작업이 없음");
  else if (t.dept !== "CONTRACT_OWNER") problems.push(`AP-04 계약 건 확인 작업 부서 = ${t.dept}(CONTRACT_OWNER여야 함)`);
  const au = s.audit.filter((a) => a.case_id === co.id && /확인 요청/.test(a.detail) && a.topic !== "task.created" && a.topic !== "command.refused").pop();
  if (!au || !au.detail.includes(c.title) || !au.detail.includes("지급 일정 근거 재확인")) problems.push(`AP-08 확인 요청 감사 문구 = '${au?.detail ?? "없음"}'('${c.title} 확인 요청 — 의견'이어야 함)`);
  return { co: c, task: t };
}

/** AP-05·AP-06·O-5: 같은 회신 재접수 거절, 사람이 건 보류는 회신으로 풀리지 않음, 풀린 뒤 재검증에 다시 들어감, 감사 순서. */
async function replyAndHoldRules(A, problems) {
  const { co, audit, n0 } = await counterReady(A);
  const iReply = audit.findLastIndex((a) => a.topic === "reply.received");
  const iResult = audit.findLastIndex((a) => a.case_id === co.id && a.topic === "case.analyzed");   // 회신 뒤 다시 판단한 결과
  if (iReply < 0 || iResult < 0 || iReply > iResult) problems.push(`O-5 감사 순서: 회신 접수 #${iReply} / 결과 #${iResult}(회신이 먼저여야 함)`);
  await A.decide(co.id, "GROUP_CEO", "request_info", "지급 일정 근거 재확인");
  const dup = await A.reply();
  const dupBody = await dup.json().catch(() => ({}));
  let s = await A.snap();
  let c = caseOf(s, co.id);
  const manual = tasksOf(s, co.id).find((x) => x.kind === "INFO_REQUEST" && x.status === "OPEN");
  if (dup.status === 200) problems.push(`AP-05 같은 회신(MR-002) 두 번째 → HTTP 200, 건 ${c.state}(거절·보류 유지여야 함)`);
  else if (!/이미|기다리는 건이 없/.test(dupBody.detail || "")) problems.push(`AP-05 거절 문구 = '${dupBody.detail}'`);
  if (c.state !== "NEEDS_INFO" || c.hold_reason !== "MANUAL" || !manual) problems.push(`AP-05 회신 뒤 사람 보류: 상태 ${c.state} · hold ${c.hold_reason} · 확인 작업 ${manual ? "열림" : "닫힘"}`);
  // 조건 변경 1: 사람 보류 중에는 재검증에서 빠짐(D-10)
  await A.cond("CONSERVATIVE");
  s = await A.snap(); c = caseOf(s, co.id);
  if (c.state !== "NEEDS_INFO") problems.push(`D-10 사람 보류 중 조건 변경이 보류를 풀었음: ${c.state}`);
  // 담당 부서가 확인 완료 → 다시 판단(보류 사유 지움)
  const t = tasksOf(s, co.id).find((x) => x.kind === "INFO_REQUEST" && x.status === "OPEN");
  if (t) await A.done(t.id, t.dept);
  s = await A.snap(); c = caseOf(s, co.id);
  if (c.state !== "PENDING_APPROVAL" || c.hold_reason) problems.push(`확인 완료 뒤: 상태 ${c.state} · hold ${c.hold_reason ?? "-"}(승인 대기·사유 없음이어야 함)`);
  const before = c.history.length;
  // 조건 변경 2: 이제는 재검증에 들어가야 함(AP-06)
  await A.cond("AS_IS");
  s = await A.snap(); c = caseOf(s, co.id);
  const rechecked = c.history.slice(before).some((h) => /재검증/.test(h.note || ""));
  if (!rechecked) problems.push(`AP-06 보류가 풀린 건이 조건 변경 재검증에서 빠짐(이력 ${c.history.slice(before).map((h) => h.to).join("→") || "변화 없음"})`);
  if (!/원본 due_date|AS_IS|현행/.test(c.decision?.cash?.assumption || "") && c.decision?.cash?.window?.[1] !== "2026-08-21") problems.push(`AP-06 결재 서류 현금 가정이 낡음: ${c.decision?.cash?.assumption} ${c.decision?.cash?.window}`);
  return { dup_http: dup.status, dup_detail: dupBody.detail, final: c.state };
}

/** AP-07: 카피 위반 + 공급 제약은 카피 수정이 먼저(수정 필요), 위반 카피가 남은 기안은 누구도 승인할 수 없음. */
async function copyGateRules(A, problems) {
  await A.reset();
  await A.event("BUDGET_PLAN_BATCH", "MARKETING_TEAM");
  let s = await A.snap();
  const p11 = planOf(s, "PLAN-011");
  if (p11.state !== "ACTION_REQUIRED") problems.push(`AP-07 PLAN-011(카피 위반+공급 제약) 상태 = ${p11.state}(수정 필요여야 함), 권고 ${p11.decision.recommendation}`);
  if (p11.decision.alternatives.some((a) => a.code === "AS_PROPOSED")) problems.push("AP-07 위반 카피인데 대안에 '원안 그대로 확정'");
  if (!/공급/.test(p11.decision.label)) problems.push(`AP-07 공급 제약이 권고 문구에서 사라짐: ${p11.decision.label}`);
  const ap = await A.decide(p11.id, p11.approval.approver, "approve", "원안 승인 시도");
  s = await A.snap();
  if (ap.status === 200) problems.push(`AP-07 위반 카피 그대로 승인됨(${planOf(s, "PLAN-011").state})`);
  // PLAN-001: 부결 권고(실질 ROAS<0)지만 결재 대기 — 위반 카피가 남아 있으면 결재권자도 승인 불가
  const p01 = planOf(s, "PLAN-001");
  if (p01.state === "PENDING_APPROVAL") {
    const r = await A.decide(p01.id, p01.approval.approver, "approve", "권고와 달리 승인 시도");
    if (r.status === 200) problems.push("AP-07 PLAN-001 위반 카피(부결 권고 건)가 승인됨");
  }
  // 수정안 반영 → 카피 통과 → 공급 보류 승인 대기
  const f = await A.fix(p11.id);
  s = await A.snap();
  const p11b = planOf(s, "PLAN-011");
  if (f.status !== 200 || p11b.state !== "PENDING_APPROVAL" || p11b.decision.recommendation !== "HOLD_SUPPLY") problems.push(`수정안 반영 뒤 PLAN-011: HTTP ${f.status} · ${p11b.state} · ${p11b.decision.recommendation}(승인 대기·공급 보류여야 함)`);
  const counts = { HOLD_COPY: 0, HOLD_SUPPLY: 0 };
  return { p11_before: p11.state, p11_after: p11b.state, counts };
}

describe("29차 결함 × v1.29", () => {
  T("AQ02", "AP-01: requirements.txt만 깐 깨끗한 파이썬(배포 이미지와 같은 의존성)에서 글자층 PDF·스캔 PDF·md 계약서 3종 업로드가 모두 처리되고 조항 값이 맞으며, 앱이 쓰는 외부 모듈이 모두 깔려 있고 /api/health가 PDF·OCR 준비를 알림", async () => {
    const req = fs.readFileSync(path.join(H.ROOT, "backend", "requirements.txt"), "utf8");
    const hash = crypto.createHash("sha256").update(req).digest("hex");
    const py = path.join(VENV, "bin", "python");
    if (!fs.existsSync(py) || (fs.existsSync(path.join(VENV, ".req")) ? fs.readFileSync(path.join(VENV, ".req"), "utf8") : "") !== hash) {
      fs.rmSync(VENV, { recursive: true, force: true });
      execFileSync("python3", ["-m", "venv", VENV]);
      execFileSync(path.join(VENV, "bin", "pip"), ["install", "-q", "-r", path.join(H.ROOT, "backend", "requirements.txt")], { stdio: "pipe", timeout: 600000 });
      fs.writeFileSync(path.join(VENV, ".req"), hash);
    }
    // ① 앱이 import하는 외부 모듈(선택 기능 제외)이 깨끗한 환경에 모두 있는가
    const OPTIONAL = new Set(["chromadb", "langchain_openai", "langchain_anthropic"]);
    const scan = execFileSync("python3", ["-c", `
import ast, pathlib, sys, json
std = set(sys.stdlib_module_names); out = set()
for f in pathlib.Path("app").rglob("*.py"):
    for n in ast.walk(ast.parse(f.read_text())):
        if isinstance(n, ast.Import): out |= {a.name.split(".")[0] for a in n.names}
        elif isinstance(n, ast.ImportFrom) and n.level == 0 and n.module: out.add(n.module.split(".")[0])
print(json.dumps(sorted(m for m in out if m not in std and m != "app")))`], { cwd: path.join(H.ROOT, "backend"), encoding: "utf8" });
    const mods = JSON.parse(scan).filter((m) => !OPTIONAL.has(m));
    const missing = mods.filter((m) => spawnSync(py, ["-c", `import ${m}`], { encoding: "utf8" }).status !== 0);
    // ② 깨끗한 환경으로 서버를 띄워 계약서 3종 업로드
    const port = 8230, base = `http://localhost:${port}`;
    const p = H.startProc(py, ["-m", "uvicorn", "app.main:app", "--port", String(port), "--log-level", "warning"], { cwd: path.join(H.ROOT, "backend"), env: { ...process.env, PATH: `${path.join(VENV, "bin")}:${process.env.PATH}`, PYTHONPATH: "", API_KEYS: KEY, LLM_PROVIDER: "offline", REPO: "memory", REPO_PATH: "", SERVE_FRONTEND: "0" } });
    try {
      await H.waitHttp(`${base}/api/health`);
      const A = mk(base);
      const health = await (await fetch(`${base}/api/health`)).json();
      await A.reset();
      const out = {};
      for (const f of ["e2e29_warehouse_contract_text.pdf", "e2e29_adagency_contract_scan.pdf", "e2e29_logistics_contract.md"]) {
        const t0 = Date.now(); const r = await A.upload(path.join(C29, f)); out[f] = { http: r.http, status: r.status, ms: Date.now() - t0, error: r.error || r.detail };
      }
      const dupe = await A.upload(path.join(C29, "e2e29_logistics_contract.md"));
      const s = await A.snap();
      const rc = s.cases.filter((c) => c.type === "RENEWAL");
      const terms = Object.fromEntries(rc.map((c) => [c.decision?.terms?.filename, c]));
      const tw = terms["e2e29_warehouse_contract_text.pdf"]?.decision?.terms || {}, ts = terms["e2e29_adagency_contract_scan.pdf"]?.decision?.terms || {}, tl = terms["e2e29_logistics_contract.md"]?.decision?.terms || {};
      const bad = [];
      for (const [f, r] of Object.entries(out)) if (r.http !== 202 || r.status !== "done") bad.push(`${f}: HTTP ${r.http} ${r.status ?? ""} ${r.error ?? ""}`);
      const want = (name, t, exp) => { for (const [k, v] of Object.entries(exp)) if (JSON.stringify(t[k]) !== JSON.stringify(v)) bad.push(`${name}.${k} = ${JSON.stringify(t[k])}(기대 ${JSON.stringify(v)})`); };
      want("창고(글자층 PDF)", tw, { counterparty: "주식회사 누리창고", expiry: "2027-01-31", notice_days: 90, notice_deadline: "2026-11-02", annual_fee_krw: 400000000, penalty_pct: 20 });
      want("물류(md)", tl, { counterparty: "주식회사 한결물류", expiry: "2026-09-30", notice_days: 30, notice_deadline: "2026-08-31", annual_fee_krw: 600000000, penalty_pct: 30 });
      want("광고(스캔 OCR)", ts, { counterparty: "주식회사 새솔애드", expiry: "2026-12-31", annual_fee_krw: 900000000, penalty_pct: 40 });
      // 스캔 OCR이 '60일'을 못 읽으면 지어내지 않고 확인 필요 → 계약 담당이 확인한 값을 넣으면 다시 판단
      const scanCase = terms["e2e29_adagency_contract_scan.pdf"];
      let scanAfter = null;
      if (scanCase && ts.notice_days == null) {
        if (scanCase.state !== "NEEDS_INFO") bad.push(`스캔 통보 일수를 못 읽었는데 상태 ${scanCase.state}(확인 필요여야 함)`);
        const fr = await A.facts(scanCase.target_id, { actor: "CONTRACT_OWNER", notice_days: 60, note: "원문 제3조 60일 확인(30차)" });
        const s2 = await A.snap(); scanAfter = s2.cases.find((c) => c.id === scanCase.id);
        if (fr.status !== 200 || scanAfter.decision?.terms?.notice_deadline !== "2026-11-01" || scanAfter.state === "NEEDS_INFO") bad.push(`확인한 값 반영 뒤: HTTP ${fr.status} · 통보 기한 ${scanAfter?.decision?.terms?.notice_deadline} · ${scanAfter?.state}`);
      } else if (ts.notice_days !== 60) bad.push(`스캔 통보 일수 ${ts.notice_days}(60이거나 비어 있어야 함 — 틀린 값을 지어냄)`);
      const dupMsg = [dupe.detail, dupe.error, dupe.message].filter(Boolean).join(" ");
      if (!/이미 올라와/.test(dupMsg)) bad.push(`같은 md 다시 올림 → ${dupe.http} ${dupe.status ?? ""} ${dupMsg}`);
      if (!health.contracts || health.contracts.pdf !== true) bad.push(`/api/health contracts = ${JSON.stringify(health.contracts)}(pdf: true여야 함)`);
      const docker = fs.readFileSync(path.join(H.ROOT, "Dockerfile"), "utf8");
      if (!/python -c "import pypdf/.test(docker)) bad.push("Dockerfile이 빌드 때 PDF 모듈을 확인하지 않음");
      assert.deepEqual(missing, [], `깨끗한 환경에 없는 모듈: ${missing.join(", ")}`);
      assert.deepEqual(bad, []);
      return { modules: mods.length, uploads: out, scan_notice: ts.notice_days ?? `확인 필요 → ${scanAfter?.decision?.terms?.notice_deadline}`, health: health.contracts };
    } finally { H.stop(p); }
  });

  T("AQ03", "AP-02: 로그인 창의 아이디·비밀번호 칸에 예시 글자(계정·비밀번호)가 없고, 배포 번들에 계정 아이디·비밀번호가 없으며, 서버가 평문·약한·여러 계정 공용 비밀번호를 기동 때 경고(값은 쓰지 않음)", async () => {
    const port = 8231, base = `http://localhost:${port}`;
    const weak = "ceo.kang:Aurora1234:GROUP_CEO;contract.park:Aurora1234:CONTRACT_OWNER;scm.kim:Aurora1234:SCM";
    const logs = [];
    const p = spawn("python3", ["-m", "uvicorn", "app.main:app", "--port", String(port), "--log-level", "warning"], { cwd: path.join(H.ROOT, "backend"), detached: true,
      env: { ...process.env, API_KEYS: KEY, AUTH_MODE: "jwt", USERS: weak, JWT_SECRET: "e2e-secret-0123456789abcdef", SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "", LLM_PROVIDER: "offline" } });
    p.stdout.on("data", (d) => logs.push(String(d))); p.stderr.on("data", (d) => logs.push(String(d)));
    const B = await H.newPage(); const pg = B.page;
    try {
      await H.waitHttp(`${base}/api/health`);
      await pg.goto(base); await pg.waitForSelector(".top");
      await pg.evaluate(() => { localStorage.setItem("aurora-desk-ui", JSON.stringify({ role: "GROUP_CEO", selected: null, tab: "facts", mode: "api" })); sessionStorage.clear(); });
      await pg.reload(); await pg.locator('[data-testid="login-user"]').waitFor({ timeout: 8000 });
      const ph = await pg.evaluate(() => ["login-user", "login-password"].map((id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute("placeholder") ?? ""));
      const bundle = fs.readdirSync(path.join(DIST, "assets")).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(DIST, "assets", f), "utf8")).join("\n");
      const leaked = ["ceo.kang", "contract.park", "Aurora1234", "pw-ceo"].filter((x) => bundle.includes(x));
      const log = logs.join("");
      const bad = [];
      if (ph.some((x) => x && (/[a-z]+\.[a-z]+/i.test(x) || x.length >= 6) && !/^(아이디|비밀번호)$/.test(x))) bad.push(`로그인 칸 예시 글자 = ${JSON.stringify(ph)}`);
      if (leaked.length) bad.push(`번들에 계정·비밀번호: ${leaked.join(", ")}`);
      if (!/USERS/.test(log) || !/(공용|같은 비밀번호)/.test(log)) bad.push(`기동 경고 없음(평문·공용 비밀번호): ${log.slice(0, 200) || "로그 없음"}`);
      if (log.includes("Aurora1234")) bad.push("경고에 비밀번호 값이 찍힘");
      assert.deepEqual(bad, []);
      return { placeholders: ph, warning: (log.match(/[^\n]*USERS[^\n]*/) || [""])[0].slice(0, 160) };
    } finally { await B.browser.close().catch(() => {}); H.stop(p); }
  });

  T("AQ04", "AP-03·AP-04·AP-08·AP-10: 확인 요청은 결재권자만(서버 403 + 화면 버튼 잠김), 확인 작업은 그 건의 기안 부서(계약 건 → 계약 담당), 감사에 '건 제목 확인 요청 — 의견', 로그인 모드 안내는 '○○ 계정으로 로그인' — 서버·브라우저 엔진 같은 규칙", async () => {
    const port = 8232, base = `http://localhost:${port}`;
    const api = await H.startApi(port, { ...JWT, SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const pg = B.page;
    const problems = [];
    try {
      // 서버(로그인 모드: 역할 = 토큰)
      const tok = { co: await login(base, "contract.choi", "pw-co"), ceo: await login(base, "ceo.kang", "pw-ceo") };
      const As = (t) => mk(base, { Authorization: `Bearer ${t}` });
      const A = As(tok.ceo);
      // API 키 모드와 같은 명령을 토큰으로: actor는 토큰이 정하므로 본문 actor는 무시됨
      const Aco = As(tok.co);
      const proxy = { ...A, decide: (id, actor, action, comment) => (actor === "CONTRACT_OWNER" ? Aco : A).decide(id, actor, action, comment),
        event: (k, actor, text) => (actor === "CONTRACT_OWNER" ? Aco : A).event(k, actor, text), reply: () => Aco.reply() };
      const srv = await infoRequestRules(proxy, problems);
      // 화면(서버 모드, 계약 담당 로그인): 그룹 CEO 건의 확인 요청 버튼 잠김 + 로그인 모드 안내
      await pg.goto(base); await pg.waitForSelector(".top");
      await pg.evaluate(() => { localStorage.setItem("aurora-desk-ui", JSON.stringify({ role: "GROUP_CEO", selected: null, tab: "case", mode: "api" })); sessionStorage.clear(); });
      await pg.reload();
      await pg.locator('[data-testid="login-user"]').fill("contract.choi"); await pg.locator('[data-testid="login-password"]').fill("pw-co"); await pg.locator('[data-testid="login-submit"]').click();
      await pg.locator('[data-testid="whoami"]').waitFor({ timeout: 8000 });
      // 확인 필요였던 건을 CEO가 다시 결재로 돌려 둔 상태가 아니므로, 새로 역제안 승인 대기를 만든다
      await counterReady(proxy);
      await pg.waitForTimeout(2500);
      await pg.locator(".cases .case-item", { hasText: "역제안" }).last().click(); await pg.waitForSelector(".sheet");
      const reqDisabled = await pg.locator('[data-testid="request-info"]').isDisabled();
      const hint = await pg.locator(".decide .hint").first().innerText().catch(() => "");
      if (!reqDisabled) problems.push("AP-03 화면: 계약 담당에게 그룹 CEO 건의 '확인 요청' 버튼이 켜져 있음");
      if (/상단에서 역할을 바꾸면/.test(hint) || !/그룹 CEO.*로그인/.test(hint)) problems.push(`AP-10 로그인 모드 안내 = '${hint}'`);
      // 브라우저 엔진(로그인 없음): 같은 규칙
      await pg.locator('[data-testid="logout"]').click(); await pg.waitForTimeout(400);
      await pg.evaluate(() => { localStorage.setItem("aurora-desk-ui", JSON.stringify({ role: "CONTRACT_OWNER", selected: null, tab: "case", mode: "local" })); sessionStorage.clear(); });
      await pg.reload(); await pg.waitForSelector(".top");
      const btn = (n) => pg.getByRole("button", { name: n, exact: true });
      await btn("전속계약 갱신 통보 접수").click(); await btn("에이전시 역제안 수신").click(); await btn("에이전시 지급 일정 회신").click();
      await pg.locator(".cases .case-item", { hasText: "역제안" }).last().click(); await pg.waitForSelector(".sheet");
      const localDisabled = await pg.locator('[data-testid="request-info"]').isDisabled();
      if (!localDisabled) problems.push("AP-03 브라우저 엔진: 계약 담당에게 '확인 요청' 버튼이 켜져 있음");
      await pg.locator('[data-testid="role-select"]').selectOption("GROUP_CEO");
      await pg.locator("#cmt").fill("지급 일정 근거 재확인"); await pg.locator('[data-testid="request-info"]').click();
      await pg.waitForTimeout(300);
      const localTask = await pg.locator(".dept li", { hasText: "[확인 요청] CT-INF001-2025" }).first().innerText().catch(() => "");
      const deptHead = await pg.evaluate(() => { const li = [...document.querySelectorAll(".dept li")].find((x) => x.textContent.includes("[확인 요청] CT-INF001-2025")); return li?.closest(".dept")?.querySelector("h3,h4,.dept-name")?.textContent ?? ""; });
      if (!localTask) problems.push("브라우저 엔진: 확인 작업 없음");
      else if (!/계약/.test(deptHead)) problems.push(`AP-04 브라우저 엔진: 확인 작업 부서 = '${deptHead}'`);
      await pg.getByRole("button", { name: "전체 기록 보기·검색" }).click();
      await pg.locator('[data-testid="audit-search"]').fill("확인 요청 —"); await pg.waitForTimeout(500);
      const auLocal = await pg.locator('[data-testid="audit-results"]').innerText();
      if (!/역제안\(조건 변경\) 확인 요청 — 지급 일정 근거 재확인/.test(auLocal)) problems.push(`AP-08 브라우저 엔진 감사 = '${auLocal.slice(0, 120)}'`);
      assert.deepEqual(problems, []);
      assert.deepEqual(pg.errors, []);
      return { server_task_dept: srv.task?.dept };
    } finally { await B.browser.close().catch(() => {}); H.stop(api); }
  });

  T("AQ05", "AP-05·AP-06·O-5: 같은 에이전시 회신(MR-002)을 다시 받으면 거절하고 사람이 건 확인 요청 보류·작업이 그대로이며, 담당 부서가 확인을 끝내 보류가 풀린 건은 다음 조건 변경에서 다시 검증되고, 감사는 '회신 접수 → 결과' 순서 — 서버·브라우저 엔진", async () => {
    const port = 8233, base = `http://localhost:${port}`;
    const api = await H.startApi(port, { SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const pg = B.page;
    const problems = [];
    try {
      const out = await replyAndHoldRules(mk(base), problems);
      // 브라우저 엔진: 회신 버튼은 '회신 대기'일 때만, 같은 흐름
      await pg.goto(base); await pg.waitForSelector(".top");
      await pg.evaluate(() => { localStorage.setItem("aurora-desk-ui", JSON.stringify({ role: "CONTRACT_OWNER", selected: null, tab: "case", mode: "local" })); sessionStorage.clear(); });
      await pg.reload(); await pg.waitForSelector(".top");
      const btn = (n) => pg.getByRole("button", { name: n, exact: true });
      const role = (r) => pg.locator('[data-testid="role-select"]').selectOption(r);
      await btn("전속계약 갱신 통보 접수").click(); await btn("에이전시 역제안 수신").click(); await btn("에이전시 지급 일정 회신").click();
      await pg.locator(".cases .case-item", { hasText: "역제안" }).last().click(); await pg.waitForSelector(".sheet");
      await role("GROUP_CEO"); await pg.locator("#cmt").fill("지급 일정 근거 재확인"); await pg.locator('[data-testid="request-info"]').click(); await pg.waitForTimeout(200);
      const replyBtnDisabled = await btn("에이전시 지급 일정 회신").isDisabled();
      if (!replyBtnDisabled) problems.push("AP-05 브라우저 엔진: 사람이 건 확인 요청인데 '에이전시 지급 일정 회신' 버튼이 켜짐");
      const st = await pg.locator(".sheet-meta .chip").first().innerText();
      if (st !== "확인 필요") problems.push(`브라우저 엔진 보류 상태 = ${st}`);
      await role("CONTRACT_OWNER");
      await pg.locator(".dept li", { hasText: "[확인 요청] CT-INF001-2025" }).first().getByRole("button").click(); await pg.waitForTimeout(200);
      await role("FINANCE"); await btn("재무: 연체 채권 회수 불확실").click(); await pg.waitForTimeout(300);
      await pg.locator(".cases .case-item", { hasText: "역제안" }).last().click();
      const lines = await pg.evaluate(() => [...document.querySelectorAll(".sheet .evidence td")].map((td) => td.textContent).join(" "));
      if (!/7\/21~8\/28|2026-07-21~2026-08-28/.test(lines)) problems.push("AP-06 브라우저 엔진: 보류가 풀린 역제안이 조건 변경(보수 가정)으로 다시 검증되지 않음");
      assert.deepEqual(problems, []);
      assert.deepEqual(pg.errors, []);
      return out;
    } finally { await B.browser.close().catch(() => {}); H.stop(api); }
  });

  T("AQ06", "AP-07: PLAN-011(카피 위반 '치료' + 더마 공급 제약)은 '수정 필요'로 멈추고(공급 제약도 함께 표시, '원안 그대로 확정' 없음), 위반 카피가 남은 기안은 결재권자도 승인할 수 없으며(PLAN-001 부결 권고 건 포함), 수정안 반영 뒤에야 공급 보류 결재로 올라감 — 서버·브라우저 엔진", async () => {
    const port = 8234, base = `http://localhost:${port}`;
    const api = await H.startApi(port, { SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const pg = B.page;
    const problems = [];
    try {
      const out = await copyGateRules(mk(base), problems);
      await pg.goto(base); await pg.waitForSelector(".top");
      await pg.evaluate(() => { localStorage.setItem("aurora-desk-ui", JSON.stringify({ role: "MASIL_CEO", selected: null, tab: "plans", mode: "local" })); sessionStorage.clear(); });
      await pg.reload(); await pg.waitForSelector(".top");
      await pg.getByRole("button", { name: "확대 기안 25건 접수", exact: true }).click();
      await pg.getByRole("tab", { name: "확대 기안 25건" }).click();
      await pg.locator(".plans tbody tr", { hasText: "PLAN-011" }).click(); await pg.waitForSelector(".sheet");
      const st = await pg.locator(".sheet-meta .chip").first().innerText();
      const approveBtn = await pg.locator('[data-testid="approve"]').count();
      if (st !== "수정 필요") problems.push(`브라우저 엔진 PLAN-011 = ${st}`);
      if (approveBtn) problems.push("브라우저 엔진 PLAN-011에 승인 버튼이 보임");
      await pg.getByRole("tab", { name: "확대 기안 25건" }).click();
      await pg.locator(".plans tbody tr", { hasText: "PLAN-001" }).click(); await pg.waitForSelector(".sheet");
      await pg.locator('[data-testid="role-select"]').selectOption("GROUP_CEO");
      if (await pg.locator('[data-testid="approve"]').count()) {
        const dis = await pg.locator('[data-testid="approve"]').isDisabled();
        if (!dis) problems.push("브라우저 엔진 PLAN-001(위반 카피) 승인 버튼이 결재권자에게 켜짐");
      }
      assert.deepEqual(problems, []);
      assert.deepEqual(pg.errors, []);
      return out;
    } finally { await B.browser.close().catch(() => {}); H.stop(api); }
  });

  T("AQ07", "AP-09·AP-11·AP-12: 체인 검증 결과는 로그아웃·다른 사람 로그인 때 지워지고 그 뒤 기록이 늘면 '다시 검증' 안내, 로그인 창에서 브라우저 모드로 돌아갈 수 있고, 서버 로그인이 남은 채 브라우저 모드로 바꾸면 고른 역할이 그대로 쓰임", async () => {
    const port = 8235, base = `http://localhost:${port}`;
    const api = await H.startApi(port, { ...JWT, SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const pg = B.page;
    const problems = [];
    const loginUi = async (u, pw) => { await pg.locator('[data-testid="login-user"]').fill(u); await pg.locator('[data-testid="login-password"]').fill(pw); await pg.locator('[data-testid="login-submit"]').click(); await pg.locator('[data-testid="whoami"]').waitFor({ timeout: 8000 }); };
    try {
      const tok = await login(base, "ceo.kang", "pw-ceo");
      await fetch(`${base}/api/reset`, { method: "POST", headers: { "X-API-Key": KEY, Authorization: `Bearer ${tok}` } });
      await pg.goto(base); await pg.waitForSelector(".top");
      await pg.evaluate(() => { localStorage.setItem("aurora-desk-ui", JSON.stringify({ role: "GROUP_CEO", selected: null, tab: "facts", mode: "api" })); sessionStorage.clear(); });
      await pg.reload(); await pg.locator('[data-testid="login-user"]').waitFor();
      // AP-11: 로그인 창에서 브라우저 모드로
      const back = pg.locator('[data-testid="login-local"]');
      if (!(await back.count())) problems.push("AP-11 로그인 창에 '브라우저 모드로 보기' 없음");
      else {
        await back.click(); await pg.waitForTimeout(300);
        const dlg = await pg.locator('[data-testid="login-user"]').count();
        const mode = await pg.locator(".role select").nth(1).inputValue();
        if (dlg || mode !== "local") problems.push(`AP-11 브라우저 모드로 가지 않음(창 ${dlg} · 실행 위치 ${mode})`);
        await pg.locator(".role select").nth(1).selectOption("api"); await pg.locator('[data-testid="login-user"]').waitFor();
      }
      // AP-09: 검증 → 기록 늘어남 → 안내, 로그아웃 → 지움, 다른 사람 로그인 → 빈 칸
      await loginUi("ceo.kang", "pw-ceo");
      await pg.locator('[data-testid="audit-verify"]').click();
      const out = pg.locator('[data-testid="audit-verify-result"]');
      await out.filter({ hasText: /이상 없음/ }).waitFor({ timeout: 6000 });
      const first = await out.innerText();
      await mk(base, { Authorization: `Bearer ${tok}` }).event("FREE_TEXT", "GROUP_CEO", "30차 검증 뒤 기록");
      await pg.waitForTimeout(4500);
      const stale = await out.innerText();
      if (stale === first || !/다시 검증/.test(stale)) problems.push(`AP-09 기록이 늘어도 결과 그대로: '${stale}'`);
      await pg.locator('[data-testid="logout"]').click(); await pg.locator('[data-testid="login-user"]').waitFor();
      await loginUi("mk.park", "pw-mk");
      const next = await out.innerText();
      if (next.trim()) problems.push(`AP-09 다음 사람 로그인 뒤에도 앞 사람 결과: '${next}'`);
      // AP-12: 서버 로그인(마케팅팀)이 남은 채 브라우저 모드 → 역할 선택이 그대로 쓰임
      await pg.locator(".role select").nth(1).selectOption("local"); await pg.waitForTimeout(300);
      const sel = pg.locator('[data-testid="role-select"]');
      const enabled = await sel.isEnabled();
      if (enabled) {
        await sel.selectOption("CONTRACT_OWNER"); await pg.waitForTimeout(200);
        const v = await sel.inputValue();
        if (v !== "CONTRACT_OWNER") problems.push(`AP-12 브라우저 모드에서 계약 담당을 골랐는데 ${v}로 되돌아감`);
      } else problems.push("AP-12 브라우저 모드인데 역할 선택이 잠김");
      assert.deepEqual(problems, []);
      assert.deepEqual(pg.errors, []);
      return { verify_first: first, verify_after: stale };
    } finally { await B.browser.close().catch(() => {}); H.stop(api); }
  });

  T("AQ08", "O-4·O-6: 조건변경 통보를 보낸 뒤 기한을 넘기면 '통보 미발송'이 아니라 '미갱신 통보 미발송(조건변경 통보는 보냄 — 법무 확인)'으로 기록하고, 결재권자가 아닌 역할에게 'AI 설명 도착' 안내를 띄우지 않음", async () => {
    const port = 8236, base = `http://localhost:${port}`;
    const api = await H.startApi(port, { SERVE_FRONTEND: "1", FRONTEND_DIST: DIST, ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const pg = B.page;
    const problems = [];
    try {
      const A = mk(base);
      await A.reset();
      await A.event("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER");
      let s = await A.snap();
      const notice = byKind(s, "CONTRACT_RENEWAL_NOTICE")[0];
      await A.decide(notice.id, "GROUP_CEO", "approve", "조건변경 통보 승인");
      s = await A.snap();
      const send = tasksOf(s, notice.id).find((t) => t.effect === "CONTRACT_NOTICE_SENT");
      await A.done(send.id, send.dept);
      await A.event("AGENCY_COUNTER_OFFER", "CONTRACT_OWNER"); await A.reply();
      s = await A.snap();
      const co = byKind(s, "AGENCY_COUNTER_OFFER")[0];
      await A.decide(co.id, "GROUP_CEO", "reject", "역제안 거절");
      await A.clock("2026-07-18");
      s = await A.snap();
      const ex = s.audit.filter((a) => a.topic === "deadline.expired" && /INF-001 통보 기한/.test(a.detail)).pop();
      if (!ex) problems.push("기한 경과 기록 없음");
      else if (/까지 통보 미발송\(/.test(ex.detail) || !/조건변경 통보/.test(ex.detail)) problems.push(`O-4 기한 경과 문구 = '${ex.detail}'`);
      // O-6: 브라우저 모드, 재무팀이 PLAN-004를 보는 중 조건 변경 → 결재권자가 아니므로 'AI 설명' 안내 없음
      await pg.goto(base); await pg.waitForSelector(".top");
      await pg.evaluate(() => { localStorage.setItem("aurora-desk-ui", JSON.stringify({ role: "FINANCE", selected: null, tab: "plans", mode: "local" })); sessionStorage.clear(); });
      await pg.reload(); await pg.waitForSelector(".top");
      await pg.getByRole("button", { name: "확대 기안 25건 접수", exact: true }).click();
      await pg.getByRole("tab", { name: "확대 기안 25건" }).click();
      await pg.locator(".plans tbody tr", { hasText: "PLAN-004" }).click(); await pg.waitForSelector(".sheet");
      await pg.getByRole("button", { name: "재무: 연체 채권 회수 불확실", exact: true }).click(); await pg.waitForTimeout(500);
      const note = await pg.locator(".sheet").innerText();
      if (/AI 설명이 방금 도착/.test(note)) problems.push("O-6 결재권자가 아닌 재무팀에게 'AI 설명이 방금 도착' 안내");
      assert.deepEqual(problems, []);
      return { expired: ex?.detail };
    } finally { await B.browser.close().catch(() => {}); H.stop(api); }
  });

  T("AQ09", "MySQL(MariaDB) 저장소: 확인 요청 권한·부서·감사 문구(AQ04), 같은 회신 거절·보류 해제 뒤 재검증(AQ05), 카피 게이트(AQ06)가 메모리 저장소와 같고, 계약서 3종이 renewals 표에 한 줄씩·감사 체인 이상 없음", async () => {
    needDb();
    const port = 8237, base = `http://localhost:${port}`;
    const api = await H.startApi(port, { ...db.env });
    const problems = [];
    try {
      const A = mk(base);
      const t0 = Date.now();
      await infoRequestRules(A, problems);
      await replyAndHoldRules(A, problems);
      await copyGateRules(A, problems);
      const flowMs = Date.now() - t0;
      await A.reset();
      for (const f of ["e2e29_logistics_contract.md", "e2e29_warehouse_contract_text.pdf", "e2e29_adagency_contract_scan.pdf"]) { const r = await A.upload(path.join(C29, f)); if (r.status !== "done") problems.push(`MySQL 업로드 ${f}: ${r.http} ${r.status} ${r.error ?? r.detail ?? ""}`); }
      const sock = `/tmp/aurora-e2e-${PORT}.sock`;
      const rows = execFileSync("mariadb", ["-uroot", `--socket=${sock}`, "-N", "-B", "aurora_desk", "-e", "SELECT COUNT(*) FROM renewals"], { encoding: "utf8" }).trim();
      if (rows !== "3") problems.push(`renewals 행 ${rows}(3이어야 함)`);
      const v = await (await A.call("GET", "/api/audit/verify")).json();
      if (!v.ok) problems.push(`감사 체인 ${JSON.stringify(v).slice(0, 120)}`);
      assert.deepEqual(problems, []);
      return { renewals: Number(rows), audit_checked: v.checked, rules_ms: flowMs };
    } finally { H.stop(api); }
  });

  T("AQ10", "배포 확인 스크립트(읽기 전용): 배포와 같은 단일 컨테이너(로그인 모드)에 --browser로 돌리면 실패 0, PDF·OCR 준비(A14)와 로그인 칸 예시 글자(U04)를 확인하고, 예시 글자에 비밀번호를 넣은 번들은 U04 실패로 잡음 — 보낸 요청은 GET·HEAD·OPTIONS뿐", async () => {
    const port = 8238, base = `http://localhost:${port}/`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aq10-"));
    const bad = path.join(tmp, "dist-bad");
    fs.cpSync(DIST, bad, { recursive: true });
    for (const f of fs.readdirSync(path.join(bad, "assets")).filter((x) => x.endsWith(".js"))) {
      const fp = path.join(bad, "assets", f); const src = fs.readFileSync(fp, "utf8");
      fs.writeFileSync(fp, src.replace(/"data-testid":"login-password"/g, '"data-testid":"login-password",placeholder:"pw-ceo"').replace(/"data-testid":"login-user"/g, '"data-testid":"login-user",placeholder:"ceo.kang"'));
    }
    const run = async (dist) => {
      const api = await H.startApi(port, { ...JWT, SERVE_FRONTEND: "1", FRONTEND_DIST: dist, ALLOWED_ORIGINS: "" });
      try {
        const rep = path.join(tmp, `r-${path.basename(dist)}.json`);
        const r = spawnSync("node", [path.join(__dirname, "smoke_remote.cjs"), base, "--browser", "--report", rep, "--expect-version", "1.29.0"], { cwd: tmp, encoding: "utf8", timeout: 180000 });
        const j = JSON.parse(fs.readFileSync(rep, "utf8"));
        return { code: r.status, j, out: r.stdout };
      } finally { H.stop(api); await sleep(400); }
    };
    const good = await run(DIST);
    const evil = await run(bad);
    const get = (j, id) => j.results.find((x) => x.id === id);
    const fails = good.j.results.filter((x) => x.level === "FAIL").map((x) => `${x.id} ${x.title}: ${x.detail}`);
    assert.deepEqual(fails, [], "정상 번들에서 실패");
    assert.equal(get(good.j, "A14")?.level, "PASS", `A14 = ${JSON.stringify(get(good.j, "A14"))}`);
    assert.equal(get(good.j, "U04")?.level, "PASS", `U04 = ${JSON.stringify(get(good.j, "U04"))}`);
    assert.equal(get(evil.j, "U04")?.level, "FAIL", `예시 글자 번들을 못 잡음: ${JSON.stringify(get(evil.j, "U04"))}`);
    assert.equal(evil.code, 1);
    const sent = good.j.sent || {};
    assert.deepEqual(Object.keys(sent).filter((m) => !["GET", "HEAD", "OPTIONS"].includes(m)), []);
    return { good: good.j.summary, sent, u04_bad: get(evil.j, "U04").detail.slice(0, 120) };
  });

  T("AQ11", "시연 영상: 5분 미만, AI 음성 해설 트랙, 해설이 모두 영상 안이고, PRD·README에 적은 영상 길이가 실제와 같으며, 바뀐 규칙(PLAN-011 수정 필요)이 자막과 맞음", async () => {
    const mp4 = path.join(H.ROOT, "demo", "aurora_demo.mp4"), nar = path.join(H.ROOT, "demo", "narration.json");
    if (!fs.existsSync(mp4)) return { skipped: "영상 파일 없음(zip에는 영상이 빠짐)" };
    const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", mp4], { encoding: "utf8" }));
    const dur = Number(info.format.duration);
    const lines = JSON.parse(fs.readFileSync(nar, "utf8"));
    const mmss = `${Math.floor(dur / 60)}분 ${Math.floor(dur % 60)}초`;
    const prd = fs.readFileSync(path.join(H.ROOT, "docs", "PRD.md"), "utf8").match(/## 10\. 시연 시나리오 \(영상: `demo\/aurora_demo\.mp4`, (\d분 \d+초)/)?.[1];
    const readme = fs.readFileSync(path.join(H.ROOT, "README.md"), "utf8").match(/\((\d분 \d+초), \*\*AI 음성 해설 포함\*\*/)?.[1];
    const script = fs.readFileSync(path.join(H.ROOT, "demo", "record_demo.cjs"), "utf8");
    assert.ok(dur < 300, `영상 ${dur.toFixed(1)}초 — 5분 미만이 아님`);
    assert.ok(info.streams.some((s) => s.codec_type === "audio"), "음성 트랙 없음");
    assert.ok(lines.every((l) => l.at + l.dur <= dur + 0.5), "영상 밖 해설");
    assert.equal(prd, mmss, `PRD §10의 영상 길이 ${prd} ≠ 실제 ${mmss}`);
    assert.equal(readme, mmss, `README의 영상 길이 ${readme} ≠ 실제 ${mmss}`);
    assert.ok(!/카피 보류 2건|공급 보류 1건/.test(script), "자막에 낡은 수치(카피 보류 2건·공급 보류 1건)");
    return { seconds: Math.round(dur * 10) / 10, lines: lines.length };
  });
});

// ---------------- §14 · §15 대조 + 기능 고정 확인 ----------------
const SUITES = () => (fs.readFileSync(path.join(__dirname, "run_all.sh"), "utf8").match(/for s in ([^;]+);/) || [, ""])[1].trim().split(/\s+/);
const latestOf = (s) => { const f = path.join(__dirname, "reports", `${s}.json`); return fs.existsSync(f) ? Object.fromEntries(JSON.parse(fs.readFileSync(f, "utf8")).results.map((r) => [r.id, r.ok])) : {}; };

describe("§14 리스크와 한계 · §15 대조", () => {
  T("AQ01", "§14의 모든 행이 지키는 테스트를 가리키고 통과했으며, §15 '검증' 열의 테스트가 모두 있고 통과했고, 표의 E2E 수가 사실과 같고, 기능 고정(§15에 'v1.28·v1.29 추가' 열 없음), 29차 결함 12건이 §14 또는 §36 한계에 모두 있음", async () => {
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
    const okOf = (s, id) => (s === "pytest" ? pyOk : s === "round30" ? results.find((r) => r.id === id)?.ok : (cache[s] ??= latestOf(s))[id]);
    const failing = [];
    for (const [risk, refs] of Object.entries(RISK_GUARDS)) for (const ref of refs) { const [s, id] = ref.split(/:(.+)/); const ok = okOf(s, id); if (ok !== true) failing.push(`${risk} ← ${ref}(${ok === undefined ? "없음" : "실패"})`); }
    const headLine = s15.split("\n").find((l) => /^\| # \|/.test(l));
    const head = headLine.split("|").map((x) => x.trim());
    const vcol = head.indexOf("검증");
    const s15rows = s15.split("\n").filter((l) => /^\| [0-9①-⑩]/.test(l)).map((l) => l.split("|").map((x) => x.trim()));
    const suiteOf = { AH: "round21", AI: "round22", AJ: "round23", AK: "round24", AL: "round25", AM: "round26", AN: "round27", AO: "round28", AQ: "round30" };
    const verifyBad = [];
    for (const r of s15rows) {
      const ids = [];
      for (const m of (r[vcol] || "").matchAll(/\b(A[H-Q])(\d\d)(?:~A[H-Q](\d\d))?/g)) { const x = Number(m[2]), z = Number(m[3] || m[2]); for (let i = x; i <= z; i++) ids.push(`${m[1]}${String(i).padStart(2, "0")}`); }
      for (const id of ids) if (okOf(suiteOf[id.slice(0, 2)], id) !== true) verifyBad.push(`§15 ${r[1]} ← ${id}`);
    }
    const total = SUITES().filter((s) => s !== "round30").reduce((n, s) => n + Object.keys(latestOf(s)).length, 0) + results.length + 1;
    const stated = Number((sec.match(/E2E\(현재 (\d+)개\)/) || [])[1]);
    const ap = Array.from({ length: 12 }, (_, i) => `AP-${String(i + 1).padStart(2, "0")}`);
    const r30 = rep.split(/\n## \d+\. 30차 E2E/)[1] || "";
    const untracked = ap.filter((id) => !r30.includes(id));
    assert.deepEqual(unmapped, [], `지키는 테스트가 없는 리스크 행: ${unmapped.join(", ")}`);
    assert.deepEqual(failing, [], `대응이 지켜지지 않는 리스크 ${failing.length}건: ${failing.slice(0, 6).join(" / ")}`);
    assert.deepEqual(verifyBad, [], `§15 '검증' 열의 테스트가 없거나 실패: ${verifyBad.join(", ")}`);
    assert.ok(!/v1\.2[89] 추가/.test(headLine), "기능 고정인데 §15에 'v1.28/v1.29 추가' 열이 있음");
    assert.equal(stated, total, `§14가 말하는 E2E 수 ${stated} ≠ 실제 ${total}`);
    assert.deepEqual(untracked, [], `30차 절에 없는 29차 결함: ${untracked.join(", ")}`);
    return { risks: rows.length, refs: Object.values(RISK_GUARDS).flat().length, e2e_total: total };
  });
});
