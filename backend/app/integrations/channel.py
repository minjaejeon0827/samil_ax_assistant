"""전자결재·메신저 채널 어댑터(v1.21, PRD §15-2) — 전략(Strategy) 패턴.

CHANNEL=outbox(기본): 지금까지처럼 화면의 '채널 발송함'에만 남긴다(모의).
CHANNEL=webhook     : 실제 시스템으로 보낸다. 전자결재(ESIGN_WEBHOOK_URL)에는 '결재 요청'·'결재 종료'를, 메신저
                      (MESSENGER_WEBHOOK_URL)에는 발송 메시지를 JSON으로 보낸다. 사내 전자결재·메신저마다 받는 형식이 다르면
                      그 앞에 얇은 변환기를 두면 된다(이 서버는 바꾸지 않음).

보내는 쪽(서버 → 외부)
  - 명령이 저장(커밋)된 뒤에만 보낸다. 실패한 명령의 결재 요청이 나가지 않는다.
  - 보내기는 별도 스레드에서 — 외부 시스템이 느려도 결재·접수 응답은 기다리지 않는다.
  - 서명: X-Aurora-Signature: sha256=HMAC(CHANNEL_SECRET, "{timestamp}.{본문}"), X-Aurora-Timestamp, Idempotency-Key(=event_id).
  - 5xx·연결 오류는 0.5·1·2초 간격으로 3번 다시 보내고, 끝내 실패하면 감사 기록(channel.failed). 4xx는 다시 보내지 않음.
  - 전송 기록은 kv 'deliveries'(최근 200건): 상태·시도 횟수·마지막 오류.

받는 쪽(외부 → 서버): POST /api/integrations/approval
  - 같은 방식의 서명(ESIGN_SECRET)을 확인하고, 시각이 5분 넘게 차이 나면 거부(재전송 방지).
  - event_id가 이미 처리된 것이면 같은 결과를 돌려주고 다시 처리하지 않는다(멱등 — 전자결재가 재시도해도 한 번만).
  - 결재자 아이디 → 역할은 ESIGN_USERS("kim.ceo:GROUP_CEO;...")로만 정한다(본문의 역할은 믿지 않음). 권한·상태·판 번호
    검사는 화면과 같은 명령(DecideCommand)이 한다. 감사 기록의 사용자는 '아이디(전자결재)'.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import queue
import threading
import time
import uuid

import httpx

from ..api.auth import CURRENT_USER, ROLES, norm_user


def sign(secret: str, ts: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()


class Channel:
    def __init__(self, desk, kv_update) -> None:
        self.desk = desk
        self.mode = os.getenv("CHANNEL", "outbox").lower()
        self.esign_url = os.getenv("ESIGN_WEBHOOK_URL", "")
        self.messenger_url = os.getenv("MESSENGER_WEBHOOK_URL", "")
        self.secret = os.getenv("CHANNEL_SECRET", "")
        self.in_secret = os.getenv("ESIGN_SECRET", "") or self.secret
        self.users = {norm_user(a): r for a, r in (x.split(":", 1) for x in filter(None, (y.strip() for y in os.getenv("ESIGN_USERS", "").split(";"))) if ":" in x)}
        self.public_url = os.getenv("PUBLIC_URL", "").rstrip("/")
        self.backoff = [float(x) for x in os.getenv("CHANNEL_BACKOFF_S", "0.5,1,2").split(",")]
        self._kv = kv_update
        self._q: queue.Queue = queue.Queue()
        self._worker: threading.Thread | None = None

    @property
    def webhook(self) -> bool:
        return self.mode == "webhook" and bool(self.secret)

    # ---------- 보내기 ----------
    def flush(self, items: list[tuple[str, object]]) -> None:
        """명령이 커밋된 뒤 호출(OpsDesk.run·intake_ex). 결재 요청은 지금 상태를 다시 읽어 보낸다."""
        if not self.webhook or not items:
            return
        for kind, ref in items:
            msg = self._build(kind, ref)
            if msg:
                self._enqueue(*msg)

    def _build(self, kind: str, ref):
        from ..workflow.service import ROLE_KO
        if kind in ("approval.requested", "approval.closed") and self.esign_url:
            c = self.desk.repo.get("cases", ref)
            if not c:
                return None
            if kind == "approval.requested" and c.get("state") != "PENDING_APPROVAL":
                return None
            d, a = c.get("decision") or {}, c.get("approval") or {}
            body = {"type": kind, "case_id": c["id"], "version": c.get("version"), "title": c.get("title"),
                    "approver_role": a.get("approver"), "approver_ko": ROLE_KO.get(a.get("approver"), a.get("approver")),
                    "proposal": d.get("proposal"), "label": d.get("label"), "deadline": (d.get("subject") or {}).get("deadline"),
                    "state": c.get("state"), "decision": a.get("decision"), "decided_by": a.get("decided_by"),
                    "link": f"{self.public_url}/?case={c['id']}" if self.public_url else None}
            return self.esign_url, body
        if kind == "message" and self.messenger_url:
            return self.messenger_url, {"type": "message", **{k: ref.get(k) for k in ("id", "channel", "body", "case_id", "sim_date")}}
        return None

    def _enqueue(self, url: str, body: dict) -> None:
        body = {"event_id": uuid.uuid4().hex, **body}
        self._record(body["event_id"], {"type": body["type"], "url": url, "case_id": body.get("case_id"), "status": "queued", "attempts": 0, "at": time.time(),
                                        "body": body})   # v1.22: 다시 보내기용(같은 event_id로)
        self._start(url, body)

    def _start(self, url: str, body: dict) -> None:
        self._q.put((url, body))
        if not self._worker or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._run, daemon=True)
            self._worker.start()

    def _run(self) -> None:
        while True:
            try:
                url, body = self._q.get(timeout=30)
            except queue.Empty:
                return
            self._send(url, body)

    def _send(self, url: str, body: dict) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode()
        err, attempts = "", 0
        for i in range(len(self.backoff) + 1):
            attempts = i + 1
            ts = str(int(time.time()))
            try:
                r = httpx.post(url, content=raw, timeout=5, headers={"Content-Type": "application/json", "X-Aurora-Event": body["type"],
                                                                     "X-Aurora-Timestamp": ts, "X-Aurora-Signature": sign(self.secret, ts, raw),
                                                                     "Idempotency-Key": body["event_id"]})
                if r.status_code < 300:
                    self._record(body["event_id"], {"status": "sent", "attempts": attempts, "http": r.status_code, "sent_at": time.time()})
                    return
                err = f"HTTP {r.status_code}"
                if r.status_code < 500:
                    break                      # 4xx는 다시 보내도 같다
            except Exception as e:  # noqa: BLE001
                err = type(e).__name__
            if i < len(self.backoff):
                time.sleep(self.backoff[i])
        self._record(body["event_id"], {"status": "failed", "attempts": attempts, "last_error": err})
        try:
            self.desk.record("channel.failed", {"case_id": body.get("case_id"), "detail": f"외부 채널 전송 실패({body['type']}, {attempts}회 시도, {err}) — 발송함·화면 기록은 그대로"})
        except Exception:  # noqa: BLE001
            pass

    def _record(self, eid: str, patch: dict) -> None:
        def up(doc):
            items = doc.get("items") or {}
            items[eid] = {**items.get(eid, {}), **patch}
            while len(items) > 200:
                items.pop(next(iter(items)))
            doc["items"] = items
        try:
            self._kv("deliveries", up)
        except Exception:  # noqa: BLE001
            pass

    def retry(self, eid: str, actor: str) -> dict:
        """v1.22(§15-2 남은 일): 끝내 실패한 전송을 사람이 다시 보낸다 — 같은 event_id(Idempotency-Key)라 받는 쪽이 중복을 거른다."""
        from fastapi import HTTPException
        box: dict = {}

        def take(doc):
            """23차 AJ04: 확인과 '보내는 중' 표시를 한 번에(저장소 잠금 안에서) — 두 사람이 동시에 눌러도 한 번만 보낸다."""
            items = doc.get("items") or {}
            d = items.get(eid)
            box["v"] = dict(d) if d else None
            if d and d.get("status") == "failed" and d.get("body") and d.get("url"):
                d.update(status="queued", retried=int(d.get("retried", 0)) + 1, last_error=None, retried_by=actor, retried_at=time.time())
                box["ok"] = True
            doc["items"] = items
        self._kv("deliveries", take)
        d = box.get("v")
        if not d:
            raise HTTPException(404, "전송 기록을 찾을 수 없습니다(최근 200건만 보관).")
        if not box.get("ok"):
            st = d.get("status")
            if st == "queued":
                raise HTTPException(409, "이미 다시 보내는 중입니다(다른 사람이 먼저 눌렀을 수 있음). 결과는 '외부 채널 전송'에 곧 표시됩니다.")
            if st == "sent":
                raise HTTPException(409, "이미 전달된 전송입니다. 다시 보낼 필요가 없습니다.")
            raise HTTPException(409, "보낼 내용이 남아 있지 않아 다시 보낼 수 없습니다(v1.21 이전 기록).")
        n = int(d.get("retried", 0)) + 1
        self.desk.record("channel.retried", {"actor": actor, "case_id": d.get("case_id"), "detail": f"외부 채널 다시 보내기({d.get('type')}, event {eid[:8]}…, {n}번째)"})
        self._start(d["url"], d["body"])
        return {"ok": True, "event_id": eid, "status": "queued"}

    # ---------- 받기(전자결재 콜백) ----------
    def verify(self, ts: str, sig: str, raw: bytes) -> None:
        from fastapi import HTTPException
        if not self.in_secret:
            raise HTTPException(404, "전자결재 연동이 설정되어 있지 않습니다(ESIGN_SECRET).")
        try:
            skew = abs(time.time() - int(ts))
        except (TypeError, ValueError):
            raise HTTPException(401, "서명 시각(X-Aurora-Timestamp)이 없습니다.") from None
        if skew > 300:
            raise HTTPException(401, f"서명 시각이 {int(skew)}초 차이 납니다(5분 초과 — 재전송 의심).")
        if not sig or not hmac.compare_digest(sig, sign(self.in_secret, ts, raw)):
            raise HTTPException(401, "서명(X-Aurora-Signature)이 맞지 않습니다.")

    def role_of(self, user: str) -> str | None:
        r = self.users.get(norm_user(user))
        return r if r in ROLES else None

    def handle_decision(self, body: dict) -> dict:
        """서명 확인이 끝난 콜백 → 결재 명령. event_id로 한 번만."""
        from fastapi import HTTPException
        from ..workflow.service import DecideCommand
        eid = str(body.get("event_id") or "")
        if not eid or len(eid) > 100:
            raise HTTPException(422, "event_id가 필요합니다(100자 이하).")
        box: dict = {}

        def seen(doc):
            box["prev"] = (doc.get("items") or {}).get(eid)
        self._kv("esign_inbound", seen)
        if box.get("prev"):
            return {**box["prev"], "duplicate": True}
        user = str(body.get("user") or "")
        role = self.role_of(user)
        if not role:
            raise HTTPException(403, f"전자결재 사용자 '{user}'의 역할이 등록되어 있지 않습니다(ESIGN_USERS).")
        action = body.get("action")
        if action not in ("approve", "reject", "request_info"):
            raise HTTPException(422, "action은 approve·reject·request_info 중 하나여야 합니다.")
        CURRENT_USER.set(f"{norm_user(user)}(전자결재)")
        res = self.desk.run(DecideCommand(role, case_id=str(body.get("case_id") or ""), action=action,
                                          comment=str(body.get("comment") or "전자결재")[:200],
                                          expected_version=body.get("expected_version")))
        out = {"ok": bool(res.get("ok")), "state": (res.get("case") or {}).get("state"), "error": res.get("error"), "forbidden": res.get("forbidden")}

        def keep(doc):
            items = doc.get("items") or {}
            items[eid] = {**out, "at": time.time()}
            while len(items) > 500:
                items.pop(next(iter(items)))
            doc["items"] = items
        if out["ok"] or not out.get("forbidden"):
            self._kv("esign_inbound", keep)
        return out
