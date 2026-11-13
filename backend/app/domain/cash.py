"""Masil 13주 현금 재전망 (calculation_definitions §1.2, covenant_terms_ms).

Closing[t] = Opening[t] + Collections(AR due) − Payments(AP po_id='NONE') − Other(PO)
- 이중계상 금지: AP 중 po_id가 PO에 있는 행은 제외.
- 공식 전망(fin_cash_forecast_ms)은 '재무팀 주장'으로 대조만 한다.
- 수금 가정은 전략(Strategy) 객체로 바꿔 끼운다(낙관/보수, LC-0001 결제조건 45/90일).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Protocol

from .data import DataRoom, num

AS_OF = date(2026, 7, 1)
HORIZON_END = date(2026, 9, 30)


def d(s: str) -> date:
    return date.fromisoformat(s)


def next_business(x: date) -> date:
    x = max(x, AS_OF)
    while x.weekday() >= 5:
        x += timedelta(days=1)
    return x


def business_days(a: date, b: date) -> list[date]:
    out, x = [], a
    while x <= b:
        if x.weekday() < 5:
            out.append(x)
        x += timedelta(days=1)
    return out


class CollectionAssumption(Protocol):
    """Strategy: AR 회수 시점 가정."""
    name: str

    def due(self, row: dict[str, str]) -> date | None: ...


@dataclass
class ScheduleAsIs:
    """원본 AR due_date 그대로(LC-0001 90일 통보 반영 상태). 연체분은 기준일 회수(가정 A-05 낙관)."""
    include_overdue: bool = True
    name: str = "원본 due_date(LC-0001 90일 반영)"

    def due(self, row):
        dd = d(row["due_date"])
        if dd < AS_OF and not self.include_overdue:
            return None
        return dd


@dataclass
class LegacyTerms45:
    """LC-0001(CH-03)이 기존 45일 조건이라고 가정할 때(공식 전망 작성 시점의 가정 추정)."""
    include_overdue: bool = True
    name: str = "LC-0001 45일 가정(변경 통보 미반영)"

    def due(self, row):
        if row["channel_id"] == "CH-03":
            return d(row["invoice_date"]) + timedelta(days=45)
        dd = d(row["due_date"])
        if dd < AS_OF and not self.include_overdue:
            return None
        return dd


@dataclass
class ForecastResult:
    assumption: str
    opening: float
    days: list[dict]
    breach_days: list[str]
    window: tuple[str, str] | None
    min_balance: float
    min_date: str
    official_min: float
    extra_outflows: list[dict] = field(default_factory=list)

    def in_window(self, day: str) -> bool:
        if not self.window:
            return False
        return self.window[0] <= day <= self.window[1]

    def to_dict(self) -> dict:
        return {
            "assumption": self.assumption,
            "opening": self.opening,
            "days": self.days,
            "breach_days": self.breach_days,
            "window": list(self.window) if self.window else None,
            "min_balance": self.min_balance,
            "min_date": self.min_date,
            "official_min": self.official_min,
            "extra_outflows": self.extra_outflows,
        }


def forecast(dr: DataRoom, assumption: CollectionAssumption | None = None,
             extra_outflows: list[dict] | None = None) -> ForecastResult:
    """extra_outflows: [{'date': 'YYYY-MM-DD', 'amount_krw': n, 'label': ...}] — 신규 약정 시뮬레이션."""
    assumption = assumption or ScheduleAsIs()
    cmin = dr.policy["covenant"]["min_cash_krw"]
    opening = num(dr.table("cash_daily")[-1]["closing_balance"])
    po_ids = {p["po_id"] for p in dr.table("po")}
    col: dict[date, float] = {}
    pay: dict[date, float] = {}
    oth: dict[date, float] = {}
    ext: dict[date, float] = {}
    for r in dr.table("ar"):
        due = assumption.due(r)
        if due is None:
            continue
        k = next_business(due)
        col[k] = col.get(k, 0) + num(r["outstanding_krw"])
    for r in dr.table("ap"):
        if r["po_id"] != "NONE" and r["po_id"] in po_ids:
            continue  # 이중계상 금지
        k = next_business(d(r["payment_due_date"]))
        pay[k] = pay.get(k, 0) + num(r["amount_krw"])
    for r in dr.table("po"):
        k = next_business(d(r["payment_due_date"]))
        oth[k] = oth.get(k, 0) + num(r["amount_krw"])
    for e in extra_outflows or []:
        k = next_business(d(e["date"]))
        ext[k] = ext.get(k, 0) + float(e["amount_krw"])

    bal = opening
    days, breach = [], []
    for day in business_days(AS_OF, HORIZON_END):
        i, p, o, x = col.get(day, 0), pay.get(day, 0), oth.get(day, 0), ext.get(day, 0)
        bal = bal + i - p - o - x
        iso = day.isoformat()
        days.append({"date": iso, "inflow": i, "ap": p, "po": o, "extra": x, "closing": bal,
                     "breach": bal < cmin})
        if bal < cmin:
            breach.append(iso)
    mn = min(days, key=lambda r: r["closing"])
    official_min = min(num(r["projected_closing_krw"]) for r in dr.table("cash_forecast"))
    return ForecastResult(
        assumption=assumption.name, opening=opening, days=days, breach_days=breach,
        window=(breach[0], breach[-1]) if breach else None,
        min_balance=mn["closing"], min_date=mn["date"], official_min=official_min,
        extra_outflows=list(extra_outflows or []),
    )


def history_check(dr: DataRoom) -> dict:
    """실적 구간 항등식 검증(closing = opening + inflow − outflow)."""
    rows = dr.table("cash_daily")
    bad = [r["date"] for r in rows
           if abs(num(r["opening_balance"]) + num(r["inflow_krw"]) - num(r["outflow_krw"])
                  - num(r["closing_balance"])) > 1]
    return {"rows": len(rows), "identity_violations": bad,
            "historical_breaches": sum(r["breach_flag"] == "True" for r in rows)}
