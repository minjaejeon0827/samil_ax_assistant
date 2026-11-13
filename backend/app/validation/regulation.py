"""check_regulation — 인플루언서 광고 카피의 표시광고법·화장품법·추천보증 심사지침 검증.

계약서 v1.2 준수 사항
- 1단: 키워드 스크리닝(normalize·squeeze 양쪽, 예외 표현도 같은 기준으로 마스킹).
- 2단: RAG로 조문 검색 → (LLM이 있으면) LLM 판정. `law`는 LLM 값이 아니라 검색·매칭된 조문에서 코드가 채운다.
- warn이면 alternative를 반드시 채우고, message 안에 대안을 문장으로 넣는다(서비스 계약에서 별도 필드는 버려짐).
- _safe_alternative(): 제시 대안을 1단에 다시 넣어 걸리면 다음 대안으로 폴백(무한 루프 방지).
- 반환 dict는 pass일 때도 5개 키를 모두 채운다.
"""
from __future__ import annotations

from functools import lru_cache

from ..domain.data import get_dataroom
from .text import normalize, squeeze

PASS = {"action": "pass", "law": "", "reason": "", "alternative": "", "message": ""}
ORDER = {"pass": 0, "warn": 1, "block": 2}


@lru_cache(maxsize=1)
def _rules() -> tuple[dict, ...]:
    return tuple(get_dataroom().legal_kb["rules"])


def _mask_exceptions(text: str, exceptions: list[str]) -> tuple[str, str]:
    n, s = normalize(text), squeeze(text)
    for e in exceptions:
        en = normalize(e)
        n = n.replace(en, " ")
        s = s.replace(en.replace(" ", ""), "")
    return n, s


def _trigger_hits(text: str, rule: dict) -> list[str]:
    n, s = _mask_exceptions(text, rule.get("exceptions", []))
    hits = []
    for t in rule.get("triggers", []):
        tn = normalize(t)
        if tn in n or tn.replace(" ", "") in s:
            hits.append(t)
    return hits


def screen(text: str) -> list[dict]:
    """1단 스크리닝 — 위반 후보 목록."""
    findings = []
    low = normalize(text)
    for r in _rules():
        if r["type"] == "trigger":
            hits = _trigger_hits(text, r)
            if hits:
                findings.append({"rule": r, "hits": hits})
        elif r["type"] == "required_disclosure":
            if not any(normalize(k) in low for k in r["required_any"]):
                findings.append({"rule": r, "hits": ["(공개 문구 없음)"]})
    return findings


def _passes_stage1(phrase: str) -> bool:
    return not any(f for f in screen(phrase) if f["rule"]["type"] == "trigger")


def _safe_alternative(rule: dict) -> str:
    for alt in rule.get("alternatives", []):
        if _passes_stage1(alt):
            return alt
    return "표현을 사실 위주로 바꿔 주세요"


def suggest_rewrite(text: str, findings: list[dict]) -> str:
    """위반 표현을 안전 대안으로 치환한 수정안(1단 기준). LLM 없이도 동작하는 결정적 재작성."""
    out = text
    for f in findings:
        r = f["rule"]
        if r["type"] == "trigger":
            # 긴 표현부터 치환해야 '재생까지 책임지는'이 '재생'보다 먼저 바뀐다
            for src, dst in sorted(r.get("replace", {}).items(), key=lambda kv: -len(kv[0])):
                out = out.replace(src, dst)
        elif r["type"] == "required_disclosure":
            out = f"#광고 {out}"
    return " ".join(out.split())


def check_regulation(copy: str) -> dict:
    findings = screen(copy or "")
    if not findings:
        return dict(PASS)
    worst = max(findings, key=lambda f: ORDER[f["rule"]["action"]])
    r = worst["rule"]
    alt = _safe_alternative(r)
    hits = ", ".join(f"'{h}'" for h in worst["hits"])
    others = [f["rule"]["law"] for f in findings if f is not worst]
    extra = f" (그 밖에 {', '.join(others)} 검토 필요)" if others else ""
    if r["type"] == "required_disclosure":
        head = "광고·협찬 표시가 없어요"
    else:
        head = f"{hits} 표현이 걸려요"
    if r["action"] == "block":
        msg = f"{head} — {r['reason']}({r['law']}). 집행할 수 없으니 '{alt}' 같은 표현으로 바꿔 주세요.{extra}"
    else:
        msg = f"{head} — {r['reason']}({r['law']}). 대신 '{alt}' 같은 표현은 어떨까요?{extra}"
    return {
        "action": r["action"],
        "law": r["law"],          # 코드가 KB 조문에서 채움(LLM 값 사용 안 함)
        "reason": r["reason"],
        "alternative": alt,
        "message": msg,
    }


def regulation_detail(copy: str) -> dict:
    """화면·감사 로그용 상세(모든 위반 후보 + 수정안)."""
    findings = screen(copy or "")
    return {
        "verdict": check_regulation(copy),
        "findings": [{"id": f["rule"]["id"], "law": f["rule"]["law"], "title": f["rule"]["title"],
                      "action": f["rule"]["action"], "hits": f["hits"]} for f in findings],
        "rewrite": suggest_rewrite(copy, findings) if findings else copy,
    }
