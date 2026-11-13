// 13차 E2E — 태블릿·작은 노트북 화면, 정책 근거 검색(RAG)의 정확도, 서버 재시작 중 진행하던 작업의 안내.
//   ① 1~12차는 1440px 데스크톱·휴대폰(390·320px)만 봤다 → 761~1180px(iPad 가로 1024, 세로 768, 작은 노트북)와 머리글 높이
//   ② 정책 근거 상위 4개에 '그 결정의 사유가 된 문서'가 들어 있는가(광고 규제 → 해당 법 조항, covenant 하회 → 차입 약정, 권한 → 권한표)
//   ③ 일괄 접수 직후 서버가 다시 시작되면(재배포) 화면이 무엇을 알려 주는가
const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("./helpers.cjs");

const KEY = "e2e-key";
const DIST_DOCKER = path.join(H.ROOT, "frontend", "dist-docker");
const results = [];
const T = (id, name, fn) => test(`${id} ${name}`, async () => {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ id, name, ok: true, ms: Date.now() - t0, ...(r || {}) }); }
  catch (e) { results.push({ id, name, ok: false, ms: Date.now() - t0, error: String(e.message).split("\n")[0] }); throw e; }
});
const call = (base, method, u, body) => fetch(`${base}${u}`, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const waitJob = async (base, r) => { const b = await r.json(); for (let i = 0; i < 400; i++) { const j = await (await call(base, "GET", `/api/jobs/${b.job_id}`)).json(); if (j.status === "done" || j.status === "failed") return j; await new Promise((x) => setTimeout(x, 25)); } throw new Error("job timeout"); };
after(() => H.writeReport("round13", { results }));

describe("태블릿·작은 노트북 화면", () => {
  const SIZES = [["iPad 가로 1024×768", { viewport: { width: 1024, height: 768 } }], ["iPad 세로", H.devices["iPad Mini"]], ["작은 노트북 1180×800", { viewport: { width: 1180, height: 800 } }],
    ["노트북 1280×800", { viewport: { width: 1280, height: 800 } }], ["데스크톱 1440×900", { viewport: { width: 1440, height: 900 } }]];
  T("Y01", "왼쪽(사건·처리 건)과 오른쪽(작업·감사 로그) 패널이 겹치지 않고, 머리글에 가리지 않으며, 두 패널의 모든 버튼을 누를 수 있음", async () => {
    const pv = await H.startPreview(4192);
    const problems = [];
    try {
      for (const [name, dev] of SIZES) {
        const B = await H.newPage({ ...dev }); const p = B.page;
        try {
          await H.fresh(p, "http://localhost:4192");
          await p.getByRole("button", { name: "확대 기안 25건 접수" }).click();
          await p.getByRole("button", { name: "전속계약 갱신 통보 접수" }).click();
          await p.locator('[data-testid="case-CT-INF001-2025"]').click();
          await p.locator('[data-testid="approve"]').click(); await p.waitForTimeout(200);   // 오른쪽에 작업 버튼이 생김
          const r = await p.evaluate(async () => {
            const out = { overlap: [], hidden: [], blocked: [] };
            const box = (s) => document.querySelector(s).getBoundingClientRect();
            const H = document.documentElement.scrollHeight;
            for (const y of [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round((H - innerHeight) * f))) {
              window.scrollTo(0, y); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
              const L = box(".left"), R = box(".right"), top = box(".top");
              const inter = Math.min(L.right, R.right) - Math.max(L.left, R.left) > 1 && Math.min(L.bottom, R.bottom) - Math.max(L.top, R.top) > 1;
              if (inter) out.overlap.push(y);
              const head = getComputedStyle(document.querySelector(".top")).position === "sticky" ? top.bottom : -1;
              for (const s of [".left", ".right"]) { const b = box(s); if (getComputedStyle(document.querySelector(s)).position === "sticky" && b.top < head - 1 && b.bottom > head) out.hidden.push(`${s}@${y}:${Math.round(head - b.top)}px`); }
            }
            for (const el of document.querySelectorAll(".left button, .left input, .right button, .right select")) {
              if (el.offsetParent === null || !el.checkVisibility() || el.closest("details:not([open])")) continue;   // 접힌 목록(완료된 기안 등)은 제외
              el.scrollIntoView({ block: "center" }); await new Promise((r) => requestAnimationFrame(r));
              const b = el.getBoundingClientRect(); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
              if (!(t === el || el.contains(t))) out.blocked.push(`${(el.textContent || el.placeholder || el.tagName).trim().slice(0, 14)}←${(t && (t.className || t.tagName)) || "없음"}`);
            }
            return out;
          });
          if (r.overlap.length) problems.push(`${name}: 패널 겹침(스크롤 ${r.overlap.join("/")})`);
          if (r.hidden.length) problems.push(`${name}: 머리글에 가림 ${r.hidden.slice(0, 2).join(", ")}`);
          if (r.blocked.length) problems.push(`${name}: 못 누르는 버튼 ${r.blocked.length}개(${r.blocked.slice(0, 2).join(", ")})`);
        } finally { await B.browser.close(); }
      }
      assert.deepEqual(problems, []);
    } finally { H.stop(pv); }
  });
});

describe("정책 근거 검색(RAG)의 정확도", () => {
  T("Y02", "정책 근거 상위 4개에 그 결정의 사유가 된 문서가 들어 있음(광고 규제 → 해당 법 조항, covenant 하회 → 차입 약정, 권한 판정 → 권한표)", async () => {
    const base = "http://localhost:8070";
    const api = await H.startApi(8070, {});
    try {
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "CONTRACT_RENEWAL_NOTICE", actor: "CONTRACT_OWNER" }));
      await waitJob(base, await call(base, "POST", "/api/events", { kind: "BUDGET_PLAN_BATCH", actor: "MARKETING_TEAM" }));
      const s = await (await call(base, "GET", "/api/snapshot")).json();
      const need = []; const miss = [];
      for (const c of s.cases.filter((x) => x.decision)) {
        const srcs = (c.policy_hits || []).map((h) => h.source);
        const reg = (c.validation || {}).regulation;
        const req = [["권한표", "approval_authority_policy"]];
        if (reg && reg.action !== "pass" && reg.law) req.push([`법 조항(${reg.law})`, `legal_kb:${reg.law}`]);
        if (c.decision.evidence.some((e) => /∈ covenant 하회 구간/.test(e.text))) req.push(["차입 약정(covenant)", "covenant_terms"]);
        for (const [label, key] of req) { need.push(label); if (!srcs.some((x) => x.includes(key))) miss.push(`${c.target_id}: ${label}`); }
      }
      const recall = 1 - miss.length / need.length;
      H.recordPerf("결정 사유 문서 재현율(recall@4)", Math.round(recall * 1000) / 10, { need: need.length, miss: miss.length });
      assert.deepEqual(miss, [], `사유 문서가 근거에 없음 ${miss.length}/${need.length}건 — 재현율 ${(recall * 100).toFixed(1)}%: ${miss.slice(0, 4).join(", ")}`);
      return { need: need.length };
    } finally { H.stop(api); }
  });
});

describe("서버 재시작 중 진행하던 작업", () => {
  T("Y03", "일괄 접수 직후 서버가 다시 시작돼 작업 기록이 사라져도, 화면은 '찾을 수 없음' 대신 재시작 사실과 결과 확인 방법을 알려 주고 목록을 갱신함", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aurora13-")), "desk.json");
    const env = { REPO: "memory", REPO_PATH: file, SERVE_FRONTEND: "1", FRONTEND_DIST: DIST_DOCKER, ALLOWED_ORIGINS: "" };
    let api = await H.startApi(8071, env);
    const B = await H.newPage(); const p = B.page;
    try {
      await p.goto("http://localhost:8071"); await p.waitForSelector(".top");
      await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForSelector(".top");
      await p.locator(".role select").nth(1).selectOption("api"); await p.waitForTimeout(600);
      let release; const held = new Promise((r) => (release = r)); let first = true;
      await p.route(/\/api\/jobs\//, async (route) => { if (first) { first = false; await held; } await route.continue(); });
      await p.getByRole("button", { name: "전속계약 갱신 통보 접수" }).click();
      await new Promise((r) => setTimeout(r, 800));                       // 서버에서는 접수가 끝남(파일에 저장)
      H.stop(api); await new Promise((r) => setTimeout(r, 500));
      api = await H.startApi(8071, env);                                  // 재배포·재시작 → 작업 기록(메모리)은 사라짐
      release();
      await p.locator(".toast.show").waitFor({ timeout: 8000 });
      const toast = await p.locator(".toast").innerText();
      await p.locator('[data-testid="case-CT-INF001-2025"]').waitFor({ timeout: 8000 }).catch(() => {});
      const listed = await p.locator('[data-testid="case-CT-INF001-2025"]').count();
      assert.doesNotMatch(toast, /작업을 찾을 수 없습니다/, `안내: ${toast}`);
      // v1.13: 재시작 사실을 안내. v1.14(AA-02)부터는 끝난 작업 결과가 저장소에 남아 실제 결과 문장을 그대로 보여 준다
      assert.match(toast, /다시 시작|분석 완료/, `안내: ${toast}`);
      assert.equal(listed, 1, "갱신 뒤 접수된 건이 목록에 없음");
    } finally { await B.browser.close(); H.stop(api); }
  });
});
