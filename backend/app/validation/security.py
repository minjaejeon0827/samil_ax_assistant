"""보안1(check_input) · 보안2(check_output).

check_input  : LLM/판단 파이프라인 '앞'에서 막는다 → block이면 LLM 호출 0회.
check_output : 화면·MCP 채널로 나가는 텍스트의 민감정보를 masked_text로 가린다.
               (에이전시 회신에 담당자 휴대폰·지급 계좌가 섞여 들어오는 실제 상황을 가정)
"""
from __future__ import annotations

import re

from .text import fold_confusables, fold_width, normalize, squeeze, strip_invisible

INJECTION = [
    "이전 지시 무시", "이전지시무시", "ignore previous", "ignore all previous", "system prompt",
    "시스템 프롬프트", "<|im_start|>", "</s>", "승인된 것으로 처리", "승인으로 간주", "관리자 권한으로",
]
# F-03: 고정 문구만 보던 방식은 조사·어순만 바꿔도 통과('이전 지시를 무시하고', 'Ignore the previous instructions')
#       → 흔한 변형을 정규식으로 함께 본다. 브라우저 판(validation.ts)과 같은 식.
INJECTION_RE = [
    re.compile(r"(이전|앞|위|기존|모든|지금까지|위의|앞의)\s*(의|에서)?\s*(모든\s*)?(지시|명령|지침|규칙|설정|프롬프트|규정)\s*(사항|들)?\s*(을|를|은|는|도)?\s*(모두|전부|다)?\s*(무시|잊어|잊고|따르지\s*(말|않))"),
    re.compile(r"\b(ignore|disregard|forget|override)\b[\w\s,']{0,30}?\b(previous|prior|above|earlier|preceding|all|system)\b[\w\s']{0,20}?\b(instructions?|prompts?|rules|directions|guidelines)\b"),
]
ILLEGAL = ["리베이트 현금", "허위 세금계산서", "뒷돈", "비자금"]

PHONE = re.compile(r"01[016789]-?\d{3,4}-?\d{4}")
ACCOUNT = re.compile(r"\b\d{3}-\d{2,6}-\d{4,8}\b")
RRN = re.compile(r"\b\d{6}-[1-4]\d{6}\b")
EMAIL = re.compile(r"([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")   # V-02: 이메일도 연락처
LEAK = ["sk-", "api_key=", "x-api-key:"]


def _hit(patterns: list[str], text: str) -> str | None:
    n, s = normalize(text), squeeze(text)
    for p in patterns:
        pn = normalize(p)
        if pn in n or pn.replace(" ", "") in s:
            return p
    return None


def _hit_re(patterns: list[re.Pattern], text: str) -> str | None:
    n, s = normalize(text), squeeze(text)
    for rx in patterns:
        m = rx.search(n) or rx.search(s)
        if m:
            return m.group(0)
    return None


def check_input(text: str) -> dict:
    if not text or not text.strip():
        return {"action": "warn", "message": "입력 내용이 비어 있습니다. 사건 내용을 한 줄 이상 적어 주세요."}
    if (p := _hit(INJECTION, text) or _hit_re(INJECTION_RE, text)) is not None:
        return {"action": "block", "message": f"승인 절차를 우회하려는 지시('{p}')가 포함되어 처리하지 않습니다."}
    if (p := _hit(ILLEGAL, text)) is not None:
        return {"action": "block", "message": f"부정 지급이 의심되는 표현('{p}')이 있어 내부감시로 이관합니다."}
    if len(normalize(text)) < 4:
        return {"action": "warn", "message": "내용이 너무 짧아 판단할 수 없습니다. 대상(계약/기안 ID)과 요청을 적어 주세요."}
    return {"action": "pass", "message": ""}


def check_output(text: str) -> dict:
    if text is None:
        text = ""
    # V-01: 보이지 않는 문자를 지우고 전각 숫자를 반각으로 맞춘 뒤 검사(기존: '010-12\u200b34-5678'은 그대로 나감)
    clean = fold_width(strip_invisible(text))
    if any(k in fold_confusables(clean).lower() for k in LEAK):
        return {"action": "block", "message": "시스템 비밀값으로 보이는 문자열이 있어 내보내지 않습니다.", "masked_text": ""}
    masked = PHONE.sub(lambda m: m.group(0)[:3] + "-****-****", clean)
    masked = ACCOUNT.sub("***-***-******", masked)
    masked = RRN.sub("******-*******", masked)
    masked = EMAIL.sub(lambda m: f"{m.group(1)}***@{m.group(2)}", masked)
    if masked != clean:
        return {"action": "warn", "message": "연락처·이메일·계좌 등 민감정보를 가렸습니다.", "masked_text": masked}
    return {"action": "pass", "message": "", "masked_text": text}
