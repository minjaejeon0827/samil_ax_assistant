"""캠페인·인플루언서 실질 공헌이익 (calculation_definitions §1.4 + A05 §5).

중요한 스케일 규칙(data_dictionary §6):
- mkt_* 계열은 '대표 표본'이다. 여기서 나온 값은 비중·순위·비율로만 쓴다.
- 풀스케일 계약 금액(고정 피 28억)과 곱하거나 합산하지 않는다 → 나란히 놓는다.

공헌이익(A05 우선, 가정 A-03):
  Net Revenue = GMV(쿠폰 반영 후) − 반품환불액
  CP = Net Revenue − COGS − 마케팅비(ad_cost_krw 전액) − 채널수수료 − 배송비 − 반품물류비
  cp_alt = CP − 쿠폰(계산정의 문자 그대로 적용한 대안 시나리오)
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass

from .data import DataRoom, num


@dataclass
class CampaignPerf:
    campaign_id: str
    campaign_name: str
    influencer_id: str
    product_line: str
    country: str
    orders: int
    gmv: float
    coupon: float
    refund: float
    cogs: float
    channel_fee: float
    shipping: float
    return_logistics: float
    spend: float
    cp: float
    cp_alt: float

    @property
    def nominal_roas(self) -> float:
        return self.gmv / self.spend if self.spend else 0.0

    @property
    def real_roas(self) -> float:
        return self.cp / self.spend if self.spend else 0.0

    @property
    def return_rate(self) -> float:
        return self.refund / self.gmv if self.gmv else 0.0

    def to_dict(self) -> dict:
        d = asdict(self)
        d.update(nominal_roas=self.nominal_roas, real_roas=self.real_roas, return_rate=self.return_rate)
        return d


def campaign_performance(dr: DataRoom) -> dict[str, CampaignPerf]:
    cost = {(r["sku_id"], r["channel_id"]): r for r in dr.table("cost_master")}
    refunds: dict[str, float] = defaultdict(float)
    for r in dr.table("returns"):
        refunds[r["order_id"]] += num(r["refund_amount_krw"])
    camps = {c["campaign_id"]: c for c in dr.table("campaigns")}
    acc: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for o in dr.table("orders"):
        cid = o["campaign_id"]
        if cid == "NONE":
            continue
        c = cost[(o["sku_id"], o["channel_id"])]
        gmv = num(o["gmv_krw"])
        ref = refunds.get(o["order_id"], 0.0)
        returned = o["order_id"] in refunds
        a = acc[cid]
        a["orders"] += 1
        a["gmv"] += gmv
        a["coupon"] += num(o["coupon_discount_krw"])
        a["refund"] += ref
        a["cogs"] += num(c["product_cost_krw"])  # 가정 A-01: 주문 1행 = 1개
        a["channel_fee"] += gmv * num(c["channel_fee_pct"]) / 100  # 가정 A-02
        a["shipping"] += num(c["shipping_cost_krw"])
        a["return_logistics"] += num(c["return_logistics_cost_krw"]) if returned else 0.0
    spend: dict[str, float] = defaultdict(float)
    for s in dr.table("ad_spend"):
        spend[s["campaign_id"]] += num(s["ad_cost_krw"])  # 인플루언서+퍼포먼스+오프라인 전액

    out: dict[str, CampaignPerf] = {}
    for cid, a in acc.items():
        net = a["gmv"] - a["refund"]
        cp = net - a["cogs"] - spend[cid] - a["channel_fee"] - a["shipping"] - a["return_logistics"]
        cm = camps[cid]
        out[cid] = CampaignPerf(
            campaign_id=cid, campaign_name=cm["campaign_name"], influencer_id=cm["influencer_id"],
            product_line=cm["product_line"], country=cm["country"], orders=int(a["orders"]),
            gmv=a["gmv"], coupon=a["coupon"], refund=a["refund"], cogs=a["cogs"],
            channel_fee=a["channel_fee"], shipping=a["shipping"], return_logistics=a["return_logistics"],
            spend=spend[cid], cp=cp, cp_alt=cp - a["coupon"],
        )
    return out


def influencer_performance(dr: DataRoom) -> dict[str, dict]:
    camps = campaign_performance(dr)
    infl = {r["influencer_id"]: r for r in dr.table("influencers")}
    plan_by_inf: dict[str, float] = defaultdict(float)
    cmap = {c["campaign_id"]: c["influencer_id"] for c in dr.table("campaigns")}
    for p in dr.table("budget_plan"):
        plan_by_inf[cmap[p["campaign_id"]]] += num(p["requested_budget_krw"])
    agg: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for c in camps.values():
        a = agg[c.influencer_id]
        for k in ("gmv", "spend", "cp", "cp_alt", "refund", "coupon"):
            a[k] += getattr(c, k)
        a["campaigns"] += 1
    total_spend = sum(a["spend"] for a in agg.values())
    total_plan = sum(plan_by_inf.values())
    ranked_cp = sorted(agg, key=lambda i: agg[i]["cp"], reverse=True)
    ranked_spend = sorted(agg, key=lambda i: agg[i]["spend"], reverse=True)
    ranked_gmv = sorted(agg, key=lambda i: agg[i]["gmv"], reverse=True)
    ranked_alt = sorted(agg, key=lambda i: agg[i]["cp_alt"], reverse=True)
    out = {}
    for iid, a in agg.items():
        m = infl[iid]
        out[iid] = {
            "influencer_id": iid,
            "influencer_name": m["influencer_name"],
            "tier": m["tier"],
            "country": m["primary_country"],
            "fee_type": m["fee_type"],
            "campaigns": int(a["campaigns"]),
            "gmv": a["gmv"],
            "spend": a["spend"],
            "cp": a["cp"],
            "cp_alt": a["cp_alt"],
            "nominal_roas": a["gmv"] / a["spend"],
            "real_roas": a["cp"] / a["spend"],
            "return_rate": a["refund"] / a["gmv"],
            "spend_share": a["spend"] / total_spend,
            "plan_share": plan_by_inf[iid] / total_plan if total_plan else 0.0,
            "cp_rank": ranked_cp.index(iid) + 1,
            "cp_alt_rank": ranked_alt.index(iid) + 1,
            "spend_rank": ranked_spend.index(iid) + 1,
            "gmv_rank": ranked_gmv.index(iid) + 1,
            "scale": "SAMPLE",
        }
    return out


def allocation_alignment(inf: dict[str, dict]) -> dict:
    """배분이 성과를 따라가는가: 집행 비중 순위와 실질 공헌이익 순위의 스피어만 상관."""
    ids = list(inf)
    n = len(ids)
    d2 = sum((inf[i]["spend_rank"] - inf[i]["cp_rank"]) ** 2 for i in ids)
    rho = 1 - 6 * d2 / (n * (n * n - 1))
    top = min(ids, key=lambda i: inf[i]["spend_rank"])
    return {
        "spearman_spend_vs_cp": rho,
        "inverted": rho < 0,
        "top_spend_influencer": top,
        "top_spend_share": inf[top]["spend_share"],
        "top_spend_cp_rank": inf[top]["cp_rank"],
        "n": n,
    }


def half_year_trend(dr: DataRoom) -> list[dict]:
    """GMV 성장률 vs 실질 공헌이익 추이(반기). 회의록 요청 사항."""
    cost = {(r["sku_id"], r["channel_id"]): r for r in dr.table("cost_master")}
    refunds: dict[str, float] = defaultdict(float)
    for r in dr.table("returns"):
        refunds[r["order_id"]] += num(r["refund_amount_krw"])

    def half(d: str) -> str:
        return f"{d[:4]}H{1 if int(d[5:7]) <= 6 else 2}"

    acc: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for o in dr.table("orders"):
        c = cost[(o["sku_id"], o["channel_id"])]
        gmv = num(o["gmv_krw"])
        ref = refunds.get(o["order_id"], 0.0)
        h = acc[half(o["order_date"])]
        h["gmv"] += gmv
        h["pre"] += (gmv - ref - num(c["product_cost_krw"]) - gmv * num(c["channel_fee_pct"]) / 100
                     - num(c["shipping_cost_krw"])
                     - (num(c["return_logistics_cost_krw"]) if o["order_id"] in refunds else 0))
    for s in dr.table("ad_spend"):
        acc[half(s["spend_date"])]["spend"] += num(s["ad_cost_krw"])
    rows = []
    prev = None
    for k in sorted(acc):
        h = acc[k]
        cp = h["pre"] - h["spend"]
        row = {"half": k, "gmv": h["gmv"], "cp": cp, "spend": h["spend"],
               "gmv_growth": (h["gmv"] / prev["gmv"] - 1) if prev else None,
               "cp_growth": (cp / prev["cp"] - 1) if prev else None}
        rows.append(row)
        prev = row
    return rows
