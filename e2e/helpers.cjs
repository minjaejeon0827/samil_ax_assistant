// E2E 공통 도구 — 서버 기동/종료, 브라우저 페이지, 클릭→화면 반영 시간 측정, 콘솔 오류 수집, 보고서 기록.
// 의존성: playwright(frontend devDependency 1.63.0 또는 전역) + Node 내장 node:test.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
// H-06: 전역 NODE_PATH가 없는 새 환경에서도 찾도록 frontend/node_modules(devDependency)도 함께 본다
const PW = require(require.resolve("playwright", { paths: [__dirname, path.resolve(__dirname, "..", "frontend"), ...(process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean)] }));
const { chromium, devices } = PW;

const ROOT = path.resolve(__dirname, "..");
const REPORT_DIR = path.join(__dirname, "reports");
fs.mkdirSync(REPORT_DIR, { recursive: true });

async function waitHttp(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server not ready: ${url}`);
}

function startProc(cmd, args, opts) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, ...opts });
  let log = "";
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  p.logs = () => log;
  return p;
}

async function startPreview(port = 4173, outDir = "dist") {
  const p = startProc("npx", ["vite", "preview", "--port", String(port), "--strictPort", "--outDir", outDir], { cwd: path.join(ROOT, "frontend") });
  await waitHttp(`http://localhost:${port}`);
  return p;
}

async function startApi(port = 8000, env = {}) {
  const p = startProc("python3", ["-m", "uvicorn", "app.main:app", "--port", String(port), "--log-level", "warning"], {
    cwd: path.join(ROOT, "backend"),
    env: { ...process.env, API_KEYS: "e2e-key", ALLOWED_ORIGINS: "http://localhost:4174,http://localhost:4173", SERVE_FRONTEND: "0", ...env },
  });
  await waitHttp(`http://localhost:${port}/api/health`);
  return p;
}

/** MariaDB(MySQL 호환) 임시 서버 — mariadbd가 설치된 환경에서만. 스키마를 적용하고 aurora 계정을 만든다.
 *  CI·도커에서는 MySQL 8.4 서비스(docker-compose)로 같은 테스트를 돌린다. */
async function startMariaDB(port = 3307) {
  const { execFileSync } = require("node:child_process");
  try { execFileSync("which", ["mariadbd"]); } catch { return null; }
  const dir = path.join(ROOT, "e2e", ".mariadb");
  const sock = `/tmp/aurora-e2e-${port}.sock`;
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync("mariadb-install-db", ["--user=root", `--datadir=${dir}`, "--auth-root-authentication-method=normal"], { stdio: "ignore" });
  const p = startProc("mariadbd", ["--user=root", `--datadir=${dir}`, `--socket=${sock}`, `--pid-file=${dir}/m.pid`, `--port=${port}`, "--bind-address=127.0.0.1", "--skip-name-resolve"], {});
  for (let i = 0; i < 60; i++) {
    try { execFileSync("mariadb", ["-uroot", `--socket=${sock}`, "-e", "SELECT 1"], { stdio: "ignore" }); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  const sql = (q) => execFileSync("mariadb", ["-uroot", `--socket=${sock}`], { input: q });
  const schema = fs.readFileSync(path.join(ROOT, "backend", "app", "repo", "schema.sql"), "utf-8");
  p.schemaError = null;
  try { sql(schema); } catch (e) {
    // 원본 스키마가 실패하면 기록만 하고(테스트 M00이 실패로 보고), 나머지 시험을 위해 호환 문법으로 바꿔 적용
    p.schemaError = String(e.stderr || e.message).trim();
    sql(schema.replace(/utf8mb4_0900_ai_ci/g, "utf8mb4_unicode_ci").replace(/\(doc->>'\$\.(\w+)'\)/g, "(JSON_UNQUOTE(JSON_EXTRACT(doc,'$.$1')))"));
  }
  sql("CREATE USER IF NOT EXISTS 'aurora'@'127.0.0.1' IDENTIFIED BY 'e2e-pass'; GRANT ALL ON aurora_desk.* TO 'aurora'@'127.0.0.1'; FLUSH PRIVILEGES;");
  p.env = { REPO: "mysql", MYSQL_HOST: "127.0.0.1", MYSQL_PORT: String(port), MYSQL_USER: "aurora", MYSQL_PASSWORD: "e2e-pass", MYSQL_DB: "aurora_desk" };
  p.sql = sql;
  return p;
}

function stop(p) { if (p && p.exitCode === null) { try { process.kill(-p.pid, "SIGTERM"); } catch { /* already gone */ } } }

async function newPage(opts = {}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);   // 실패는 빨리 드러나게(사용자가 기다릴 수 있는 한계)
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") page.errors.push(`console: ${m.text()}`); });
  page.on("dialog", (d) => d.accept());
  return { browser, ctx, page };
}

const perf = [];
/** 클릭 → React 반영 → 두 번째 프레임까지(사용자가 결과를 보는 시점) 걸린 시간(ms)을 페이지 안에서 측정. */
async function clickTimed(page, locator, label) {
  await locator.waitFor({ state: "visible" });
  const handle = await locator.elementHandle();
  const ms = await page.evaluate(async (el) => {
    const t = performance.now();
    el.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t;
  }, handle);
  perf.push({ label, ms: Math.round(ms * 10) / 10 });
  return ms;
}
function recordPerf(label, ms, extra = {}) { perf.push({ label, ms: Math.round(ms * 10) / 10, ...extra }); }

function writeReport(name, data) {
  const f = path.join(REPORT_DIR, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...data, perf }, null, 1));
  return f;
}

async function fresh(page, url) {
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".top");
}

module.exports = { devices, ROOT, startProc, startPreview, startApi, startMariaDB, stop, newPage, clickTimed, recordPerf, writeReport, fresh, perf, waitHttp };
