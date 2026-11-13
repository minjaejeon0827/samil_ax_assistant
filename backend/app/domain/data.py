"""원본 데이터 로더.

- 원본(data/raw)은 읽기만 한다. 수정·덮어쓰기 금지(A05 §1).
- 파이프(|) 구분 CSV, 'NONE' = 해당 없음 코드(0과 구분).
- 싱글톤(Singleton) 패턴: 30MB 남짓한 CSV를 요청마다 다시 읽지 않도록 프로세스당 1회만 적재한다.
"""
from __future__ import annotations

import csv
import json
import threading
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
RAW = ROOT / "data" / "raw"
ASSUMPTIONS = ROOT / "data" / "assumptions"
SHARED = ROOT / "shared"

RAW_FILES = {
    "orders": "02_masil/marketing/mkt_orders_ms.csv",
    "returns": "02_masil/marketing/mkt_returns_ms.csv",
    "coupons": "02_masil/marketing/mkt_coupons_ms.csv",
    "ad_spend": "02_masil/marketing/mkt_ad_spend_ms.csv",
    "cost_master": "02_masil/marketing/mkt_cost_master_ms.csv",
    "budget_plan": "02_masil/marketing/mkt_budget_plan_ms.csv",
    "campaigns": "02_masil/master/m_campaign_ms.csv",
    "influencers": "02_masil/master/m_influencer_ms.csv",
    "channels": "02_masil/master/m_channel_ms.csv",
    "skus": "02_masil/master/m_sku_ms.csv",
    "cash_daily": "02_masil/financials/fin_cash_daily_ms.csv",
    "cash_forecast": "02_masil/financials/fin_cash_forecast_ms.csv",
    "ar": "02_masil/financials/fin_ar_aging_ms.csv",
    "ap": "02_masil/financials/fin_ap_aging_ms.csv",
    "po": "02_masil/inventory/sc_purchase_orders_ms.csv",
    "inventory": "02_masil/inventory/sku_inventory_ms.csv",
    "weekly_sales": "02_masil/inventory/sku_weekly_sales_ms.csv",
    "capacity": "production/strat_capacity_cv.csv",
}


def read_pipe_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as f:
        return [row for row in csv.DictReader(f, delimiter="|")]


def num(v: str | None) -> float:
    """'NONE'은 0이 아니라 '해당 없음'이지만, 금액 합산 맥락에서는 0으로 본다."""
    if v is None or v == "NONE" or v == "":
        return 0.0
    return float(v)


@dataclass
class DataRoom:
    raw_dir: Path = RAW
    _cache: dict[str, list[dict[str, str]]] = field(default_factory=dict)

    def table(self, name: str) -> list[dict[str, str]]:
        if name not in self._cache:
            self._cache[name] = read_pipe_csv(self.raw_dir / RAW_FILES[name])
        return self._cache[name]

    @cached_property
    def policy(self) -> dict[str, Any]:
        return json.loads((SHARED / "policy_rules.json").read_text(encoding="utf-8"))

    @cached_property
    def legal_kb(self) -> dict[str, Any]:
        return json.loads((SHARED / "legal_kb.json").read_text(encoding="utf-8"))

    @cached_property
    def ad_copies(self) -> dict[str, dict[str, str]]:
        rows = read_pipe_csv(ASSUMPTIONS / "ad_copies.csv")
        return {r["plan_id"]: r for r in rows}

    @cached_property
    def mock_replies(self) -> dict[str, Any]:
        return json.loads((ASSUMPTIONS / "mock_replies.json").read_text(encoding="utf-8"))

    def policy_docs(self) -> list[tuple[str, str]]:
        """RAG 인덱싱 대상 원본 정책 문서(경로, 본문)."""
        paths = [
            "00_common/approval_authority_policy.md",
            "00_common/calculation_definitions.md",
            "00_common/data_dictionary.md",
            "00_common/mkt_meeting_notes_ms.md",
            "02_masil/financials/covenant_terms_ms.md",
            "02_masil/financials/lc0001_payment_term_notice.md",
            "02_masil/marketing/inf001_exclusive_contract_notice.md",
        ]
        return [(p, (self.raw_dir / p).read_text(encoding="utf-8")) for p in paths]


_lock = threading.Lock()
_instance: DataRoom | None = None


def get_dataroom() -> DataRoom:
    """싱글톤 접근자. 테스트에서는 reset_dataroom()으로 초기화한다."""
    global _instance
    if _instance is None:
        with _lock:
            if _instance is None:
                _instance = DataRoom()
    return _instance


def reset_dataroom() -> None:
    global _instance
    _instance = None
