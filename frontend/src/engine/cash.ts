// Masil 13주 현금 재전망 — backend/app/domain/cash.py와 같은 규칙.
import { DS } from "./data";
import type { CashAssumption } from "./types";

export const AS_OF = "2026-07-01";
export const HORIZON_END = "2026-09-30";

const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86400000);

export function nextBusiness(s: string): string {
  let d = s < AS_OF ? AS_OF : s;
  while ([0, 6].includes(toDate(d).getUTCDay())) d = addDays(d, 1);
  return d;
}

export interface CashDay { date: string; inflow: number; ap: number; po: number; extra: number; closing: number; breach: boolean }
export interface Forecast { assumption: CashAssumption; opening: number; days: CashDay[]; breachDays: string[]; window: [string, string] | null; min: number; minDate: string; officialMin: number }

export const ASSUMPTION_KO: Record<CashAssumption, string> = {
  AS_IS: "원본 due_date(LC-0001 90일 반영)",
  CONSERVATIVE: "보수: 연체 채권 미회수",
  LEGACY45: "LC-0001 45일 가정(공식 전망 방식)",
};

function arDue(r: (typeof DS.cash.ar)[number], a: CashAssumption): string | null {
  if (a === "LEGACY45" && r.channel_id === "CH-03") return addDays(r.invoice_date, 45);
  if (a === "CONSERVATIVE" && r.due_date < AS_OF) return null;
  return r.due_date;
}

const cache = new Map<string, Forecast>();

export function forecast(a: CashAssumption, extra: { date: string; amount_krw: number }[] = []): Forecast {
  const key = a + JSON.stringify(extra);
  const hit = cache.get(key);
  if (hit) return hit;
  const bucket = (m: Map<string, number>, d: string, v: number) => m.set(nextBusiness(d), (m.get(nextBusiness(d)) ?? 0) + v);
  const col = new Map<string, number>(), pay = new Map<string, number>(), oth = new Map<string, number>(), ext = new Map<string, number>();
  DS.cash.ar.forEach((r) => { const d = arDue(r, a); if (d) bucket(col, d, r.amount); });
  DS.cash.ap.forEach((r) => bucket(pay, r.due, r.amount)); // po_id='NONE'만 (이중계상 금지)
  DS.cash.po.forEach((r) => bucket(oth, r.due, r.amount));
  extra.forEach((e) => bucket(ext, e.date, e.amount_krw));
  const min = DS.policy.covenant.min_cash_krw;
  let bal = DS.cash.opening;
  const days: CashDay[] = [];
  for (let d = AS_OF; d <= HORIZON_END; d = addDays(d, 1)) {
    if ([0, 6].includes(toDate(d).getUTCDay())) continue;
    const i = col.get(d) ?? 0, p = pay.get(d) ?? 0, o = oth.get(d) ?? 0, x = ext.get(d) ?? 0;
    bal = bal + i - p - o - x;
    days.push({ date: d, inflow: i, ap: p, po: o, extra: x, closing: bal, breach: bal < min });
  }
  const breachDays = days.filter((d) => d.breach).map((d) => d.date);
  const m = days.reduce((x, y) => (y.closing < x.closing ? y : x));
  const res: Forecast = {
    assumption: a, opening: DS.cash.opening, days, breachDays,
    window: breachDays.length ? [breachDays[0], breachDays[breachDays.length - 1]] : null,
    min: m.closing, minDate: m.date, officialMin: Math.min(...DS.cash.official.map((o) => o.closing)),
  };
  cache.set(key, res);
  return res;
}
