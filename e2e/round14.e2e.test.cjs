// 14차 E2E — 서버 재시작을 견디는가(로그아웃·진행 중 작업), 휴대폰·비밀 파일로 들어오는 로그인 아이디, 외부 LLM 출력 계약.
//   ① 1~13차 '남은 한계'의 메모리 의존 항목: 로그아웃 무효화 목록, 진행 중 작업 기록 → 재시작(재배포) 뒤에도 유지되는가
//   ② 아이디 앞뒤 공백·대문자(휴대폰 자동 대문자, 비밀 파일 끝 줄바꿈)와 대소문자를 바꿔 잠금을 피하는 시도
//   ③ LLM이 아주 긴 글(2만 자)·영어·HTML 태그를 돌려줄 때 승인자에게 무엇이 보이는가
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const H = require("./helpers.cjs");

const KEY = "e2e-key";
const LLM = "http://127.0.0.1:8902";
const LLM_ENV = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `${LLM}/v1`, LLM_TIMEOUT_S: "3" };
const AUTH = { AUTH_MODE: "jwt", USERS: "ceo.kang:pw-ceo:GROUP_CEO;fin.park:pw-fin:FINANCE", JWT_SECRET: "e2e-secret-0123456789abcdef" };
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, { token, body } = {}) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
const loginR = (base, user, password) => call(base, "POST", "/api/auth/login", { body: { user, password } });
const waitJob = async (base, r, token) => { const b = await r.json(); for (let i = 0; i < 600; i++) { const j = await (await call(base, "GET", `/api/jobs/${b.job_id}`, { token })).json(); if (j.status === "done" || j.status === "failed") return { ...j, job_id: b.job_id }; await new Promise((x) => setTimeout(x, 25)); } throw new Error("job timeout"); };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aurora14-")), "desk.json");
let llm = null, db = null;
before(async () => { llm = spawn("python3", [path.join(__dirname, "mock_llm.py"), "8902"], { stdio: "ignore", detached: true }); await H.waitHttp(`${LLM}/__stats`); });
after(() => { H.writeReport("round14", { results }); try { process.kill(-llm.pid); } catch { /* gone */ } H.stop(db); });

describe("서버 재시작을 견디는가", () => {
  const modes = async () => {
    const out = [["메모리 파일", { REPO: "memory", REPO_PATH: tmpFile() }]];
    db = db || await H.startMariaDB(3314);
    if (db) out.push(["MySQL", db.env]);
    else if (process.env.REQUIRE_DB === "1") throw new Error("MariaDB 없음");
    return out;
  };
  T("Z01", "로그아웃한 로그인(연장 전 토큰 포함)은 서버를 다시 켠 뒤에도 무효(메모리 파일·MySQL)", async () => {
    const bad = [];
    for (const [label, env] of await modes()) {
      const base = "http://localhost:8080";
      let api = await H.startApi(8080, { ...AUTH, ...env });
      try {
        const t0 = (await (await loginR(base, "ceo.kang", "pw-ceo")).json()).token;
        const t1 = (await (await call(base, "POST", "/api/auth/refresh", { token: t0 })).json()).token;
        await call(base, "POST", "/api/auth/logout", { token: t1 });
        H.stop(api); await new Promise((r) => setTimeout(r, 500));
        api = await H.startApi(8080, { ...AUTH, ...env });          // 재배포·재시작(같은 비밀값)
        const c = { t0: (await call(base, "GET", "/api/revision", { token: t0 })).status, t1: (await call(base, "GET", "/api/revision", { token: t1 })).status,
          refresh: (await call(base, "POST", "/api/auth/refresh", { token: t0 })).status };
        if (c.t0 !== 401 || c.t1 !== 401 || c.refresh !== 401) bad.push(`${label}: 재시작 뒤 ${JSON.stringify(c)}`);
      } finally { H.stop(api); await new Promise((r) => setTimeout(r, 300)); }
    }
    assert.deepEqual(bad, [], "로그아웃이 재시작으로 풀림");
  });
  T("Z02", "진행 중이던 접수의 결과를 서버를 다시 켠 뒤에도 조회할 수 있음(API·MCP가 '없음'으로 오해하지 않음)", async () => {
    const bad = [];
    for (const [label, env] of await modes()) {
      const base = "http://localhost:8081";
      let api = await H.startApi(8081, env);
      try {
        await call(base, "POST", "/api/reset");
        const j = await waitJob(base, await call(base, "POST", "/api/events", { body: { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" } }));
        H.stop(api); await new Promise((r) => setTimeout(r, 500));
        api = await H.startApi(8081, env);
        const r = await call(base, "GET", `/api/jobs/${j.job_id}`);
        const b = await r.json().catch(() => ({}));
        if (r.status !== 200 || b.status !== "done" || b.message !== j.message) bad.push(`${label}: ${r.status} ${JSON.stringify(b).slice(0, 80)}`);
      } finally { H.stop(api); await new Promise((r) => setTimeout(r, 300)); }
    }
    assert.deepEqual(bad, [], "재시작 뒤 작업 결과를 찾지 못함");
  });
});

describe("로그인 아이디", () => {
  T("Z03", "아이디의 대문자·앞뒤 공백·끝 줄바꿈(휴대폰 자동 대문자, 비밀 파일)으로도 로그인되고, 대소문자를 바꿔 가며 틀려도 잠금을 피하지 못함", async () => {
    const base = "http://localhost:8082";
    const api = await H.startApi(8082, { ...AUTH, SERVE_FRONTEND: "1", FRONTEND_DIST: path.join(H.ROOT, "frontend", "dist-docker"), ALLOWED_ORIGINS: "" });
    const B = await H.newPage(); const p = B.page;
    try {
      const ok = {};
      for (const u of ["Ceo.kang", " ceo.kang ", "ceo.kang\n", "CEO.KANG"]) ok[JSON.stringify(u)] = (await loginR(base, u, "pw-ceo")).status;
      const codes = [];
      for (const u of ["Fin.park", "FIN.PARK", "fin.Park", "fIn.park", "Fin.Park", "FIN.park"]) codes.push((await loginR(base, u, "wrong")).status);
      const right = (await loginR(base, "fin.park", "pw-fin")).status;
      await p.goto(base); await p.waitForSelector(".top");
      await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector(".top");
      await p.locator(".role select").nth(1).selectOption("api");
      const attrs = await p.locator('[data-testid="login-user"]').evaluate((el) => ({ cap: el.getAttribute("autocapitalize"), spell: el.getAttribute("spellcheck"), corr: el.getAttribute("autocorrect") }));
      assert.deepEqual(Object.values(ok), [200, 200, 200, 200], `아이디 변형 로그인 ${JSON.stringify(ok)}`);
      assert.equal(codes[5], 429, `대소문자 바꿔 6번 틀림 → ${codes}`);
      assert.equal(right, 429, "잠금 중인데 로그인됨");
      assert.equal(attrs.cap, "none", `휴대폰 자동 대문자 끄기 ${JSON.stringify(attrs)}`);
      assert.equal(attrs.spell, "false");
    } finally { await B.browser.close(); H.stop(api); }
  });
});

describe("외부 LLM 출력 계약", () => {
  T("Z04", "LLM이 2만 자 설명·영어 설명·HTML 태그/외부 링크를 돌려주면 승인자에게는 근거 기반 대체문(1,500자 이하·한국어·태그 없음)이 보이고 사유가 남음", async () => {
    const base = "http://localhost:8083";
    const api = await H.startApi(8083, LLM_ENV);
    const bad = [];
    const sizes = {};
    try {
      for (const m of ["long", "english", "html"]) {
        await fetch(`${LLM}/__mode`, { method: "POST", body: JSON.stringify({ mode: m }) });
        await call(base, "POST", "/api/reset");
        await waitJob(base, await call(base, "POST", "/api/events", { body: { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" } }));
        const raw = await (await call(base, "GET", "/api/snapshot")).text();
        sizes[m] = raw.length;
        const c = JSON.parse(raw).cases[0];
        const e = c.explanation || "";
        if (e.length > 1500) bad.push(`${m}: ${e.length}자`);
        if (!/[가-힣]/.test(e)) bad.push(`${m}: 한국어 아님`);
        if (/<\s*(script|img)|\]\(https?:/i.test(e)) bad.push(`${m}: 태그·외부 링크 그대로`);
        if (!/대체문/.test(String(c.llm))) bad.push(`${m}: 대체 표시 없음(${c.llm})`);
      }
      H.recordPerf("LLM 긴 응답 때 스냅샷 크기(자)", sizes.long, sizes);
      assert.deepEqual(bad, []);
      return { sizes: JSON.stringify(sizes) };
    } finally { H.stop(api); }
  });
});
