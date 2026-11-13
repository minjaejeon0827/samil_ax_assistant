"""평가 하네스 — RAG(RAGAS 지표) + 판단 정확도 + LLM-as-a-Judge.

python -m eval.run_eval            (backend 폴더에서)
  · ragas 패키지 + LLM 키가 있으면 공식 RAGAS(context_precision·context_recall·faithfulness·answer_relevancy)
  · 없으면 같은 정의의 로컬 근사치:
      context_precision = 상위 k개 중 정답 출처 문서 비율(순위 가중 평균정밀도)
      context_recall    = 정답 출처 문서 중 상위 k에 들어온 비율
      answer_coverage   = 정답 핵심어가 검색 문맥에 포함된 비율
      faithfulness      = 판단 설명문 수치가 사실 목록에 있는 비율(LLM-as-a-Judge 규칙 판사)
  · 계약서 교훈: RAGAS는 보조 지표. 최종 지표는 '판단 정확도'(권고·승인자 일치율)다.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.domain.data import get_dataroom  # noqa: E402
from app.domain.decision import Context  # noqa: E402
from app.graph.pipeline import engine, run_case  # noqa: E402
from app.rag.store import get_retriever  # noqa: E402

GOLD = json.loads((Path(__file__).parent / "golden_set.json").read_text(encoding="utf-8"))
K = 4


def _hit(source: str, wanted: list[str]) -> bool:
    return any(w in source for w in wanted)


def rag_metrics() -> dict:
    r = get_retriever()
    rows = []
    for g in GOLD["rag"]:
        hits = r.retrieve(g["q"], k=K)
        rel = [_hit(h["source"], g["sources"]) for h in hits]
        ap, n = 0.0, 0
        for i, ok in enumerate(rel, 1):
            if ok:
                n += 1
                ap += n / i
        precision = ap / max(1, sum(rel)) if any(rel) else 0.0
        recall = sum(any(w in h["source"] for h in hits) for w in g["sources"]) / len(g["sources"])
        ctx = " ".join(h["text"] for h in hits)
        coverage = sum(m in ctx for m in g["must"]) / len(g["must"])
        rows.append({"id": g["id"], "context_precision": precision, "context_recall": recall, "answer_coverage": coverage,
                     "top1": hits[0]["source"]})
    avg = {k: round(sum(x[k] for x in rows) / len(rows), 3) for k in ("context_precision", "context_recall", "answer_coverage")}
    return {"store": r.store_name, "k": K, "avg": avg, "rows": rows}


def decision_metrics() -> dict:
    mr = get_dataroom().mock_replies
    offers = {"counter": mr["agency_counter_offer"],
              "counter_sched": dict(mr["agency_counter_offer"], payment_schedule=mr["agency_payment_schedule"]["payment_schedule"])}
    e = engine()
    rows, faith = [], []
    for g in GOLD["decisions"]:
        ctx = dict(g["ctx"])
        if "offer" in ctx:
            ctx["offer"] = offers[ctx["offer"]]
            ctx["contract_status"] = "COUNTER_OFFER"
        c = Context(**ctx)
        d = e.decide_contract(c) if g["case"] == "CONTRACT" else e.decide_plan(g["case"], c)
        ok = d["recommendation"] == g["expect"]["recommendation"] and d["approver"] == g["expect"]["approver"]
        rows.append({"id": g["id"], "ok": ok, "got": [d["recommendation"], d["approver"]], "expect": g["expect"]})
        s = run_case("CONTRACT" if g["case"] == "CONTRACT" else "PLAN", g["case"] if g["case"] != "CONTRACT" else "CT-INF001-2025",
                     "평가 실행", ctx)
        faith.append(s["judge"]["faithfulness"])
    return {"accuracy": round(sum(r["ok"] for r in rows) / len(rows), 3), "judge_faithfulness_avg": round(sum(faith) / len(faith), 3),
            "rows": rows}


def official_ragas() -> dict | None:  # pragma: no cover - 선택 의존성
    try:
        import os

        from datasets import Dataset
        from ragas import evaluate
        from ragas.metrics import answer_relevancy, context_precision, context_recall, faithfulness
        if not os.getenv("OPENAI_API_KEY"):
            return None
    except Exception:
        return None
    r = get_retriever()
    data = {"question": [], "contexts": [], "answer": [], "ground_truth": []}
    for g in GOLD["rag"]:
        hits = r.retrieve(g["q"], k=K)
        data["question"].append(g["q"])
        data["contexts"].append([h["text"] for h in hits])
        data["answer"].append(hits[0]["text"][:300])
        data["ground_truth"].append(" ".join(g["must"]))
    res = evaluate(Dataset.from_dict(data), metrics=[context_precision, context_recall, faithfulness, answer_relevancy])
    return {k: float(v) for k, v in res.items()}


def main() -> dict:
    out = {"rag": rag_metrics(), "decisions": decision_metrics(), "ragas_official": official_ragas()}
    p = Path(__file__).parent / "eval_report.json"
    p.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"rag": out["rag"]["avg"], "decision_accuracy": out["decisions"]["accuracy"],
                      "judge_faithfulness": out["decisions"]["judge_faithfulness_avg"],
                      "ragas_official": out["ragas_official"]}, ensure_ascii=False))
    return out


if __name__ == "__main__":
    main()
