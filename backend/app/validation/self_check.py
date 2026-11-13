"""self_check — 판단 결과의 근거 유무·완결성 (품질 '되돌림' = reject).

검사 규칙(A 규칙형, LLM 호출 0회)
1. 권고(recommendation)가 있어야 한다.
2. 근거(evidence)가 1개 이상이며 각 근거는 출처 종류(원본/계산/가정/주장/모의)를 가져야 한다.
3. 대안(alternatives)이 1개 이상.
4. 승인자(approver)가 정해져 있거나, 확인 필요(needs_info) 사유가 있어야 한다.
5. 표본 금액과 풀스케일 금액을 곱한 값이 근거에 섞이면 안 된다(data_dictionary §6) → warn.
"""
from __future__ import annotations

KINDS = {"ORIGINAL", "CALC", "ASSUMPTION", "CLAIM", "MOCK"}


def self_check(result: dict, context: dict) -> dict:
    reasons: list[str] = []
    warns: list[str] = []
    if not result.get("recommendation"):
        reasons.append("권고 없음")
    ev = result.get("evidence") or []
    if not ev:
        reasons.append("판단 근거 없음")
    elif any(e.get("kind") not in KINDS for e in ev):
        reasons.append("출처 종류가 없는 근거 포함")
    if not result.get("alternatives"):
        reasons.append("대안 없음")
    if not result.get("approver") and not result.get("needs_info"):
        reasons.append("승인자·확인필요 사유 모두 없음")
    if any(e.get("mixes_scale") for e in ev):
        warns.append("표본×풀스케일 혼합 근거")
    if reasons:
        return {"action": "reject", "reasons": reasons, "message": "판단 결과에 근거·대안이 부족해 다시 생성합니다."}
    if warns:
        return {"action": "warn", "reasons": warns, "message": "근거 일부가 약합니다(로그 기록)."}
    return {"action": "pass", "reasons": [], "message": ""}
