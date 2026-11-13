"""LangGraph 판단 파이프라인.

  security_input ─(blocked/clarify)→ END
        │
      decide  (결정적 규칙 엔진: 공헌이익·현금·권한·공급·규제)
        │
    regulation (기안 건만: check_regulation 결과 기록)
        │
  retrieve_policy (FAISS 하이브리드 RAG: 권한·계약·covenant 조항)
        │
     explain   (LLM/오프라인: 승인자용 설명문)
        │
      judge    (self_check + LLM-as-a-Judge) ─(reject & retry<1)→ explain
        │
  security_output (check_output: 연락처·계좌 마스킹)
        │
       END

검증 노드 4원칙(계약서 §8.0): 부분 업데이트만 반환 · validation은 기존 값과 병합 ·
차단은 issues에 append · 라우팅은 선언된 필드(status, *_retry_count)로만.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from collections import OrderedDict
from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from ..domain.data import get_dataroom
from ..domain.decision import Context, DecisionEngine
from ..llm.judge import judge, passes, rule_judge
from ..llm.provider import LLMRateLimited, explain_chain, invoke_llm, llm_available, mark_down, offline_explain
from ..rag.store import get_retriever
from ..validation import check_input, check_output, self_check
from ..validation.regulation import regulation_detail

MAX_SELF_CHECK_RETRY = 1


class CaseState(TypedDict, total=False):
    case_type: str            # CONTRACT | PLAN
    target_id: str
    event_text: str
    ctx: dict
    status: str               # ok | blocked | needs_clarification
    issues: list
    validation: dict
    decision: dict
    policy_hits: list
    explanation: str
    judge: dict
    self_check_retry_count: int
    trace: list
    llm: str
    explain_key: str
    judge_cached: dict


_engine: DecisionEngine | None = None


def engine() -> DecisionEngine:
    global _engine
    if _engine is None:
        _engine = DecisionEngine(get_dataroom())
    return _engine


def _t(state: CaseState, node: str, note: str, t0: float) -> list:
    return state.get("trace", []) + [{"node": node, "note": note, "ms": round((time.perf_counter() - t0) * 1000, 1)}]


def security_input_node(state: CaseState) -> dict:
    t0 = time.perf_counter()
    v = check_input(state.get("event_text", ""))
    up: dict[str, Any] = {"validation": {**state.get("validation", {}), "input": v}}
    if v["action"] == "pass":
        up["status"] = "ok"
    else:
        up["status"] = "blocked" if v["action"] == "block" else "needs_clarification"
        up["issues"] = state.get("issues", []) + [{
            "source": "input", "action": "block" if v["action"] == "block" else "reask",
            "reason": "illegal_or_injection" if v["action"] == "block" else "need_clarification",
            "message": v["message"]}]
    up["trace"] = _t(state, "security_input", f"check_input → {v['action']}", t0)
    return up


def decide_node(state: CaseState) -> dict:
    t0 = time.perf_counter()
    ctx = Context(**(state.get("ctx") or {}))
    e = engine()
    d = (e.decide_contract(ctx) if state["case_type"] == "CONTRACT"
         else e.decide_renewal(state["target_id"], ctx) if state["case_type"] == "RENEWAL"   # v1.21(§15-4) 다른 자동 갱신 계약
         else e.decide_plan(state["target_id"], ctx))
    return {"decision": d, "trace": _t(state, "decide", f"권고 {d['recommendation']} · 승인자 {d['approver'] or '확인 필요'}", t0)}


def regulation_node(state: CaseState) -> dict:
    t0 = time.perf_counter()
    d = state["decision"]
    if state["case_type"] != "PLAN" or not d.get("copy"):
        return {"trace": _t(state, "regulation", "대상 아님(계약 건)", t0)}
    r = regulation_detail(d["copy"])
    return {"validation": {**state.get("validation", {}), "regulation": r["verdict"]},
            "trace": _t(state, "regulation", f"check_regulation → {r['verdict']['action']}", t0)}


def retrieve_node(state: CaseState) -> dict:
    t0 = time.perf_counter()
    d = state["decision"]
    rules = " ".join(t["rule"] for t in d["authority"]["trace"])
    # Y-02(13차): 결정의 '사유'도 질의에 넣고, 사유가 된 문서(법 조항·차입 약정·권한표)는 근거에 반드시 포함
    reg = (state.get("validation") or {}).get("regulation") or {}
    extra, need = [], ["approval_authority_policy"]
    if reg.get("action") not in (None, "pass") and reg.get("law"):
        extra.append(f"{reg['law']} {reg.get('reason', '')}")
        need.append(f"legal_kb:{reg['law']}")
    if any("∈ covenant 하회 구간" in e["text"] for e in d["evidence"]):
        extra.append("covenant 최저 잔액 하회 차입 약정 재무 약정")
        need.append("covenant_terms")
    q = f"{d['proposal']} {d['label']} {rules} {' '.join(extra)}"
    hits = get_retriever().retrieve(q, k=max(4, len(need) + 1), require=tuple(need))
    return {"policy_hits": hits, "trace": _t(state, "retrieve_policy", f"정책 조각 {len(hits)}개 ({get_retriever().store_name})", t0)}


ROLE_KO = {"MARKETING_TEAM": "마케팅팀", "MASIL_CEO": "Masil 대표", "GROUP_CEO": "그룹 CEO/이사회", None: "확인 필요"}


def _facts_text(d: dict) -> str:
    return "\n".join(f"[{e['kind']}/{e['scale']}] {e['text']} ({e['source']})" for e in d["evidence"])


def _policy_text(hits: list) -> str:
    return "\n---\n".join(f"[{h['source']}] {h['text']}" for h in hits)


_CACHE: "OrderedDict[str, tuple[str, dict]]" = OrderedDict()   # 입력 해시 → (설명문, 판사 결과)
_CACHE_LOCK = threading.Lock()


def _explain_vars(state: CaseState) -> dict:
    d = state["decision"]
    return {"proposal": d["proposal"], "label": d["label"], "approver": ROLE_KO.get(d["approver"], d["approver"]),
            "facts": _facts_text(d), "policy": _policy_text(state.get("policy_hits", [])),
            "needs_info": "; ".join(d.get("needs_info") or []) or "없음"}


def explain_node(state: CaseState) -> dict:
    t0 = time.perf_counter()
    v = _explain_vars(state)
    name, chain = explain_chain()
    retry = len([t for t in state.get("trace", []) if t["node"] == "explain"]) > 0
    key = hashlib.sha256(json.dumps([name, v], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    if name != "offline" and not retry:
        with _CACHE_LOCK:
            hit = _CACHE.get(key)
        if hit is not None:   # H-04: 판단이 그대로인 건을 다시 볼 때 LLM을 다시 부르지 않는다(판사를 통과한 설명문만 저장)
            return {"explanation": hit[0], "judge_cached": hit[1], "llm": name, "explain_key": "",
                    "trace": _t(state, "explain", f"설명문({name}, 캐시 — LLM 호출 없음)", t0)}
    if name != "offline" and not llm_available():
        return {"explanation": offline_explain(v), "llm": f"대체문({name} 차단 중)",
                "trace": _t(state, "explain", f"{name} 직전 실패로 잠시 차단 → 근거 기반 대체문", t0)}
    try:
        out = invoke_llm(chain, v)
    except LLMRateLimited:   # AD-03: 사용량 한도 — 이 건만 대체문, 차단기는 열지 않음(다른 건은 계속 LLM)
        return {"explanation": offline_explain(v), "llm": f"대체문({name} 사용량 한도)",
                "trace": _t(state, "explain", f"{name} 사용량 한도(429)가 풀리지 않음 → 근거 기반 대체문", t0)}
    except Exception as e:  # noqa: BLE001 — H-02: LLM 오류·시간 초과에도 판단·결재는 계속(근거 기반 대체문)
        mark_down()
        return {"explanation": offline_explain(v), "llm": f"대체문({name} 오류)",
                "trace": _t(state, "explain", f"{name} 실패({type(e).__name__}) → 근거 기반 대체문", t0)}
    return {"explanation": out, "llm": name, "explain_key": key if name != "offline" else "",
            "trace": _t(state, "explain", f"설명문 생성({name})", t0)}


def _remember(key: str, text: str, judged: dict) -> None:
    with _CACHE_LOCK:
        _CACHE[key] = (text, judged)
        while len(_CACHE) > 512:
            _CACHE.popitem(last=False)


def clear_cache() -> None:
    """처음부터(reset) 때 설명문 캐시와 LLM 차단 상태도 비운다."""
    with _CACHE_LOCK:
        _CACHE.clear()
    mark_down(0)


def judge_node(state: CaseState) -> dict:
    t0 = time.perf_counter()
    d = state["decision"]
    sc = self_check(d, {})
    facts = f"{d['proposal']}\n{d['label']}\n{_facts_text(d)}"
    jg = state.get("judge_cached") or judge(facts, _policy_text(state.get("policy_hits", [])), state.get("explanation", ""), d.get("recommendation"))
    up: dict[str, Any] = {"validation": {**state.get("validation", {}), "self_check": sc}, "judge": jg}
    bad = sc["action"] == "reject" or not passes(jg)
    if not bad and state.get("explain_key"):
        _remember(state["explain_key"], state.get("explanation", ""), jg)   # 판사를 통과한 LLM 설명문만 재사용
    if bad and state.get("self_check_retry_count", 0) < MAX_SELF_CHECK_RETRY:
        up["self_check_retry_count"] = state.get("self_check_retry_count", 0) + 1
    up["trace"] = _t(state, "judge", f"self_check {sc['action']} · faithfulness {jg['faithfulness']}", t0)
    return up


def security_output_node(state: CaseState) -> dict:
    t0 = time.perf_counter()
    d = dict(state["decision"])
    verdicts = {}
    explanation, llm, judged = state.get("explanation", ""), state.get("llm"), state.get("judge") or {}
    if not passes(judged) and llm and not str(llm).startswith(("offline", "대체문")):
        # H-01: 재생성까지 했는데도 판사를 통과하지 못한 LLM 설명문은 승인자에게 보여 주지 않고 근거 기반 대체문으로 바꾼다
        bad_issue = (judged.get("issues") or ["판사 기준 미달"])[0]
        explanation = offline_explain(_explain_vars(state))
        judged = {**rule_judge(f"{d['proposal']}\n{d['label']}\n{_facts_text(d)}", _policy_text(state.get("policy_hits", [])), explanation, d.get("recommendation")),
                  "replaced": f"{llm} 설명문 폐기 — {bad_issue}"}
        why = "결론 불일치" if bad_issue.startswith("결론") else "출력 형식 위반" if bad_issue.startswith("출력 형식") else "근거 없는 수치"
        llm = f"대체문({llm} {why})"
    v = check_output(explanation)
    verdicts["explanation"] = v["action"]
    explanation = v["masked_text"] if v["action"] != "block" else ""
    new_ev = []
    for i, e in enumerate(d["evidence"]):
        r = check_output(e["text"])
        verdicts[f"evidence[{i}]"] = r["action"]
        new_ev.append({**e, "text": r["masked_text"]} if r["action"] == "warn" else e)
    d["evidence"] = new_ev
    masked = sum(1 for x in verdicts.values() if x == "warn")
    return {"decision": d, "explanation": explanation, "llm": llm, "judge": judged,
            "validation": {**state.get("validation", {}), "output": verdicts},
            "trace": _t(state, "security_output", f"check_output — 마스킹 {masked}건", t0)}


def route_after_input(state: CaseState) -> str:
    return "end" if state.get("status") != "ok" else "decide"


def route_after_judge(state: CaseState) -> str:
    sc = (state.get("validation") or {}).get("self_check") or {}
    jg = state.get("judge") or {}
    bad = sc.get("action") == "reject" or not passes(jg)
    # 재시도 카운터가 이번 judge에서 올라갔으면 다시 설명, 아니면 진행(상한 1회)
    if bad and state.get("self_check_retry_count", 0) == 1 and len([t for t in state.get("trace", []) if t["node"] == "explain"]) < 2:
        return "explain"
    return "security_output"


def build_graph():
    g = StateGraph(CaseState)
    g.add_node("security_input", security_input_node)
    g.add_node("decide", decide_node)
    g.add_node("regulation", regulation_node)
    g.add_node("retrieve_policy", retrieve_node)
    g.add_node("explain", explain_node)
    g.add_node("judge", judge_node)
    g.add_node("security_output", security_output_node)
    g.set_entry_point("security_input")
    g.add_conditional_edges("security_input", route_after_input, {"decide": "decide", "end": END})
    g.add_edge("decide", "regulation")
    g.add_edge("regulation", "retrieve_policy")
    g.add_edge("retrieve_policy", "explain")
    g.add_edge("explain", "judge")
    g.add_conditional_edges("judge", route_after_judge, {"explain": "explain", "security_output": "security_output"})
    g.add_edge("security_output", END)
    return g.compile()


_graph = None


def warm() -> None:
    """여러 스레드가 동시에 run_case를 부르기 전에 그래프·엔진·검색기를 한 번 만든다."""
    global _graph
    if _graph is None:
        _graph = build_graph()
    engine()
    get_retriever()


def run_case(case_type: str, target_id: str, event_text: str, ctx: dict | None = None) -> CaseState:
    global _graph
    if _graph is None:
        _graph = build_graph()
    return _graph.invoke({"case_type": case_type, "target_id": target_id, "event_text": event_text,
                          "ctx": ctx or {}, "issues": [], "validation": {}, "trace": [],
                          "self_check_retry_count": 0}, {"recursion_limit": 25})
