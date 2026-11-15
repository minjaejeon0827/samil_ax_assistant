"""운영 데스크 — 퍼사드(Facade) + 커맨드(Command) + 팩토리 메서드(Factory Method).

API·MCP 서버·테스트는 OpsDesk 하나만 호출한다. 내부에서는
  - CaseFactory      : 사건 종류별로 처리 건을 만든다(팩토리 메서드)
  - Command 객체      : 승인/거절/확인요청/회신/수정/작업완료/시계진행을 객체로 실행·감사 기록
  - EventBus         : 상태 변경 → 감사·작업 생성·연계 건 갱신·채널 발송(옵저버)
  - State            : 허용 전이 검사
  - LangGraph        : 분석(run_case)
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from abc import ABC, abstractmethod
from datetime import date, datetime
from typing import Any

from ..domain.data import get_dataroom
from ..domain.decision import HOLD_STATUSES
from ..api.auth import CURRENT_USER
from . import permissions as perm
from ..graph.pipeline import clear_cache, run_case, warm
from ..repo.base import Repository
from ..validation import check_input, check_output
from .events import EventBus


def copy_unresolved(case: dict) -> bool:
    """30차(AP-07): 이 기안의 현재 광고 카피에 수정이 필요한 위반(warn)이 남아 있는가 — 남아 있으면 누구도 승인할 수 없다."""
    reg = (case.get("decision") or {}).get("regulation") or {}
    return case.get("type") == "PLAN" and bool(reg.get("findings"))


NOTICE_EFFECTS = ("CONTRACT_NOTICE_SENT", "CONTRACT_TERMINATION_SENT", "CONTRACT_RENEWED")


def hard_deadline(case: dict) -> str | None:
    """기한 감시가 쓰는 마지막 선. 32차(AR-04): 업로드 계약서의 통보 기한이 미확인이면 결재 서류의 기한은 비어 있지만,
    만료일이 지나면 어차피 자동 갱신이므로 만료일을 마지막 선으로 쓴다."""
    d = case.get("decision") or {}
    dl = (d.get("subject") or {}).get("deadline")
    if not dl and case.get("type") == "RENEWAL":
        dl = (d.get("terms") or {}).get("expiry")
    return dl


def info_dept(case: dict) -> str:
    """30차(AP-04): 결재권자의 '확인 요청'을 받아 근거를 보완할 부서 = 그 건을 올린 부서(계약 건·다른 계약서 → 계약 담당, 기안 → 마케팅팀)."""
    return "CONTRACT_OWNER" if case.get("type") in ("CONTRACT", "RENEWAL") else "MARKETING_TEAM"
from .states import InvalidTransition, next_state_for, state_of


# v1.26(26차 AM04, §15 ⑧): 감사 기록 해시 체인 — 기록마다 바로 앞 기록의 해시(prev)를 넣고 자기 내용의 해시(hash)를 남긴다.
# DB 트리거(v1.25)는 앱 계정 비밀번호를 가진 사람이 우회할 수 있었다(@aurora_reset·DROP TRIGGER). 체인은 고치거나 지운 자리를 찾아낸다.
AUDIT_CHAIN_FIELDS = ("id", "sim_date", "at", "topic", "actor", "case_id", "detail", "user", "prev")


def audit_hash(a: dict) -> str:
    body = json.dumps({k: a.get(k) for k in AUDIT_CHAIN_FIELDS}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def audit_text(a: dict) -> str:
    """R-02(10차): 감사 검색 대상 = 화면에 보이는 것. 내용·역할(코드와 한국어명)·로그인 사용자·건 ID·주제·날짜(2026-07-02와 7월 2일).
    값이 없는 칸은 빈칸(기존: None이 'None'으로 들어가 'no'·'one' 검색에 모든 기록이 걸림). frontend auditText, MySQL search_text와 같은 규칙."""
    d = a.get("sim_date") or ""
    ko_date = f"{int(d[5:7])}월 {int(d[8:10])}일" if len(d) >= 10 else ""
    parts = (a.get("detail"), a.get("actor"), ROLE_KO.get(a.get("actor") or ""), a.get("user"), a.get("case_id"), a.get("topic"), d, ko_date)
    return " ".join(str(x) for x in parts if x not in (None, "")).lower()


def id_order(doc: dict) -> tuple[int, str]:
    """'CS-0001'·'CS-10000'처럼 자릿수가 늘어나는 ID를 숫자 순서로(Q-01: 문자열 정렬이면 CS-10000 < CS-9999)."""
    i = doc["id"]
    return (len(i), i)


def state_ko(name: str) -> str:
    return state_of(name).label


ROLE_KO = {"MARKETING_TEAM": "마케팅팀", "MASIL_CEO": "Masil 대표", "GROUP_CEO": "그룹 CEO/이사회",
           "FINANCE": "재무팀", "SCM": "SCM", "CONTRACT_OWNER": "계약 담당", "TEST_AURORA": "테스트(Aurora)", "AGENCY": "에이전시(모의)", "SYSTEM": "시스템"}
CONTRACT_STATUS_KO = {
    "UNDER_REVIEW": "갱신 통보 접수·검토 중", "NOTICE_APPROVED": "조건변경 통보 승인(발송 대기)",
    "NOTICE_SENT": "조건변경 통보 발송·회신 대기", "COUNTER_OFFER": "에이전시 역제안 검토 중",
    "TERMINATION_APPROVED": "미갱신 결정(통보 발송 대기)", "TERMINATION_SENT": "미갱신 통보 발송",
    "TERMINATED": "계약 종료 합의", "RENEWAL_APPROVED": "갱신 승인(회신 대기)", "RENEWED": "갱신 체결", "AUTO_RENEWED": "기한 경과 자동 갱신(승인 없는 체결)",
}
PLAN_STATUS_FROM_CASE = {"PENDING_APPROVAL": "승인 대기", "ACTION_REQUIRED": "카피 수정 필요", "HOLD_LINKED": "상위 계약 대기",
                         "NEEDS_INFO": "확인 필요", "APPROVED": "확정", "REJECTED": "부결", "AUTO_COMMITTED": "기한 경과 자동 확정",
                         "SUPERSEDED": "재검증 대기", "ANALYZING": "분석 중", "RECEIVED": "접수"}


class PermissionDenied(Exception):
    pass


class NotFound(Exception):
    """없는 처리 건·작업 ID (D-07: 기존에는 500 서버 오류)."""


class Duplicate(Exception):
    """이미 접수된 사건을 다시 접수(E-05: 기존에는 API·MCP·더블클릭으로 같은 기안 25건이 50건으로 늘어남)."""


# 한 번만 접수되는 사건 → 이미 있는지 판별하는 조건
_ONCE = {
    "CONTRACT_RENEWAL_NOTICE": lambda c: c["kind"] == "CONTRACT_RENEWAL_NOTICE",
    "BUDGET_PLAN_BATCH": lambda c: c["type"] == "PLAN",
    "AGENCY_COUNTER_OFFER": lambda c: c["kind"] == "AGENCY_COUNTER_OFFER",
}
_ONCE_KO = {"CONTRACT_RENEWAL_NOTICE": "전속계약 갱신 통보", "BUDGET_PLAN_BATCH": "확대 기안 25건", "AGENCY_COUNTER_OFFER": "에이전시 역제안"}


# ---------------- 커맨드 ----------------
class Command(ABC):
    name = "command"

    def __init__(self, actor: str, **kw: Any):
        self.actor, self.kw = actor, kw

    @abstractmethod
    def execute(self, desk: "OpsDesk") -> dict: ...


class DecideCommand(Command):
    name = "decide"

    def execute(self, desk):
        return desk._decide(self.actor, **self.kw)


class ReceiveReplyCommand(Command):
    name = "receive_reply"

    def execute(self, desk):
        return desk._receive_reply(self.actor, **self.kw)


class ApplyFixCommand(Command):
    name = "apply_fix"

    def execute(self, desk):
        return desk._apply_fix(self.actor, **self.kw)


class CompleteTaskCommand(Command):
    name = "complete_task"

    def execute(self, desk):
        return desk._complete_task(self.actor, **self.kw)


class AdvanceClockCommand(Command):
    name = "advance_clock"

    def execute(self, desk):
        return desk._advance_clock(self.actor, **self.kw)


class ContractFactsCommand(Command):
    """24차(AK04): 확인 필요로 멈춘 자동 갱신 계약에 사람이 확인한 값(원화 금액·자동 갱신 여부·통보 일수)을 넣고 다시 판단."""
    name = "contract_facts"

    def execute(self, desk):
        return desk._contract_facts(self.actor, **self.kw)


class AnchorAuditCommand(Command):
    """27차(AN07, §15 ⑧ 남은 일): 감사 기록 머리값(마지막 해시)을 메신저(밖)로 보낸다 — 체인 전체를 다시 계산한 위조도 드러나게."""
    name = "audit_anchor"

    def execute(self, desk):
        return desk._anchor_audit(self.actor, **self.kw)


class SummaryFeedbackCommand(Command):
    """24차(AK03, ⑤ 남은 일): 계약서 요약 품질 평가(사람 평점) — 한 사람 한 표, 결재 서류의 판 번호는 바꾸지 않음."""
    name = "summary_feedback"

    def execute(self, desk):
        return desk._summary_feedback(self.actor, **self.kw)


class ChangeConditionCommand(Command):
    name = "change_condition"

    def execute(self, desk):
        return desk._change_condition(self.actor, **self.kw)


# ---------------- 팩토리 메서드 ----------------
class CaseFactory:
    @staticmethod
    def create(kind: str, target_id: str, title: str, event_text: str, today: str, extra: dict | None = None) -> dict:
        ctype = ("CONTRACT" if kind in ("CONTRACT_RENEWAL_NOTICE", "AGENCY_COUNTER_OFFER")
                 else "RENEWAL" if kind == "CONTRACT_UPLOAD"     # v1.21(§15-4): 업로드한 다른 자동 갱신 계약
                 else "MEMO" if kind == "FREE_TEXT" else "PLAN")   # D-06: 메모가 기안 집계에 섞이지 않게
        return {"type": ctype, "kind": kind, "target_id": target_id, "title": title, "event_text": event_text,
                "state": "RECEIVED", "received_on": today, "history": [], "approval": None, **(extra or {})}


def won_short(v: float) -> str:
    return f"{v / 1e8:,.2f}".rstrip("0").rstrip(".") + "억원" if v >= 1e8 else f"{v:,.0f}원"


_SKIP = object()
_ENRICH_SLOTS: dict[int, threading.BoundedSemaphore] = {}


def _enrich_slots() -> threading.BoundedSemaphore:
    """AD-04: 설명 작성 스레드가 여러 개여도 동시에 분석하는 건 수는 서버 전체에서 LLM_CONCURRENCY까지(나머지는 줄 서서,
    차례가 오면 '아직 필요한가'를 확인)."""
    n = max(1, int(os.getenv("LLM_CONCURRENCY", "16")))
    return _ENRICH_SLOTS.setdefault(n, threading.BoundedSemaphore(n))


def _decision_sig(d: dict | None) -> str:
    """설명이 기대는 판단의 핵심(권고·승인자·근거·확인 필요) — 같아야 설명을 넣는다."""
    d = d or {}
    return json.dumps({k: d.get(k) for k in ("label", "approver", "recommendation", "evidence", "needs_info")}, ensure_ascii=False, sort_keys=True, default=str)


KEEP_ON_RESET = ("rev", "cluster", "revoked", "passwords", "refresh", "oidc_sessions", "oidc_pending", "esign_inbound", "oidc_bc_jti", "tpm",
                 "chain_epochs")   # 28차 AO03: '처음부터' 이전에 밖으로 보낸 머리값 목록(지운 뒤 옛 머리값을 '위조'로 오판하지 않게)


class OpsDesk:
    def __init__(self, repo: Repository):
        self.repo = repo
        self.bus = EventBus()
        self._lock = threading.RLock()
        self._llm_todo: list[dict] = []
        self._bg: set[threading.Thread] = set()   # AD-02: 응답 뒤 설명을 쓰는 스레드(정상 종료 때 기다림)
        self._outbound: list[tuple[str, object]] = []   # v1.21(§15-2): 커밋 뒤 외부 채널로 보낼 것(결재 요청·종료·메시지)
        self.channel = None                               # main.py가 integrations.channel.Channel을 연결
        self.revision = 0     # E-07: 변경될 때마다 1 증가 → 화면은 이 값만 가볍게 확인하고 바뀌었을 때만 스냅샷을 받는다
        self.dr = get_dataroom()
        self.bus.subscribe("*", self._audit)
        self._ensure_kv()

    # ---------- 공통 ----------
    @contextmanager
    def _mutating(self):
        """변경 번호를 시작·끝에 한 번씩 올린다 → 홀수면 '변경 중'. 스냅샷 캐시는 짝수이고 계산 전후가 같을 때만 저장(P-05)."""
        self.revision += 1
        try:
            yield
            self._bump()
        finally:
            self.revision += 1

    def _bump(self) -> None:
        """AB-01(15차): 저장소에 남는 전역 변경 번호(kv 'rev'). 서버가 여러 대일 때 다른 서버의 변경을 알아채는 기준.
        기존 변경 번호(self.revision)는 프로세스 안에만 있어, B 서버는 A의 변경을 영영 모른 채 자기 캐시를 보냈다."""
        cur = self.repo.get("kv", "rev") or {"id": "rev", "n": 0}
        self.repo.put("kv", {"id": "rev", "n": int(cur.get("n", 0)) + 1})

    def stamp(self) -> int:
        d = self.repo.get("kv", "rev")
        return int(d["n"]) if d else 0

    def cluster_id(self) -> str:
        d = self.repo.get("kv", "cluster")
        return d["cid"] if d else "-"

    # ---------- 공통 ----------
    def _ensure_kv(self):
        if not self.repo.get("kv", "cluster"):   # 같은 저장소를 쓰는 서버들이 공유하는 ID(화면의 '서버가 바뀌었나' 판단용)
            import uuid as _uuid
            self.repo.put("kv", {"id": "cluster", "cid": _uuid.uuid4().hex[:8]})
        if not self.repo.get("kv", "ctx"):
            self.repo.put("kv", {"id": "ctx", "today": "2026-07-01", "cash_assumption": "AS_IS",
                                 "contract_status": "UNDER_REVIEW", "offer": None, "claims": [], "copy_overrides": {}})
        if not self.repo.get("kv", "seq"):
            self.repo.put("kv", {"id": "seq", "case": 0, "task": 0, "audit": 0, "outbox": 0})

    def ctx(self) -> dict:
        return self.repo.get("kv", "ctx")

    def _set_ctx(self, **kw) -> dict:
        c = self.ctx()
        c.update(kw)
        return self.repo.put("kv", c)

    def _next_id(self, kind: str, prefix: str) -> str:
        s = self.repo.get("kv", "seq")
        s[kind] += 1
        self.repo.put("kv", s)
        return f"{prefix}-{s[kind]:04d}"

    def _audit(self, topic: str, p: dict):
        s = self.repo.get("kv", "seq")              # 번호와 체인 머리값을 같은 문서·같은 트랜잭션에서(명령 잠금 안)
        s["audit"] += 1
        doc = {"id": f"AU-{s['audit']:04d}", "sim_date": self.ctx()["today"], "at": datetime.now().isoformat(timespec="seconds"),
               "topic": topic, "actor": p.get("actor", "SYSTEM"), "case_id": p.get("case_id"),
               "detail": p.get("detail", ""), "user": CURRENT_USER.get(),   # J-02: 역할이 아니라 실제 사용자
               "prev": s.get("audit_head", "")}
        doc["hash"] = s["audit_head"] = audit_hash(doc)
        self.repo.put("kv", s)
        self.repo.put("audit", doc)

    def _anchor_audit(self, actor: str, auto: bool = False, every_s: float = 0) -> dict:
        """머리값(마지막 감사 기록의 id·해시)을 메신저로 보내고 감사 기록에 남긴다. auto(주기 기록)는 서버가 여러 대여도
        명령 잠금(kv 'ctx' 행) 안에서 kv 'anchor'의 마지막 시각을 보고 한 번만, 그사이 새 기록이 없으면 보내지 않는다."""
        self._need("audit_anchor", actor)
        s = self.repo.get("kv", "seq") or {}
        head, last = s.get("audit_head", ""), self.repo.get("kv", "anchor") or {"id": "anchor"}
        if not head:
            return {"anchor": None, "skipped": "감사 기록 없음"}
        if auto and (head == last.get("after") or time.time() - float(last.get("at", 0)) < every_s * 0.9):
            return {"anchor": None, "skipped": "새 기록 없음 또는 주기 전"}
        aid = f"AU-{s['audit']:04d}"
        a = {"id": aid, "hash": head, "at": datetime.now().isoformat(timespec="seconds"), "by": actor, "user": CURRENT_USER.get()}
        msg = self.send_channel("messenger", f"[감사 기록 머리값] {aid} sha256 {head} — 보관하세요. 검증: /api/audit/verify?anchor={aid}:{head}", None)
        # 28차 AO04: 메신저 전달은 커밋 뒤 따로 일어나므로(실패하면 재시도·전송 목록에 실패) 여기서는 '보냄'이 아니라 '전송 요청'
        self.bus.publish("audit.anchor", {"actor": actor, "detail": f"감사 기록 머리값 {aid} = {head} → 메신저 전송 요청{'(정기)' if auto else ''} — 전달 여부는 외부 채널 전송 목록"})
        sent = (last.get("sent") or [])[-499:] + [{"id": aid, "hash": head, "at": a["at"]}]   # 이번 체인에서 밖으로 보낸 머리값('처음부터' 때 보관)
        self.repo.put("kv", {**{k: v for k, v in last.items() if k != "version"}, "id": "anchor", "at": time.time(), "last": a, "sent": sent,
                             "after": (self.repo.get("kv", "seq") or {}).get("audit_head", "")})
        return {"anchor": a, "message": msg}

    def verify_audit(self, anchors: list[str] | tuple = ()) -> dict:
        """v1.26: 감사 기록 체인 검증(오래된 순, 한 시점의 모습). 고친 기록은 '내용이 바뀜', 지운 기록은 그다음 기록이 '앞 기록이 바뀌거나 지워짐'.
        v1.25까지의 기록(해시 없음)은 legacy로 세고 건너뛴다. head는 마지막 기록의 해시 — 밖(메신저·WORM)에 적어 두면 통째로 다시 계산한 위조도 드러난다."""
        t0 = time.perf_counter()
        broken, checked, legacy, expected, started, notes = [], 0, 0, "", False, []
        with self.repo.read_view():
            head = (self.repo.get("kv", "seq") or {}).get("audit_head", "")
            last = None
            for a in self.repo.scan("audit"):
                if not a.get("hash"):
                    legacy += 1
                    continue
                checked += 1
                if checked % 500 == 0:
                    time.sleep(0.002)   # v1.27(AN03): 다른 요청에 차례를 넘김(해시 계산이 GIL을 오래 쥐어 검증 중 화면 p95 168ms)
                if audit_hash(a) != a["hash"]:
                    broken.append({"id": a["id"], "reason": "내용이 바뀜(해시 불일치)"})
                if a.get("prev", "") != (expected if started else ""):
                    broken.append({"id": a["id"], "reason": "바로 앞 기록이 바뀌거나 지워짐(체인 끊김)" if started else "체인의 첫 기록이 아님(앞부분이 지워짐)"})
                expected, started, last = a["hash"], True, a
            epochs = (self.repo.get("kv", "chain_epochs") or {}).get("items") or []
            for an in anchors:      # v1.27(AN07): 밖(메신저)에 적어 둔 머리값 — 체인 전체를 다시 계산한 위조는 여기서만 드러난다
                aid, _, h = str(an).partition(":")
                aid, h = aid.strip(), h.strip()
                rec = self.repo.get("audit", aid)
                if rec and rec.get("hash") == h:
                    continue
                ep = next((e for e in reversed(epochs) if any(x.get("hash") == h for x in e.get("sent") or []) or e.get("head") == h), None)
                if ep:   # 28차 AO03: '처음부터' 이전에 보낸 머리값 — 그 기록은 정당하게 지워졌다(번호가 다시 쓰여 같은 번호의 다른 기록이 있을 수 있음)
                    notes.append({"id": aid, "note": f"'처음부터'({ep.get('reset_at', '')}) 이전에 보낸 머리값입니다 — 그때 기록은 지워졌습니다"
                                                     f"(지운 건수는 그 '처음부터' 감사 기록). 메신저 메시지 시각이 이보다 앞서는지 확인하세요."})
                    continue
                if not rec:
                    broken.append({"id": aid, "reason": "밖에 적어 둔 머리값의 기록이 없음(지워짐 — '처음부터' 이전 머리값이면 정상)"})
                elif rec.get("hash") != h.strip():
                    broken.append({"id": aid, "reason": "밖에 적어 둔 머리값과 다름(체인을 다시 계산한 위조)"})
        if head and (last is None or last["hash"] != head):
            broken.append({"id": "(끝)", "reason": "마지막 기록 뒤가 지워짐(머리값 불일치)"})
        return {"ok": not broken, "checked": checked, "legacy": legacy, "head": head, "head_id": last["id"] if last else None, "anchors": len(anchors),
                "broken": broken[:50], "broken_total": len(broken), "notes": notes,
                "ms": round((time.perf_counter() - t0) * 1000)}

    # ---- v1.25(25차 AL03 정규화): 계약 기록 = renewals 모음의 문서 하나씩(기존: kv 'renewals' 문서 하나에 전부) ----
    def _renewal(self, rid: str) -> dict | None:
        d = self.repo.get("renewals", rid)
        if not d and self.repo.get("kv", "renewals"):   # v1.26(AM03): 무중단 배포 중 아직 안 바꾼 v1.24 서버가 kv에 쓴 계약 → 그 자리에서 옮김
            self.migrate()
            d = self.repo.get("renewals", rid)
        return {k: v for k, v in d.items() if k not in ("id", "version")} if d else None

    def _put_renewal(self, rid: str, rec: dict) -> None:
        self.repo.put("renewals", {**{k: v for k, v in rec.items() if k != "version"}, "id": rid})

    def renewals(self) -> dict[str, dict]:
        """전체 계약 기록(기한 감시·시험용). 명령 경로는 _renewal(rid)로 필요한 행만 읽는다."""
        if self.repo.get("kv", "renewals"):
            self.migrate()
        return {d["id"]: {k: v for k, v in d.items() if k not in ("id", "version")} for d in self.repo.list("renewals")}

    def migrate(self) -> int:
        """v1.24까지의 kv 'renewals'·'summary_feedback' 문서를 행으로 옮기고 옛 문서를 지운다(옮긴 건수).
        서버 기동 때 한 번, 그리고 v1.26부터는 옛 문서가 다시 보이면 그때마다(무중단 배포 중 구 서버가 쓴 것 — AM03).
        읽기도 명령 잠금(kv 'ctx' 행) 안에서 — 읽고 지우는 사이에 구 서버가 쓴 것을 잃지 않게."""
        n = 0
        with self._lock, self.repo.batch():
            old = self.repo.get("kv", "renewals")
            if old:
                for rid, rec in (old.get("items") or {}).items():
                    if not self.repo.get("renewals", rid):   # 이미 옮긴 행이 더 새것
                        self._put_renewal(rid, rec)
                    n += 1
                self.repo.delete("kv", "renewals")
            fb = self.repo.get("kv", "summary_feedback")
            if fb:
                for cid, box in (fb.get("items") or {}).items():
                    for key, v in (box or {}).items():
                        fid = f"{cid}|{key}"
                        if not self.repo.get("feedback", fid):
                            self.repo.put("feedback", {**v, "id": fid, "case_id": cid, "key": key})
                        n += 1
                self.repo.delete("kv", "summary_feedback")
        return n

    def _engine_ctx(self, cases: list[dict] | tuple = ()) -> dict:
        """판단 엔진 입력. 계약 기록은 이번에 판단할 건(cases)이 가리키는 계약만 읽는다 — 기존에는 분석·결재마다 전체를 읽었다."""
        c = self.ctx()
        rids = {x["target_id"] for x in cases if x.get("type") == "RENEWAL"}
        ren = {rid: r for rid in rids if (r := self._renewal(rid))}
        return {"today": c["today"], "cash_assumption": c["cash_assumption"], "contract_status": c["contract_status"],
                "offer": c["offer"], "claims": c["claims"], "copy_overrides": c["copy_overrides"], "renewals": ren}

    def _transition(self, case: dict, cmd: str, new_state: str, actor: str, note: str) -> dict:
        state_of(case["state"]).check(cmd)
        case["history"].append({"sim_date": self.ctx()["today"], "from": case["state"], "to": new_state,
                                "by": actor, "note": note})
        if case["state"] == "NEEDS_INFO" and new_state != "NEEDS_INFO":
            case.pop("hold_reason", None)   # 30차(AP-06): 보류가 풀리는 모든 길에서 사유를 지운다(남으면 이후 조건 변경 재검증에서 계속 빠짐)
        case["state"] = new_state
        return case

    # ---------- 분석 ----------
    # ---------- AC-01(16차): AI 설명은 잠금 밖에서 ----------
    # 기존에는 LLM 설명·판사 호출(건당 수 초)을 처리 순서(잠금)를 쥔 채 했다. 그래서 기안 25건을 접수하는 동안(LLM 1.5초/회에서
    # 약 6초) 다른 사람의 결재·조건 변경이 모두 기다렸고(서버 여러 대면 다른 서버도), 접수한 사람도 25건이 다 될 때까지 목록에서
    # 아무것도 볼 수 없었다. 이제 ① 잠금 안: 규칙 판단·결재란·근거 기반 설명을 바로 저장('AI 설명 작성 중') ② 잠금 밖: LLM 설명·판사
    # ③ 짧은 잠금: 그 사이 판단이 바뀌지 않은 건에만 설명을 바꿔 끼운다(상태·결재 기록은 건드리지 않음).
    def _llm_name(self) -> str:
        from ..llm.provider import configured_llm
        return configured_llm()

    @contextmanager
    def _deferred_llm(self):
        from ..llm.provider import OFFLINE_ONLY
        on = self._llm_name() != "offline"
        tok = OFFLINE_ONLY.set(True) if on else None
        try:
            yield on
        finally:
            if tok is not None:
                OFFLINE_ONLY.reset(tok)

    def _enrich(self, todo: list[dict], debounce: float = 0.0) -> None:
        """AI 설명 2·3단계(AC-01). 17차 보완:
        AD-01 늦게 시작한 분석이 먼저 끝나거나 반대로 끝나도, '그 건을 마지막으로 표시한 분석'(llm_pending 표)만 설명을 넣는다.
              기존에는 판단 라벨만 비교해, 조건을 연달아 바꾸면 지난 조건의 설명(승인자 Masil 대표)이 지금 판단(그룹 CEO)에 붙었다.
              넣기 전에 승인자·근거까지 같은지도 확인한다.
        AD-04 지나간 분석은 LLM을 부르기 전에 건너뛴다. 명령 뒤에는 잠깐(ENRICH_DEBOUNCE_S) 기다려 연달아 바뀐 조건을 한 번에 처리한다."""
        if not todo:
            return
        if debounce > 0:
            time.sleep(debounce)
        todo = list({c["id"]: c for c in todo}.values())
        name = self._llm_name()
        ctx = self._engine_ctx(todo)
        warm()

        def current(c):
            cur = self.repo.get("cases", c["id"])
            if cur and str(cur.get("llm", "")).startswith("작성 중") and cur.get("llm_pending") == c.get("llm_pending"):
                return cur
            return None

        def one(c):
            with _enrich_slots():
                if current(c) is None:        # 더 새 분석이 있거나 이미 끝남 → LLM을 부르지 않음
                    return _SKIP
                try:
                    return run_case(c["type"], c["target_id"], c["event_text"], ctx)
                except Exception:  # noqa: BLE001 — 실패하면 근거 기반 설명을 그대로 둔다
                    return None
        with ThreadPoolExecutor(max_workers=max(1, min(int(os.getenv("LLM_CONCURRENCY", "16")), len(todo)))) as ex:
            got = list(ex.map(one, todo))
        if all(r is _SKIP for r in got):
            return
        with self._lock, self.repo.batch(), self._mutating():
            for c, res in zip(todo, got):
                cur = None if res is _SKIP else current(c)
                if cur is None:
                    continue
                d = (res or {}).get("decision")
                signed = bool((cur.get("approval") or {}).get("decision"))
                if not d or _decision_sig(d) != _decision_sig(cur.get("decision")) or c.get("event_text") != cur.get("event_text"):
                    cur["llm"] = f"대체문({name} {'오류' if not res else '판단이 바뀌어 생략'})"   # 근거 기반 설명 유지
                elif signed and not str(res.get("llm", "")).startswith(name):
                    # AF-02(19차): 결재 뒤 받은 LLM 설명이 판사를 통과하지 못함(대체문) → 'AI 설명'으로 보관하지 않는다.
                    # 기존: 지어낸 수치로 거부된 글의 대체문을 '결재 뒤 도착한 AI 설명'이라며 보관·표시했다
                    cur["llm"] = f"결재 당시({name} 설명 불채택)"
                    self._archive(cur, {"kind": "late_rejected", "llm": res.get("llm"), "reason": "판사를 통과하지 못해 쓰지 않음(글은 보관하지 않음)"})
                    self.bus.publish("case.explained_late", {"case_id": cur["id"], "detail": f"{cur['target_id']} 결재 뒤 {name} AI 설명 도착 — 판사를 통과하지 못해 쓰지 않음({res.get('llm')}), 결재 서류는 결재 당시 설명 유지"})
                elif signed:
                    # AE-03(18차): 설명이 '작성 중'일 때 이미 결재됨 → 결재 서류는 결재한 사람이 본 설명 그대로 두고,
                    # 늦게 온 LLM 설명은 따로 보관한다(기존: 결재 뒤 서류의 설명을 조용히 바꿔, 결재자가 본 적 없는 글이 서류에 남음)
                    cur.update({"late_explanation": res.get("explanation"), "late_judge": res.get("judge"), "late_llm": res.get("llm"),
                                "llm": f"결재 당시({name} 설명은 결재 뒤 도착)"})
                    self._archive(cur, {"kind": "late", "text": res.get("explanation"), "llm": res.get("llm"),
                                        "faithfulness": (res.get("judge") or {}).get("faithfulness")})
                    self.bus.publish("case.explained_late", {"case_id": cur["id"], "detail": f"{cur['target_id']} 결재 뒤 {name} AI 설명 도착 — 결재 서류는 결재 당시 근거 기반 설명 유지, AI 설명은 별도 보관"})
                else:
                    cur.update({"explanation": res.get("explanation", cur.get("explanation")), "judge": res.get("judge"), "llm": res.get("llm")})
                cur.pop("llm_pending", None)
                self.repo.put("cases", cur)

    @staticmethod
    def _archive(case: dict, entry: dict, keep: int = 5) -> None:
        """v1.22(다음 후보 ⑥): 결재 뒤 도착한 AI 설명 보관함 — 재상신·재분석으로 결재 서류에서 빠져도 그 건에 남는다(최근 5건).
        어느 결재(결재자·결정·날짜) 뒤에 왔는지 함께 남긴다."""
        a = case.get("approval") or {}
        box = list(case.get("explain_archive") or [])
        box.append({**entry, "approval": {k: a.get(k) for k in ("approver", "decision", "decided_by", "decided_on")},
                    "case_version": case.get("version"), "at": datetime.now().isoformat(timespec="seconds")})
        case["explain_archive"] = box[-keep:]

    def resume_pending(self) -> int:
        """AD-02(17차): 설명을 쓰던 중 서버가 꺼져 '작성 중'으로 남은 건을 기동할 때 이어서 쓴다(백그라운드).
        기존에는 강제 종료·재배포 한 번이면 그 건들이 영영 '작성 중'이었다."""
        todo = [c for c in self.repo.list("cases") if str(c.get("llm", "")).startswith("작성 중")]
        if todo:
            self._background(todo, 0.0)
        return len(todo)

    def _background(self, todo: list[dict], debounce: float) -> None:
        t = threading.Thread(target=self._enrich_quiet, args=(todo, debounce), daemon=True)
        self._bg.add(t)
        t.start()

    def drain(self, timeout: float = 10.0) -> bool:
        """응답 뒤 설명을 쓰는 스레드가 끝나기를 기다린다(정상 종료·테스트). 모두 끝났으면 True."""
        end = time.monotonic() + timeout
        for t in list(self._bg):
            t.join(max(0.0, end - time.monotonic()))
        return not any(t.is_alive() for t in self._bg)

    def _prefetch(self, cases: list[dict]) -> dict[int, dict]:
        """H-04: 외부 LLM을 쓸 때 여러 건의 분석(설명문·판사 호출)을 동시에 돌린다.
        기존에는 25건 × (설명 + 판사)를 차례로 불러 호출당 0.5초면 25초가 걸렸다. 판단 규칙은 건마다 독립이라 순서와 무관하다.
        오프라인 모드는 CPU 작업이라 그대로 순차 처리한다."""
        from ..llm.provider import get_llm
        if len(cases) < 2 or get_llm()[0] == "offline":   # 잠금 안(AC-01)에서는 항상 offline → 미리 부르지 않음
            return {}
        warm()
        ctx = self._engine_ctx(cases)
        with ThreadPoolExecutor(max_workers=int(os.getenv("LLM_CONCURRENCY", "16"))) as ex:
            futs = {id(c): ex.submit(run_case, c["type"], c["target_id"], c["event_text"], ctx) for c in cases}
        return {k: f.result() for k, f in futs.items()}

    def _analyze(self, case: dict, actor: str = "SYSTEM", res: dict | None = None) -> dict:
        case["history"].append({"sim_date": self.ctx()["today"], "from": case["state"], "to": "ANALYZING", "by": actor, "note": "LangGraph 분석 시작"})
        case["state"] = "ANALYZING"
        res = res or run_case(case["type"], case["target_id"], case["event_text"], self._engine_ctx([case]))
        d = res.get("decision")
        status = res.get("status", "ok")
        new = next_state_for(d or {}, status)
        # AF-01(19차): 새 분석이면 이전 결재 뒤에 도착했던 AI 설명은 이 결재 서류와 무관 — 지운다(도착 사실은 감사 기록에 남아 있음).
        # 기존: 재상신된 새 결재 서류에 옛 결재(Masil 대표) 뒤의 AI 설명이 '결재 뒤 도착'으로 그대로 붙어 있었다
        for k in ("late_explanation", "late_judge", "late_llm"):
            case.pop(k, None)
        case.update({"decision": d, "explanation": res.get("explanation", ""), "judge": res.get("judge"),
                     "validation": res.get("validation"), "trace": res.get("trace"), "issues": res.get("issues", []),
                     "policy_hits": res.get("policy_hits", []), "llm": res.get("llm")})
        if new == "PENDING_APPROVAL" and case.get("id"):
            self._outbound.append(("approval.requested", case["id"]))   # v1.21: 전자결재로 결재 요청(커밋 뒤, 그때 상태로)
        if d:
            case["approval"] = {"approver": d["approver"], "proposal": d["proposal"], "recommendation": d["recommendation"],
                                "label": d["label"], "decision": None}
        self._transition(case, "analysis_done", new, "SYSTEM", (d or {}).get("label") or (res.get("issues") or [{}])[0].get("message", ""))
        if new == "NEEDS_INFO" and case["type"] == "RENEWAL":
            # 32차(AR-03): 업로드한 계약서의 '확인 필요'는 원문을 다시 보는 내부 일이다 — 외부 발송 없음, 해소는 '확인한 값 넣기'.
            # 기존: 사유와 상관없이 INF-001 에이전시 지급 일정 회신 요청(email:agency)을 만들어 엉뚱한 상대에게 사실과 다른 메시지가 나갔다
            # AR-04: 기한을 모를 수 있으므로 작업 기한은 접수 뒤 3일(통보 기한이 그보다 이르면 그 7일 전, 오늘보다 앞이면 오늘)
            q = d["needs_info"][0]
            due = self._add(self.ctx()["today"], 3)
            dl = d["subject"].get("deadline")
            if dl:
                due = max(self.ctx()["today"], min(due, self._before(dl, 7)))
            self._create_task(case["id"], {"dept": "CONTRACT_OWNER", "kind": "INFO_REQUEST", "due": due,
                                           "title": f"[원문 확인] {d['subject'].get('name')}: {q} → 결재 서류의 '확인한 값 넣기'에 입력(외부 발송 없음)"})
        elif new == "NEEDS_INFO":
            for q in d["needs_info"]:
                self._create_task(case["id"], {"dept": "CONTRACT_OWNER", "title": f"[확인 요청] {q} → 에이전시에 지급 일정 회신 요청",
                                               "due": self._before(d["subject"].get("deadline"), 7), "kind": "INFO_REQUEST",
                                               "channel": "email:agency",
                                               "message": f"[Masil Commerce → 에이전시] 역제안 검토를 위해 고정 피 지급 일정(지급일·금액)을 {self._before(d['subject'].get('deadline'), 7)}까지 회신 부탁드립니다. 지급일에 따라 승인 절차가 달라집니다."})
        if new == "ACTION_REQUIRED":
            rw = (d.get("regulation") or {}).get("rewrite")
            self._create_task(case["id"], {"dept": "MARKETING_TEAM", "title": f"[카피 수정] {d['subject']['id']} — 수정안 “{rw}” 검토 후 재상신",
                                           "due": d["subject"]["deadline"], "kind": "FIX"})
        self.bus.publish("case.analyzed", {"case_id": case["id"], "actor": actor,
                                           "detail": f"{case['title']} → {state_of(new).label} ({(d or {}).get('label','')})"})
        return case

    @staticmethod
    def _add(day: str, days: int) -> str:
        from datetime import timedelta
        return (date.fromisoformat(day) + timedelta(days=days)).isoformat()

    @staticmethod
    def _before(deadline: str | None, days: int) -> str | None:
        if not deadline:
            return None
        from datetime import timedelta
        return (date.fromisoformat(deadline) - timedelta(days=days)).isoformat()

    def _save(self, case: dict) -> dict:
        from ..llm.provider import OFFLINE_ONLY
        marked = OFFLINE_ONLY.get() and case.get("decision") and case.get("llm") == "offline"
        if marked:
            case["llm"] = f"작성 중({self._llm_name()})"   # AC-01: 규칙 판단은 확정, AI 설명은 잠금 밖에서 곧 채움
            case["llm_pending"] = uuid.uuid4().hex[:12]     # AD-01: 이 분석의 표 — 설명은 표가 같을 때만 넣는다
        saved = self.repo.put("cases", case)
        if marked:   # 같은 명령 안에서 여러 번 저장해도 한 번만(기존: 저장할 때마다 다시 넣어 같은 건을 두 번 분석)
            self._llm_todo.append(saved)
        return saved

    def _create_task(self, case_id: str, t: dict) -> dict:
        if t.get("kind") in ("FIX", "INFO_REQUEST", "DEADLINE_ALERT"):  # 재분석해도 같은 확인·수정 작업을 중복 생성하지 않음
            for ex in self.repo.list("tasks"):
                if ex["case_id"] == case_id and ex["kind"] == t["kind"] and ex["status"] == "OPEN":
                    return ex
        tid = self._next_id("task", "TK")
        doc = {"id": tid, "case_id": case_id, "status": "OPEN", "created_on": self.ctx()["today"], **t}
        self.repo.put("tasks", doc)
        self.bus.publish("task.created", {"case_id": case_id, "detail": f"{ROLE_KO.get(t['dept'], t['dept'])}: {t['title']}"})
        return doc

    # ---------- 사건 접수 ----------
    def intake(self, kind: str, actor: str = "SYSTEM", text: str | None = None, payload: dict | None = None) -> list[dict]:
        return self.intake_ex(kind, actor, text, payload)[0]

    def intake_ex(self, kind: str, actor: str = "SYSTEM", text: str | None = None, payload: dict | None = None) -> tuple[list[dict], str]:
        """사건 접수 + 사용자 안내 문구(G-02: 브라우저 엔진과 같은 문장).
        G-03: 한 사건의 모든 쓰기를 한 트랜잭션으로(repo.batch) — MySQL에서 연결·커밋을 한 번만."""
        with self._deferred_llm():
            with self._lock, self.repo.batch():
                once = _ONCE.get(kind)
                if once and self._cases(once):
                    raise Duplicate(f"{_ONCE_KO[kind]}은(는) 이미 접수되어 다시 처리하지 않았습니다(중복 접수 방지).")
                with self._mutating():
                    self._info, self._llm_todo, self._outbound = "", [], []
                    try:
                        out = self._intake(kind, actor, text, payload)
                        info = self._info or self._intake_info(kind, out)
                    finally:
                        todo, self._llm_todo = self._llm_todo, []
                        outb, self._outbound = self._outbound, []
        self._send_out(outb)
        self._enrich(todo)
        return [self.repo.get("cases", c["id"]) or c for c in out], info

    def _intake_info(self, kind: str, out: list[dict]) -> str:
        if kind == "BUDGET_PLAN_BATCH":
            return f"기안 {len(out)}건 분석 완료"
        if not out:
            return "접수"
        c = out[0]
        if kind == "AGENCY_COUNTER_OFFER":
            return f"{c['id']} 역제안 접수 → {state_ko(c['state'])}{' (연락처 마스킹)' if (c.get('inbound') or {}).get('masked') else ''}"
        if kind == "FREE_TEXT":
            v = (c.get("validation") or {}).get("input") or {}
            return "메모 접수" if v.get("action") == "pass" else f"⚠ {v.get('message')}"
        return f"{c['id']} 분석 완료 → {state_ko(c['state'])}"

    def _intake(self, kind: str, actor: str, text: str | None, payload: dict | None) -> list[dict]:
        today = self.ctx()["today"]
        # V-02(11차): API·MCP로 들어온 문장(외부 공문·메모)도 화면·MCP에 나가기 전에 연락처·이메일·계좌를 가린다.
        # 기존에는 모의 역제안만 가려, 직접 넣은 공문·메모의 휴대폰·이메일이 결재 서류에 그대로 보였다.
        raw, inbound = text, None
        if text:
            o = check_output(text)
            text = o["masked_text"] if o["action"] != "block" else "(시스템 비밀값으로 보이는 문자열이 있어 원문을 가렸습니다)"
            if o["action"] != "pass":
                inbound = {"masked": True}
        mr = self.dr.mock_replies
        created = []
        if kind == "CONTRACT_RENEWAL_NOTICE":
            c = CaseFactory.create(kind, "CT-INF001-2025", "INF-001 혜인 전속계약 갱신 통보", text or "에이전시 공문: INF-001 연간 전속계약 갱신 통보(통보 기한 2026-07-17)", today)
            created.append(c)
        elif kind == "BUDGET_PLAN_BATCH":
            for p in self.dr.table("budget_plan"):
                created.append(CaseFactory.create(kind, p["plan_id"], f"{p['plan_id']} 캠페인 확대 기안", text or f"마케팅팀 확대 기안 상신 {p['plan_id']}", today))
        elif kind == "AGENCY_COUNTER_OFFER":
            r = mr["agency_counter_offer"]
            masked = check_output(r["summary"])
            offer = {k: r[k] for k in ("reply_id", "fixed_fee_krw", "performance_fee", "payment_schedule")}
            self._set_ctx(contract_status="COUNTER_OFFER", offer=offer)
            for old in self._cases(lambda x: x["type"] == "CONTRACT" and x["state"] == "PENDING_APPROVAL"):
                self._transition(old, "supersede", "REPLACED", "SYSTEM", "에이전시 역제안 수신 → 새 건으로 대체")
                self._save(old)
            c = CaseFactory.create(kind, "CT-INF001-2025", "INF-001 에이전시 역제안(조건 변경)", masked["masked_text"], today,
                                   {"inbound": {"reply_id": r["reply_id"], "masked": masked["action"] == "warn"}})
            created.append(c)
        elif kind == "MARKETING_CLAIM":
            r = mr["marketing_claim_report"]
            claims = self.ctx()["claims"] + [{"from": "마케팅팀", "summary": r["summary"]}]
            self._set_ctx(claims=claims)
            self.bus.publish("claim.recorded", {"actor": "MARKETING_TEAM", "detail": f"부서 주장 기록(사실 아님): {r['summary']}"})
            out = self.reanalyze_open(lambda x: x["type"] == "CONTRACT", "마케팅팀 성과 보고(주장) 반영 재검토")
            self._info = f"마케팅팀 주장 기록 · 계약 건 {len(out)}건 재검토(결론 유지 여부 확인)"
            return out
        elif kind == "FINANCE_OVERDUE_AR":
            r = mr["finance_overdue_ar"]
            self.bus.publish("reply.received", {"actor": "FINANCE", "detail": f"모의 회신 {r['reply_id']}: {r['summary']}"})
            res = self._change_condition("FINANCE", r["cash_assumption"])
            self._info = self._condition_info(res)   # 기존: 기승인 무효 건 수만 세어 '1건 분석 완료'로 안내(사실과 다름)
            return [self.repo.get("cases", cid) for cid in res["reopened"]]
        elif kind == "CONTRACT_UPLOAD":   # v1.21(§15-3·4): 계약서에서 뽑은 조건으로 자동 갱신 계약 건을 만든다
            rec = dict((payload or {}).get("record") or {})
            rid = rec["terms"]["contract_id"]
            if self._cases(lambda x: x["type"] == "RENEWAL" and x["target_id"] == rid):
                raise Duplicate(f"같은 계약서({rec['terms'].get('filename')}, {rid})는 이미 올라와 있어 다시 만들지 않았습니다.")
            self._put_renewal(rid, {**rec, "status": "UNDER_REVIEW", "uploaded_on": today, "uploaded_by": actor})   # v1.25: 행 하나만 씀
            t = rec["terms"]
            c = CaseFactory.create(kind, rid, f"{t.get('counterparty') or '상대방 미상'} 자동 갱신 계약 검토", f"계약서 업로드: {t.get('filename')}", today)
            created.append(c)
        elif kind == "FREE_TEXT":
            v = check_input(raw or "")          # 우회 지시 검사는 원문으로
            c = CaseFactory.create(kind, "MEMO", "자유 입력 메모", text or "", today)
            created.append(c)
        else:
            raise ValueError(f"알 수 없는 사건: {kind}")
        if inbound:
            for c in created:
                c.setdefault("inbound", inbound)
        out = []
        pre = self._prefetch([c for c in created if kind != "FREE_TEXT"])
        for c in created:
            c["id"] = self._next_id("case", "CS")
            self.bus.publish("case.received", {"case_id": c["id"], "actor": actor, "detail": c["title"]})
            if kind == "FREE_TEXT":
                v = check_input(c["event_text"])
                c["validation"] = {"input": v}
                c["state"] = "BLOCKED" if v["action"] == "block" else ("NEEDS_CLARIFICATION" if v["action"] == "warn" else "RECEIVED")
                out.append(self._save(c))
                continue
            out.append(self._save(self._analyze(c, actor, pre.get(id(c)))))
        return out

    def _cases(self, pred=lambda x: True) -> list[dict]:
        return [c for c in self.repo.list("cases") if pred(c)]

    def reanalyze_open(self, pred, note: str) -> list[dict]:
        out = []
        targets = self._cases(lambda x: pred(x) and x["state"] in ("PENDING_APPROVAL", "NEEDS_INFO", "ACTION_REQUIRED", "HOLD_LINKED")
                              and not (x["state"] == "NEEDS_INFO" and x.get("hold_reason") == "MANUAL"))   # 30차(AP-06): 사람 보류는 '확인 필요'일 때만 제외
        pre = self._prefetch(targets)
        for c in targets:
            before = (c.get("approval") or {}).get("approver")
            self._transition(c, "supersede", "SUPERSEDED", "SYSTEM", note)
            c = self._analyze(c, res=pre.get(id(c)))
            after = (c.get("approval") or {}).get("approver")
            if before != after:
                self.bus.publish("authority.changed", {"case_id": c["id"], "detail": f"{c['target_id']} 승인자 변경 {ROLE_KO.get(before, before)} → {ROLE_KO.get(after, after)}"})
            out.append(self._save(c))
        return out

    # ---------- 커맨드 실행(Invoker) ----------
    def run(self, cmd: Command) -> dict:
        todo: list[dict] = []
        out: dict = {}
        with self._deferred_llm():
            with self._lock, self.repo.batch(), self._mutating():
                self._llm_todo, self._outbound = [], []
                try:
                    res = cmd.execute(self)
                    out = {"ok": True, **res, "info": self._command_info(cmd, res)}
                except NotFound:
                    raise
                except (InvalidTransition, PermissionDenied) as e:
                    self.bus.publish("command.refused", {"actor": cmd.actor, "case_id": cmd.kw.get("case_id"), "detail": f"{cmd.name} 거부: {e}"})
                    out = {"ok": False, "error": str(e), "forbidden": isinstance(e, PermissionDenied)}
                finally:
                    todo, self._llm_todo = self._llm_todo, []
                    outb, self._outbound = (self._outbound if out.get("ok") else []), []
        self._send_out(outb)
        if todo:   # 재분석된 건의 AI 설명은 잠금 밖·응답 뒤에(결재한 사람이 LLM을 기다리지 않음 — 화면은 끝나면 자동 갱신)
            self._background(todo, float(os.getenv("ENRICH_DEBOUNCE_S", "0.4")))
        return out

    def _send_out(self, items: list) -> None:
        if items and self.channel is not None:
            try:
                self.channel.flush(items)
            except Exception:  # noqa: BLE001 — 외부 채널 문제가 명령 결과를 바꾸지 않는다
                pass

    def _enrich_quiet(self, todo: list[dict], debounce: float = 0.0) -> None:
        try:
            self._enrich(todo, debounce)
        except Exception:  # noqa: BLE001 — 저장소 장애 등: '작성 중'은 다음 기동 때 이어서 씀(AD-02)
            pass
        finally:
            self._bg.discard(threading.current_thread())

    # ---------- 사용자 안내 문구(G-02) — frontend/src/engine/desk.ts exec()의 반환 문장과 같게 ----------
    def _condition_info(self, res: dict) -> str:
        reopened = [self.repo.get("cases", cid)["target_id"] for cid in res["reopened"]]
        return f"조건 변경 → 미결 {res['reanalyzed']}건 재검증" + (f" · 기승인 무효·재상신: {', '.join(reopened)}" if reopened else "")

    def _command_info(self, cmd, res: dict) -> str:
        n = cmd.name
        if n == "decide":
            c = res["case"]
            if cmd.kw.get("action") == "request_info":
                return f"{c['id']} 확인 요청"
            return f"{c['id']} {'승인' if cmd.kw.get('action') == 'approve' else '거절'} · 작업 {len(res.get('tasks', []))}건 생성"
        if n == "complete_task":
            t = res["task"]
            info = f"작업 완료: {t['title']}" + (" · 채널 발송(모의)" if res.get("message") else "")
            if res.get("resumed"):
                info += f" · {res['resumed']['target_id']} 재판단 → {state_ko(res['resumed']['state'])}"
            return info
        if n == "apply_fix":
            return f"{res['case']['id']} 수정 카피 재검증 → {state_ko(res['case']['state'])}"
        if n == "receive_reply":
            return f"에이전시 회신 반영 → 재분석 {len(res['cases'])}건" if res.get("cases") else "에이전시 회신 기록"
        if n == "change_condition":
            return self._condition_info(res)
        if n == "contract_facts":
            return f"{res['case']['id']} 확인한 값 반영 → 다시 판단: {state_ko(res['case']['state'])}"
        if n == "audit_anchor":
            a = res.get("anchor")
            return f"감사 기록 머리값 {a['id']}의 메신저 전송을 요청했습니다(전달 여부는 외부 채널 전송 목록)" if a else f"보낼 새 기록이 없습니다({res.get('skipped')})"
        if n == "summary_feedback":
            f = res["feedback"]
            return f"요약 평가 반영 — {f['total']}건 중 도움됨 {f['up']}건"
        if n == "advance_clock":
            return f"기준일 {res['today']}" + (f" · 기한 경과 자동 확정 {len(res['expired'])}건" if res.get("expired") else "")
        return "처리 완료"

    def _get(self, col: str, id_: str) -> dict:
        doc = self.repo.get(col, id_)
        if not doc:
            raise NotFound(f"{id_}을(를) 찾을 수 없습니다.")
        return doc

    def _decide(self, actor: str, case_id: str, action: str, comment: str = "", expected_version: int | None = None) -> dict:
        case = self._get("cases", case_id)
        if expected_version is not None and case["version"] != expected_version:
            # AG-02(20차): 아직 아무도 결정하지 않았는데 판이 바뀐 경우(대개 AI 설명 도착)를 '다른 사용자가 먼저 처리'라고 안내하지 않는다
            if not (case.get("approval") or {}).get("decision") and state_of(case["state"]).open_decision:
                raise InvalidTransition("이 결재 서류는 화면을 연 뒤에 바뀌었습니다(AI 설명 도착·재분석 등). 바뀐 내용을 확인한 뒤 다시 결재하세요.")
            raise InvalidTransition("다른 사용자가 먼저 이 건을 처리했습니다. 새로고침 후 다시 확인하세요.")
        appr = case.get("approval") or {}
        if actor != appr.get("approver"):
            # D-11: '수정 필요' 건 부결도 결재권자만. 30차(AP-03): 확인 요청도 결재권자만(PRD §9) — 기존에는 누구나 아무 결재 건을 '확인 필요'로 멈춤
            who = ROLE_KO.get(appr.get("approver"), appr.get("approver") or "미정")
            if action == "request_info":
                raise PermissionDenied(f"이 건의 확인 요청은 결재권자({who})만 할 수 있습니다({ROLE_KO.get(actor, actor)} 불가).")
            raise PermissionDenied(f"이 건의 승인 권한은 {who}에게 있습니다({ROLE_KO.get(actor, actor)} 불가).")
        if action == "approve" and copy_unresolved(case):
            # 30차(AP-07): 위반 카피가 남은 기안은 권고와 상관없이 승인하지 않는다(필수 확장 카피 게이트)
            raise InvalidTransition("광고 카피 위반이 남아 있어 승인할 수 없습니다 — 마케팅팀이 수정안을 반영해 재검증을 통과한 뒤 결재하세요(부결·확인 요청은 가능).")
        if action == "request_info":
            self._transition(case, "request_info", "NEEDS_INFO", actor, comment or "추가 확인 요청")
            case["hold_reason"] = "MANUAL"   # D-10: 사람이 건 확인 요청은 조건 변경 재검증으로 풀리지 않음
            # 30차(AP-04): 확인 작업은 그 건의 기안 부서로(기존: 항상 마케팅팀 → 계약 건을 계약 담당이 풀 수 없었음)
            dl = (case.get("decision") or {}).get("subject", {}).get("deadline")
            # 32차(O-8): 확인 요청서 양식의 원칙 — 확정기한 7일 전까지 회신(오늘보다 앞이면 오늘). 기존: 확정기한 당일
            due = max(self.ctx()["today"], self._before(dl, 7)) if dl else self._add(self.ctx()["today"], 3)
            self._create_task(case_id, {"dept": info_dept(case), "title": f"[확인 요청] {case['target_id']}: {comment or '근거 보완'}",
                                        "due": due, "kind": "INFO_REQUEST",
                                        "resume_case": True})
            # 30차(AP-08): 감사에 행위와 대상을 남긴다(기존: 의견만 — 의견이 없으면 빈 행)
            self.bus.publish("case.info_requested", {"case_id": case_id, "actor": actor,
                                                     "detail": f"{case['title']} 확인 요청" + (f" — {comment}" if comment else "")})
            self._outbound.append(("approval.closed", case_id))
            return {"case": self._save(case)}
        new = "APPROVED" if action == "approve" else "REJECTED"
        self._transition(case, action, new, actor, comment)
        appr.update({"decision": action, "decided_by": actor, "decided_on": self.ctx()["today"], "comment": comment,
                     "followed_ai": (action == "approve") == (appr.get("recommendation") in ("APPROVE", "CHANGE_TERMS", "CONDITIONAL"))})
        case["approval"] = appr
        tasks = (case["decision"]["on_approve"] if action == "approve" else case["decision"]["on_reject"])
        created = [self._create_task(case_id, t) for t in tasks]
        self._apply_decision_effects(case, action)
        self.bus.publish(f"case.{new.lower()}", {"case_id": case_id, "actor": actor,
                                                  "detail": f"{case['title']} {('승인' if action == 'approve' else '거절')} — {comment}"})
        self._outbound.append(("approval.closed", case_id))   # v1.21: 전자결재 쪽 결재 문서도 닫는다
        return {"case": self._save(case), "tasks": created}

    def _renewal_status(self, rid: str, status: str) -> None:
        rec = self._renewal(rid)
        if rec:
            self._put_renewal(rid, {**rec, "status": status})

    def _apply_decision_effects(self, case: dict, action: str):
        if case["type"] == "RENEWAL":
            self._renewal_status(case["target_id"], "DECIDED_" + ("APPROVE" if action == "approve" else "REJECT"))
            return
        if case["type"] == "CONTRACT":
            if case["kind"] == "CONTRACT_RENEWAL_NOTICE":
                self._set_ctx(contract_status="NOTICE_APPROVED" if action == "approve" else "UNDER_REVIEW")
            else:
                self._set_ctx(contract_status="RENEWAL_APPROVED" if action == "approve" else "TERMINATION_APPROVED")
            effects = {t.get("effect") for t in (case["decision"]["on_approve"] if action == "approve" else case["decision"]["on_reject"])}
            linked = case["decision"].get("linked_plans", [])
            for pc in self._cases(lambda x: x["type"] == "PLAN" and x["target_id"] in linked and not state_of(x["state"]).terminal):
                if "REJECT_LINKED_PLANS" in effects:
                    pc["history"].append({"sim_date": self.ctx()["today"], "from": pc["state"], "to": "REJECTED", "by": "SYSTEM",
                                          "note": f"상위 계약 결정({case['id']}, {ROLE_KO['GROUP_CEO']})에 따라 부결"})
                    pc["state"] = "REJECTED"
                    pc["approval"] = {**(pc.get("approval") or {}), "decision": "reject", "decided_by": "SYSTEM(상위 계약 연동)"}
                    self.bus.publish("case.rejected", {"case_id": pc["id"], "detail": f"{pc['target_id']} 상위 계약 연동 부결"})
                elif "HOLD_LINKED_PLANS" in effects:
                    pc["history"].append({"sim_date": self.ctx()["today"], "from": pc["state"], "to": "HOLD_LINKED", "by": "SYSTEM",
                                          "note": f"상위 계약 조건변경 통보 승인({case['id']}) — 결과까지 보류"})
                    pc["state"] = "HOLD_LINKED"
                    self.bus.publish("case.hold", {"case_id": pc["id"], "detail": f"{pc['target_id']} 상위 계약 대기 보류"})
                elif pc["state"] == "HOLD_LINKED" and self.ctx()["contract_status"] not in HOLD_STATUSES:
                    self._transition(pc, "linked_resolved", "RECEIVED", "SYSTEM", f"상위 계약 결정({case['id']}) — 보류 해제 후 재판단")
                    pc = self._analyze(pc)
                    self.bus.publish("case.released", {"case_id": pc["id"], "detail": f"{pc['target_id']} 상위 계약 결정으로 보류 해제"})
                self._save(pc)

    def _receive_reply(self, actor: str, reply_key: str) -> dict:
        """모의 외부 회신 수신 → 확인 필요 건을 이어서 처리."""
        r = self.dr.mock_replies[reply_key]
        masked = check_output(r["summary"])
        if reply_key == "agency_payment_schedule":
            c = self.ctx()
            if (c.get("offer") or {}).get("payment_schedule"):
                # 30차(AP-05): 같은 회신을 두 번 반영하지 않는다(FR-27 중복 접수와 같은 원칙) — 기존: 다시 받으면 사람이 건 보류까지 풀림
                raise InvalidTransition(f"이미 받은 회신({r['reply_id']})입니다 — 다시 반영하지 않았습니다.")
            # 회신을 기다리는 건만(사람이 건 확인 요청 보류는 담당 부서의 확인 완료로만 풀린다 — D-10)
            targets = self._cases(lambda x: x["type"] == "CONTRACT" and x["state"] == "NEEDS_INFO" and x.get("hold_reason") != "MANUAL")
            if not targets:
                raise InvalidTransition("지급 일정 회신을 기다리는 건이 없습니다.")
            offer = dict(c["offer"] or {})
            offer["payment_schedule"] = r["payment_schedule"]
            self._set_ctx(offer=offer)
            self.bus.publish("reply.received", {"actor": "AGENCY", "detail": masked["masked_text"]})   # 30차(O-5): 회신 접수 → 결과 순서로 남김
            out = []
            for case in targets:
                self._transition(case, "receive_reply", "RECEIVED", actor, f"모의 회신 {r['reply_id']}: {masked['masked_text']}")
                for t in self.repo.list("tasks"):
                    if t["case_id"] == case["id"] and t["kind"] == "INFO_REQUEST" and t["status"] == "OPEN":
                        t.update(status="DONE", done_by="AGENCY", done_on=self.ctx()["today"], result=masked["masked_text"])
                        self.repo.put("tasks", t)
                out.append(self._save(self._analyze(case, actor)))
            return {"cases": out, "masked": masked["action"] == "warn"}
        if reply_key == "agency_accepts_termination":
            self._set_ctx(contract_status="TERMINATED" if self.ctx()["contract_status"] == "TERMINATION_SENT" else self.ctx()["contract_status"])
            self.bus.publish("reply.received", {"actor": "AGENCY", "detail": masked["masked_text"]})
            return {"cases": []}
        raise InvalidTransition(f"처리할 수 없는 회신: {reply_key}")

    def _need(self, action: str, actor: str) -> None:
        """P-01: 화면이 버튼을 막는 것과 별개로 서버가 역할을 확인(permissions.py 한곳의 정책)."""
        if not perm.allowed(action, actor):
            who = ", ".join(ROLE_KO.get(r, r) for r in perm.roles_for(action) if r != "SYSTEM")
            raise PermissionDenied(f"{perm.label(action)}은(는) {who}만 할 수 있습니다({ROLE_KO.get(actor, actor)} 불가).")

    def _apply_fix(self, actor: str, case_id: str, copy: str | None = None) -> dict:
        self._need("apply_fix", actor)
        case = self._get("cases", case_id)
        d = case["decision"]
        new_copy = copy or (d.get("regulation") or {}).get("rewrite")
        overrides = dict(self.ctx()["copy_overrides"])
        overrides[case["target_id"]] = new_copy
        self._set_ctx(copy_overrides=overrides)
        self._transition(case, "apply_fix", "RECEIVED", actor, f"카피 수정 반영: “{new_copy}”")
        for t in self.repo.list("tasks"):
            if t["case_id"] == case_id and t["kind"] == "FIX" and t["status"] == "OPEN":
                t.update(status="DONE", done_by=actor, done_on=self.ctx()["today"])
                self.repo.put("tasks", t)
        case = self._analyze(case, actor)
        return {"case": self._save(case)}

    def _contract_facts(self, actor: str, case_id: str, annual_fee_krw: float | None = None, auto_renew: bool | None = None,
                        notice_days: int | None = None, note: str = "") -> dict:
        """확인 필요 → 사람이 확인한 값 → 다시 판단(§14 '확인 필요로 정지하고 확인 요청'의 끝맺음). 넣은 값은 '사람 입력'으로
        누가·언제·무슨 근거로 넣었는지와 함께 계약 기록에 남고, 결재 서류의 근거에도 그렇게 표시된다."""
        from ..contracts.extract import cash_out_dates, checks as recheck
        self._need("contract_facts", actor)
        case = self._get("cases", case_id)
        if case["type"] != "RENEWAL":
            raise InvalidTransition("업로드한 자동 갱신 계약 건에만 값을 넣을 수 있습니다.")
        if state_of(case["state"]).terminal:
            raise InvalidTransition(f"이미 끝난 건입니다({state_ko(case['state'])}). 값을 바꾸려면 계약서를 다시 올리세요.")
        if annual_fee_krw is None and auto_renew is None and notice_days is None:
            raise InvalidTransition("넣을 값이 없습니다(연간 금액·자동 갱신 여부·통보 일수 중 하나 이상).")
        rec = self._renewal(case["target_id"])
        if not rec:
            raise NotFound("계약 기록을 찾을 수 없습니다.")
        t, today = rec["terms"], self.ctx()["today"]
        who = {"by": actor, "user": CURRENT_USER.get(), "at": today, "note": (note or "")[:200]}
        prov = dict(t.get("provided") or {})
        if annual_fee_krw is not None:
            t["annual_fee_krw"] = float(annual_fee_krw)
            t["fee_basis"] = (t.get("fee_basis") + " → " if t.get("currency") and t.get("fee_basis") else "") + f"사람 입력 {won_short(float(annual_fee_krw))}"
            prov["annual_fee_krw"] = who
        if auto_renew is not None:
            t["auto_renew"] = bool(auto_renew)
            prov["auto_renew"] = who
            if not auto_renew:
                t.pop("notice_deadline", None); t.pop("notice_days", None)
        if notice_days is not None and t.get("auto_renew") and t.get("expiry"):
            from datetime import date as _d, timedelta as _td
            t["notice_days"] = int(notice_days)
            t["notice_deadline"] = (_d.fromisoformat(t["expiry"]) - _td(days=int(notice_days))).isoformat()
            prov["notice_deadline"] = who
        t["provided"] = prov
        t["cash_out_dates"] = cash_out_dates(t, today)
        rec["checks"] = [c for c in rec.get("checks") or [] if c["id"].startswith("OCR_")] + recheck(t, today)
        self._put_renewal(case["target_id"], rec)
        fields = ", ".join({"annual_fee_krw": "연간 금액", "auto_renew": "자동 갱신 여부", "notice_deadline": "통보 기한"}[k] for k in prov if prov[k] is who)
        if case["state"] == "NEEDS_INFO":
            self._transition(case, "receive_reply", "RECEIVED", actor, f"확인한 값 반영({fields}): {who['note'] or '근거 메모 없음'}")
        else:
            self._transition(case, "supersede", "SUPERSEDED", actor, f"확인한 값 반영({fields}) → 다시 판단")
        for tk in self.repo.list("tasks"):   # 이 건의 '확인 요청' 작업은 값 입력으로 해소
            if tk["case_id"] == case_id and tk.get("resume_case") and tk["status"] == "OPEN":
                tk.update(status="DONE", done_by=actor, done_on=today, result="확인한 값 입력으로 해소")
                self.repo.put("tasks", tk)
        case.pop("hold_reason", None)
        self.bus.publish("contract.facts", {"actor": actor, "case_id": case_id, "detail": f"{case['target_id']} 확인한 값 입력({fields}) — {who['note'] or '근거 메모 없음'}"})
        return {"case": self._save(self._analyze(case, actor))}

    def _summary_feedback(self, actor: str, case_id: str, rating: str, note: str = "") -> dict:
        case = self._get("cases", case_id)
        if case["type"] != "RENEWAL" or not (case.get("decision") or {}).get("contract_summary"):
            raise InvalidTransition("계약서 요약이 있는 건에만 평가할 수 있습니다.")
        if rating not in ("up", "down"):
            raise InvalidTransition("평가는 '도움됨(up)' 또는 '부정확함(down)'입니다.")
        key = f"{CURRENT_USER.get() or actor}"
        # v1.26(AM05, §15 ⑧): 한 사람 한 표 = 행 하나((건, 사람)이 열쇠). 기존 kv 문서 하나는 평가 2만 건이면 2.9MB를 매번 읽고 썼다.
        self.repo.put("feedback", {"id": f"{case_id}|{key}", "case_id": case_id, "key": key, "rating": rating, "note": (note or "")[:300],
                                   "role": actor, "user": CURRENT_USER.get(), "at": self.ctx()["today"],
                                   "llm": case["decision"]["contract_summary"].get("llm")})
        self.bus.publish("summary.feedback", {"actor": actor, "case_id": case_id,
                                              "detail": f"{case['target_id']} 계약서 요약 평가: {'도움됨' if rating == 'up' else '부정확함'}" + (f" — {note[:80]}" if note else "")})
        return {"feedback": self.summary_feedback(case_id)}

    def summary_feedback(self, case_id: str | None = None) -> dict:
        if self.repo.get("kv", "summary_feedback"):     # 구 서버가 쓴 옛 문서가 있으면 먼저 옮김
            self.migrate()
        rows = self.repo.find("feedback", "case_id", case_id) if case_id else self.repo.list("feedback")
        up = sum(1 for r in rows if r["rating"] == "up")
        by: dict = {}
        for r in rows:
            k = str(r.get("llm") or "offline")
            by.setdefault(k, {"up": 0, "down": 0})[r["rating"]] += 1
        return {"total": len(rows), "up": up, "down": len(rows) - up, "up_rate": round(up / len(rows), 3) if rows else None, "by_llm": by,
                "notes": [{"case_id": r["case_id"], "rating": r["rating"], "note": r["note"], "role": r["role"]} for r in rows if r.get("note")][-20:]}

    def _complete_task(self, actor: str, task_id: str) -> dict:
        t = self._get("tasks", task_id)
        if actor != t["dept"]:   # P-02: 부서 작업은 그 부서만(기존: 누구나 완료 → 다른 부서가 통보를 대신 발송)
            raise PermissionDenied(f"이 작업은 {ROLE_KO.get(t['dept'], t['dept'])}의 작업입니다({ROLE_KO.get(actor, actor)} 불가).")
        if t["status"] != "OPEN":
            raise InvalidTransition("이미 완료된 작업입니다." if t["status"] == "DONE" else f"이미 닫힌 작업입니다({t.get('result') or t['status']}).")
        # 32차(AR-05): 기한 경과로 자동 갱신이 기록된 계약에는 '기한 전' 통보를 보내지 않는다(기존: 사실과 다른 통보 + 상태가 되돌아감)
        if t.get("effect") in NOTICE_EFFECTS and self.ctx()["contract_status"] == "AUTO_RENEWED":
            raise InvalidTransition("INF-001은 통보 기한 경과로 동일 조건 자동 갱신이 기록됐습니다 — 기한 전 통보 작업은 완료할 수 없습니다(법무 확인 작업으로 처리).")
        if t.get("effect") == "RENEWAL_NOTICE_SENT":
            rid = self._get("cases", t["case_id"])["target_id"]
            if (self.renewals().get(rid) or {}).get("status") == "AUTO_RENEWED":
                raise InvalidTransition("이 계약은 통보 기한 경과로 자동 갱신이 기록됐습니다 — 기한 전 통보 작업은 완료할 수 없습니다.")
        t.update(status="DONE", done_by=actor, done_on=self.ctx()["today"])
        self.repo.put("tasks", t)
        msg = resumed = None
        if t.get("channel"):
            msg = self.send_channel(t["channel"], t.get("message") or t["title"], t["case_id"])
        # D-02: 내부 확인 요청을 담당 부서가 완료하면 그 건을 다시 판단해 결재로 돌려보낸다(기존: 영구 '확인 필요')
        if t.get("resume_case"):
            case = self._get("cases", t["case_id"])
            if case["state"] == "NEEDS_INFO":
                self._transition(case, "receive_reply", "RECEIVED", actor, f"확인 완료: {t['title']}")
                case.pop("hold_reason", None)
                resumed = self._save(self._analyze(case, actor))
        eff = t.get("effect")
        if eff == "RENEWAL_NOTICE_SENT":   # v1.21: 다른 자동 갱신 계약의 통보 발송 → 그 계약만 '통보 완료'(INF-001 상태는 그대로)
            self._renewal_status(self._get("cases", t["case_id"])["target_id"], "NOTICE_SENT")
        elif eff == "CONTRACT_NOTICE_SENT":
            self._set_ctx(contract_status="NOTICE_SENT")
        elif eff == "CONTRACT_TERMINATION_SENT":
            self._set_ctx(contract_status="TERMINATION_SENT")
        elif eff == "CONTRACT_RENEWED":
            self._set_ctx(contract_status="RENEWED")
        self.bus.publish("task.done", {"case_id": t["case_id"], "actor": actor, "detail": t["title"]})
        return {"task": t, "message": msg, "resumed": resumed}

    def send_channel(self, channel: str, body: str, case_id: str | None) -> dict:
        """채널 어댑터(모의) — MCP 서버의 send_channel_message 도구와 같은 경로. 발송 전 check_output."""
        v = check_output(body)
        if v["action"] == "block":
            raise InvalidTransition(v["message"])
        oid = self._next_id("outbox", "MSG")
        doc = {"id": oid, "channel": channel, "body": v["masked_text"], "case_id": case_id,
               "sim_date": self.ctx()["today"], "status": "SENT(모의)"}
        self.repo.put("outbox", doc)
        self.bus.publish("channel.sent", {"case_id": case_id, "detail": f"[{channel}] {v['masked_text']}"})
        self._outbound.append(("message", doc))   # v1.21: 메신저 연동이면 실제로도 보낸다(커밋 뒤)
        return doc

    def _change_condition(self, actor: str, cash_assumption: str) -> dict:
        self._need("change_condition", actor)
        before = self.ctx()["cash_assumption"]
        self._set_ctx(cash_assumption=cash_assumption)
        self.bus.publish("condition.changed", {"actor": actor, "detail": f"현금 전망 가정 {before} → {cash_assumption}"})
        changed = self.reanalyze_open(lambda x: True, f"현금 전망 가정 변경({before}→{cash_assumption}) 재검증")
        # 이미 승인된 건 중 새 조건에서 승인 권한이 올라가면 승인 무효·재상신
        from ..graph.pipeline import engine
        from ..domain.decision import Context
        rank = {"MARKETING_TEAM": 1, "MASIL_CEO": 2, "GROUP_CEO": 3}
        reopened = []
        for c in self._cases(lambda x: x["type"] == "PLAN" and x["state"] == "APPROVED"):
            nd = engine().decide_plan(c["target_id"], Context(**self._engine_ctx()))
            decided_by = c["approval"].get("decided_by")
            if rank.get(nd["approver"], 0) > rank.get(decided_by, 0) and nd["subject"]["settlement_date"] >= self.ctx()["today"]:
                self._transition(c, "supersede_after_approval", "SUPERSEDED", "SYSTEM",
                                 f"조건 변경으로 승인 권한 상향({ROLE_KO.get(decided_by)}→{ROLE_KO.get(nd['approver'])}) — 승인 무효·재상신")
                for t in self.repo.list("tasks"):  # 무효가 된 승인에서 나온 작업은 취소
                    if t["case_id"] == c["id"] and t["status"] == "OPEN":
                        t.update(status="CANCELLED", done_on=self.ctx()["today"], result="승인 무효(조건 변경)로 취소")
                        self.repo.put("tasks", t)
                        self.bus.publish("task.cancelled", {"case_id": c["id"], "detail": f"취소: {t['title']}"})
                c = self._analyze(c)
                reopened.append(self._save(c))
                self.bus.publish("authority.changed", {"case_id": c["id"], "detail": f"{c['target_id']} 기승인 무효 → {ROLE_KO.get(nd['approver'])} 재상신"})
        return {"reanalyzed": len(changed), "reopened": [c["id"] for c in reopened]}

    def _advance_clock(self, actor: str, to: str) -> dict:
        """기한 감시(옵저버) — 미결정 상태로 기한을 넘기면 자동 확정(묵시적 승인)으로 기록."""
        cur = self.ctx()["today"]
        try:   # F-04: API 스키마를 거치지 않는 호출(MCP·내부)도 실제 날짜만 받는다
            date.fromisoformat(to)
        except (TypeError, ValueError):
            raise InvalidTransition(f"존재하지 않는 날짜입니다: {to}") from None
        if to <= cur:
            raise InvalidTransition("시계는 앞으로만 진행할 수 있습니다.")
        self._set_ctx(today=to)
        # Q-06(9차): 시계 진행은 기한 경과 자동 확정을 일으킬 수 있는 동작 → 누가 언제 옮겼는지 남긴다(기존: 기록 없음)
        self.bus.publish("clock.advanced", {"actor": actor, "detail": f"시계 진행 {cur} → {to}"})
        expired = []
        for c in self._cases(lambda x: state_of(x["state"]).open_decision and x.get("decision")):
            dl = hard_deadline(c)
            if dl and dl < to:
                c["history"].append({"sim_date": to, "from": c["state"], "to": "AUTO_COMMITTED", "by": "SYSTEM",
                                     "note": f"확정기한 {dl} 경과 — 미결정이 묵시적 승인으로 확정(철회 불가)"})
                c["state"] = "AUTO_COMMITTED"
                if c["type"] == "CONTRACT" and self.ctx()["contract_status"] != "AUTO_RENEWED":
                    self._set_ctx(contract_status="AUTO_RENEWED")
                    self._after_auto_renewal(to)
                self.bus.publish("deadline.expired", {"case_id": c["id"], "detail": f"⚠ {c['target_id']} 기한 경과 자동 확정 — 승인 권한을 거치지 않은 체결"})
                expired.append(self._save(c))
        # 전속계약: 결정은 했어도 통보가 기한 내 '발송'되지 않으면 계약상 자동 갱신된다
        notice_dl = self.dr.policy["contracts"][0]["notice_deadline"]
        if to > notice_dl and self.ctx()["contract_status"] in ("UNDER_REVIEW", "NOTICE_APPROVED", "COUNTER_OFFER", "TERMINATION_APPROVED"):
            # 30차(O-4): 조건변경 통보를 기한 안에 보냈다면 '통보 미발송'이 아니다 — 미갱신 통보가 없었다는 사실과 법무 확인 필요를 함께 남긴다
            sent = next((t for t in self.repo.list("tasks") if t.get("effect") == "CONTRACT_NOTICE_SENT" and t["status"] == "DONE"), None)
            what = (f"미갱신 통보 미발송(조건변경 통보는 {sent.get('done_on')} 발송 — 갱신 거절 통보로 볼 수 있는지 법무 확인 필요)" if sent
                    else "통보 미발송")
            self.bus.publish("deadline.expired", {"detail": f"⚠ INF-001 통보 기한 {notice_dl}까지 {what}({CONTRACT_STATUS_KO[self.ctx()['contract_status']]}) — 동일 조건 자동 갱신(승인 없는 체결)"})
            self._set_ctx(contract_status="AUTO_RENEWED")
            self._after_auto_renewal(to)
        # v1.21(§15-4): 다른 자동 갱신 계약도 같은 원칙 — 결정했어도 통보를 기한 안에 보내지 않으면 자동 갱신(승인 없는 체결)
        for rid, r in self.renewals().items():
            tm = r.get("terms") or {}
            dl = tm.get("notice_deadline") or (tm.get("expiry") if tm.get("auto_renew") is not False else None)   # 32차(AR-04): 통보 기한 미확인이면 만료일이 마지막 선
            if tm.get("auto_renew") is not False and dl and cur <= dl < to and r.get("status") not in ("NOTICE_SENT", "AUTO_RENEWED"):
                rc = next(iter(self._cases(lambda x: x["type"] == "RENEWAL" and x["target_id"] == rid)), None)
                self.bus.publish("deadline.expired", {"case_id": rc["id"] if rc else None,
                                                      "detail": f"⚠ {r['terms'].get('counterparty')} 계약 통보 기한 {dl}까지 통보 미발송 — 동일 조건 자동 갱신(승인 없는 체결)"})
                self._renewal_status(rid, "AUTO_RENEWED")
                if rc:   # 32차(AR-05): 그 계약의 '기한 전' 통보 작업은 닫는다(완료하면 사실과 다른 통보가 나감)
                    self._close_stale_tasks(lambda t, rc=rc: t["case_id"] == rc["id"] and t.get("effect") == "RENEWAL_NOTICE_SENT", to)
        # D-3 이내 미결정 건 경보 작업
        for c in self._cases(lambda x: state_of(x["state"]).open_decision and x.get("decision")):
            dl = c["decision"]["subject"].get("deadline")
            if dl and 0 <= (date.fromisoformat(dl) - date.fromisoformat(to)).days <= 3:
                if not any(t["case_id"] == c["id"] and t["kind"] == "DEADLINE_ALERT" for t in self.repo.list("tasks")):
                    self._create_task(c["id"], {"dept": (c.get("approval") or {}).get("approver") or "CONTRACT_OWNER",
                                                "title": f"[기한 임박 D-{(date.fromisoformat(dl) - date.fromisoformat(to)).days}] {c['title']} 결정 필요", "due": dl, "kind": "DEADLINE_ALERT"})
        return {"today": to, "expired": [c["id"] for c in expired]}

    def _close_stale_tasks(self, pred, today: str) -> list[dict]:
        closed = []
        for t in self.repo.list("tasks"):
            if t["status"] == "OPEN" and pred(t):
                t.update(status="CANCELLED", done_on=today, result="통보 기한 경과(자동 갱신 기록)로 취소")
                self.repo.put("tasks", t)
                self.bus.publish("task.cancelled", {"case_id": t["case_id"], "detail": f"취소(기한 경과): {t['title']}"})
                closed.append(t)
        return closed

    def _after_auto_renewal(self, today: str) -> None:
        """32차(AR-05): INF-001이 통보 기한 경과로 동일 조건 자동 갱신 기록되면, '기한 전'을 전제로 한 작업(미갱신·조건변경 통보,
        고정 피를 뺀 현금 계획, 기한 전 재검토)은 닫고 사람이 할 일을 새로 만든다. 연계 기안 작업(마케팅)·이사회 보고는 그대로.
        기존: 통보 작업이 열린 채 남아, 완료하면 '기한 내 미갱신 통보' 메시지가 나가고 계약 상태가 자동 갱신 → 미갱신 통보 발송으로 되돌아갔다."""
        notice_dl = self.dr.policy["contracts"][0]["notice_deadline"]
        contract_ids = {c["id"] for c in self._cases(lambda x: x["type"] == "CONTRACT")}
        if not contract_ids:
            return
        self._close_stale_tasks(lambda t: t["case_id"] in contract_ids and (
            t.get("effect") in NOTICE_EFFECTS
            or (t.get("due") and t["due"] <= notice_dl and t.get("effect") not in ("HOLD_LINKED_PLANS", "REJECT_LINKED_PLANS")
                and t.get("kind") not in ("REPORT",))), today)
        last = sorted(contract_ids, key=lambda i: id_order({"id": i}))[-1]
        due = self._add(today, 7)
        self._create_task(last, {"dept": "CONTRACT_OWNER", "kind": "WATCH", "due": due,
                                 "title": "[기한 경과] INF-001 동일 조건 자동 갱신으로 기록 — 법무 확인(보낸 통보의 효력·갱신 뒤 해지 조건·위약금 50%) 후 결정안 재상신"})
        self._create_task(last, {"dept": "FINANCE", "kind": "ACTION", "due": due,
                                 "title": "[기한 경과] INF-001 자동 갱신 반영 — 고정 피 연 28억 지급 일정을 현금 계획에 다시 반영(covenant 하회 구간 대조)"})

    # ---------- 조회 ----------
    def snapshot(self, audit_limit: int = 200) -> dict:
        with self.repo.read_view():   # v1.25(AL06): 모든 조회를 한 시점의 모습으로(다른 서버의 커밋이 반쯤 섞이지 않게)
            return self._snapshot(audit_limit)

    def snapshot_stamped(self, audit_limit: int = 200) -> tuple[int, dict]:
        """(전역 변경 번호, 스냅샷)을 같은 읽기 시점에서 — 캐시 열쇠와 내용이 어긋나지 않게(main._snapshot_bytes)."""
        with self.repo.read_view():
            return self.stamp(), self._snapshot(audit_limit)

    def _snapshot(self, audit_limit: int) -> dict:
        ctx = self.ctx()
        cases = sorted(self.repo.list("cases"), key=id_order)
        plans = {}
        for c in cases:
            if c["type"] == "PLAN":
                plans[c["target_id"]] = PLAN_STATUS_FROM_CASE.get(c["state"], c["state"])
        return {"ctx": ctx, "contract_status_ko": CONTRACT_STATUS_KO.get(ctx["contract_status"], ctx["contract_status"]),
                "cases": cases, "plans": plans,
                "tasks": sorted(self.repo.list("tasks"), key=id_order),
                # Q-01·Q-02(9차): 기록 순서(삽입 순)의 마지막 N건만 읽는다. 기존에는 전 건을 두 번 읽고 문자열 ID로 정렬해
                # AU-10000이 AU-9999보다 앞에 놓였다 → 1만 건을 넘기면 '최근 감사 로그'가 AU-9999에서 멈춤
                "audit": self.repo.tail("audit", audit_limit),
                "audit_total": self.repo.count("audit"),
                "outbox": sorted(self.repo.list("outbox"), key=id_order)}

    def record(self, topic: str, payload: dict) -> None:
        """명령 밖에서 생긴 일(로그인·역할 사칭 거부)을 감사 로그에 남긴다(변경 번호도 올려 화면에 반영)."""
        with self._lock, self.repo.batch(), self._mutating():
            self.bus.publish(topic, payload)

    def audit_page(self, offset: int = 0, limit: int = 50, q: str = "") -> dict:
        """K-01: 감사 로그 전체 열람(오래된 순). 스냅샷은 최근 200건만 주므로, 그 이전 기록은 여기서 찾는다."""
        # Q-02(9차): 저장소에서 검색·페이지를 처리(MySQL은 SQL로) — 기존에는 매번 전 건을 읽어 파이썬에서 걸렀음
        with self.repo.read_view():   # v1.26(AM07): '전체 n건'과 '찾은 m건'을 같은 시점에서(기존: 다른 트랜잭션 — 쓰는 중 8/150번 어긋남)
            matched, items = self.repo.search("audit", (q or "").strip(), audit_text, offset, limit)
            return {"total": self.repo.count("audit"), "matched": matched, "offset": offset, "items": items}

    def reset(self):
        with self._lock, self._mutating():
            # 변경 번호·클러스터 ID·로그아웃 목록·바꾼 비밀번호·리프레시 토큰은 유지(보안 상태).
            # 23차 AJ03(새 칸의 수명): v1.21~22에 생긴 연동 상태도 유지 — SSO 로그인별 id_token(로그아웃을 IdP까지)·진행 중 SSO 요청·
            # 처리한 전자결재 콜백(같은 event_id가 다시 와도 새로 생긴 같은 번호의 건을 결재하지 않게)·백채널 로그아웃 jti·공동 토큰 한도
            # 28차 AO03: 지우기 전에 이번 체인의 머리값과 밖으로 보낸 머리값을 '처음부터' 기록(chain_epochs, 최근 20번)에 남김
            s0, an0 = self.repo.get("kv", "seq") or {}, self.repo.get("kv", "anchor") or {}
            if s0.get("audit_head"):
                ep = self.repo.get("kv", "chain_epochs") or {"id": "chain_epochs", "items": []}
                ep["items"] = (ep.get("items") or [])[-19:] + [{"last": s0.get("audit", 0), "head": s0["audit_head"], "sent": an0.get("sent") or [],
                                                                "reset_at": datetime.now().isoformat(timespec="seconds")}]
                self.repo.put("kv", {k: v for k, v in ep.items() if k != "version"})
            keep = [d for d in (self.repo.get("kv", k) for k in KEEP_ON_RESET) if d]
            gone = {c: self.repo.count(c) for c in ("cases", "tasks", "audit", "renewals", "feedback")}
            self.repo.reset()
            for d in keep:
                self.repo.put("kv", {k: v for k, v in d.items() if k != "version"})
            self._ensure_kv()
            clear_cache()
            # v1.25(AL04): 감사 기록을 지운 사실도 감사 기록으로 — 기존에는 '처음부터' 뒤 감사 기록이 빈 채로 시작해 지운 흔적이 없었다
            self.bus.publish("desk.reset", {"actor": "GROUP_CEO", "detail": f"처음부터 다시 시작(초기화) — 처리 건 {gone['cases']}건·작업 {gone['tasks']}건·"
                                                                        f"계약 기록 {gone['renewals']}건·감사 기록 {gone['audit']}건 삭제"})
