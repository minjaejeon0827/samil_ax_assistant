// 6차 E2E — 두 번째 LLM 제공자, 메신저(MCP) 채널의 원격 보안·입력 오류, 감사 로그 전체 열람,
//           오래 쓴 뒤의 사용성, 시뮬레이션 날짜 한계의 모드 간 일관성.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const H = require("./helpers.cjs");

const LLM = "http://127.0.0.1:8900";
const API = "http://localhost:8000";          // LLM_PROVIDER=anthropic → 모의 서버
const WEB_API = "http://localhost:4174";
const LOCAL = "http://localhost:4173";
const HDR = { "X-API-Key": "e2e-key", "Content-Type": "application/json" };
let llm, api, web, webApi, B;
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0 }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const post = (u, body = {}) => fetch(`${API}${u}`, { method: "POST", headers: HDR, body: JSON.stringify(body) });
const snap = async () => (await fetch(`${API}/api/snapshot`, { headers: HDR })).json();
const mode = (m) => fetch(`${LLM}/__mode`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: m }) });
const waitJob = async (r, limitMs = 60000) => { const { job_id } = await r.json(); const end = Date.now() + limitMs; while (Date.now() < end) { const j = await (await fetch(`${API}/api/jobs/${job_id}`, { headers: HDR })).json(); if (j.status !== "queued" && j.status !== "running") return j; await new Promise((x) => setTimeout(x, 40)); } return { status: "timeout" }; };
const mcpPy = (args, env = {}) => {
  const r = spawnSync("python3", [path.join(__dirname, "mcp_e2e6.py"), ...args], { encoding: "utf-8", timeout: 90000, env: { ...process.env, ...env } });
  const line = (r.stdout || "").trim().split("\n").pop() || "{}";
  try { return JSON.parse(line); } catch { return { error: (r.stderr || r.stdout || "").slice(-300) }; }
};

before(async () => {
  llm = spawn("python3", [path.join(__dirname, "mock_llm.py"), "8900"], { stdio: "ignore", detached: true });
  await H.waitHttp(`${LLM}/__stats`);
  api = await H.startApi(8000, { LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "mock-key", ANTHROPIC_BASE_URL: LLM, LLM_TIMEOUT_S: "3" });
  web = await H.startPreview(4173, "dist");
  webApi = await H.startPreview(4174, "dist-api");
  B = await H.newPage();
});
after(async () => {
  H.writeReport(process.env.E2E_REPORT || "round6", { suite: "round6", results });
  await B.browser.close(); H.stop(api); H.stop(web); H.stop(webApi); H.stop(llm);
});

describe("두 번째 LLM 제공자(Anthropic 호환)", () => {
  for (const [id, m, check] of [
    ["A01", "ok", (c) => { assert.equal(c.llm, "anthropic"); assert.match(c.judge.judge, /anthropic/); }],
    ["A02", "hallucinate", (c) => { assert.doesNotMatch(c.explanation, /37\.5|99\.9/); assert.match(c.llm, /대체문/); }],
    ["A03", "error", (c) => { assert.match(c.llm, /대체문/); }],
    ["A04", "hang", (c) => { assert.match(c.llm, /대체문/); }],
  ]) {
    T(id, `Anthropic ${m}: 판단·결재는 그대로, 승인자에게 근거 없는 수치 없음, 10초 안에 끝남`, async () => {
      await mode(m); await post("/api/reset");
      const t0 = Date.now();
      const j = await waitJob(await post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }), 30000);
      const ms = Date.now() - t0;
      const c = (await snap()).cases[0];
      await mode("ok");
      assert.equal(j.status, "done", `작업 ${j.status} ${j.message || ""}`);
      assert.equal(c.state, "PENDING_APPROVAL");
      assert.ok(ms < 10000, `${ms}ms`);
      check(c);
    });
  }
});

describe("메신저 채널(MCP) — 원격 보안과 입력 오류", () => {
  T("N01", "외부에 여는 원격 MCP(0.0.0.0)는 접근 토큰 없이 시작하지 않음(승인 도구가 무방비로 열리지 않음)", async () => {
    const r = spawnSync("python3", ["-m", "app.mcp_server"], { cwd: path.join(H.ROOT, "backend"), encoding: "utf-8", timeout: 8000,
      env: { ...process.env, MCP_TRANSPORT: "streamable-http", MCP_HOST: "0.0.0.0", MCP_PORT: "8766", MCP_TOKEN: "", DESK_API_URL: API, DESK_API_KEY: "e2e-key" } });
    const out = (r.stdout || "") + (r.stderr || "");
    assert.ok(r.status !== null && r.status !== 0, `토큰 없이 시작됨(종료 코드 ${r.status}, 시간 초과=${r.error?.code === "ETIMEDOUT"})`);
    assert.match(out, /MCP_TOKEN/);
  });
  T("N02", "토큰을 둔 원격 MCP: 토큰 없는 요청은 401, 토큰이 있으면 승인 대기 조회 동작", async () => {
    await post("/api/reset"); await waitJob(await post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }));
    const j = mcpPy(["remote", API, "e2e-key"]);
    assert.equal(j.error ?? null, null, j.error);
    assert.equal(j.no_token_status, 401, `토큰 없이 응답 ${j.no_token_status}`);
    assert.match(j.pending || "", /CS-\d{4} \| INF-001/);
  });
  T("N03", "MCP 도구에 잘못된 값(행동·역할·사건 종류·회신 종류)을 넣으면 한국어로 무엇이 틀렸는지와 허용 값을 안내", async () => {
    const j = mcpPy(["inputs", API, "e2e-key"]);
    const bad = Object.entries(j).filter(([, v]) => /literal_error|Input should|\{'type'/.test(String(v)) || !/허용|가능한 값/.test(String(v)));
    assert.deepEqual(bad, [], bad.map(([k, v]) => `${k}: ${String(v).slice(0, 90)}`).join(" | "));
  });
  T("N04", "MCP에 이상한 건 ID('../snapshot' 등)를 넣어도 다른 API를 부르거나 멈추지 않고 형식 오류로 안내", async () => {
    const j = mcpPy(["ids", API, "e2e-key"]);
    const bad = Object.entries(j).filter(([, v]) => !/형식/.test(String(v)));
    assert.deepEqual(bad, [], bad.map(([k, v]) => `${k}: ${String(v).slice(0, 90)}`).join(" | "));
  });
});

describe("감사 로그·장기 사용·날짜 한계", () => {
  T("K01", "감사 로그가 200건을 넘어도 가장 오래된 기록까지 화면에서 찾아 볼 수 있음(서버 모드)", async () => {
    await post("/api/reset");
    await waitJob(await post("/api/events", { kind: "CONTRACT_RENEWAL_NOTICE" }));
    await waitJob(await post("/api/events", { kind: "BUDGET_PLAN_BATCH" }));
    for (let i = 0; i < 6; i++) await post("/api/conditions", { actor: "FINANCE", cash_assumption: ["CONSERVATIVE", "AS_IS", "LEGACY45"][i % 3] });
    const s = await snap();
    assert.ok(s.audit_total > 200, `감사 ${s.audit_total}건`);
    const first = (await (await fetch(`${API}/api/audit?offset=0&limit=5`, { headers: HDR })).json().catch(() => ({})));
    const p = B.page;
    await p.goto(WEB_API); await p.waitForSelector(".top"); await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(400);
    await p.locator('[data-testid="audit-all"]').click();
    await p.locator('[data-testid="audit-search"]').fill("CS-0001");
    await p.waitForTimeout(500);
    const txt = await p.locator('[data-testid="audit-results"]').innerText();
    assert.equal(first.total, s.audit_total, "전체 감사 로그 API 없음");
    // v1.25: '처음부터'가 지운 사실을 첫 감사 기록(desk.reset)으로 남기므로, 그다음 기록이 가장 오래된 업무 기록
    assert.match(first.items?.find((a) => a.topic !== "desk.reset")?.detail || "", /갱신 통보/);
    assert.match(txt, /갱신 통보/, "가장 오래된 기록(CS-0001 접수)을 화면에서 찾을 수 없음");
  });
  T("K02", "메모 500건이 쌓여도 결정할 기안이 목록 위쪽에 보이고, 클릭 반응 100ms·저장 크기 2MB 이내(브라우저 모드)", async () => {
    const C = await H.newPage();
    const p = C.page;
    await H.fresh(p, LOCAL);
    await p.getByRole("button", { name: "전속계약 갱신 통보 접수", exact: true }).click();
    await p.getByRole("button", { name: "확대 기안 25건 접수", exact: true }).click();
    // 메모 500건을 화면과 같은 명령으로 빠르게 쌓는다(입력창을 500번 쓰는 대신 저장된 상태에 바로 적용)
    await p.evaluate(() => { const k = "aurora-desk-state"; const s = JSON.parse(localStorage.getItem(k)); let seq = s.seq.case;
      for (let i = 0; i < 500; i++) { seq++; const id = `CS-${String(seq).padStart(4, "0")}`; s.cases[id] = { id, type: "MEMO", kind: "FREE_TEXT", target_id: "MEMO", title: "자유 입력 메모", event_text: `현장 메모 ${i}`, received_on: s.ctx.today, state: "RECEIVED", history: [], version: 1 };
        s.audit.push({ id: `AU-${s.seq.audit + i + 1}`, topic: "case.received", sim_date: s.ctx.today, actor: "SYSTEM", detail: `자유 입력 메모 ${i}`, case_id: id }); }
      s.seq.case = seq; s.seq.audit += 500; localStorage.setItem(k, JSON.stringify(s)); });
    await p.reload(); await p.waitForSelector(".top");
    const y = await p.evaluate(() => { const h = [...document.querySelectorAll(".cases h2")].find((e) => e.textContent.includes("결정이 필요한 기안")); return h ? h.getBoundingClientRect().top + document.querySelector(".left").scrollTop : 1e9; });
    const ms = await H.clickTimed(p, p.getByRole("button", { name: "하루 진행", exact: true }), "메모 500건 후 하루 진행");
    const size = await p.evaluate(() => localStorage.getItem("aurora-desk-state").length);
    H.recordPerf("메모 500건 후 '결정이 필요한 기안' 위치(px)", y, { state_chars: size });
    await C.browser.close();
    assert.ok(y < 1200, `결정할 기안 목록이 ${Math.round(y)}px 아래에 있음(메모에 묻힘)`);
    assert.ok(ms < 100, `${ms}ms`); assert.ok(size < 2_000_000, `${size}`);
  });
  T("D01", "시뮬레이션 날짜 한계(2027-06-30)를 브라우저 모드도 서버와 똑같이 지키고, 이유를 알려 줌", async () => {
    const p = B.page;
    await H.fresh(p, LOCAL);
    await p.evaluate(() => { const k = "aurora-desk-state"; const s = JSON.parse(localStorage.getItem(k) || "null"); if (!s) return; s.ctx.today = "2027-06-30"; localStorage.setItem(k, JSON.stringify(s)); });
    await p.getByRole("button", { name: "전속계약 갱신 통보 접수", exact: true }).click();   // 상태 저장 유도
    await p.evaluate(() => { const k = "aurora-desk-state"; const s = JSON.parse(localStorage.getItem(k)); s.ctx.today = "2027-06-30"; localStorage.setItem(k, JSON.stringify(s)); });
    await p.reload(); await p.waitForSelector(".top");
    const dayBtn = p.getByRole("button", { name: "하루 진행", exact: true });
    const disabled = await dayBtn.isDisabled();
    if (!disabled) await dayBtn.click();
    const today = await p.locator(".clock b").innerText();
    const r = await post("/api/clock", { to: "2027-07-01" });
    assert.equal(r.status, 422);
    assert.equal(today, "6월 30일", `브라우저 모드가 한계를 넘어 ${today}로 진행`);
    assert.ok(disabled || /범위|까지/.test(await p.locator(".toast").innerText()), "한계 안내 없음");
  });
});
