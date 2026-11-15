// 시연 영상 녹화 — 실제 화면을 Playwright로 조작(정상 · 조건 변경 · 정보 부족+승인 거절). 24차: 자막마다 AI 음성 해설(demo/narration_src.json).
// 사용: (frontend에서 vite preview --port 4173 실행 후) node demo/record_demo.cjs
const path0 = require("path");
const { chromium } = require(require.resolve("playwright", { paths: [__dirname, path0.resolve(__dirname, "..", "frontend")] }));
const path = require("path");

const URL = process.env.DEMO_URL || "http://localhost:4173";
const OUT = path.resolve(__dirname, "raw");

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } });   // 32차: 1080p
  const p = await ctx.newPage();
  p.on("dialog", (d) => d.accept());
  p.on("pageerror", (e) => console.error("PAGEERR", e.message));
  const wait = (ms) => p.waitForTimeout(Math.max(150, Math.round(ms * 0.5)));   // 24차: 화면 동작 사이의 쉼을 절반으로(해설을 넣어도 5분 이내)
  await p.goto(URL);
  await p.evaluate(() => localStorage.clear());
  await p.reload();

  const { caption, save } = require("./narrate.cjs").makeCaption(p, "part1", { font: "18px/1.55 'IBM Plex Sans KR', sans-serif", maxWidth: "760px", bottom: "90px" });   // 32차: 1080p에서 읽히게   // 24차: 자막마다 AI 음성 해설(길이만큼 보여 줌)
  const role = async (r) => { await p.locator('[data-testid="role-select"]').selectOption(r); await wait(500); };
  const openCase = async (re) => { await p.locator(".cases .case-item", { hasText: re }).last().click(); await wait(700); await p.evaluate(() => window.scrollTo(0, 0)); };
  const scrollTo = async (sel, ms = 1600) => { await p.locator(sel).first().scrollIntoViewIfNeeded(); await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ behavior: "smooth", block: "start" }), sel); await wait(ms); };
  const top = async () => { await p.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })); await wait(700); };
  const btn = (name) => p.getByRole("button", { name, exact: true });

  // 32차: 제출 안내의 장면 순서(소개 30초 → 정상 → 조건 변경 → 정보 부족·승인 거절 → 필수 확장·다른 부서 영향 → 추가 확장)로 다시 짰다.
  // 장면 첫 자막의 해설이 '실제 작동'·'모의 처리'를 밝히고, 시뮬레이션 시계를 옮기는 구간은 화면 위에 '빨리 감기'를 띄운다.
  const ff = async (text, ms = 2600) => {   // 빨리 감은 구간 표시(시뮬레이션 시계 이동 — 실제 시간은 흐르지 않음)
    await p.evaluate((t) => { let el = document.getElementById("demo-ff"); if (!el) { el = document.createElement("div"); el.id = "demo-ff";
      Object.assign(el.style, { position: "fixed", top: "84px", left: "50%", transform: "translateX(-50%)", zIndex: 100, background: "#b3261e", color: "#fff", padding: "10px 22px",
        borderRadius: "999px", font: "600 20px 'IBM Plex Sans KR', sans-serif", boxShadow: "0 2px 12px rgba(0,0,0,.3)", pointerEvents: "none" }); document.body.appendChild(el); }
      el.textContent = t; el.style.display = "block"; }, text);
    await wait(ms);
    await p.evaluate(() => { const el = document.getElementById("demo-ff"); if (el) el.style.display = "none"; });
  };
  const scene = async (n, name) => p.evaluate(([k, t]) => { let el = document.getElementById("demo-scene"); if (!el) { el = document.createElement("div"); el.id = "demo-scene";
    Object.assign(el.style, { position: "fixed", top: "12px", right: "130px", zIndex: 99, background: "#1d2a36", color: "#fff", padding: "6px 14px", borderRadius: "4px",
      font: "600 16px 'IBM Plex Sans KR', sans-serif", pointerEvents: "none" }); document.body.appendChild(el); } el.textContent = `장면 ${k}/6 · ${t}`; }, [n, name]);

  // ── 1. 소개(30초) ──
  await scene(1, "소개");
  await caption("소개 · 고른 업무와 돕는 결정", "인플루언서 전속계약 갱신(그룹 CEO/이사회 결정)과 캠페인 확대 기안 25건(Masil 대표 결정)을 같은 자로 다시 판단하고 승인·작업·상태까지 잇습니다. [실제 작동 화면]", 3200);
  await scrollTo(".chart", 1000);
  await caption("소개 · 결정이 어려운 이유", "2026H1 GMV +8.1%인데 실질 공헌이익 −39.6%. 광고비 집행 1위(40.6%) 혜인이 실질 공헌이익 10위(실질 ROAS −0.20). 고정 피 28억 계약과 기안의 확정일이 같은 7/17.", 3800);
  await p.evaluate(() => window.scrollBy({ top: 620, behavior: "smooth" })); await wait(900);
  await caption("소개 · 현금이 약정 아래로", "AR·AP·발주 스케줄을 직접 합산하면 7/21~8/21에 covenant 30억을 하회(최저 16.5억). 재무팀 공식 전망(점선)은 하회가 없습니다.", 3600);
  await top();

  // ── 2. 정상 ──
  await scene(2, "정상");
  await caption("정상 · 갱신 통보 접수", "에이전시의 전속계약 갱신 통보(고정 피 연 28억, 통보 기한 7/17)를 접수합니다. 판단·결재·작업은 실제 작동, 외부 발송만 모의.", 2000);
  await btn("전속계약 갱신 통보 접수").click(); await wait(600);
  await openCase("전속계약 갱신 통보");
  await caption("AI 판단 → 결재 서류", "보안1 → 판단 → 정책 RAG → 설명 → LLM-as-a-Judge(숫자·결론이 규칙 판단과 맞는지) → 보안2. 권고: 조건변경 통보. 결재란에서 그룹 CEO 칸이 굵게 표시됩니다.", 3800);
  await scrollTo(".evidence", 1000);
  await caption("근거는 출처를 달고 나온다", "원본·계산·가정·주장·모의, 표본·풀스케일을 배지로 구분합니다.", 3000);
  await scrollTo(".chain", 1000);
  await caption("승인 권한 판정(책임 연쇄)", "전속계약 연 28억 > 10억 → CEO/이사회. 미통보 자동 갱신도 '체결'로 봅니다.", 3200);
  await top();
  await role("MASIL_CEO");
  await caption("권한 없는 승인 시도", "Masil 대표 역할로 승인을 누르면 서버 규칙이 거부하고 감사 로그에 남깁니다.", 1600);
  await p.getByRole("button", { name: "현재 역할로 승인 시도" }).click(); await wait(2200);
  await role("GROUP_CEO");
  await p.locator("#cmt").fill("조건변경 통보 승인 — 7/16까지 발송");
  await btn("승인").click(); await wait(1200);
  await caption("승인 → 작업 4건 자동 생성", "계약 담당: 통보 발송 · 마케팅: 연계 기안 보류 · 재무: 대조표 · 이사회 보고. 결재란에 도장이 찍힙니다.", 3400);
  await role("CONTRACT_OWNER");
  await p.locator(".dept li", { hasText: "조건변경 통보 발송" }).getByRole("button").click(); await wait(1200);
  await caption("작업 완료 → 채널 발송 → 상태 변경", "MCP 채널로 통보가 나가고(모의 이메일 — 발송함에만 기록) 계약 상태가 '통보 발송·회신 대기'로 바뀝니다.", 3400);
  await caption("캠페인 확대 기안 25건", "BackgroundTask로 한 번에 접수·판단합니다. 요청액이 아니라 실질 공헌이익 순으로 정렬됩니다.", 1600);
  await btn("확대 기안 25건 접수").click(); await wait(800);
  await p.getByRole("tab", { name: "확대 기안 25건" }).click(); await wait(1500);
  await caption("같은 기안, 다른 결재자", "정산일이 하회 구간에 들어가는 12건은 소액이어도 그룹 CEO 결재(covenant 우선 규정). 나머지 13건은 Masil 대표.", 4000);
  await p.locator(".plans tr", { hasText: "PLAN-024" }).click(); await wait(600); await top();
  await role("MASIL_CEO");
  await caption("Masil 대표가 PLAN-024 승인", "정산 8/24 — 현재 하회 구간(~8/21) 밖이라 Masil 대표 결재 사항입니다. 승인하면 집행·재무·SCM 작업이 생깁니다.", 1800);
  await btn("승인").click(); await wait(1500);

  // ── 3. 조건 변경 ──
  await scene(3, "조건 변경");
  await caption("조건 변경 · 재무 회신", "재무팀 회신(모의): 연체 매출채권 1.80억은 회수가 불확실하니 전망에서 빼 달라. 다시 판단하는 것은 실제 작동입니다.", 2200);
  await role("FINANCE");
  await btn("재무: 연체 채권 회수 불확실").click(); await wait(1500);
  await caption("하회 구간이 8/28까지 연장", "미결 건을 모두 재검증하고, 이미 승인된 PLAN-024는 권한 상향으로 승인 무효 → 작업 취소 → 그룹 CEO 재상신.", 3600);
  await scrollTo(".history", 2200); await top();
  await role("MARKETING_TEAM");
  await btn("마케팅팀 성과 보고(주장)").click(); await wait(1200);
  await caption("부서 주장은 사실과 분리", "'GMV 1위라 갱신 필요'는 주장 배지로 기록됩니다. 계약 건 결론은 유지 — 근거: 주장은 사실 목록 밖, 실질 공헌이익 10위는 그대로.", 3200);

  // ── 4. 정보 부족 · 승인 거절 ──
  await scene(4, "정보 부족·승인 거절");
  await role("CONTRACT_OWNER");
  await caption("정보 부족 · 에이전시 역제안", "에이전시 역제안(모의): 고정 피 28억→18억 + 성과 피 GMV 3%. 섞여 온 담당자 연락처는 접수 단계에서 가립니다(실제 작동).", 1800);
  await btn("에이전시 역제안 수신").click(); await wait(800);
  await openCase("역제안");
  await caption("정보 부족 → 확인 필요로 정지", "지급 일정이 없어 하회 구간 포함 여부를 판정할 수 없습니다. 결재를 올리지 않고 에이전시 확인 요청 작업을 만듭니다.", 3800);
  await p.locator(".dept li", { hasText: "확인 요청" }).first().getByRole("button").click(); await wait(900);
  await btn("에이전시 지급 일정 회신").click(); await wait(1000);
  await openCase("역제안");
  await caption("확인 요청 → 회신 → covenant 우선 규정", "확인 요청 발송 → 에이전시 회신(모의: 8/14 4.5억 선급). 첫 지급일이 하회 구간 안 → 최저 잔액 16.5억 → 12.0억. AI 권고: 역제안 수용 비권고.", 3200);
  await scrollTo(".chart", 2600); await top();
  await role("GROUP_CEO");
  await p.locator("#cmt").fill("역제안 거절 — 기한 내 미갱신 통보");
  await btn("거절").click(); await wait(1400);
  await caption("승인 거절 → 대안 계획으로 전환", "반려 도장 · 미갱신 통보 작업 · 연계 기안 PLAN-001~003 자동 부결 · 실질 공헌이익 상위로 재배분안 작성.", 3800);
  await role("CONTRACT_OWNER");
  await p.locator(".dept li", { hasText: "미갱신(해지) 통보 발송" }).getByRole("button", { name: "발송 완료" }).click(); await wait(1200);
  await caption("확인 요청 → 확인 완료 → 다시 결재", "Masil 대표가 PLAN-019 근거 보완을 요청하면 '확인 필요'로 멈추고, 마케팅팀이 확인을 끝내면 다시 판단해 결재로 돌아옵니다.", 1600);
  await role("MASIL_CEO");
  await p.locator('[data-testid="case-PLAN-019"]').click(); await wait(600); await top();
  await p.locator("#cmt").fill("타깃 연령대 근거 보완 요청");
  await btn("확인 요청").click(); await wait(1400);
  await role("MARKETING_TEAM");
  await p.locator(".dept li", { hasText: "PLAN-019: 타깃 연령대" }).getByRole("button").click(); await wait(2000);

  // ── 5. 필수 확장 · 다른 부서 영향 ──
  await scene(5, "필수 확장·다른 부서 영향");
  await p.getByRole("tab", { name: "확대 기안 25건" }).click(); await wait(500);
  await p.locator(".plans tr", { hasText: "PLAN-016" }).click(); await wait(800); await top();
  await caption("필수 확장 · 표시광고법 카피 게이트", "성과가 좋은 코코라운지 기안도 카피에 '주름 개선'이 있어 수정 필요로 멈춥니다(화장품법 제13조). 정상 장면의 기안 접수에서 3건이 이렇게 멈췄습니다. [실제 작동]", 2400);
  await scrollTo(".copy-diff", 1200);
  await p.locator("summary", { hasText: "검색된 정책 조각" }).click(); await p.locator(".hits").scrollIntoViewIfNeeded(); await wait(1100); await top();
  await btn("수정안 반영하고 재검증").click(); await wait(1200);
  await caption("수정안 재검증 통과 → 승인 대기", "check_regulation이 수정안을 다시 검사해 통과하면 결재로 넘어갑니다. 위반 카피가 남은 기안은 결재권자도 승인할 수 없습니다.", 2800);
  await p.getByRole("tab", { name: "확대 기안 25건" }).click(); await wait(500);
  await p.locator(".plans tr", { hasText: "PLAN-011" }).click(); await wait(700); await top();
  await scrollTo(".evidence", 900);
  await caption("필수 확장 · 다른 부서 영향(재무·SCM)", "재무 covenant: 정상 장면의 결재자 12건, 조건 변경의 승인 무효, 역제안 비권고에 쓰였습니다. SCM: 더마 재고 커버 2.2주 < 안전재고 4주 → PLAN-011은 카피 수정 뒤 공급 보류, 거절 시 SCM 입고 회신 작업.", 3600);
  await top();

  // ── 6. 추가 확장 ──
  await scene(6, "추가 확장");
  await role("GROUP_CEO");
  await caption("추가 확장 · 기한 감시", "시뮬레이션 시계를 통보 기한 다음 날로 빨리 감습니다. 미결정으로 기한을 넘긴 기안은 '묵시적 승인'으로 기록하고, 누가 시계를 옮겼는지 감사 로그에 남깁니다. [실제 작동]", 1800);
  await btn("통보 기한 다음 날로").click();
  await ff("⏩ 빨리 감기 — 시뮬레이션 시계 7월 1일 → 7월 18일 (실제 시간은 흐르지 않음)", 4000);
  await scrollTo(".audit", 1800);
  await p.locator('[data-testid="audit-all"]').click(); await wait(500);
  await p.locator('[data-testid="audit-search"]').pressSequentially("계약 담당", { delay: 100 }); await wait(800);
  await caption("감사 기록 검색", "화면에 보이는 대로 찾습니다 — 역할 이름, 날짜, 건 번호, 내용. 새로고침해도 모든 기록이 남고, 오래된 기록은 보관함까지 함께 찾습니다.", 2800);
  await p.keyboard.press("Escape"); await wait(400);
  await p.locator("#memo").scrollIntoViewIfNeeded();
  await p.locator("#memo").pressSequentially("에이전시 담당 010-1234-5678, kim@agency.co.kr 로 회신 요청", { delay: 20 }); await wait(300);
  await p.locator("#memo").press("Enter"); await wait(600);
  await p.locator('[data-testid="case-MEMO"]').last().click(); await wait(800);
  await caption("메모·공문의 연락처도 가림", "직접 넣은 메모나 API·MCP로 들어온 공문의 휴대폰·이메일·계좌는 저장·표시 전에 가립니다. 이어서 서버 모드의 추가 확장입니다.", 2800);

  save();
  await ctx.close();
  await browser.close();
})();
