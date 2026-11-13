"""v1.22(다음 후보 ⑤): 실제 LLM으로 계약서 요약 — 값(금액·날짜·비율) 추출은 계속 규칙이 한다.

LLM은 규칙이 뽑은 '추출값'과 '조항 인용'만 보고 사람이 읽을 요약을 쓴다. 쓴 요약은 규칙 판사(숫자 대조·출력 계약)가
검사해, 추출값에 없는 숫자가 있거나 형식을 어기면 버리고 근거 기반 요약(LLM 미사용)으로 바꾼다. 요약은 판단·결재자·
값에 쓰이지 않는다(참고용). LLM 호출은 접수 작업 스레드에서(명령 잠금 밖), 사용량·토큰 한도 처리는 invoke_llm과 같다.
"""
from __future__ import annotations

from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate

from ..llm.judge import passes, rule_judge
from ..llm.provider import LLMRateLimited, get_llm, invoke_llm

SUMMARY_PROMPT = ChatPromptTemplate.from_messages([
    ("system", "너는 Aurora 그룹의 계약서 요약 보조 AI다(계약서 요약). 아래 '추출값'과 '조항 인용'에 있는 숫자·날짜만 그대로 쓴다. "
               "새 숫자를 만들거나 계산하지 않는다. 출력: ■ 요약(두세 문장) ■ 주의할 조항(각 [조항]) ■ 결재 전 확인할 것."),
    ("human", "계약서: {filename}\n추출값:\n{facts}\n조항 인용:\n{clauses}\n자동 확인:\n{checks}"),
])


def _facts(rec: dict) -> str:
    t = rec.get("terms") or {}
    keys = [("counterparty", "상대방"), ("expiry", "만료일"), ("auto_renew", "자동 갱신"), ("renewal_years", "갱신 기간(년)"),
            ("notice_deadline", "통보 기한"), ("notice_days", "만료 며칠 전"), ("annual_fee_krw", "연간 금액(원)"), ("fee_basis", "금액 근거"),
            ("variable_fee", "변동 보수"), ("currency", "통화(원화 아님)"), ("penalty_pct", "위약금(%)"), ("penalty_base", "위약금 기준"), ("payment", "지급 조건")]
    return "\n".join(f"- {label}: {t[k]}" for k, label in keys if t.get(k) not in (None, "", {}))


def offline_summary(rec: dict) -> str:
    t = rec.get("terms") or {}
    hi = [c["text"] for c in rec.get("checks") or [] if c.get("level") in ("high", "missing")]
    lines = [f"■ 요약: {t.get('counterparty') or '상대방 미상'} 계약 — 만료 {t.get('expiry') or '미확인'}, "
             + (f"자동 갱신(통보 기한 {t.get('notice_deadline') or '미확인'})" if t.get("auto_renew") else ("자동 갱신하지 않음" if t.get("auto_renew") is False else "자동 갱신 여부 미확인"))
             + (f", 연간 금액 {t.get('fee_basis')}" if t.get("fee_basis") else "")]
    if hi:
        lines.append("■ 주의할 조항: " + " / ".join(hi[:3]))
    lines.append("■ 결재 전 확인할 것: 추출값을 원문 조항과 대조하고, '확인 필요' 항목은 담당 부서에 확인")
    return "\n".join(lines)


def summarize(rec: dict) -> dict:
    """→ {"text", "llm", "judge"}. LLM이 없거나 실패하거나 판사를 통과하지 못하면 근거 기반 요약."""
    name, llm = get_llm()
    facts = _facts(rec)
    if llm is None:
        return {"text": offline_summary(rec), "llm": "offline", "judge": None}
    v = {"filename": (rec.get("terms") or {}).get("filename", "계약서"), "facts": facts,
         "clauses": "\n".join(f"[{c['ref']}] {c['text']}" for c in (rec.get("citations") or {}).values()),
         "checks": "\n".join(f"- {c['text']}" for c in rec.get("checks") or [])}
    try:
        out = invoke_llm(SUMMARY_PROMPT | llm | StrOutputParser(), v)
    except LLMRateLimited:
        return {"text": offline_summary(rec), "llm": f"대체문({name} 사용량 한도)", "judge": None}
    except Exception as e:  # noqa: BLE001
        return {"text": offline_summary(rec), "llm": f"대체문({name} 오류 {type(e).__name__})", "judge": None}
    allowed = facts + "\n" + v["clauses"] + "\n" + v["checks"]
    jg = rule_judge(allowed, "", out)
    if not passes(jg):
        return {"text": offline_summary(rec), "llm": f"대체문({name} 판사 불통과)", "judge": jg}
    return {"text": out, "llm": name, "judge": jg}
