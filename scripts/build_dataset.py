"""원본 → 프론트엔드 데이터셋(JSON) + 백엔드/프론트 판단 일치(parity) 기대값 생성.

python scripts/build_dataset.py
  → frontend/src/data/dataset.json       (브라우저 엔진 입력: 계산된 지표 + 현금 스케줄 + 규칙)
  → shared/parity_expected.json          (같은 입력에서 백엔드가 낸 판단 — 프론트 테스트가 대조)
  → data/derived/*.csv                   (계산 결과 사본: 원본과 분리 보관)
원본(data/raw)은 읽기만 한다.
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.domain.cash import AS_OF  # noqa: E402
from app.domain.data import get_dataroom, num  # noqa: E402
from app.domain.decision import Context, DecisionEngine  # noqa: E402


def main() -> None:
    dr = get_dataroom()
    e = DecisionEngine(dr)
    f = e.facts()
    camps = {c["campaign_id"]: c for c in dr.table("campaigns")}
    plans = []
    for p in dr.table("budget_plan"):
        c = camps[p["campaign_id"]]
        plans.append({"plan_id": p["plan_id"], "campaign_id": p["campaign_id"], "campaign_name": c["campaign_name"],
                      "influencer_id": c["influencer_id"], "product_line": c["product_line"],
                      "requested_budget_krw": num(p["requested_budget_krw"]), "expected_gmv_krw": num(p["expected_gmv_krw"]),
                      "settlement_date": p["settlement_date"], "contract_deadline": p["contract_deadline"]})
    supply = {k: {kk: vv for kk, vv in v.items() if kk != "skus"} | {"skus": v["skus"]} for k, v in f["supply"].items()}
    ds = {
        "_meta": {"as_of": AS_OF.isoformat(), "generated_by": "scripts/build_dataset.py",
                  "scales": {"influencers": "SAMPLE", "campaigns": "SAMPLE", "cash": "FULL", "supply": "FULL", "contract": "FULL"}},
        "policy": dr.policy, "legal_kb": dr.legal_kb, "mock_replies": dr.mock_replies,
        "influencers": f["influencers"], "campaigns": f["campaigns"], "alignment": f["alignment"],
        "trend": f["trend"], "supply": supply, "plans": plans, "plan_total": f["plan_total"],
        "ad_copies": {k: v["draft_copy"] for k, v in dr.ad_copies.items()},
        "cash": {
            "opening": num(dr.table("cash_daily")[-1]["closing_balance"]),
            "ar": [{"id": r["ar_id"], "channel_id": r["channel_id"], "invoice_date": r["invoice_date"],
                    "due_date": r["due_date"], "amount": num(r["outstanding_krw"])} for r in dr.table("ar")],
            "ap": [{"id": r["ap_id"], "due": r["payment_due_date"], "amount": num(r["amount_krw"])}
                   for r in dr.table("ap") if r["po_id"] == "NONE"],
            "po": [{"id": r["po_id"], "due": r["payment_due_date"], "amount": num(r["amount_krw"])} for r in dr.table("po")],
            "official": [{"week": r["week"], "closing": num(r["projected_closing_krw"])} for r in dr.table("cash_forecast")],
            "history_tail": [{"date": r["date"], "closing": num(r["closing_balance"])} for r in dr.table("cash_daily")[-60:]],
        },
    }
    # 정책 RAG 검색 결과(백엔드 FAISS 하이브리드) 사전 계산 — 브라우저 단독 모드에서 같은 근거를 보여주기 위함
    from app.graph.pipeline import run_case
    hits = {}
    for key, ct, tid, cx in [("CONTRACT:base", "CONTRACT", "CT-INF001-2025", {}),
                             ("CONTRACT:counter", "CONTRACT", "CT-INF001-2025", {"offer": dr.mock_replies["agency_counter_offer"], "contract_status": "COUNTER_OFFER"})] + \
                            [(f"PLAN:{p['plan_id']}", "PLAN", p["plan_id"], {}) for p in plans]:
        st = run_case(ct, tid, "사전 계산", cx)
        hits[key] = [{"source": h["source"], "text": h["text"][:260], "score": h["score"]} for h in st["policy_hits"]]
    ds["policy_hits"] = hits
    out = ROOT / "frontend" / "src" / "data"
    out.mkdir(parents=True, exist_ok=True)
    (out / "dataset.json").write_text(json.dumps(ds, ensure_ascii=False), encoding="utf-8")

    # parity 기대값: 대표 조건별 판단
    mr = dr.mock_replies
    off_sched = dict(mr["agency_counter_offer"], payment_schedule=mr["agency_payment_schedule"]["payment_schedule"])
    scen = {
        "base": Context(),
        "legacy45": Context(cash_assumption="LEGACY45"),
        "conservative": Context(cash_assumption="CONSERVATIVE"),
        "counter": Context(offer=mr["agency_counter_offer"], contract_status="COUNTER_OFFER"),
        "counter_sched": Context(offer=off_sched, contract_status="COUNTER_OFFER"),
        "terminated": Context(contract_status="TERMINATION_APPROVED"),
    }
    exp = {}
    for name, ctx in scen.items():
        k = e.decide_contract(ctx)
        exp[name] = {
            "cash_window": list(e.cash(ctx).window) if e.cash(ctx).window else None,
            "cash_min": round(e.cash(ctx).min_balance),
            "contract": {"recommendation": k["recommendation"], "approver": k["approver"], "needs_info": bool(k["needs_info"]),
                         "covenant_override": k["authority"]["covenant_override"]},
            "plans": {p["subject"]["id"]: {"recommendation": p["recommendation"], "approver": p["approver"],
                                           "covenant_override": p["authority"]["covenant_override"],
                                           "copy_action": (p["regulation"] or {}).get("verdict", {}).get("action", "pass")}
                      for p in e.all_plans(ctx)},
        }
    (ROOT / "shared" / "parity_expected.json").write_text(json.dumps(exp, ensure_ascii=False, indent=1), encoding="utf-8")

    der = ROOT / "data" / "derived"
    der.mkdir(parents=True, exist_ok=True)
    with (der / "campaign_contribution.csv").open("w", newline="", encoding="utf-8") as fh:
        cols = ["campaign_id", "campaign_name", "influencer_id", "orders", "gmv", "refund", "cogs", "channel_fee", "shipping",
                "return_logistics", "spend", "cp", "cp_alt", "nominal_roas", "real_roas", "return_rate"]
        w = csv.DictWriter(fh, cols, delimiter="|", extrasaction="ignore")
        w.writeheader()
        for c in f["campaigns"].values():
            w.writerow({k: (round(v, 4) if isinstance(v, float) else v) for k, v in c.items()})
    with (der / "influencer_allocation.csv").open("w", newline="", encoding="utf-8") as fh:
        cols = ["influencer_id", "influencer_name", "spend_share", "spend_rank", "cp", "cp_rank", "cp_alt_rank", "real_roas", "plan_share"]
        w = csv.DictWriter(fh, cols, delimiter="|", extrasaction="ignore")
        w.writeheader()
        for v in sorted(f["influencers"].values(), key=lambda x: x["spend_rank"]):
            w.writerow({k: (round(x, 4) if isinstance(x, float) else x) for k, x in v.items()})
    with (der / "cash_reforecast_13w.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, ["date", "inflow", "ap", "po", "extra", "closing", "breach"], delimiter="|")
        w.writeheader()
        for r in e.cash(Context()).days:
            w.writerow({k: (round(v) if isinstance(v, float) else v) for k, v in r.items()})
    print("dataset.json", round((out / "dataset.json").stat().st_size / 1024), "KB · parity scenarios", list(exp))


if __name__ == "__main__":
    main()
