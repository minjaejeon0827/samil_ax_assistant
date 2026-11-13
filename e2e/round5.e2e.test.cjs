// 5차 E2E — 외부 의존성과 '처음 쓰는 사람'의 경로를 끝까지 확인한다.
//   외부 LLM(OpenAI 호환, 모의 서버로 정상·환각·장애·무응답·지연 재현), LLM이 판단을 바꾸지 못하는지,
//   승인자 화면의 설명문·판사 표시, 새 환경에서 E2E 도구 찾기, 데이터 재생성 재현성, 결재 서류 인쇄.
// 실제 키가 없으므로 LLM은 e2e/mock_llm.py(OpenAI 호환 /v1/chat/completions)로 대신한다.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const H = require("./helpers.cjs");

const LLM = "http://127.0.0.1:8900";
const API = "http://localhost:8000";          // LLM_PROVIDER=openai → 모의 LLM
const OFF = "http://localhost:8001";          // 오프라인(비교용)
const WEB_API = "http://localhost:4174";
const LOCAL = "http://localhost:4173";
const HDR = { "X-API-Key": "e2e-key", "Content-Type": "application/json" };
const LLM_ENV = { LLM_PROVIDER: "openai", OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `${LLM}/v1`, LLM_TIMEOUT_S: "3" };
let llm, api, off, web, webApi, B;
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0 }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const req = (base) => ({
  post: (u, body = {}) => fetch(`${base}${u}`, { method: "POST", headers: HDR, body: JSON.stringify(body) }),
  snap: async () => (await fetch(`${base}/api/snapshot`, { headers: HDR })).json(),
});
const A = req(API), O = req(OFF);
const mode = (m, latency = 0) => fetch(`${LLM}/__mode`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: m, latency }) });
const stats = async () => (await fetch(`${LLM}/__stats`)).json();
const waitJob = async (base, r, limitMs = 120000) => {
  const { job_id } = await r.json(); const end = Date.now() + limitMs;
  while (Date.now() < end) { const j = await (await fetch(`${base}/api/jobs/${job_id}`, { headers: HDR })).json(); if (j.status !== "queued" && j.status !== "running") return j; await new Promise((x) => setTimeout(x, 50)); }
  return { status: "timeout" };
};

before(async () => {
  const { spawn } = require("node:child_process");
  llm = spawn("python3", [path.join(__dirname, "mock_llm.py"), "8900"], { stdio: "ignore", detached: true });
  await H.waitHttp(`${LLM}/__stats`);
  api = await H.startApi(8000, LLM_ENV);
  off = await H.startApi(8001, { LLM_PROVIDER: "offline" });
  web = await H.startPreview(4173, "dist");
  webApi = await H.startPreview(4174, "dist-api");
  B = await H.newPage();
});
after(async () => {
  H.writeReport(process.env.E2E_REPORT || "round5", { suite: "round5", results });
  await B.browser.close(); H.stop(api); H.stop(off); H.stop(web); H.stop(webApi); H.stop(llm);
});

describe("외부 LLM 경로(OpenAI 호환)", () => {
  T("L01", "LLM이 정상이면 설명문과 판사가 LLM으로 동작하고, 처리 건이 결재로 올라감", async () => {
    await mode("ok"); await A.post("/api/reset");
    const j = await waitJob(API, await A.post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }));
    const c = (await A.snap()).cases[0];
    assert.equal(j.status, "done");
    assert.equal(c.state, "PENDING_APPROVAL");
    assert.equal(c.llm, "openai");
    assert.match(c.explanation, /사실 목록/);
  });
  T("L02", "LLM이 사실에 없는 금액을 지어내면(판사 LLM이 관대해도) 승인자에게 그 숫자가 보이지 않음", async () => {
    await mode("hallucinate"); await A.post("/api/reset");
    await waitJob(API, await A.post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }));
    const c = (await A.snap()).cases[0];
    assert.doesNotMatch(c.explanation, /37\.5억|99\.9%/, `설명문: ${c.explanation.slice(0, 80)}`);
    assert.ok(c.judge.faithfulness < 0.9 || /fallback|대체/.test(c.llm), `판사: ${JSON.stringify(c.judge)} / llm ${c.llm}`);
  });
  T("L03", "LLM 서버가 오류(500)를 내도 접수·판단은 끝나고, 설명문은 근거 기반 대체문으로", async () => {
    await mode("error"); await A.post("/api/reset");
    const j = await waitJob(API, await A.post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }));
    const s = await A.snap();
    assert.equal(j.status, "done", `작업 ${j.status}: ${j.message}`);
    assert.equal(s.cases[0]?.state, "PENDING_APPROVAL");
    assert.match(s.cases[0].llm, /대체|fallback/);
  });
  T("L04", "LLM 서버가 응답하지 않아도 접수가 10초 안에 끝나고, 이어지는 건은 기다리지 않음(시간 제한 + 회로 차단)", async () => {
    await mode("hang"); await A.post("/api/reset");
    const t0 = Date.now();
    const j = await waitJob(API, await A.post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }), 30000);
    const ms = Date.now() - t0;
    H.recordPerf("LLM 무응답 시 계약 접수", ms);
    const t1 = Date.now();
    const j2 = await waitJob(API, await A.post("/api/events", { kind: "BUDGET_PLAN_BATCH" }), 30000);   // 같은 장애 중 25건
    const ms2 = Date.now() - t1;
    H.recordPerf("LLM 무응답 중 기안 25건 접수", ms2);
    await mode("ok");
    assert.equal(j.status, "done", `작업 ${j.status}`);
    assert.ok(ms < 10000, `${ms}ms`);
    assert.equal(j2.status, "done"); assert.ok(ms2 < 3000, `장애 중 25건 ${ms2}ms`);
  });
  T("L05", "LLM 지연(호출당 0.5초)에서도 기안 25건 일괄 5초·조건 변경 3초 이내", async () => {
    await mode("ok", 0.5); await A.post("/api/reset");
    let t = Date.now(); const j = await waitJob(API, await A.post("/api/events", { kind: "BUDGET_PLAN_BATCH" })); const batch = Date.now() - t;
    const c1 = (await stats()).calls;
    t = Date.now(); await A.post("/api/conditions", { actor: "FINANCE", cash_assumption: "LEGACY45" }); const cond = Date.now() - t;
    const c2 = (await stats()).calls - c1;
    H.recordPerf("LLM 지연 0.5s: 기안 25건 일괄", batch, { llm_calls: c1 });
    H.recordPerf("LLM 지연 0.5s: 조건 변경 재검증", cond, { llm_calls: c2 });
    await mode("ok");
    assert.equal(j.status, "done");
    assert.ok(c1 >= 25, `LLM이 실제로 호출되지 않음(${c1}회)`);
    assert.ok(batch < 5000 && cond < 3000, `일괄 ${batch}ms(LLM ${c1}회) · 조건 변경 ${cond}ms(LLM ${c2}회)`);
  });
  T("L06", "LLM이 어떤 말을 해도 판단(권고·결재자·상태)은 오프라인 모드와 같음", async () => {
    await mode("hallucinate"); await A.post("/api/reset"); await O.post("/api/reset");
    for (const k of ["CONTRACT_RENEWAL_NOTICE", "BUDGET_PLAN_BATCH"]) { await waitJob(API, await A.post("/api/events", { kind: k })); await waitJob(OFF, await O.post("/api/events", { kind: k })); }
    const key = (s) => s.cases.map((c) => `${c.target_id}|${c.state}|${c.approval?.approver}|${c.decision?.recommendation}`).sort();
    const a = key(await A.snap()), b = key(await O.snap());
    await mode("ok");
    assert.deepEqual(a, b);
  });
  T("L07", "승인자 화면: 설명문을 누가 썼는지(LLM·대체문)와 판사 결과를 사실대로 표시", async () => {
    await mode("error"); await A.post("/api/reset");
    await waitJob(API, await A.post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }));
    const p = B.page;
    await p.goto(WEB_API); await p.waitForSelector(".top");
    await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(400);
    await p.locator('[data-testid="case-CT-INF001-2025"]').click();
    const txt = await p.locator('[data-testid="case-sheet"]').innerText();
    await mode("ok");
    assert.match(txt, /대체/, "LLM 실패로 대체문을 썼다는 표시가 없음");
  });
});

describe("처음 쓰는 사람의 경로", () => {
  T("C01", "새 환경(전역 NODE_PATH 없음)에서도 E2E 도구가 Playwright를 찾음", async () => {
    const env = { ...process.env }; delete env.NODE_PATH;
    const r = spawnSync("node", ["-e", "require('./e2e/helpers.cjs'); console.log('ok')"], { cwd: H.ROOT, env, encoding: "utf-8" });
    assert.equal(r.status, 0, (r.stderr || "").split("\n").find((l) => /Error/.test(l)) || r.stderr);
  });
  T("C02", "데이터 재생성(scripts/build_dataset.py)을 다시 돌려도 결과 파일이 바이트 단위로 같음", async () => {
    const files = ["frontend/src/data/dataset.json", "shared/parity_expected.json", "data/derived/campaign_contribution.csv", "data/derived/cash_reforecast_13w.csv", "data/derived/influencer_allocation.csv"];
    const before = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(H.ROOT, f))]));
    execFileSync("python3", ["scripts/build_dataset.py"], { cwd: H.ROOT, stdio: "ignore" });
    const changed = files.filter((f) => !before[f].equals(fs.readFileSync(path.join(H.ROOT, f))));
    for (const f of changed) fs.writeFileSync(path.join(H.ROOT, f), before[f]);   // 원래대로
    assert.deepEqual(changed, []);
  });
});

describe("결재 서류 인쇄", () => {
  T("P01", "결재 서류를 인쇄·PDF로 저장하면 서류만 나오고(메뉴·버튼·안내 제외) 2쪽 이내", async () => {
    const p = B.page;
    await H.fresh(p, LOCAL);
    await p.getByRole("button", { name: "전속계약 갱신 통보 접수", exact: true }).click();
    await p.locator('[data-testid="case-CT-INF001-2025"]').click();
    await p.emulateMedia({ media: "print" });
    const v = await p.evaluate(() => {
      const shown = (sel) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0; };
      return { left: shown(".left"), right: shown(".right"), top: shown(".top"), tabs: shown(".tabs"), decide: shown(".decide"), toast: shown(".toast.show"),
        sheetRatio: document.querySelector(".sheet").getBoundingClientRect().width / document.documentElement.clientWidth };
    });
    const pdf = path.join(os.tmpdir(), `aurora-sheet-${process.pid}.pdf`);
    await p.pdf({ path: pdf, format: "A4", printBackground: true });
    const pages = (fs.readFileSync(pdf, "latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    fs.rmSync(pdf, { force: true });
    await p.emulateMedia({ media: "screen" });
    H.recordPerf("결재 서류 인쇄 쪽수", pages, v);
    assert.deepEqual({ left: v.left, right: v.right, top: v.top, tabs: v.tabs, decide: v.decide, toast: v.toast }, { left: false, right: false, top: false, tabs: false, decide: false, toast: false });
    assert.ok(v.sheetRatio > 0.9, `서류 폭 ${Math.round(v.sheetRatio * 100)}%`);
    assert.ok(pages <= 2, `${pages}쪽`);
  });
});
