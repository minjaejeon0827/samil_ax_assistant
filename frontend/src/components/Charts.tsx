// 근거 차트 2종 — 직접 SVG(외부 차트 라이브러리 없음).
import { forecast, ASSUMPTION_KO } from "../engine/cash";
import { DS } from "../engine/data";
import type { CashAssumption } from "../engine/types";
import { fmtDate } from "./bits";

/** 인플루언서별: 광고비 집행 비중(막대) vs 실질 ROAS(±) — 집행 순으로 정렬해 역전을 보여준다. */
export function AllocationChart() {
  const rows = Object.values(DS.influencers).sort((a, b) => a.spend_rank - b.spend_rank);
  const W = 640, rowH = 30, top = 34, left = 120, mid = 380, H = top + rows.length * rowH + 12;
  const maxShare = Math.max(...rows.map((r) => r.spend_share));
  const maxR = Math.max(...rows.map((r) => Math.abs(r.real_roas)));
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="인플루언서별 광고비 집행 비중과 실질 ROAS">
        <text x={left} y={18} className="axis-title">광고비 집행 비중</text>
        <text x={mid + 10} y={18} className="axis-title">실질 ROAS (공헌이익 ÷ 마케팅비)</text>
        <line x1={mid + 130} x2={mid + 130} y1={top - 6} y2={H - 8} className="zero" />
        {rows.map((r, i) => {
          const y = top + i * rowH;
          const w = (r.spend_share / maxShare) * (mid - left - 60);
          const rw = (Math.abs(r.real_roas) / maxR) * 72;
          const neg = r.real_roas < 0;
          return (
            <g key={r.influencer_id}>
              <text x={left - 8} y={y + 15} className="row-label" textAnchor="end">{r.influencer_name}</text>
              <rect x={left} y={y + 4} width={w} height={16} className="bar-spend" rx={2} />
              <text x={left + w + 6} y={y + 16} className="val">{(r.spend_share * 100).toFixed(1)}%</text>
              <rect x={neg ? mid + 130 - rw : mid + 130} y={y + 4} width={rw} height={16} className={neg ? "bar-neg" : "bar-pos"} rx={2} />
              <text x={neg ? mid + 126 - rw : mid + 134 + rw} y={y + 16} className="val" textAnchor={neg ? "end" : "start"}>{r.real_roas.toFixed(2)}</text>
              <text x={W - 4} y={y + 16} className="val dim" textAnchor="end">{r.cp_rank}위</text>
            </g>
          );
        })}
      </svg>
      <figcaption>표본 데이터의 비중·순위입니다. 오른쪽 끝은 실질 공헌이익 순위. 집행 1·2위가 공헌이익 9·10위로 배분이 거꾸로 서 있습니다.</figcaption>
    </figure>
  );
}

/** 13주 현금 재전망 — 30억 covenant 선과 하회 구간, 재무팀 공식 전망(주장)을 함께. */
export function CashChart({ assumption, extra = [] }: { assumption: CashAssumption; extra?: { date: string; amount_krw: number }[] }) {
  const f = forecast(assumption, extra);
  const W = 640, H = 230, L = 44, R = 12, T = 16, B = 30;
  const vals = [...f.days.map((d) => d.closing), ...DS.cash.official.map((o) => o.closing), 3e9];
  const ymax = Math.ceil(Math.max(...vals) / 1e9) * 1e9, ymin = Math.min(0, Math.floor(Math.min(...vals) / 1e9) * 1e9);
  const x = (i: number) => L + (i / (f.days.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - ymin) / (ymax - ymin)) * (H - T - B);
  const idx = new Map(f.days.map((d, i) => [d.date, i]));
  const path = f.days.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.closing).toFixed(1)}`).join("");
  const off = DS.cash.official.map((o) => ({ i: idx.get(o.week) ?? idx.get(nearest(o.week, f.days.map((d) => d.date))) ?? 0, v: o.closing }));
  const ticks = []; for (let v = ymin; v <= ymax; v += 2e9) ticks.push(v);
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="13주 현금 재전망">
        {f.window && <rect x={x(idx.get(f.window[0])!)} y={T} width={x(idx.get(f.window[1])!) - x(idx.get(f.window[0])!)} height={H - T - B} className="breach-zone" />}
        {ticks.map((v) => (<g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" /><text x={L - 6} y={y(v) + 4} className="val" textAnchor="end">{v / 1e8}억</text></g>))}
        <line x1={L} x2={W - R} y1={y(3e9)} y2={y(3e9)} className="covenant" />
        <text x={W - R} y={y(3e9) - 5} className="val seal" textAnchor="end">covenant 30억</text>
        <polyline points={off.map((o) => `${x(o.i)},${y(o.v)}`).join(" ")} className="official" />
        <path d={path} className="closing" />
        {["2026-07-01", "2026-08-03", "2026-09-01", "2026-09-30"].map((d) => idx.has(d) && <text key={d} x={x(idx.get(d)!)} y={H - 10} className="val" textAnchor="middle">{fmtDate(d)}</text>)}
        <circle cx={x(idx.get(f.minDate)!)} cy={y(f.min)} r={4} className="min-dot" />
        <text x={x(idx.get(f.minDate)!) + 8} y={y(f.min) + 4} className="val seal">최저 {(f.min / 1e8).toFixed(1)}억</text>
      </svg>
      <figcaption>
        실선: 재전망({ASSUMPTION_KO[assumption]}) · 점선: 재무팀 공식 전망(주장, 최저 {(f.officialMin / 1e8).toFixed(1)}억).
        {f.window ? ` 붉은 구간 ${fmtDate(f.window[0])}~${fmtDate(f.window[1])}(${f.breachDays.length}영업일)에 현금이 나가는 신규 약정은 금액과 관계없이 그룹 CEO 승인 사항입니다.` : " 하회 구간이 없습니다."}
      </figcaption>
    </figure>
  );
}

function nearest(d: string, list: string[]) { return list.reduce((a, b) => (Math.abs(+new Date(b) - +new Date(d)) < Math.abs(+new Date(a) - +new Date(d)) ? b : a)); }
