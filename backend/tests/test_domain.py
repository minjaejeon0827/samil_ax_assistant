"""도메인 계산 — 원본 데이터에서 독립적으로 재계산한 값과 대조."""
import pytest

from app.domain import cash, metrics, supply
from app.domain.authority import Commitment, resolve_authority
from app.domain.data import get_dataroom

dr = get_dataroom()


def test_sample_scale_has_all_orders_attributed():
    assert len(dr.table("orders")) == 15650
    assert all(o["campaign_id"] != "NONE" for o in dr.table("orders"))


def test_influencer_allocation_is_inverted():
    inf = metrics.influencer_performance(dr)
    h = inf["INF-001"]
    assert h["spend_rank"] == 1 and h["cp_rank"] == 10
    assert h["spend_share"] == pytest.approx(0.4058, abs=1e-3)
    assert h["real_roas"] < 0 < h["nominal_roas"]
    assert h["cp_alt_rank"] == 10                    # 쿠폰 재차감 산식에서도 결론 동일(A-03 민감도)
    assert inf["INF-002"]["cp_rank"] == 1 and inf["INF-002"]["spend_rank"] == 8
    al = metrics.allocation_alignment(inf)
    assert al["inverted"] and al["spearman_spend_vs_cp"] < 0


def test_campaign_cp_identity():
    for c in metrics.campaign_performance(dr).values():
        net = c.gmv - c.refund
        assert c.cp == pytest.approx(net - c.cogs - c.spend - c.channel_fee - c.shipping - c.return_logistics)


def test_ad_spend_total_matches_raw():
    total = sum(float(r["ad_cost_krw"]) for r in dr.table("ad_spend"))
    assert sum(c.spend for c in metrics.campaign_performance(dr).values()) == pytest.approx(total)


def test_gmv_grows_while_cp_falls_in_2026h1():
    t = metrics.half_year_trend(dr)[-1]
    assert t["half"] == "2026H1" and t["gmv_growth"] > 0 > t["cp_growth"]


def test_cash_history_identity_and_no_past_breach():
    h = cash.history_check(dr)
    assert h["identity_violations"] == [] and h["historical_breaches"] == 0


def test_reforecast_finds_breach_that_official_forecast_misses():
    f = cash.forecast(dr)
    assert f.window == ("2026-07-21", "2026-08-21")
    assert len(f.breach_days) == 24
    assert f.min_balance == pytest.approx(1_647_835_595, abs=1)
    assert f.official_min > 3e9                       # 공식 전망(재무팀 주장)은 하회 없음


def test_no_double_count_of_po_in_ap():
    po_total = sum(float(r["amount_krw"]) for r in dr.table("po"))
    f = cash.forecast(dr)
    assert sum(d["po"] for d in f.days) == pytest.approx(po_total)
    linked_ap = sum(float(r["amount_krw"]) for r in dr.table("ap") if r["po_id"] != "NONE")
    assert sum(d["ap"] for d in f.days) < sum(float(r["amount_krw"]) for r in dr.table("ap")) - linked_ap + 1


def test_legacy_45day_assumption_explains_official_forecast():
    assert cash.forecast(dr, cash.LegacyTerms45()).window is None


def test_conservative_extends_window():
    f = cash.forecast(dr, cash.ScheduleAsIs(include_overdue=False))
    assert f.window == ("2026-07-21", "2026-08-28")


def test_derma_supply_constrained():
    s = supply.category_supply(dr)
    assert s["더마"]["constrained"] and s["더마"]["line_utilization_pct"] == 97
    assert not s["기초"]["constrained"]


@pytest.mark.parametrize("kind,amount,dates,total,fee,window,expect,override", [
    ("CAMPAIGN_PLAN", 5_000_000, ["2026-09-10"], 50_000_000, 0, None, "MARKETING_TEAM", False),
    ("CAMPAIGN_PLAN", 5_000_000, ["2026-09-10"], 180_000_000, 0, None, "MASIL_CEO", False),   # 기안 총액 1억 초과
    ("CAMPAIGN_PLAN", 15_000_000, ["2026-09-10"], 50_000_000, 0, None, "MASIL_CEO", False),
    ("CAMPAIGN_PLAN", 2_000_000, ["2026-08-01"], 50_000_000, 0, ("2026-07-21", "2026-08-21"), "GROUP_CEO", True),  # 소액도 상신
    ("EXCLUSIVE_CONTRACT", 0, ["2026-09-01"], 0, 2_800_000_000, None, "GROUP_CEO", False),
    ("EXCLUSIVE_CONTRACT", 0, ["2026-09-01"], 0, 900_000_000, None, "MASIL_CEO", False),
])
def test_authority_chain(kind, amount, dates, total, fee, window, expect, override):
    d = resolve_authority(Commitment("X", kind, amount, dates, plan_total_krw=total, annual_fee_krw=fee), dr.policy, window)
    assert d.approver == expect and d.covenant_override is override
    assert d.trace, "판정 경로가 남아야 한다"


def test_unknown_cash_date_needs_info():
    d = resolve_authority(Commitment("X", "EXCLUSIVE_CONTRACT", 0, None, annual_fee_krw=1.8e9), dr.policy, ("2026-07-21", "2026-08-21"))
    assert d.needs_info and d.approver == "GROUP_CEO"
