// 24차: 시연 영상 AI 음성 해설 — 자막(caption)마다 해설 한 줄(demo/narration_src.json)을 미리 합성한 음성 길이만큼 보여 주고,
// 화면에 자막이 뜬 시각을 기록한다(demo/raw/timeline_<part>.json). encode.sh가 그 시각에 음성을 깔아 MP4에 넣는다.
const fs = require("fs");
const path = require("path");
const SRC = path.join(__dirname, "narration_src.json");
const MAN = path.join(__dirname, "raw", "voice", "manifest.json");

function makeCaption(p, part, styleExtra = {}) {
  const say = JSON.parse(fs.readFileSync(SRC, "utf8"));
  const man = fs.existsSync(MAN) ? JSON.parse(fs.readFileSync(MAN, "utf8")) : {};
  const t0 = Date.now();                 // 녹화 시작(페이지 생성) 기준
  const timeline = [];
  const caption = async (title, body = "", minMs = 1800) => {
    await p.evaluate(([t, b, st]) => {
      let el = document.getElementById("demo-caption");
      if (!el) {
        el = document.createElement("div"); el.id = "demo-caption";
        Object.assign(el.style, { position: "fixed", left: "18px", bottom: "76px", zIndex: 99, maxWidth: "560px", background: "rgba(29,42,54,.94)",
          color: "#fff", padding: "12px 16px", borderRadius: "4px", font: "14px/1.55 'IBM Plex Sans KR', sans-serif", boxShadow: "0 2px 10px rgba(0,0,0,.25)", pointerEvents: "none", ...st });
        document.body.appendChild(el);
      }
      el.innerHTML = `<b style="font-size:15px">${t}</b>${b ? `<div style="opacity:.85;margin-top:3px">${b}</div>` : ""}`;
    }, [title, body, styleExtra]);
    const v = man[title];
    if (!say[title]) throw new Error(`해설 대본에 없는 자막: ${title}`);
    timeline.push({ part, title, text: say[title], file: v?.file ?? null, at: (Date.now() - t0) / 1000, dur: v?.dur ?? 0 });
    // 해설이 끝날 때까지(+0.3초) 자막을 둔다. 해설이 없으면 minMs.
    const floor = Math.min(minMs, 1800);   // 녹화 스크립트의 옛 보관 시간은 하한으로만(해설이 속도를 정함)
    await p.waitForTimeout(Math.max(floor, v ? Math.round(v.dur * 1000) + 300 : floor));
  };
  const save = () => fs.writeFileSync(path.join(__dirname, "raw", `timeline_${part}.json`), JSON.stringify(timeline, null, 1));
  return { caption, save };
}
module.exports = { makeCaption };
