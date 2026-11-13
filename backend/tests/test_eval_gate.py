"""평가 게이트 — CI에서 RAG·판단 품질이 기준 아래로 떨어지면 실패."""
from eval.run_eval import decision_metrics, rag_metrics


def test_rag_quality_gate():
    m = rag_metrics()["avg"]
    assert m["context_recall"] >= 0.9 and m["context_precision"] >= 0.8 and m["answer_coverage"] >= 0.9


def test_decision_accuracy_is_primary_metric():
    m = decision_metrics()
    assert m["accuracy"] == 1.0, [r for r in m["rows"] if not r["ok"]]
    assert m["judge_faithfulness_avg"] >= 0.95
