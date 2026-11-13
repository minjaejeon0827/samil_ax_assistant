// 시연 영상 2부(v1.21~v1.24, PRD §15 다음 단계) — 서버 모드: 사내 SSO 로그인 → 계약서 업로드(LLM 요약) → 조항 추출·자동 확인 → 같은 엔진의 결재
// → 요약 평가 → 결재 뒤 AI 설명 보관함 → 실패한 전자결재 전송 다시 보내기 → 외화 계약의 확인한 값 넣기 → 11쪽 스캔 진행 표시 → IdP가 먼저 끊는 로그아웃.
// 24차: 자막마다 AI 음성 해설(demo/narration_src.json → demo/tts.py → encode.sh가 MP4에 넣음).
// 28차(기능 고정): 장면은 그대로, 끝 자막의 E2E 수만 바꿈(감사 기록의 머리값 문구는 '→ 메신저 전송 요청').
// 27차: 운영 DB 장면을 화면의 '체인 검증' 버튼으로(v1.27), 머리값 정기 기록(AUDIT_ANCHOR_S=20), 5분 미만을 지키려고 모의 LLM 지연 4→2·12→11초(설명이 결재 뒤에 도착해야 보관함 장면이 됨).
// 26차: 운영 DB 장면에 트리거 우회 → 해시 체인 검증을 더하고, 5분 미만을 지키려고 '적대적 파일' 자막을 스캔 장면에 합침.
// 25차: 2부는 운영 DB(MariaDB, REPO=mysql)로 돌리고, 끝에 실제 SQL 결과(감사 기록 보호 트리거·보기·쓰기 중 백업 → 복구)를 보여 준다.
// 사용: node demo/record_next.cjs  (스스로 모의 IdP·API 서버(dist-docker)를 띄우고 끈다) → bash demo/encode.sh 가 1부 뒤에 붙인다.
const path = require("path");
const fs = require("fs");
const { spawn, execFileSync } = require("child_process");
const { chromium } = require(require.resolve("playwright", { paths: [__dirname, path.resolve(__dirname, "..", "frontend")] }));

const ROOT = path.resolve(__dirname, "..");
const OUT = path.resolve(__dirname, "raw", "next");
const PORT = 8181, IDP = 8952, LLM = 8954, ESIGN = 8964, DBP = 3341;
const BASE = `http://localhost:${PORT}`;
const LONG_SCAN = path.resolve(__dirname, "raw", "long_scan_11p.pdf");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitHttp(u) { for (let i = 0; i < 100; i++) { try { if ((await fetch(u)).ok) return; } catch { /* not yet */ } await sleep(150); } throw new Error(`no ${u}`); }

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  // v1.23 장면용 11쪽 흑백 스캔(본문 + 부속서 9쪽 + 마지막 쪽 위약금) — e2e/round23과 같은 방식
  const src = fs.readFileSync(path.join(ROOT, "data", "samples", "contracts", "logistics_3pl_renewal.md"), "utf8").split("\n");
  const filler = Array.from({ length: 230 }, (_, i) => `부속서 A-${String(i + 1).padStart(3, "0")}. 창고 운영 서비스 수준 항목 ${i + 1}: 입고 검수, 보관 온도 기록, 출고 정확도 점검을 매일 기록한다.`);
  fs.writeFileSync(path.join(OUT, "long.md"), [...src.filter((l) => !/위약/.test(l)), "", "## 부속서 A(서비스 수준)", ...filler, "", "## 해지", ...src.filter((l) => /위약/.test(l))].join("\n"));
  require("child_process").execFileSync("python3", [path.join(ROOT, "e2e", "make_scanned_pdf.py"), path.join(OUT, "long.md"), LONG_SCAN]);
  const db = await require(path.join(ROOT, "e2e", "helpers.cjs")).startMariaDB(DBP);   // 25차: 운영 DB로 시연
  if (!db) throw new Error("mariadbd 없음 — 2부는 운영 DB(MariaDB/MySQL)로 녹화합니다");
  const SOCK = `/tmp/aurora-e2e-${DBP}.sock`;
  const asApp = (q) => { try { execFileSync("mariadb", ["-uaurora", "-pe2e-pass", "-h127.0.0.1", `-P${DBP}`, "--default-character-set=utf8mb4", "aurora_desk", "-e", q], { stdio: "pipe" }); return "Query OK"; } catch (e) { return String(e.stderr).trim(); } };
  const idp = spawn("python3", [path.join(ROOT, "e2e", "mock_oidc.py"), String(IDP), "aurora-desk", "oidc-secret"], { stdio: "ignore", detached: true });
  const llm = spawn("python3", [path.join(ROOT, "e2e", "mock_llm.py"), String(LLM)], { stdio: "ignore", detached: true });
  const esign = spawn("python3", [path.join(ROOT, "e2e", "mock_eapproval.py"), String(ESIGN), "demo-channel-secret-0123456789abcdef"], { stdio: "ignore", detached: true });
  const ctl = (port, body) => fetch(`http://127.0.0.1:${port}/__mode`, { method: "POST", body: JSON.stringify(body) });
  const api = spawn("python3", ["-m", "uvicorn", "app.main:app", "--port", String(PORT), "--log-level", "warning"], {
    cwd: path.join(ROOT, "backend"), stdio: "ignore", detached: true,
    env: { ...process.env, ...db.env, AUDIT_ANCHOR_S: "20", API_KEYS: "e2e-key", AUTH_MODE: "jwt", JWT_SECRET: "demo-secret-0123456789abcdef", USERS: "contract.choi:pw-co:CONTRACT_OWNER",
      OIDC_ISSUER: `http://127.0.0.1:${IDP}`, OIDC_CLIENT_ID: "aurora-desk", OIDC_CLIENT_SECRET: "oidc-secret", OIDC_REDIRECT_URI: `${BASE}/`, OIDC_LABEL: "사내 SSO",
      LLM_PROVIDER: "openai", OPENAI_API_KEY: "mock-key", OPENAI_BASE_URL: `http://127.0.0.1:${LLM}/v1`, LLM_TIMEOUT_S: "12",
      CHANNEL: "webhook", CHANNEL_SECRET: "demo-channel-secret-0123456789abcdef", ESIGN_WEBHOOK_URL: `http://127.0.0.1:${ESIGN}/hooks/approval`, CHANNEL_BACKOFF_S: "0.1,0.1,0.1",
      SERVE_FRONTEND: "1", FRONTEND_DIST: path.join(ROOT, "frontend", "dist-docker"), ALLOWED_ORIGINS: "" } });
  try {
    await waitHttp(`http://127.0.0.1:${IDP}/jwks`); await waitHttp(`http://127.0.0.1:${LLM}/__stats`); await waitHttp(`http://127.0.0.1:${ESIGN}/__received`); await waitHttp(`${BASE}/api/health`);
    await ctl(LLM, { mode: "ok", latency: 2 }); await ctl(ESIGN, { fail: 100 });   // LLM은 느리게(요약·설명 '작성 중'), 전자결재는 장애 중
    await fetch(`http://127.0.0.1:${IDP}/__user`, { method: "POST", body: JSON.stringify({ sub: "u-1001", preferred_username: "kim.ceo@aurora.example", aurora_role: "GROUP_CEO" }) });
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } });
    const p = await ctx.newPage();
    p.on("dialog", (d) => d.accept());
    const wait = (ms) => p.waitForTimeout(ms);
    const { caption, save } = require("./narrate.cjs").makeCaption(p, "part2", { pointerEvents: "none" });   // 24차: AI 음성 해설
    await p.goto(BASE); await p.waitForSelector(".top");
    await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await p.reload(); await p.waitForSelector(".top");
    await p.locator(".role select").nth(1).selectOption("api"); await wait(700);
    await caption("2부 — 사내 SSO 로그인", "서버 모드 로그인 창의 '사내 SSO로 로그인'. 인가 코드 + PKCE, IdP 공개키(JWKS)로 서명·대상·만료·nonce를 검증하고 역할은 IdP가 정합니다.");
    await p.locator('[data-testid="login-sso"]').click();
    await p.locator('[data-testid="whoami"]').waitFor({ timeout: 10000 }); await wait(500);
    await caption("SSO 계정으로 로그인", "kim.ceo@aurora.example · 그룹 CEO/이사회 · SSO. 주소창의 인가 코드는 바로 지우고 감사 기록에 남깁니다.");
    await p.locator("#contract-file").scrollIntoViewIfNeeded();
    await caption("계약서 업로드 → 조항 추출", "광고 대행 계약서(합성 견본). 조항을 나눠 검색(BM25)하고 규칙으로 기간·통보 기한·금액·지급·위약금을 뽑습니다.");
    await p.locator('[data-testid="contract-file"]').setInputFiles(path.join(ROOT, "data", "samples", "contracts", "agency_media_renewal.md"));
    await caption("LLM이 계약서 요약을 씁니다", "값은 계속 규칙이 뽑고, LLM에는 추출값과 조항 인용만 줍니다. 추출값에 없는 숫자가 있으면 판사가 버립니다.");
    await p.locator(".cases h2", { hasText: "다른 자동 갱신 계약" }).waitFor({ timeout: 20000 }); await wait(500);
    await ctl(LLM, { mode: "ok", latency: 11 });   // 판사 호출을 느리게 → AI 설명이 '작성 중'인 동안 결재
    await p.locator(".cases .case-item", { hasText: "블루웨이브미디어" }).click(); await wait(700);
    await p.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })); await wait(500);
    await caption("같은 판단 엔진", "연 10.8억, 갱신일 선급(8/1)이 covenant 하회 구간 안 → 그룹 CEO. 근거마다 조항 번호. AI 설명은 '작성 중'이지만 판단·결재란은 확정.");
    await p.locator("#cmt").fill("위약금·선급 재협상 — 조건변경 통보"); await wait(300);
    await p.locator('[data-testid="approve"]').click(); await wait(1000);
    await caption("결재 → 통보 작업", "AI 설명이 '작성 중'일 때 승인했습니다. 결재 서류에는 결재한 사람이 본 근거 기반 설명이 그대로 남습니다.");
    await p.evaluate(() => document.querySelector('[data-testid="contract-checks"]')?.scrollIntoView({ behavior: "smooth", block: "center" })); await wait(700);
    await caption("위약금·지급 조건 자동 확인", "위약금 60%·선급 50%는 위험, 통보 기한 7/17 D-16. 연락처·계좌는 가리고, 못 찾은 값은 '확인 필요'로 남깁니다.");
    await p.evaluate(() => document.querySelector('[data-testid="contract-summary"]')?.scrollIntoView({ behavior: "smooth", block: "center" })); await wait(600);
    await p.locator('[data-testid="summary-up"]').click().catch(() => {}); await wait(500);
    await caption("요약 평가(v1.24)", "LLM 요약은 참고용 — 결재자가 '도움됨·부정확함'(사유)을 누르면 한 사람 한 표로 쌓이고 LLM별 도움 비율로 집계됩니다.");
    await p.locator('[data-testid="explain-archive"]').waitFor({ timeout: 40000 });
    await p.evaluate(() => { const d = document.querySelector('[data-testid="explain-archive"]'); if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "center" }); } }); await wait(600);
    await caption("결재 뒤 AI 설명 보관함", "결재 뒤 도착한 AI 설명은 서류를 바꾸지 않고 보관함에 남습니다 — 누가 언제 결재한 뒤 왔는지, 판사 점수와 함께.");
    await p.locator('[data-testid="deliveries"] [data-testid^="redeliver-"]').first().waitFor({ timeout: 15000 });
    await p.evaluate(() => document.querySelector('[data-testid="deliveries"]')?.scrollIntoView({ behavior: "smooth", block: "start" })); await wait(600);
    await caption("실패한 전자결재 전송", "전자결재 장애로 결재 요청·종료가 실패했습니다. 실패한 전송은 '외부 채널 전송' 맨 앞에 보입니다.");
    await ctl(ESIGN, { fail: 0 });
    const eids = await p.locator('[data-testid="deliveries"] [data-testid^="redeliver-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid").slice(10)));
    for (const id of eids) { await p.locator(`[data-testid="redeliver-${id}"]`).click(); await wait(400); }
    await caption("복구 → 다시 보내기", "같은 이벤트 번호로 다시 보냅니다(받는 쪽이 중복을 거름). 여럿이 동시에 눌러도 한 번만 보냅니다.");
    // 외화 계약 → 확인 필요 → 확인한 값 넣기(v1.23 외화 표시 · v1.24 끝맺음)
    await ctl(LLM, { mode: "ok", latency: 0 });
    await p.locator("#contract-file").scrollIntoViewIfNeeded();
    await p.locator('[data-testid="contract-file"]').setInputFiles(path.join(ROOT, "data", "samples", "contracts", "variants", "freight_en_usd.md"));
    await p.locator(".cases .case-item", { hasText: "Pacific" }).waitFor({ timeout: 15000 }); await wait(400);
    await p.locator(".cases .case-item", { hasText: "Pacific" }).click(); await wait(700);
    await p.evaluate(() => document.querySelector('[data-testid="contract-checks"]')?.scrollIntoView({ behavior: "smooth", block: "center" })); await wait(600);
    await caption("외화 계약 — 확인 필요", "영문 USD 계약(합성). 외화는 원화로 바꾸지 않고 '확인 필요'로 멈춥니다. 갱신 조항을 못 찾아도 '없음'으로 단정하지 않습니다.");
    await p.evaluate(() => document.querySelector('[data-testid="contract-facts"]')?.scrollIntoView({ behavior: "smooth", block: "center" })); await wait(500);
    await p.locator('[data-testid="facts-fee"]').fill("1324800000"); await wait(200);
    await p.locator('[data-testid="facts-note"]').fill("USD 80,000 × 12 × 1,380원(재무팀 7/1 환율)"); await wait(300);
    await caption("확인한 값 넣기(v1.24)", "재무팀·계약 담당·그룹 CEO가 확인한 값을 넣으면 '사람 입력'(누가·언제·근거)으로 남고 다시 판단해 결재로 올라갑니다.");
    await p.locator('[data-testid="facts-save"]').click(); await wait(1200);
    await p.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })); await wait(500);
    // v1.23 스캔 PDF 11쪽 — 업로드 즉시 접수, 진행 표시
    await p.locator("#contract-file").scrollIntoViewIfNeeded();
    await p.locator('[data-testid="contract-file"]').setInputFiles(LONG_SCAN);
    await p.locator('[data-testid="intaking"]', { hasText: "글자 인식" }).waitFor({ timeout: 8000 }).catch(() => {});
    await p.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })); await wait(300);
    // 26차: 5분 미만을 지키려고 '적대적 파일 막기' 자막을 이 장면에 합침(해설 1줄 줄임)
    await caption("11쪽 스캔 계약서", "글자 인식은 업로드 응답을 기다리게 하지 않고 '글자 인식 중 n/11쪽'을 보여 줍니다. 서버가 여러 대여도 진행이 보입니다. 8KB짜리 초대형 페이지 PDF는 그리기 전에 거절합니다.");
    // v1.25 운영 DB — 화면 위에 실제 SQL 결과(명령과 결과 행 그대로)를 띄운다. 표는 칸 맞춤이 깨지지 않게 HTML 표로.
    const panel = (title, blocks) => p.evaluate(([t, bl]) => {
      let el = document.getElementById("demo-sql");
      if (!el) {
        el = document.createElement("div"); el.id = "demo-sql";
        Object.assign(el.style, { position: "fixed", right: "18px", top: "64px", zIndex: 98, width: "820px", maxHeight: "650px", overflow: "hidden", background: "#13202b",
          color: "#d8e6ef", padding: "14px 18px 16px", borderRadius: "4px", font: "13px/1.55 'IBM Plex Mono', ui-monospace, monospace", boxShadow: "0 4px 18px rgba(0,0,0,.35)", pointerEvents: "none" });
        document.body.appendChild(el);
      }
      el.replaceChildren();
      const h = document.createElement("div"); h.textContent = t; Object.assign(h.style, { font: "600 15px 'IBM Plex Sans KR', sans-serif", color: "#9fc3d9", marginBottom: "10px" });
      el.append(h);
      for (const b of bl) {
        if (b.rows) {
          const tb = document.createElement("table"); Object.assign(tb.style, { borderCollapse: "collapse", margin: "4px 0 10px", font: "13px/1.4 'IBM Plex Sans KR', sans-serif" });
          b.rows.forEach((r, ri) => { const tr = tb.insertRow(); r.forEach((c) => { const td = tr.insertCell(); td.textContent = c;
            Object.assign(td.style, { border: "1px solid #3a5163", padding: "3px 10px", color: ri ? "#e8f1f6" : "#9fc3d9", fontWeight: ri ? "400" : "600", textAlign: /^\d+$/.test(c) ? "right" : "left" }); }); });
          el.append(tb);
        } else {
          const d = document.createElement("div"); d.textContent = b.s; Object.assign(d.style, { whiteSpace: "pre-wrap", color: b.err ? "#ffb4a8" : b.dim ? "#93a9b8" : "#d8e6ef" }); el.append(d);
        }
      }
    }, [title, blocks]);
    const rows = (q, dbn = "aurora_desk") => execFileSync("mariadb", ["-uroot", `--socket=${SOCK}`, "--default-character-set=utf8mb4", "-B", dbn, "-e", q], { encoding: "utf8" }).trim().split("\n").map((l) => l.split("\t"));
    const errLine = (out) => out.split("\n").filter((l) => /^ERROR/.test(l)).map((l) => l.replace(/ at line \d+/, "")).join("\n") || out;
    const aid = rows("SELECT id FROM audit ORDER BY seq LIMIT 1")[1][0];
    const tamper = `UPDATE audit SET doc=JSON_SET(doc,'$.detail','조작') WHERE id='${aid}';`, del = `DELETE FROM audit WHERE id='${aid}';`;
    // v1.26: 앱 계정 비밀번호로 트리거를 우회해 중간 기록 하나를 지우면 → 해시 체인 검증이 그 자리를 짚는다
    const vid = rows("SELECT id FROM audit ORDER BY seq LIMIT 1 OFFSET 4")[1][0];
    const bypass = `SET @aurora_reset = 1; DELETE FROM audit WHERE id='${vid}';`;
    const bypassOut = asApp(bypass);
    await panel("운영 DB(MariaDB) — 앱 계정으로 감사 기록을 고치거나 지우려 하면", [
      { s: `mysql> ${tamper}` }, { s: errLine(asApp(tamper)), err: true },
      { s: `mysql> ${del}` }, { s: errLine(asApp(del)), err: true }, { s: " " },
      { s: `-- 앱 계정 비밀번호로 트리거를 우회하면\nmysql> ${bypass}` }, { s: bypassOut === "Query OK" ? "Query OK, 1 row affected" : errLine(bypassOut), dim: true }, { s: " " },
      { s: "mysql> SELECT id, type, state, approver FROM v_cases ORDER BY seq;" }, { rows: rows("SELECT id, type, state, approver FROM v_cases ORDER BY seq") }]);
    await caption("운영 DB — 감사 기록 보호(v1.25·v1.26)", "2부는 운영 DB(MariaDB)로 돌았습니다. 트리거가 감사 기록의 UPDATE·DELETE를 거부합니다. 앱 계정 비밀번호로 우회해 중간 기록을 지우면?");
    // v1.27: 감사 담당이 화면의 '체인 검증' 버튼으로 — 지운 자리를 짚고, 머리값은 AUDIT_ANCHOR_S마다 메신저로 나가 있다
    await p.evaluate(() => document.getElementById("demo-sql")?.remove());
    await p.evaluate(() => document.querySelector("section.audit")?.scrollIntoView({ behavior: "smooth", block: "center" })); await wait(500);
    await p.locator('[data-testid="audit-verify"]').click();
    await p.locator('[data-testid="audit-verify-result"]', { hasText: /이상|이상 없음/ }).waitFor({ timeout: 8000 });
    await p.evaluate(() => { const el = document.querySelector('[data-testid="audit-verify-result"]'); if (el) Object.assign(el.style, { outline: "3px solid #e0a300", outlineOffset: "3px" }); });
    await caption("화면에서 체인 검증 · 머리값(v1.27)", "감사 담당이 '체인 검증'을 누르면 해시 체인이 지운 자리를 짚습니다. 머리값은 정기적으로 메신저에 보내 두어, 체인을 통째로 다시 계산한 위조도 드러납니다.");
    const t0 = Date.now();
    const dump = execFileSync("mariadb-dump", ["-uroot", `--socket=${SOCK}`, "--single-transaction", "--routines", "--triggers", "aurora_desk"], { maxBuffer: 1 << 28 });
    const dumpMs = Date.now() - t0;
    execFileSync("mariadb", ["-uroot", `--socket=${SOCK}`, "-e", "CREATE DATABASE aurora_restore CHARACTER SET utf8mb4"]);
    execFileSync("mariadb", ["-uroot", `--socket=${SOCK}`, "aurora_restore"], { input: dump });
    const health = await (await fetch(`${BASE}/api/health`)).json();
    await panel("백업 → 새 DB로 복구 → 확인", [
      { s: "$ mariadb-dump --single-transaction --routines --triggers aurora_desk > backup.sql" },
      { s: `  ${(dump.length / 1024).toFixed(0)}KB · ${dumpMs}ms — 잠그지 않는 백업(서버는 계속 씀)`, dim: true },
      { s: "$ mariadb aurora_restore < backup.sql" }, { s: " " },
      { s: "mysql> SELECT 건수 FROM aurora_restore;   -- 관리자 계정, 앱 계정 권한을 주기 전" },
      { rows: rows("SELECT (SELECT COUNT(*) FROM cases) AS 처리건, (SELECT COUNT(*) FROM tasks) AS 작업, (SELECT COUNT(*) FROM audit) AS 감사기록, (SELECT COUNT(*) FROM renewals) AS 계약기록, (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='aurora_restore') AS 트리거, (SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA='aurora_restore') AS 보기", "aurora_restore") },
      { s: "mysql> SELECT counterparty, annual_fee_krw, status FROM v_renewals;" },
      { rows: rows("SELECT counterparty, annual_fee_krw, status FROM v_renewals ORDER BY seq", "aurora_restore") },
      { s: `GET /api/health → 지금까지 맺은 DB 연결 ${health.db.opened}개 · 쉬는 연결 ${health.db.idle}개 · 트리거·보기 ${Object.values(health.db.guards).filter(Boolean).length}/${Object.keys(health.db.guards).length}`, dim: true }]);
    await caption("운영 DB — 백업과 복구", "서버가 쓰는 중에도 잠그지 않고 백업하고, 새 DB로 복구하면 트리거·보기까지 살아 있습니다. 연결은 풀에서 재사용합니다.");
    await p.evaluate(() => document.getElementById("demo-sql")?.remove());
    // v1.23 IdP가 먼저 끊는 로그아웃(Back-Channel)
    await caption("IdP가 먼저 로그아웃시키면", "퇴사·계정 잠금처럼 사내 SSO가 먼저 로그아웃을 알리면 이 시스템의 그 사람 로그인도 모두 끊깁니다.");
    await fetch(`http://127.0.0.1:${IDP}/__backchannel`, { method: "POST", body: JSON.stringify({ to: `${BASE}/api/auth/oidc/backchannel`, sub: "u-1001", no_sid: true }) });
    await p.locator('[data-testid="login-sso"]').waitFor({ timeout: 10000 }); await wait(800);
    await caption("끝 — v1.21~v1.28", "SSO·백채널 로그아웃 · 전자결재 다시 보내기 · 계약서 추출(스캔·영문·문구 변형)·LLM 요약과 평가 · 확인 필요의 끝맺음 · 토큰 한도 · 운영 DB(연결 풀·정규화·트리거·보기·백업 복구·위변조 탐지·머리값). v1.28은 기능 고정 — E2E 275개 통과.");
    save();
    await ctx.close(); await browser.close();
  } finally {
    for (const x of [api, idp, llm, esign, db]) { try { process.kill(-x.pid); } catch { /* gone */ } }
  }
})();
