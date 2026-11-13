"""LLM-as-a-Judge — 판단 설명문의 충실성 채점.

- LLM이 있으면 JUDGE_PROMPT로 채점(JSON).
- 없으면 결정적 규칙 판사: 설명문의 숫자 토큰이 사실 목록에 모두 있는지(faithfulness),
  정책 출처를 1개 이상 인용했는지(policy_grounded)를 잰다.
- 판정이 기준 미달이면 그래프가 설명문을 1회 재생성한다(계약서 V-03: self_check 재시도 1회).
- v1.12(12차 X-01): 결론 일치 검사. 숫자가 모두 맞아도 설명문의 결론이 규칙 판단과 반대면(예: 규칙은 '역제안 수용 비권고'인데
  '원안대로 승인을 권고합니다') 충실도 0 → 재생성 → 그래도 반대면 승인자에게 보이지 않고 근거 기반 대체문으로 바뀐다.
  기존에는 숫자만 대조해, 결론이 뒤집힌 LLM 설명문이 판사(관대한 LLM 판사 포함)를 통과해 결재 서류에 그대로 실렸다.
"""
from __future__ import annotations

import json
import re

from langchain_core.output_parsers import StrOutputParser

from .provider import JUDGE_PROMPT, LLMRateLimited, get_llm, invoke_llm, llm_available, mark_down

NUM = re.compile(r"-?\d[\d,]*\.?\d*")


LIST_MARK = re.compile(r"^\s*\d+\.\s", re.M)
IDS = re.compile(r"[A-Z]{2,}-[\w\-~]+|\d{4}-\d{2}-\d{2}")


def _nums(text: str) -> set[str]:
    """설명문의 '주장 수치'만 뽑는다. 목록 번호·ID·날짜는 숫자 주장이 아니므로 제외(날짜는 별도 대조)."""
    t = IDS.sub(" ", LIST_MARK.sub("", text))
    return {n.replace(",", "").rstrip(".") for n in NUM.findall(t) if len(n.replace(",", "").replace(".", "")) >= 2}


POSITIVE = re.compile(r"(승인|수용|원안|동일\s*조건\s*갱신|그대로\s*진행)\s*(을|를|이|하는\s*것을)?\s*(권고|권장|추천|바람직|유리)")
NEGATIVE = re.compile(r"(비권고|부결|거절|반려|보류|미갱신|불가)")


def _conclusion(answer: str) -> str:
    lines = [ln for ln in (answer or "").splitlines() if ln.strip()]
    return next((ln for ln in lines if "결론" in ln), lines[0] if lines else "")


def contradicts(reco: str | None, answer: str) -> bool:
    """설명문의 결론 줄이 규칙 판단(recommendation)과 반대 방향인가."""
    if not reco:
        return False
    line = _conclusion(answer)
    if reco == "APPROVE":
        return bool(NEGATIVE.search(line)) and not POSITIVE.search(line)
    if reco == "CONDITIONAL" and ("조건부" in line or "축소" in line):
        return False
    return bool(POSITIVE.search(line)) and "비권고" not in line


MAX_EXPLAIN = 1500
TAG = re.compile(r"<\s*/?\s*[a-zA-Z][^>]*>|\]\(\s*https?://|javascript:", re.I)
HANGUL = re.compile(r"[가-힣]")


def contract_issues(answer: str) -> list[str]:
    """AA-04(14차): 설명문 출력 계약 — 1,500자 이하, 한국어, 태그·외부 링크 없음.
    기존에는 숫자·결론만 봐서 2만 자 글·영어 글·<script>·피싱 링크가 결재 서류에 그대로 실렸다(스냅샷도 4배로 커짐)."""
    out = []
    if len(answer or "") > MAX_EXPLAIN:
        out.append(f"출력 형식 위반: {len(answer)}자(최대 {MAX_EXPLAIN}자)")
    if len(HANGUL.findall(answer or "")) < 10:
        out.append("출력 형식 위반: 한국어 설명이 아님")
    if TAG.search(answer or ""):
        out.append("출력 형식 위반: HTML 태그·외부 링크 포함")
    return out


def rule_judge(facts: str, policy: str, answer: str, reco: str | None = None) -> dict:
    a, f = _nums(answer), _nums(facts + "\n" + policy)
    unsupported = sorted(x for x in a if x not in f)
    faith = 1.0 if not a else 1 - len(unsupported) / len(a)
    grounded = 1.0 if ("정책 근거" in answer or "approval_authority" in answer or "§" in answer) else 0.5
    issues = [f"사실 목록에 없는 수치: {', '.join(unsupported[:5])}"] if unsupported else []
    bad_form = contract_issues(answer)
    if bad_form:
        faith = 0.0
        issues = issues + bad_form
    if contradicts(reco, answer):
        faith = 0.0
        issues.insert(0, f"결론이 규칙 판단과 반대(규칙 권고: {reco}) — '{_conclusion(answer).strip()[:60]}'")
    return {"faithfulness": round(faith, 3), "policy_grounded": grounded, "issues": issues, "judge": "rule"}


def judge(facts: str, policy: str, answer: str, reco: str | None = None) -> dict:
    name, llm = get_llm()
    if llm is None:
        return rule_judge(facts, policy, answer, reco)
    rule = rule_judge(facts, policy, answer, reco)
    if not llm_available():   # 직전에 LLM이 실패했으면 판사도 부르지 않는다(회로 차단)
        return {**rule, "judge": f"rule({name} 차단 중)"}
    try:
        raw = invoke_llm(JUDGE_PROMPT | llm | StrOutputParser(), {"facts": facts, "policy": policy, "answer": answer})
        out = json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    except LLMRateLimited:   # AD-03: 사용량 한도는 장애가 아님 — 차단기를 열지 않는다
        return {**rule, "judge": f"rule({name} 사용량 한도)"}
    except Exception as e:  # LLM 판사 실패(오류·시간 초과·파싱) → 규칙 판사 결과만
        if not isinstance(e, ValueError):   # 파싱 실패는 LLM 장애가 아님
            mark_down()
        return {**rule, "judge": f"rule({name} 판사 실패)"}
    # H-01: LLM 판사가 관대해도 규칙 판사가 찾은 '사실 목록에 없는 수치'를 덮어쓰지 못하게 더 엄격한 쪽을 택한다
    return {"faithfulness": round(min(float(out.get("faithfulness", 0)), rule["faithfulness"]), 3),
            "policy_grounded": round(min(float(out.get("policy_grounded", 0)), rule["policy_grounded"]), 3) if out.get("policy_grounded") is not None else rule["policy_grounded"],
            "issues": list(dict.fromkeys(rule["issues"] + [str(i) for i in (out.get("issues") or [])])),
            "judge": f"{name}+rule"}


def passes(score: dict, faith_min: float = 0.9) -> bool:
    return score.get("faithfulness", 0) >= faith_min
