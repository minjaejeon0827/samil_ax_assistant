#!/usr/bin/env node
// 32차(31차 AR-01·AR-02): 배포 번들을 만들 때 막는 마지막 선 — `npm run build`와 Dockerfile이 빌드 끝에 실행한다.
//   ① 로그인 칸(아이디·비밀번호)에 회색 예시 글자(placeholder)를 넣은 번들 — 29차·31차 배포에서 계정·공용 비밀번호가 화면에 그대로 보였다
//   ② 권한표(PRD §9)에 없는 역할 이름표가 든 번들 — 31차 배포의 TEST_AURORA('테스트(Aurora)')
// 값(예시 글자·비밀번호)은 출력하지 않는다. 사용: node scripts/check-bundle.cjs [dist 폴더]
const fs = require("node:fs");
const path = require("node:path");
const dir = path.resolve(process.argv[2] || "dist");
const ROLES = new Set(["MARKETING_TEAM", "MASIL_CEO", "GROUP_CEO", "FINANCE", "SCM", "CONTRACT_OWNER", "TEST_AURORA", "AGENCY", "SYSTEM"]);   // TEST_AURORA: 시연·점검용 계정 역할(사용자 결정으로 유지)
const assets = path.join(dir, "assets");
if (!fs.existsSync(assets)) { console.error(`check-bundle: ${assets} 없음 — 빌드 결과 폴더를 넘겨 주세요`); process.exit(2); }
const problems = [];
for (const f of fs.readdirSync(assets).filter((x) => x.endsWith(".js"))) {
  const src = fs.readFileSync(path.join(assets, f), "utf8");
  for (const id of ["login-user", "login-password"]) {
    let i = src.indexOf(`"data-testid":"${id}"`);
    while (i >= 0) {
      // 같은 요소의 속성 묶음 안(앞뒤 400자, 다른 data-testid를 넘지 않음)에 placeholder가 있으면 잡는다
      const a = Math.max(src.lastIndexOf('"data-testid":"', i - 1), i - 400), b = src.indexOf('"data-testid":"', i + 10);
      const win = src.slice(a, b < 0 ? i + 400 : Math.min(b, i + 400));
      if (/\bplaceholder\s*:\s*["'`][^"'`]+["'`]/.test(win)) problems.push(`${f}: 로그인 칸(${id === "login-user" ? "아이디" : "비밀번호"})에 예시 글자가 있음 — 계정이나 비밀번호를 화면에 적지 마세요`);
      i = src.indexOf(`"data-testid":"${id}"`, i + 10);
    }
  }
  const m = src.match(/\{[^{}]*MARKETING_TEAM:"마케팅팀"[^{}]*\}/);
  if (m) {
    const keys = [...m[0].matchAll(/([A-Z][A-Z0-9_]+):"/g)].map((x) => x[1]);
    const extra = keys.filter((k) => !ROLES.has(k));
    if (extra.length) problems.push(`${f}: 권한표(PRD §9)에 없는 역할 이름표 ${extra.join(", ")} — 시험 계정·역할은 운영 번들에서 빼세요`);
  }
}
if (problems.length) { console.error(`check-bundle: 실패 ${problems.length}건\n- ${problems.join("\n- ")}`); process.exit(1); }
console.log(`check-bundle: 통과 — 로그인 칸 예시 글자 없음, 역할 이름표는 권한표의 역할뿐 (${dir})`);
