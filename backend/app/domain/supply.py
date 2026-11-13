"""제품군 공급 여력 점검 (다른 부서 영향: SCM·Corevia 생산).

재고 커버(주) = on_hand_qty / 최근 4주 평균 판매량 (calculation_definitions §1.3, in_transit 미합산).
캠페인 확대는 해당 제품군 수요를 늘린다(가정 A-10). 커버가 안전재고 하한 미만이고
리드타임이 캠페인 기간보다 길면 '공급 제약'으로 판정한다.
"""
from __future__ import annotations

from collections import defaultdict

from .data import DataRoom, num

LINE_BY_CATEGORY = {"더마": "PL-02", "기초": "PL-01", "색조": "PL-04", "선케어": "PL-03", "헤어": "PL-05", "바디": "PL-06"}


def category_supply(dr: DataRoom) -> dict[str, dict]:
    skus = {s["sku_id"]: s for s in dr.table("skus")}
    weekly: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for r in dr.table("weekly_sales"):
        weekly[r["sku_id"]].append((r["week"], num(r["sold_qty"])))
    util = {c["product_id"]: num(c["utilization_pct"]) for c in dr.table("capacity")}
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for inv in dr.table("inventory"):
        sid = inv["sku_id"]
        last4 = sorted(weekly[sid])[-4:]
        avg = sum(q for _, q in last4) / len(last4)
        s = skus[sid]
        by_cat[s["category"]].append({
            "sku_id": sid, "sku_name": s["sku_name"], "on_hand": num(inv["on_hand_qty"]),
            "in_transit": num(inv["in_transit_qty"]), "avg4w": avg,
            "cover_weeks": num(inv["on_hand_qty"]) / avg if avg else 0.0,
            "safety_min": num(s["safety_stock_weeks_min"]), "lead_time_weeks": num(s["lead_time_weeks"]),
        })
    out = {}
    alert_util = dr.policy["supply"]["line_utilization_alert_pct"]
    for cat, rows in by_cat.items():
        worst = min(rows, key=lambda r: r["cover_weeks"])
        pl = LINE_BY_CATEGORY.get(cat)
        u = util.get(pl or "", 0.0)
        constrained = worst["cover_weeks"] < worst["safety_min"]
        out[cat] = {
            "category": cat, "product_id": pl, "min_cover_weeks": worst["cover_weeks"],
            "min_cover_sku": worst["sku_id"], "safety_min": worst["safety_min"],
            "lead_time_weeks": worst["lead_time_weeks"], "line_utilization_pct": u,
            "constrained": constrained, "line_saturated": u >= alert_util, "skus": rows,
        }
    return out
