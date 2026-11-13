"""LLM 제공자 — 전략(Strategy) 패턴 + LangChain LCEL.

LLM이 맡는 일(운영 중 AI 역할)
  1) 결정 패키지를 승인자가 읽을 '판단 설명문'으로 쓴다(근거 인용·숫자는 사실 목록에서만).
  2) LLM-as-a-Judge로 설명문이 사실·정책 근거에 충실한지 채점한다.
계산·권한 판정은 LLM에 맡기지 않는다(결정적 규칙 엔진). → 환각이 권한·금액을 바꿀 수 없다.

- LLM_PROVIDER=openai(OPENAI_API_KEY) | anthropic(ANTHROPIC_API_KEY) | offline(기본)
- offline: 외부 호출 없이 템플릿으로 같은 형식의 출력을 만든다(시연·CI 재현성).
- v1.5(5차 E2E): 호출 제한 시간(LLM_TIMEOUT_S, 기본 8초)·재시도 1회. 기존에는 제한이 없어 LLM이 응답하지 않으면
  접수가 끝나지 않았다(H-03). 클라이언트는 한 번만 만들어 재사용한다.
"""
from __future__ import annotations

import os
import random
import threading
import time
import uuid
from contextvars import ContextVar
from functools import lru_cache

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import Runnable, RunnableLambda

EXPLAIN_PROMPT = ChatPromptTemplate.from_messages([
    ("system",
     "너는 Aurora 그룹의 운영 판단 보조 AI다. 아래 '사실 목록'과 '정책 발췌'에 있는 숫자·조항만 사용한다. "
     "표본(SAMPLE) 수치와 풀스케일(FULL) 금액을 곱하지 않는다. 부서 주장(CLAIM)은 사실로 쓰지 않는다. "
     "출력: 1) 결론 한 줄 2) 근거 3개(각 [출처]) 3) 승인자와 이유 4) 대안 5) 확인 필요 사항."),
    ("human", "제안: {proposal}\n권고: {label}\n승인자: {approver}\n사실 목록:\n{facts}\n정책 발췌:\n{policy}\n확인 필요: {needs_info}"),
])

JUDGE_PROMPT = ChatPromptTemplate.from_messages([
    ("system", "너는 감사인이다. 설명문의 모든 숫자가 사실 목록에 있는지, 결론이 정책 발췌와 모순되지 않는지 채점하라. "
               "JSON으로 {{\"faithfulness\":0~1,\"policy_grounded\":0~1,\"issues\":[...]}}만 출력."),
    ("human", "사실 목록:\n{facts}\n정책 발췌:\n{policy}\n설명문:\n{answer}"),
])


def _offline_explain(msgs) -> str:
    """프롬프트 변수에서 직접 조립하는 결정적 설명문(LLM 미사용 모드)."""
    v = msgs if isinstance(msgs, dict) else {}
    facts = [f for f in v.get("facts", "").split("\n") if f.strip()]
    pol = [p.split("\n")[0] for p in v.get("policy", "").split("\n---\n") if p.strip()]
    lines = [f"■ 결론: {v.get('label','')}", f"■ 제안: {v.get('proposal','')}", "■ 근거:"]
    lines += [f"  {i+1}. {f.strip()}" for i, f in enumerate(facts[:4])]
    lines.append(f"■ 승인자: {v.get('approver','')}")
    if pol:
        lines.append(f"■ 정책 근거: {pol[0][:120]}")
    if v.get("needs_info") and v["needs_info"] != "없음":
        lines.append(f"■ 확인 필요: {v['needs_info']}")
    return "\n".join(lines)


def _offline_runnable() -> Runnable:
    return RunnableLambda(_offline_explain)


_DOWN_UNTIL = {"t": 0.0}


def mark_down(seconds: float | None = None) -> None:
    """회로 차단기: LLM 호출이 실패하면 잠시(기본 60초) LLM을 쓰지 않고 바로 대체문으로 간다.
    기존에는 실패한 LLM을 건마다 다시 불러, 기안 25건이면 '시간 초과 × 25'를 기다려야 했다."""
    _DOWN_UNTIL["t"] = time.monotonic() + (seconds if seconds is not None else float(os.getenv("LLM_COOLDOWN_S", "60")))


def llm_available() -> bool:
    return time.monotonic() >= _DOWN_UNTIL["t"]


class LLMRateLimited(Exception):
    """AD-03(17차): 제공자 사용량 한도(429)가 기다릴 수 있는 시간(LLM_RATE_WAIT_S) 안에 풀리지 않음."""


def is_rate_limited(e: BaseException) -> bool:
    """OpenAI·Anthropic 클라이언트의 RateLimitError(HTTP 429)인가."""
    return getattr(e, "status_code", None) == 429 or "RateLimit" in type(e).__name__


def _retry_after(e: BaseException, attempt: int) -> float:
    try:
        v = float(getattr(getattr(e, "response", None), "headers", {}).get("retry-after"))
        if 0 <= v <= 60:
            return v
    except (TypeError, ValueError):
        pass
    return min(8.0, 0.5 * 2 ** attempt)


_SLOTS: dict[str, threading.BoundedSemaphore] = {}
_SLOTS_LOCK = threading.Lock()


def _slots() -> threading.BoundedSemaphore:
    n = max(1, int(os.getenv("LLM_MAX_INFLIGHT", os.getenv("LLM_CONCURRENCY", "16"))))
    with _SLOTS_LOCK:
        if str(n) not in _SLOTS:
            _SLOTS[str(n)] = threading.BoundedSemaphore(n)
        return _SLOTS[str(n)]


class _TokenBudget:
    """v1.22(다음 후보 ⑦): 분당 토큰 한도(LLM_TPM, 창 LLM_TPM_WINDOW_S 기본 60초). 보내기 전에 예상 토큰을 창 안의 사용량과
    더해 보고, 넘으면 가장 오래된 사용분이 창 밖으로 나갈 때까지 기다린다 — 한도를 넘겨 보내고 429를 받는 대신 미리 속도를 맞춘다.
    예상 토큰 = 실제로 채운 메시지 글자 수 ÷ 2 × 1.1(한국어 기준 보수적 근사). 실제 계산과 다를 수 있어 429 처리는 그대로 둔다."""

    def __init__(self) -> None:
        self._log: list[list] = []          # [시각, 토큰] — 시각은 보낸 때, 끝나면 끝난 때로 고침(settle)
        self._cv = threading.Condition()

    def acquire(self, est: int) -> list | None:
        tpm = int(os.getenv("LLM_TPM", "0"))
        if tpm <= 0:
            return None
        win = float(os.getenv("LLM_TPM_WINDOW_S", "60"))
        est = min(est, tpm)
        waited = 0.0
        with self._cv:
            while True:
                now = time.monotonic()
                self._log = [e for e in self._log if now - e[0] < win]
                used = sum(e[1] for e in self._log)
                if used + est <= tpm or not self._log:
                    entry = [now, est]
                    self._log.append(entry)
                    return entry
                pause = max(0.05, self._log[0][0] + win - now)
                self._cv.wait(timeout=pause)
                waited += pause

    def settle(self, entry: list | None, counted: bool = True, headers: dict | None = None) -> None:
        """22차 AI08: 제공자는 요청을 '받은' 때부터 창을 센다 — 보내기 직전 시각으로 세면 창이 조금 일찍 비어 경계에서 429.
        응답이 끝난 시각(≥ 받은 시각)으로 고쳐 보수적으로 센다. 429로 거절된 요청은 제공자도 세지 않으므로 뺀다."""
        if entry is None:
            return
        with self._cv:
            if counted:
                entry[0] = time.monotonic()
            elif entry in self._log:
                self._log.remove(entry)
            self._cv.notify_all()


class _SharedBudget:
    """23차(§15 ⑦ 남은 일): 같은 저장소(MySQL)를 쓰는 서버 여러 대가 한 제공자의 분당 토큰 한도를 함께 센다(LLM_TPM_SCOPE=shared).
    창 안의 사용 기록을 kv 'tpm'에 두고, 행 잠금 안에서 '더해 보고 넘지 않으면 기록'을 한 번에 한다(서버 간 경쟁 없음).
    시각은 벽시계(서버 간 비교) — 서버 시계는 NTP로 맞춘다고 가정. 호출마다 저장소 쓰기 2번(LLM 호출 수백 ms에 비해 작음)."""

    def __init__(self) -> None:
        self.update = None

    def acquire(self, est: int):
        tpm = int(os.getenv("LLM_TPM", "0"))
        if tpm <= 0 or self.update is None:
            return None
        win = float(os.getenv("LLM_TPM_WINDOW_S", "60"))
        est = min(est, tpm)
        eid = uuid.uuid4().hex[:10]
        while True:
            box: dict = {}

            def take(doc):
                now = time.time()
                log = [e for e in (doc.get("log") or []) if now - e[0] < win]
                used = sum(e[1] for e in log)
                if used + est <= tpm or not log:
                    log.append([now, est, eid])
                    box["ok"] = True
                else:
                    box["pause"] = max(0.05, min(e[0] for e in log) + win - now)
                doc["log"] = log
            self.update(take)
            if box.get("ok"):
                return eid
            time.sleep(min(box["pause"], 0.5) + random.uniform(0, 0.05))

    def settle(self, eid, counted: bool = True, headers: dict | None = None) -> None:
        if eid is None or self.update is None:
            return

        def fix(doc):
            log = doc.get("log") or []
            for e in log:
                if e[2] == eid:
                    e[0] = time.time()
            doc["log"] = log if counted else [e for e in log if e[2] != eid]
        try:
            self.update(fix)
        except Exception:  # noqa: BLE001 — 기록 실패는 다음 창에서 정리됨
            pass


def _secs(v) -> float | None:
    """'6m0s'·'1.5s'·'20ms'·'2' → 초."""
    if v is None:
        return None
    v = str(v).strip()
    try:
        return float(v)
    except ValueError:
        pass
    total, num = 0.0, ""
    i = 0
    while i < len(v):
        ch = v[i]
        if ch.isdigit() or ch == ".":
            num += ch
        else:
            unit = "ms" if v[i:i + 2] == "ms" else ch
            f = {"ms": 0.001, "s": 1, "m": 60, "h": 3600}.get(unit)
            if f is None or not num:
                return None
            total += float(num) * f
            num = ""
            i += len(unit) - 1
        i += 1
    return total if not num else None


class _HeaderBudget:
    """24차(§15 ⑦ 남은 일): LLM_TPM을 정하지 않아도 제공자 응답 헤더(x-ratelimit-remaining-tokens·reset-tokens·limit-tokens,
    OpenAI 방식)를 보고 속도를 맞춘다. 남은 토큰에서 보내는 중인 요청의 예상 토큰을 빼고(보수적으로) 모자라면 초기화 시각까지
    기다린다. 초기화 시각이 지나면 얼마나 풀렸는지 모르므로 한 번에 하나만 보내 새 헤더를 받는다. 헤더가 없으면 아무것도 하지 않음."""

    def __init__(self) -> None:
        self._cv = threading.Condition()
        self.seen = False
        self.remaining = 0
        self.reset_at = 0.0
        self.reserved = 0
        self.probing = False
        self.absent = False      # 첫 응답에 헤더가 없으면(다른 제공자) 이 예산은 쓰지 않는다

    def acquire(self, est: int):
        with self._cv:
            while True:
                if self.absent:
                    return None
                if not self.seen:   # 첫 응답(헤더)을 받을 때까지는 하나만 보낸다 — 처음부터 몰아 보내 429를 받지 않게(24차 AK02)
                    if not self.probing:
                        self.probing = True
                        self.reserved += est
                        return [est, True]
                    self._cv.wait(timeout=0.2)
                    continue
                now = time.monotonic()
                if self.remaining - self.reserved >= est:
                    self.reserved += est
                    return [est, False]
                if now >= self.reset_at and not self.probing:   # 얼마나 풀렸는지 모름 → 하나만 보내 확인
                    self.probing = True
                    self.reserved += est
                    return [est, True]
                self._cv.wait(timeout=max(0.05, min(self.reset_at - now, 1.0)) if now < self.reset_at else 0.2)

    def settle(self, entry, counted: bool = True, headers: dict | None = None) -> None:
        if not entry:
            return
        with self._cv:
            self.reserved = max(0, self.reserved - entry[0])
            if entry[1]:
                self.probing = False
            h = {k.lower(): v for k, v in (headers or {}).items()}
            rem = h.get("x-ratelimit-remaining-tokens")
            if rem is None and counted and not self.seen:
                self.absent = True          # 이 제공자는 남은 토큰을 알려 주지 않음 → 기다리지 않음(동시 요청 상한·429 재시도만)
            if rem is not None:
                try:
                    r, now = int(float(rem)), time.monotonic()
                    rs = now + (_secs(h.get("x-ratelimit-reset-tokens")) or 1.0)
                    # 응답이 도착 순서와 다르게 처리될 수 있다 — 같은 창 안에서는 더 적은 남은 토큰을 믿는다(늦게 온 옛 응답이 낙관적으로 덮어쓰지 않게)
                    if self.seen and now < self.reset_at:
                        self.remaining = min(self.remaining, r)
                        self.reset_at = max(self.reset_at, rs) if r <= self.remaining else self.reset_at
                    else:
                        self.remaining, self.reset_at = r, rs
                    self.seen = True
                except ValueError:
                    pass
            self._cv.notify_all()


_HEADER_BUDGET = _HeaderBudget()
_LOCAL_BUDGET = _TokenBudget()
_SHARED_BUDGET = _SharedBudget()


def attach_shared_budget(update) -> None:
    _SHARED_BUDGET.update = update


class _Budget:
    """LLM_TPM_SCOPE(server 기본 | shared)에 따라 서버 안 예산 또는 저장소 공동 예산."""

    @staticmethod
    def _pick():
        if int(os.getenv("LLM_TPM", "0") or 0) <= 0:      # 한도를 모르면 제공자 헤더를 따름(24차)
            return _HEADER_BUDGET if os.getenv("LLM_TPM_HEADERS", "1") != "0" else _LOCAL_BUDGET
        return _SHARED_BUDGET if os.getenv("LLM_TPM_SCOPE", "server").lower() == "shared" and _SHARED_BUDGET.update else _LOCAL_BUDGET

    def acquire(self, est: int):
        b = self._pick()
        return (b, b.acquire(est))

    def settle(self, entry, counted: bool = True, headers: dict | None = None) -> None:
        if entry:
            if entry[0] is _HEADER_BUDGET:
                entry[0].settle(entry[1], counted, headers)
            else:
                entry[0].settle(entry[1], counted)


_BUDGET = _Budget()


class _HeaderCatcher(BaseCallbackHandler):
    """LLM 응답의 HTTP 헤더(남은 토큰)를 꺼낸다 — 설명문 사슬은 글자만 돌려주므로 콜백으로 받는다."""

    def __init__(self) -> None:
        self.headers: dict = {}

    def on_llm_end(self, response, **kw) -> None:
        try:
            msg = response.generations[0][0].message
            self.headers = dict((getattr(msg, "response_metadata", {}) or {}).get("headers") or {})
        except Exception:  # noqa: BLE001
            pass


def _calls_model(runnable) -> bool:
    """22차 AI08: 실제 LLM을 부르는 사슬만 토큰 한도에 센다. 기존: 잠금 안 1단계의 오프라인 설명(LLM 미사용)까지 예약해
    25건 접수에서 토큰 한도의 1/3을 헛되이 쓰고, 한도가 차면 명령 잠금을 쥔 채 기다릴 수 있었다."""
    from langchain_core.language_models import BaseLanguageModel
    steps = getattr(runnable, "steps", None) or [runnable]
    return any(isinstance(x, BaseLanguageModel) for x in steps)


def estimate_tokens(variables: dict, runnable=None) -> int:
    """보낼 메시지를 실제로 채워 글자 수를 센다(틀 포함 — 22차 AI08: 변수만 세면 긴 시스템 지시문만큼 적게 잡아 429).
    채울 수 없으면 (변수 글자 수 + 틀 1,500자). ÷2에 10% 여유."""
    try:
        first = getattr(runnable, "first", None)
        msgs = first.format_messages(**(variables or {})) if hasattr(first, "format_messages") else None
    except Exception:  # noqa: BLE001
        msgs = None
    n = sum(len(str(m.content)) for m in msgs) if msgs else sum(len(str(v)) for v in (variables or {}).values()) + 1500
    return int(n / 2 * 1.1) + 1


def invoke_llm(runnable: Runnable, variables: dict):
    """AD-03(17차): 외부 LLM 호출 한 번. 기존에는 429(사용량 한도)도 '장애'로 보고 회로 차단기를 60초 열어,
    동시 요청 4건 한도의 제공자에서 기안 25건 중 18건이 대체문이 됐다(그 뒤 60초 동안 모든 접수도 대체문).
    이제 ① 서버 전체 동시 호출을 LLM_MAX_INFLIGHT로 묶고 ② 429는 Retry-After만큼(+흔들림) 기다렸다 다시 부르며
    ③ LLM_RATE_WAIT_S(기본 30초) 안에 풀리지 않을 때만 대체문으로 간다(차단기는 열지 않음 — 다른 건은 계속 LLM)."""
    end = time.monotonic() + float(os.getenv("LLM_RATE_WAIT_S", "30"))
    attempt = 0
    est = estimate_tokens(variables, runnable)
    while True:
        with _slots():
            entry = _BUDGET.acquire(est) if _calls_model(runnable) else None   # 자리를 얻은 뒤 예약(자리 기다리는 동안 예약 시각이 낡지 않게)
            hc = _HeaderCatcher()
            try:
                out = runnable.invoke(variables, config={"callbacks": [hc]}) if entry else runnable.invoke(variables)
                _BUDGET.settle(entry, headers=hc.headers)
                return out
            except Exception as e:  # noqa: BLE001
                limited = is_rate_limited(e)
                _BUDGET.settle(entry, counted=not limited, headers=hc.headers or dict(getattr(getattr(e, "response", None), "headers", {}) or {}))
                if not limited:
                    raise
                wait = _retry_after(e, attempt) + random.uniform(0, 0.5)
        if time.monotonic() + wait > end:
            raise LLMRateLimited(f"사용량 한도가 {os.getenv('LLM_RATE_WAIT_S', '30')}초 안에 풀리지 않음")
        time.sleep(wait)
        attempt += 1


# AC-01(16차): 처리 순서(잠금)를 쥔 동안에는 LLM을 부르지 않는다 — 규칙 판단만 먼저 저장하고 설명은 잠금 밖에서 쓴다
OFFLINE_ONLY: ContextVar[bool] = ContextVar("offline_only", default=False)


def configured_llm() -> str:
    """설정된 LLM 이름(잠금 여부와 무관). 'offline'이면 LLM 없음."""
    return _make_llm(os.getenv("LLM_PROVIDER", "offline").lower(), os.getenv("LLM_MODEL", ""), float(os.getenv("LLM_TIMEOUT_S", "8")),
                     bool(os.getenv("OPENAI_API_KEY")), bool(os.getenv("ANTHROPIC_API_KEY")))[0]


def get_llm() -> tuple[str, Runnable | None]:
    if OFFLINE_ONLY.get():
        return "offline", None
    return _make_llm(os.getenv("LLM_PROVIDER", "offline").lower(), os.getenv("LLM_MODEL", ""),
                     float(os.getenv("LLM_TIMEOUT_S", "8")), bool(os.getenv("OPENAI_API_KEY")), bool(os.getenv("ANTHROPIC_API_KEY")))


@lru_cache(maxsize=4)
def _make_llm(p: str, model: str, timeout: float, has_openai: bool, has_anthropic: bool) -> tuple[str, Runnable | None]:
    try:
        if p == "openai" and has_openai:
            from langchain_openai import ChatOpenAI  # type: ignore
            return "openai", ChatOpenAI(model=model or "gpt-4o-mini", temperature=0, timeout=timeout, max_retries=1,
                                        include_response_headers=True)   # 24차: 남은 토큰 헤더로 속도 맞춤(⑦ 남은 일)
        if p == "anthropic" and has_anthropic:
            from langchain_anthropic import ChatAnthropic  # type: ignore
            return "anthropic", ChatAnthropic(model=model or "claude-haiku-4-5", temperature=0, timeout=timeout, max_retries=1)
    except Exception:  # 패키지 미설치 → 오프라인 폴백
        pass
    return "offline", None


def offline_explain(variables: dict) -> str:
    """LLM 실패·환각 시 쓰는 근거 기반 대체문(사실 목록의 숫자만 사용)."""
    return _offline_explain(variables)


def explain_chain() -> tuple[str, Runnable]:
    name, llm = get_llm()
    if llm is None:
        return name, _offline_runnable() | StrOutputParser()
    return name, EXPLAIN_PROMPT | llm | StrOutputParser()
