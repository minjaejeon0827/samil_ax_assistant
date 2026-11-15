#!/usr/bin/env node
/* eslint-disable no-console */
// 배포 확인 스크립트(읽기 전용) — 배포한 Aurora 판단 데스크 주소에 대고 '배포 환경에서만 생기는 문제'를 확인합니다.
//
//   node smoke_remote.cjs <배포 URL> [--api-key 키] [--browser] [--report 파일.json] [--expect-version 1.30.0]
//
// 원칙
//   - 읽기만 합니다: 서버에 보내는 요청은 GET·HEAD·OPTIONS뿐입니다(실행 끝에 보낸 요청의 방식별 개수를 보여 줌).
//     '처음부터'·접수·결재·머리값 기록처럼 데이터를 바꾸는 요청은 보내지 않습니다.
//   - 설치할 것이 없습니다: Node 18 이상의 내장 fetch만 씁니다. --browser만 Playwright가 필요합니다.
//   - 배포 방식을 스스로 알아냅니다: /api/health가 JSON이면 '서버 배포'(Dockerfile), 아니면 '정적 배포'(axhub.yaml static).
//
// --browser: 실제 브라우저(Playwright Chromium)로 화면을 엽니다. 정적 배포(브라우저 단독 모드)에서는 상황 1 접수를 눌러 보고
//   새로고침해도 남는지 확인합니다 — 이 동작은 그 브라우저의 저장소에만 쓰이고 서버에는 아무것도 보내지 않으며, 끝나면 지웁니다.
//   서버 배포에서는 화면이 뜨는지만 보고 아무것도 누르지 않습니다(로그인 모드면 이 브라우저의 화면 설정만 '서버'로 바꿔 로그인 창의
//   예시 글자를 읽고(U04, 30차 — 29차 AP-02) 끝나면 지웁니다). /api/health의 contracts로 PDF 읽기 준비도 봅니다(A14, 29차 AP-01).
//
// 판정: PASS(통과) · WARN(배포 환경에 따라 괜찮을 수 있음 — 확인 권장) · FAIL(고쳐야 함) · INFO(참고).
// FAIL이 하나라도 있으면 종료 코드 1.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// ---------------- 인자 ----------------
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? def) : def; };
const flag = (name) => argv.includes(name);
const target = argv.find((a) => /^https?:\/\//i.test(a));
if (!target || flag("--help") || flag("-h")) {
  console.log(`사용법: node smoke_remote.cjs <배포 URL> [--api-key 키] [--browser] [--report 파일.json] [--expect-version 1.30.0] [--timeout 초]
  예) node smoke_remote.cjs https://samil-ax-assistant.example.com
      node smoke_remote.cjs https://…/apps/samil-ax-assistant/ --browser
      node smoke_remote.cjs https://… --api-key demo-public-key        (서버 배포일 때)`);
  process.exit(target ? 0 : 2);
}
const BASE = target.endsWith("/") ? target : `${target}/`;           // 하위 경로 배포도 그대로(…/apps/samil-ax-assistant/)
const ORIGIN = new URL(BASE).origin;
const API_KEY = opt("--api-key", process.env.AURORA_API_KEY || "");
const EXPECT_VERSION = opt("--expect-version", "1.30.0");
const TIMEOUT_MS = Number(opt("--timeout", "15")) * 1000;
const REPORT = opt("--report", "smoke_report.json");
const SENT = {};                                                       // 보낸 요청의 방식별 개수(읽기 전용 증명)
let AUTH = null;                                                       // 서버 인증 방식(/api/health) — U04 로그인 창 확인에 씀

// ---------------- 결과 ----------------
const results = [];
const add = (id, level, title, detail = "") => { results.push({ id, level, title, detail }); };
const ICON = { PASS: "✅", WARN: "⚠️ ", FAIL: "❌", INFO: "ℹ️ " };

// ---------------- HTTP(읽기 전용) ----------------
async function req(url, { method = "GET", headers = {}, redirect = "follow" } = {}) {
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) throw new Error(`읽기 전용 스크립트가 ${method}를 보내려 함`);
  SENT[method] = (SENT[method] || 0) + 1;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const r = await fetch(url, { method, headers, redirect, signal: ctl.signal });
    const buf = method === "HEAD" ? Buffer.alloc(0) : Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, body: buf.toString("utf8"), bytes: buf.length, ms: Math.round(performance.now() - t0), url: r.url, redirected: r.redirected };
  } catch (e) {
    return { status: 0, headers: new Headers(), body: "", bytes: 0, ms: Math.round(performance.now() - t0), error: e.name === "AbortError" ? `시간 초과(${TIMEOUT_MS / 1000}초)` : String(e.cause?.code || e.message) };
  } finally { clearTimeout(t); }
}
const u = (p) => new URL(p, BASE).toString();
const ct = (r) => (r.headers.get("content-type") || "").toLowerCase();
const isJson = (r) => ct(r).includes("application/json");
const p95 = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))]; };
const authH = () => (API_KEY ? { "X-API-Key": API_KEY } : {});

// ---------------- 1. 화면 문서와 자산(정적·서버 공통) ----------------
async function checkPage() {
  const page = await req(BASE);
  if (page.status === 0) { add("P01", "FAIL", "배포 주소에 연결", `${page.error} — 주소·사내망·VPN을 확인하세요`); return null; }
  const html = page.body;
  const okHtml = page.status === 200 && ct(page).includes("text/html") && html.includes('id="root"');
  add("P01", okHtml ? "PASS" : "FAIL", "화면 문서(index.html) 응답", `HTTP ${page.status} · ${ct(page) || "형식 없음"} · ${page.ms}ms${okHtml ? "" : " — React 화면의 #root가 없음(다른 페이지가 응답하는지 확인)"}`);
  if (!okHtml) return null;
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
  add("P02", /Aurora 판단 데스크/.test(title) ? "PASS" : "WARN", "화면 제목", title ? `"${title}"` : "제목 없음 — Vite 템플릿 index.html이 그대로 배포됐을 수 있음");
  if (html.includes('/src/main.tsx')) add("P03", "FAIL", "빌드 결과가 배포됐는가", "index.html이 /src/main.tsx를 직접 부름 — 빌드 전 원본이 배포됨(npm run build의 dist를 배포해야 함)");

  // 자산 경로와 응답
  const refs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/gi)].map((m) => m[1]).filter((x) => !/^(https?:|data:|#)/.test(x));
  const sub = new URL(BASE).pathname !== "/";
  const absolute = refs.filter((x) => x.startsWith("/"));
  if (sub && absolute.length) add("P04", "WARN", "자산 경로(하위 경로 배포)", `앱이 ${new URL(BASE).pathname} 아래에 있는데 자산이 절대 경로(${absolute[0]}) — vite.config.ts에 base: "./"를 넣고 다시 빌드하세요(아래 P05에서 실제 응답 확인)`);
  else add("P04", "PASS", "자산 경로", refs.length ? (refs.every((x) => x.startsWith("./")) ? "상대 경로(./assets/…) — 어느 주소에서도 열림" : "절대 경로지만 루트에 배포됨") : "참조 없음");
  let js = "", bad = [], loose = [];
  for (const ref of refs) {
    const r = await req(new URL(ref, BASE).toString());
    const type = ct(r);
    const wantJs = /\.m?js(\?|$)/.test(ref), wantCss = /\.css(\?|$)/.test(ref);
    if (r.status !== 200) bad.push(`${ref} → HTTP ${r.status || r.error}`);
    else if (wantJs && !/javascript/.test(type)) bad.push(`${ref} → 형식 ${type || "없음"}(자바스크립트여야 함 — 아니면 브라우저가 실행을 거부해 흰 화면)`);
    else if (wantCss && !/text\/css/.test(type)) bad.push(`${ref} → 형식 ${type || "없음"}(text/css여야 함)`);
    else if (wantJs && /<!doctype html/i.test(r.body.slice(0, 200))) bad.push(`${ref} → 자바스크립트 대신 HTML이 옴(경로가 틀려 index.html로 대체됨)`);
    if (wantJs && r.status === 200) js += r.body;
    if (wantJs || wantCss) {
      const cc = r.headers.get("cache-control") || "";
      if (r.status === 200 && /-[A-Za-z0-9_-]{8}\.(js|css)/.test(ref) && !/max-age=\d{5,}|immutable/.test(cc)) loose.push(cc || "없음");
    }
  }
  if (loose.length) add("P06", "INFO", "자산 캐시", `해시 파일명 자산 ${loose.length}개의 Cache-Control "${loose[0]}" — 길게 캐시해도 안전(성능 참고, 고치지 않아도 됨)`);
  add("P05", bad.length ? "FAIL" : "PASS", "자산(JS·CSS) 응답과 형식", bad.length ? bad.join(" / ") : `${refs.length}개 모두 200·올바른 형식`);

  // 번들 내용: React 버전·데이터·모드
  if (js) {
    const react = (js.match(/"(1[89]\.\d+\.\d+)"/) || [])[1] || (js.match(/version\s*[:=]\s*"(1[89]\.\d+\.\d+)"/) || [])[1];
    add("B01", !react ? "INFO" : react.startsWith("18.3.") ? "PASS" : "WARN", "React 버전(번들 안)", react ? `${react}${react.startsWith("18.3.") ? " — 시험한 버전(18.3.1)과 같은 계열" : " — 시험한 버전은 18.3.1(템플릿의 React 19가 깔렸을 수 있음, package.json 확인)"}` : "번들에서 버전 문자열을 찾지 못함");
    const data = /INF-001/.test(js) && /PLAN-0\d\d/.test(js);
    add("B02", data ? "PASS" : "FAIL", "데이터가 번들에 들어 있음", data ? "INF-001·PLAN-0xx 데이터 포함(정적 배포에서도 상황 1~3 실행 가능)" : "데이터(src/data/dataset.json)가 번들에 없음 — 다른 앱이거나 src가 바뀜");
    // 32차(31차 AR-02): 권한표(PRD §9)에 없는 역할 이름표(예: TEST_AURORA)가 든 번들 — 이 소스와 다른 사본에서 빌드된 신호
    const roleMap = js.match(/\{[^{}]*MARKETING_TEAM:"마케팅팀"[^{}]*\}/);
    if (roleMap) {
      const known = new Set(["MARKETING_TEAM", "MASIL_CEO", "GROUP_CEO", "FINANCE", "SCM", "CONTRACT_OWNER", "TEST_AURORA", "AGENCY", "SYSTEM"]);   // TEST_AURORA: 시연·점검용 계정 역할(유지)
      const extra = [...roleMap[0].matchAll(/([A-Z][A-Z0-9_]+):"/g)].map((x) => x[1]).filter((k) => !known.has(k));
      add("B05", extra.length ? "FAIL" : "PASS", "번들의 역할 이름표", extra.length ? `권한표에 없는 역할 ${extra.join(", ")} — 시험 계정·역할을 운영 번들에서 빼고 이 소스로 다시 빌드(빌드 확인: frontend/scripts/check-bundle.cjs)` : "권한표의 역할 6개 + 에이전시(모의)·시스템뿐");
    } else add("B05", "INFO", "번들의 역할 이름표", "역할 이름표를 찾지 못함(다른 빌드 방식)");
    if (/sourceMappingURL=/.test(js)) add("B04", "INFO", "소스맵", "번들에 소스맵 주소가 있음 — 원본 코드가 공개될 수 있음(대회 제출용이면 무방)");
  }

  // 보안 헤더(정적 호스트에 따라 다름 → WARN)
  const h = page.headers;
  const missing = [["x-content-type-options", /nosniff/i], ["referrer-policy", /./], ["content-security-policy", /frame-ancestors|default-src/i]].filter(([k, re]) => !re.test(h.get(k) || "")).map(([k]) => k);
  const frameOk = /frame-ancestors/i.test(h.get("content-security-policy") || "") || /deny|sameorigin/i.test(h.get("x-frame-options") || "");
  add("H01", missing.length ? "WARN" : "PASS", "보안 헤더(화면 문서)", missing.length ? `없음: ${missing.join(", ")}${frameOk ? "" : " · 다른 사이트의 iframe에 넣기 막힘 없음"} — 정적 호스트 설정에 따라 다름(서버 배포는 FastAPI가 붙임)` : "nosniff·referrer-policy·CSP 있음");
  const cc = h.get("cache-control") || "";
  add("H02", /no-cache|no-store|max-age=0|must-revalidate/i.test(cc) ? "PASS" : "WARN", "화면 문서 캐시", `Cache-Control "${cc || "없음"}"${/no-cache|no-store|max-age=0|must-revalidate/i.test(cc) ? "" : " — 다시 배포한 뒤 옛 화면·흰 화면이 남을 수 있음(X-02)"}`);
  return { html };
}

// ---------------- 2. 노출되면 안 되는 파일 ----------------
async function checkExposure(indexHtml) {
  const probes = [".env", ".git/config", ".claude/settings.local.json", ".codex/hooks.json", ".agents/hooks.json", "axhub.yaml", "package.json", "src/main.tsx", "backend/app/main.py", "data/raw/"];
  const leaked = [];
  for (const p of probes) {
    const r = await req(u(p));
    const isIndex = indexHtml && r.body.includes('id="root"');
    if (r.status === 200 && r.bytes > 0 && !isIndex) leaked.push(`${p}(${r.bytes}B)`);
  }
  add("X01", leaked.length ? "FAIL" : "PASS", "설정·원본 파일 노출", leaked.length ? `열림: ${leaked.join(", ")} — dist만 배포되도록 static_output_dir를 확인하세요` : `${probes.length}개 경로 모두 막힘(또는 화면 문서로 대체)`);
  const nf = await req(u("this-path-should-not-exist-7f3a"));
  add("X02", "INFO", "없는 주소의 응답", nf.status === 404 ? "404" : nf.status === 200 && nf.body.includes('id="root"') ? "화면 문서로 대체(SPA 대체 — 이 앱은 라우터가 없어 무방)" : `HTTP ${nf.status}`);
  if (BASE.startsWith("https://")) {
    const http = await req(BASE.replace(/^https:/, "http:"), { redirect: "manual" });
    add("X03", http.status >= 300 && http.status < 400 && /^https:/.test(http.headers.get("location") || "") ? "PASS" : http.status === 0 ? "INFO" : "WARN", "HTTP → HTTPS 이동",
      http.status === 0 ? "http 주소에 연결되지 않음(https만 열림)" : `HTTP ${http.status}${http.headers.get("location") ? ` → ${http.headers.get("location")}` : ""}`);
  } else add("X03", "WARN", "HTTPS", "http 주소 — 로그인·API 키가 암호화되지 않음(공개 배포는 https)");
}

// ---------------- 3. 서버 배포(API)일 때 ----------------
async function checkApi() {
  const hz = await req(u("api/health"));
  if (!(hz.status === 200 || hz.status === 503) || !isJson(hz)) { add("A00", "INFO", "배포 방식", "정적 배포(브라우저 단독) — /api가 없음. 2부 기능(SSO·MySQL·계약서 업로드·체인 검증)은 이 주소에서 동작하지 않음"); return false; }
  let h = {}; try { h = JSON.parse(hz.body); } catch { /* JSON 아님 */ }
  AUTH = h.auth ?? null;
  add("A00", "INFO", "배포 방식", `서버 배포(FastAPI) — 저장소 ${h.repo ?? "?"} · 인증 ${h.auth ?? "?"}${h.oidc ? ` · SSO(${h.oidc_label})` : ""} · 채널 ${h.channel ?? "?"}`);
  add("A01", hz.status === 200 && h.status === "ok" ? "PASS" : "FAIL", "/api/health", `HTTP ${hz.status} · ${h.status ?? "?"} · ${hz.ms}ms${h.detail ? ` — ${h.detail}` : ""}`);
  if (h.repo === "memory") add("A02", "WARN", "저장 방식", "메모리 저장소 — 서버를 다시 시작하면 처리 건·감사 기록이 사라짐(REPO_PATH 또는 REPO=mysql 권장, 리더 가이드 §2.3)");
  if (h.db) {
    const guards = h.db.guards || {}, off = Object.entries(guards).filter(([, v]) => !v).map(([k]) => k);
    add("A03", off.length ? "WARN" : "PASS", "운영 DB 보호 장치", off.length ? `만들지 못함: ${off.join(", ")} — 관리자 계정으로 schema.sql 적용(리더 가이드 §2.3)` : `트리거·보기 ${Object.keys(guards).length}개 · 맺은 연결 ${h.db.opened} · 열린 연결 ${h.db.open ?? "?"} · 대기 ${h.db.waited ?? 0}`);
  }
  // 30차(AP-01): 배포 이미지에 PDF 읽기 모듈이 빠지면 업로드가 모두 422였다 — 업로드 없이(읽기만) 서버가 알리는 준비 상태로 확인
  if (h.contracts) add("A14", h.contracts.pdf ? (h.contracts.ocr ? "PASS" : "WARN") : "FAIL", "계약서 PDF 읽기 준비",
    h.contracts.pdf ? (h.contracts.ocr ? "PDF 읽기·스캔 글자 인식(한국어) 준비됨" : "PDF 읽기는 됨 · 스캔 PDF 글자 인식 도구(poppler-utils·tesseract-ocr-kor) 없음 — 스캔 계약서는 '글자 인식 실패'로 끝남")
      : "서버에 PDF 읽기 모듈(pypdf)이 없음 — PDF 계약서 업로드가 모두 실패. backend/requirements.txt로 이미지를 다시 빌드");
  else add("A14", "INFO", "계약서 PDF 읽기 준비", "서버가 준비 상태를 알리지 않음(v1.29 이전) — 화면에서 PDF 계약서를 한 번 올려 확인하세요");
  if (h.auth === "apikey") add("A04", "WARN", "인증 방식", "apikey 모드 — 공개 배포에서는 역할을 요청 본문으로 정할 수 있음(AUTH_MODE=jwt 권장, PRD §14 'API 역할 사칭')");
  const oa = await req(u("openapi.json"));
  if (oa.status === 200 && isJson(oa)) {
    const v = (() => { try { return JSON.parse(oa.body).info?.version; } catch { return null; } })();
    add("A05", v === EXPECT_VERSION ? "PASS" : "WARN", "서버 버전", `${v ?? "알 수 없음"}${v === EXPECT_VERSION ? "" : ` — 기대 ${EXPECT_VERSION}(옛 이미지가 배포됐는지 확인)`}`);
    add("A06", "INFO", "API 문서 공개", "/docs·/openapi.json이 열려 있음 — 공개 배포에서 숨기려면 리버스 프록시에서 막으세요");
  }
  // 인증 없는 읽기는 거절돼야 함
  const anon = await req(u("api/snapshot"));
  add("A07", anon.status === 401 || anon.status === 403 ? "PASS" : anon.status === 200 ? "FAIL" : "WARN", "인증 없는 조회 거절", `키 없이 /api/snapshot → HTTP ${anon.status}${anon.status === 200 ? " — 누구나 처리 건·감사 기록을 볼 수 있음" : ""}`);
  // CORS: 다른 출처를 그대로 허락하지 않아야 함
  const evil = "https://evil.example";
  const pre = await req(u("api/snapshot"), { method: "OPTIONS", headers: { Origin: evil, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-api-key" } });
  const acao = pre.headers.get("access-control-allow-origin") || "";
  add("A08", acao === evil || acao === "*" ? "FAIL" : "PASS", "허용 출처(CORS)", acao ? `다른 출처에 '${acao}' 허락${acao === evil || acao === "*" ? " — ALLOWED_ORIGINS를 화면 주소로 좁히세요" : ""}` : "다른 출처 허락 없음");
  const sh = hz.headers;
  add("H03", /nosniff/i.test(sh.get("x-content-type-options") || "") ? "PASS" : "WARN", "보안 헤더(API)", `nosniff ${sh.get("x-content-type-options") ? "있음" : "없음"} · CSP ${sh.get("content-security-policy") ? "있음" : "없음"}`);

  if (!API_KEY) { add("A09", "INFO", "키가 필요한 조회", "--api-key를 주면 스냅샷·감사 기록·체인 검증까지 확인합니다(읽기만)"); return true; }
  const lat = []; let snap = null, last;
  for (let i = 0; i < 5; i++) { last = await req(u("api/snapshot"), { headers: authH() }); lat.push(last.ms); if (last.status === 200 && !snap) { try { snap = JSON.parse(last.body); } catch { /* */ } } }
  if (last.status === 401 && h.auth === "jwt") { add("A09", "INFO", "키가 필요한 조회", "jwt 모드라 API 키만으로는 조회할 수 없음(로그인 토큰 필요) — 화면 확인(--browser)으로 대신하세요"); return true; }
  add("A09", snap ? "PASS" : "FAIL", "스냅샷 조회", snap ? `처리 건 ${snap.cases?.length ?? "?"} · 작업 ${snap.tasks?.length ?? "?"} · 감사 기록 ${snap.audit_total ?? "?"} · p95 ${p95(lat)}ms` : `HTTP ${last.status}`);
  if (snap) add("A10", p95(lat) <= 1000 ? "PASS" : "WARN", "스냅샷 응답 속도", `5회 p95 ${p95(lat)}ms(판정 기준 1초 — 같은 지역 기준 보통 100ms 안팎)`);
  const au = await req(u("api/audit?limit=5"), { headers: authH() });
  let a = {}; try { a = JSON.parse(au.body); } catch { /* */ }
  add("A11", au.status === 200 && a.total === a.matched ? "PASS" : "FAIL", "감사 기록 조회", `HTTP ${au.status} · 전체 ${a.total ?? "?"} · 찾은 ${a.matched ?? "?"}`);
  const vr = await req(u("api/audit/verify"), { headers: authH() });
  let v = {}; try { v = JSON.parse(vr.body); } catch { /* */ }
  add("A12", vr.status === 200 && v.ok ? "PASS" : vr.status === 200 ? "WARN" : "FAIL", "감사 기록 체인 검증", vr.status === 200 ? `${v.ok ? "이상 없음" : `이상 ${v.broken_total}곳`} · 검사 ${v.checked}건${v.legacy ? ` · 체인 이전 ${v.legacy}건` : ""} · ${v.ms}ms${v.head ? ` · 머리값 ${v.head_id} ${v.head.slice(0, 12)}…` : ""}` : `HTTP ${vr.status}`);
  const bad = await req(u("api/audit/verify?anchor=AU-0001"), { headers: authH() });
  add("A13", bad.status === 422 ? "PASS" : "WARN", "잘못된 머리값 입력 거절", `형식이 틀린 머리값 → HTTP ${bad.status}(422여야 함 — v1.28)`);
  return true;
}

// ---------------- 4. 실제 브라우저(선택) ----------------
async function checkBrowser(isApi) {
  let pw;
  try { pw = require("playwright"); } catch {
    add("U00", "WARN", "브라우저 확인", "Playwright가 없음 — 이 스크립트가 있는 폴더에서 npm i -D playwright@1.63.0 && npx playwright install chromium 뒤 다시 실행"); return;
  }
  const browser = await pw.chromium.launch();
  try {
    for (const [label, viewport] of [["PC 1440px", { width: 1440, height: 900 }], ["휴대폰 390px", { width: 390, height: 844 }]]) {
      const ctx = await browser.newContext({ viewport, locale: "ko-KR" });
      const page = await ctx.newPage();
      const errors = [], failed = [], writes = [];
      page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 120)));
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 120)); });
      page.on("requestfailed", (r) => failed.push(`${r.url().replace(ORIGIN, "")} ${r.failure()?.errorText || ""}`));
      page.on("request", (r) => { if (!["GET", "HEAD", "OPTIONS"].includes(r.method()) && r.url().startsWith(ORIGIN)) writes.push(`${r.method()} ${r.url().replace(ORIGIN, "")}`); });
      const t0 = Date.now();
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      const shown = await page.waitForSelector(".top", { timeout: TIMEOUT_MS }).then(() => true).catch(() => false);
      const ms = Date.now() - t0;
      const shot = path.resolve(`smoke_${viewport.width}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      const uid = viewport.width === 1440 ? "U01" : "U03";
      if (!shown) { add(uid, "FAIL", `화면이 뜸(${label})`, `${ms}ms 안에 상단 바가 나타나지 않음(흰 화면) · 오류 ${errors.slice(0, 2).join(" / ") || "없음"} · 캡처 ${shot}`); await ctx.close(); continue; }
      const wide = await page.evaluate(() => document.scrollingElement.scrollWidth - innerWidth);
      const modeNow = await page.locator(".role select").nth(1).count().then((n) => (n ? "실행 위치 선택 있음(서버 연결 빌드)" : "브라우저 단독 빌드"));
      add(uid, errors.length ? "FAIL" : "PASS", `화면이 뜸(${label})`, `${ms}ms · ${modeNow} · 콘솔 오류 ${errors.length}건${errors.length ? `: ${errors.slice(0, 2).join(" / ")}` : ""}${failed.length ? ` · 실패한 요청 ${failed.slice(0, 2).join(", ")}` : ""} · 가로 넘침 ${wide > 1 ? `${wide}px` : "없음"} · 캡처 ${shot}`);
      const mode = await page.locator(".role select").nth(1).count().then((n) => (n ? "서버 선택 가능" : "브라우저 단독"));
      if (viewport.width === 1440 && !isApi && mode === "브라우저 단독") {
        // 정적 배포: 상황 1 접수 → 새로고침 유지(브라우저 저장소에만 쓰임, 서버로 가는 요청 없음) → 끝나면 지움
        const btn = page.getByRole("button", { name: "전속계약 갱신 통보 접수" });
        await btn.click();
        const appeared = await page.locator("text=INF-001").first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
        await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForSelector(".top");
        const kept = await page.getByRole("button", { name: "전속계약 갱신 통보 접수" }).isDisabled().catch(() => false);
        add("U02", appeared && kept ? "PASS" : "FAIL", "상황 1 접수 → 새로고침 유지(브라우저 단독)", `접수 ${appeared ? "됨" : "안 됨"} · 새로고침 뒤 ${kept ? "그대로" : "사라짐"}${writes.length ? ` · 서버로 간 쓰기 요청 ${writes.join(", ")}` : " · 서버로 간 쓰기 요청 0"}`);
        await page.evaluate(async () => { localStorage.clear(); sessionStorage.clear(); const dbs = (await indexedDB.databases?.()) || []; for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name); });
      } else if (viewport.width === 1440) add("U02", "INFO", "화면 조작", `${mode} — 서버 배포에서는 데이터를 바꾸지 않도록 아무것도 누르지 않았습니다`);
      if (viewport.width === 1440 && isApi && mode === "서버 선택 가능" && AUTH === "jwt") {
        // 30차(AP-02): 로그인 창의 회색 예시 글자에 계정·비밀번호가 들어간 번들을 잡는다 — 화면 설정(이 브라우저 저장소)만 '서버'로 바꿔 창을 띄우고 읽기만
        await page.evaluate(() => { const k = "aurora-desk-ui"; let u = {}; try { u = JSON.parse(localStorage.getItem(k) || "{}"); } catch { /* 없음 */ } localStorage.setItem(k, JSON.stringify({ role: "GROUP_CEO", selected: null, tab: "facts", ...u, mode: "api" })); sessionStorage.clear(); });
        await page.reload({ waitUntil: "domcontentloaded" });
        const shownLogin = await page.locator('[data-testid="login-user"]').waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
        if (!shownLogin) add("U04", "WARN", "로그인 창 예시 글자", "로그인 창이 뜨지 않아 확인하지 못함(로그인 모드인데 창이 없음 — 화면 확인 권장)");
        else {
          const ph = await page.evaluate(() => ["login-user", "login-password"].map((id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute("placeholder") || ""));
          const looksLikeAccount = (x) => /^[a-z0-9_-]+[.@][a-z0-9_.-]+$/i.test(x.trim());
          const leak = (ph[1] && !/^비밀번호$/.test(ph[1].trim())) || looksLikeAccount(ph[0]);
          add("U04", leak ? "FAIL" : "PASS", "로그인 창 예시 글자", leak ? `아이디 칸 '${ph[0].replace(/./g, (c, i) => (i < 3 ? c : "*"))}' · 비밀번호 칸 ${ph[1] ? "예시 글자 있음(값은 적지 않음)" : "없음"} — 누구나 계정을 알 수 있음. 예시 글자를 지우고 비밀번호를 계정마다 바꿔 다시 배포` : `아이디 칸 '${ph[0] || "(없음)"}' · 비밀번호 칸 ${ph[1] ? `'${ph[1]}'` : "(없음)"}`);
        }
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      }
      await ctx.close();
    }
  } finally { await browser.close(); }
}

// ---------------- 실행 ----------------
(async () => {
  const t0 = Date.now();
  console.log(`\nAurora 판단 데스크 배포 확인(읽기 전용) — ${BASE}\n`);
  const page = await checkPage();
  if (page) await checkExposure(page.html);
  const isApi = page ? await checkApi() : false;
  if (page && flag("--browser")) await checkBrowser(isApi);
  const order = { FAIL: 0, WARN: 1, PASS: 2, INFO: 3 };
  for (const r of results) console.log(`${ICON[r.level]} ${r.id} ${r.title}${r.detail ? `\n     ${r.detail}` : ""}`);
  const n = (lv) => results.filter((r) => r.level === lv).length;
  const sent = Object.entries(SENT).map(([k, v]) => `${k} ${v}`).join(" · ");
  console.log(`\n결과: 통과 ${n("PASS")} · 확인 권장 ${n("WARN")} · 실패 ${n("FAIL")} · 참고 ${n("INFO")}  (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
  console.log(`서버에 보낸 요청: ${sent || "없음"} — 데이터를 바꾸는 요청(POST·PUT·DELETE) 0건`);
  fs.writeFileSync(REPORT, JSON.stringify({ target: BASE, at: new Date().toISOString(), sent: SENT, summary: { pass: n("PASS"), warn: n("WARN"), fail: n("FAIL"), info: n("INFO") },
    results: [...results].sort((a, b) => order[a.level] - order[b.level]) }, null, 1));
  console.log(`보고서: ${path.resolve(REPORT)}\n`);
  process.exit(n("FAIL") ? 1 : 0);
})().catch((e) => { console.error("확인 스크립트 오류:", e); process.exit(2); });
