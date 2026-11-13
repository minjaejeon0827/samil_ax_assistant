"""FastAPI 서버 — 멀티유저 비동기 처리.

- async 엔드포인트 + 무거운 작업은 run_in_threadpool(동기 pymysql·LangGraph가 이벤트 루프를 막지 않게).
- 25건 일괄 분석은 BackgroundTasks로 접수만 하고 202 + job_id 반환 → 클라이언트는 /api/jobs/{id} 폴링
  ("처리 중" → 완료 후 결과 조회 UX). 운영에서 처리량이 커지면 Redis+Celery로 교체(같은 Job 인터페이스).
- 보안: CORS 허용 출처 화이트리스트(ALLOWED_ORIGINS) + X-API-Key. HTTPS는 Let's Encrypt(배포 문서 참조).
- 동시성: OpsDesk 내부 RLock + 저장소 낙관적 잠금(version) — 두 승인자가 같은 건을 동시에 눌러도 한 명만 반영.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from typing import Literal

from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .api.schemas import ActorIn, ClockIn, ConditionIn, DecisionIn, EventIn, FixIn, JobOut, LoginIn, OidcCallbackIn, PasswordIn, ReplyIn, TaskDoneIn, TokenIn
from .api.sso import OIDC
from .workflow import permissions as perm
from .api.auth import CURRENT_USER, Identity, get_auth, norm_user, require_identity
from .api.security import verify_api_key
from .config import get_settings
from .domain.data import get_dataroom
from .graph.pipeline import engine
from .domain.decision import Context
from .repo.base import StorageUnavailable
from .repo.memory import MemoryRepository
from .workflow.service import (AnchorAuditCommand, AdvanceClockCommand, ApplyFixCommand, ChangeConditionCommand, CompleteTaskCommand, ContractFactsCommand, SummaryFeedbackCommand,
                               DecideCommand, Duplicate, NotFound, OpsDesk, ReceiveReplyCommand, ROLE_KO)

settings = get_settings()
log = logging.getLogger("aurora")


@asynccontextmanager
async def lifespan(_: FastAPI):
    """첫 사용자 요청이 RAG 인덱스·판단 엔진 적재 비용(약 200ms)을 떠안지 않도록 기동 시 미리 준비."""
    from .rag.store import get_retriever
    await run_in_threadpool(lambda: (engine(), get_retriever(), desk.repo.prepare()))
    try:
        await run_in_threadpool(desk.migrate)          # v1.25(AL03): kv 'renewals' 문서 → renewals 모음(행 하나씩)
    except StorageUnavailable:
        pass                                           # DB가 아직 없으면 다음 기동 때(옛 문서는 남아 있어 잃지 않음)
    await run_in_threadpool(desk.resume_pending)      # AD-02(17차): 꺼지기 전 '작성 중'이던 설명을 이어서 씀(백그라운드)
    stop_anchor = _start_anchor_timer()               # v1.27(AN07·AN08): AUDIT_ANCHOR_S마다 감사 기록 머리값을 메신저로
    yield
    stop_anchor.set()
    await run_in_threadpool(desk.drain, float(os.getenv("SHUTDOWN_DRAIN_S", "8")))   # 정상 종료(재배포) 때는 쓰던 설명을 마치고 끈다


def _start_anchor_timer() -> threading.Event:
    """AUDIT_ANCHOR_S(초, 0이면 끔)마다 머리값을 밖으로 — 서버가 여러 대여도 명령 잠금 안에서 kv 'anchor'를 보고 주기마다 한 번만."""
    stop = threading.Event()
    every = float(os.getenv("AUDIT_ANCHOR_S", "0") or 0)
    if every <= 0:
        return stop

    def loop():
        while not stop.wait(every):
            try:
                desk.run(AnchorAuditCommand("SYSTEM", auto=True, every_s=every))
            except Exception:  # noqa: BLE001 — DB 장애 등은 다음 주기에 다시
                log.warning("감사 기록 머리값 정기 기록 실패", exc_info=True)
    threading.Thread(target=loop, name="audit-anchor", daemon=True).start()
    return stop


app = FastAPI(title="Aurora 캠페인·계약 판단 데스크 API", version="1.28.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-API-Key", "Authorization"],   # 로그인 모드 토큰(Authorization: Bearer)
)
# P-05: 스냅샷(25건 기준 약 330KB)을 압축 — 느린 4G에서 결재 → 화면 반영이 2.3초 걸렸음
app.add_middleware(GZipMiddleware, minimum_size=1024)

MAX_BODY = int(os.getenv("MAX_BODY_BYTES", str(64 * 1024)))   # 가장 큰 정상 요청(메모 2,000자)도 10KB 미만


class BodyLimit:
    """Q-04(9차): 요청 본문 크기 제한(ASGI). 기존에는 60MB 본문을 끝까지 읽어 메모리에 올린 뒤 422 → 요청 하나에 서버
    메모리 +300MB(몇 개만 동시에 보내도 메모리 부족). 길이 표시(Content-Length)가 크면 읽기 전에, 분할 전송은 읽는 중
    한도를 넘는 순간 413으로 끊는다. 한도 안의 본문은 그대로 앱에 넘긴다.
    조금 넘는 본문(DRAIN 이하)은 버리면서 끝까지 받은 뒤 413을 보내 브라우저가 안내 문구를 읽을 수 있게 한다
    (중간에 끊으면 클라이언트에는 '연결 끊김'으로만 보임). 그보다 크면 즉시 끊는다. 어느 쪽이든 메모리에 쌓지 않는다."""
    DRAIN = 4 * 1024 * 1024

    def __init__(self, app, limit: int, paths: dict | None = None):
        self.app, self.limit, self.paths = app, limit, paths or {}

    async def _reject(self, send, close: bool = True):
        body = json.dumps({"detail": f"요청이 너무 큽니다({self.limit // 1024}KB 이하로 보내 주세요)."}, ensure_ascii=False).encode()
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]
        if close:   # 본문을 다 받지 않고 끊을 때만 연결 종료(다 받은 경우 연결을 유지해야 클라이언트가 안내를 확실히 읽음 — 14차 L06 간헐 실패)
            headers.append((b"connection", b"close"))
        await send({"type": "http.response.start", "status": 413, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            return await self.app(scope, receive, send)
        limit = self.paths.get(scope.get("path"), self.limit)   # v1.21: 계약서 업로드만 따로(2MB)
        if limit != self.limit:
            return await self._bounded(scope, receive, send, limit)
        length = dict(scope["headers"]).get(b"content-length")
        if length is not None and length.isdigit() and int(length) > self.DRAIN:
            return await self._reject(send)
        chunks, size = [], 0
        while True:
            m = await receive()
            if m["type"] == "http.disconnect":
                return
            size += len(m.get("body", b""))
            if size > self.DRAIN:
                return await self._reject(send)
            if size <= self.limit:
                chunks.append(m.get("body", b""))
            if not m.get("more_body"):
                break
        if size > self.limit:
            return await self._reject(send, close=False)
        body, done = b"".join(chunks), False
        return await self._replay(scope, receive, send, body)

    async def _bounded(self, scope, receive, send, limit: int):
        """계약서 업로드: 한도(+여유 64KB)를 넘으면 읽기 전·읽는 중 413. 안내 문구는 업로드 한도 기준."""
        length = dict(scope["headers"]).get(b"content-length")
        cap, drain_max = limit + 64 * 1024, 16 * 1024 * 1024
        msg = f"계약서 파일이 너무 큽니다({limit // 1024 // 1024}MB 이하로 올려 주세요)."
        if length is not None and length.isdigit() and int(length) > drain_max:
            return await self._reject_msg(send, msg)          # 아주 큰 것은 바로 끊는다
        chunks, size = [], 0
        while True:
            m = await receive()
            if m["type"] == "http.disconnect":
                return
            size += len(m.get("body", b""))
            if size > drain_max:
                return await self._reject_msg(send, msg)
            if size <= cap:
                chunks.append(m.get("body", b""))
            if not m.get("more_body"):
                break
        if size > cap:
            # AH-08(21차): 한도를 조금 넘는 파일(16MB 이하)은 끝까지 받아 버린 뒤 413 — 중간에 끊으면 브라우저에는 안내 대신
            # '서버에 연결할 수 없음'으로 보였다(메모리에 쌓지 않음)
            return await self._reject_msg(send, msg, close=False)
        return await self._replay(scope, receive, send, b"".join(chunks))

    async def _reject_msg(self, send, msg: str, close: bool = True):
        body = json.dumps({"detail": msg}, ensure_ascii=False).encode()
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())] + ([(b"connection", b"close")] if close else [])
        await send({"type": "http.response.start", "status": 413, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    async def _replay(self, scope, receive, send, body: bytes):
        done = False

        async def replay():
            nonlocal done
            if not done:
                done = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()
        return await self.app(scope, replay, send)


SECURITY_HEADERS = {   # F-02: 기본 보안 헤더(기존: 없음)
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    resp = await call_next(request)
    for k, v in SECURITY_HEADERS.items():
        resp.headers.setdefault(k, v)
    return resp


app.add_middleware(BodyLimit, limit=MAX_BODY, paths={"/api/contracts": 2 * 1024 * 1024})   # 가장 바깥(먼저 실행)


def _make_repo():
    if settings.repo == "mysql":
        from .repo.mysql import MySQLRepository
        return MySQLRepository()
    return MemoryRepository(settings.repo_path)


desk = OpsDesk(_make_repo())
BOOT_ID = uuid.uuid4().hex[:8]
# AA-01(14차): 로그아웃 무효화 목록은 저장소(kv 'revoked')에도 둔다 — 재시작·여러 대에서도 유지
get_auth().attach(lambda: desk.repo.get("kv", "revoked"), lambda doc: desk.repo.put("kv", doc))


def _kv_update(key: str, fn):
    """kv 문서 하나를 읽고-고치고-쓰기(서버 간에도 한 번에 하나씩)."""
    with desk._lock, desk.repo.batch():
        doc = desk.repo.get("kv", key) or {"id": key}
        out = fn(doc)
        desk.repo.put("kv", {k: v for k, v in doc.items() if k != "version"})
        return out


# AB-02(15차): 로그인 실패 기록도 저장소(kv 'auth_fails')에 — 서버마다 따로 세면 대수 × 5번까지 시도할 수 있었다
get_auth().attach_fails(lambda: desk.repo.get("kv", "auth_fails"), lambda fn: _kv_update("auth_fails", fn))
# v1.21(§15-1): 비밀번호 변경·리프레시 토큰·SSO 진행 중 요청도 저장소에(재시작·서버 여러 대)
get_auth().attach_passwords(lambda: desk.repo.get("kv", "passwords"), lambda fn: _kv_update("passwords", fn))
get_auth().attach_refresh(lambda fn: _kv_update("refresh", fn))
# 23차(§15 ⑦ 남은 일): LLM_TPM_SCOPE=shared면 분당 토큰 한도를 저장소(kv 'tpm')에서 서버 여러 대가 함께 센다
from .llm.provider import attach_shared_budget  # noqa: E402
attach_shared_budget(lambda fn: _kv_update("tpm", fn))
oidc = OIDC(lambda: desk.repo.get("kv", "oidc_pending"), lambda fn: _kv_update("oidc_pending", fn), lambda fn: _kv_update("oidc_sessions", fn))
# v1.21(§15-2): 전자결재·메신저 어댑터(CHANNEL=outbox 기본 | webhook)
from .integrations.channel import Channel  # noqa: E402
desk.channel = Channel(desk, _kv_update)


def _session(ident: Identity, idp: str | None = None) -> dict:
    """접근 토큰 + 리프레시 토큰(같은 로그인 sid)."""
    a = get_auth()
    tok = a.issue(ident, idp=idp)
    c = a.claims(tok)
    return {"token": tok, "refresh_token": a.new_refresh(ident, c["sid"], int(c["auth_time"]), idp), "user": ident.user, "role": ident.role,
            "expires_in": int(c["exp"]) - int(c["iat"]), "idp": idp or "local"}


@app.exception_handler(StorageUnavailable)
async def _storage_down(_: Request, e: StorageUnavailable):
    # G-01: DB 장애는 500 내부 오류가 아니라 503 + 원인·할 일 안내
    if getattr(e, "locked", False):   # V-04: 백업·점검 잠금 — 처리되지 않았음을 분명히 알린다
        return JSONResponse(status_code=503, headers={"Retry-After": "10"}, content={"detail": "데이터베이스가 잠시 잠겨 있어(백업·점검 중일 수 있음) 처리하지 못했습니다. 변경된 내용은 없습니다. 잠시 후 다시 시도하세요."})
    return JSONResponse(status_code=503, content={"detail": "저장소(데이터베이스)에 연결할 수 없습니다. 잠시 후 다시 시도하거나 관리자에게 DB 상태를 확인해 달라고 요청하세요."})


_KO_422 = {   # 자주 나오는 검증 오류는 한국어로(화면 readable422와 같은 뜻)
    "string_unicode": "깨진 문자가 들어 있습니다(복사 과정에서 글자가 손상됨). 해당 부분을 지우고 다시 입력하세요.",
    "missing": "필수 입력이 빠졌습니다.",
    "literal_error": "허용되지 않는 값입니다.",
    "json_invalid": "요청 형식(JSON)이 올바르지 않습니다.",
    "string_too_long": "입력이 너무 깁니다.",
    "string_too_short": "입력이 비어 있습니다.",
}


@app.exception_handler(RequestValidationError)
async def _invalid(_: Request, e: RequestValidationError):
    """V-03(11차): 422 응답에 입력값을 되돌려 보내지 않는다(깨진 문자가 그대로 실려 응답을 만들다 500이 났음).
    위치(loc)·종류(type)·메시지(msg)·조건(ctx)만 — 화면은 이것으로 한국어 안내를 만든다."""
    detail = [{"loc": list(x.get("loc", ())), "type": x.get("type"), "msg": _KO_422.get(x.get("type"), str(x.get("msg", "")).replace("Value error, ", "")),
               **({"ctx": {k: v for k, v in x["ctx"].items() if isinstance(v, (int, float, str))}} if x.get("ctx") else {})} for x in e.errors()]
    return JSONResponse(status_code=422, content={"detail": detail})


@app.exception_handler(NotFound)
async def _not_found(_: Request, e: NotFound):
    return JSONResponse(status_code=404, content={"detail": str(e)})
JOBS: dict[str, dict] = {}
auth = [Depends(verify_api_key), Depends(require_identity)]   # J-01: 로그인 모드면 토큰도 필요
WHO = Depends(require_identity)


def _may(who: Identity | None, action: str) -> None:
    """로그인 모드에서만 확인하는 '누가 일으키는가' 규칙(permissions.LOGIN_ONLY). P-01."""
    if who is None or perm.allowed(action, who.role):
        return
    roles = ", ".join(ROLE_KO.get(r, r) for r in perm.roles_for(action))
    desk.record("command.refused", {"actor": who.role, "detail": f"권한 없음: {who.user}({ROLE_KO.get(who.role, who.role)}) — {perm.label(action)}"})
    raise HTTPException(403, f"{perm.label(action)}은(는) {roles}만 할 수 있습니다(로그인: {who.user}, {ROLE_KO.get(who.role, who.role)}).")


def _as(who: Identity | None, requested: str, action: str) -> str:
    """요청 역할 확인. 로그인 모드에서는 토큰의 역할만 쓸 수 있다(J-01: 기존에는 본문 actor를 그대로 믿음)."""
    if who is None:
        return requested
    if requested != who.role:
        desk.record("command.refused", {"actor": who.role, "detail": f"역할 사칭 거부: {who.user}({ROLE_KO.get(who.role, who.role)}) 계정이 {ROLE_KO.get(requested, requested)} 역할로 {action} 시도"})
        raise HTTPException(403, f"로그인한 계정({who.user})의 역할은 {ROLE_KO.get(who.role, who.role)}입니다. {ROLE_KO.get(requested, requested)} 역할로는 처리할 수 없습니다.")
    return who.role


def _unwrap(res: dict) -> dict:
    if not res.get("ok"):
        raise HTTPException(status_code=403 if res.get("forbidden") else 409, detail=res.get("error"))
    return res


@app.post("/api/auth/login", dependencies=[Depends(verify_api_key)])
async def login(body: LoginIn, request: Request):
    a = get_auth()
    if not a.enabled:
        raise HTTPException(404, "로그인 모드(AUTH_MODE=jwt)가 꺼져 있습니다.")
    ip = request.client.host if request.client else "-"
    try:
        ident = await run_in_threadpool(a.login, body.user, body.password, ip)
    except HTTPException as e:
        # P-04: 로그인 실패·잠금도 감사 대상(누가 어느 계정에 시도했는지). 비밀번호는 남기지 않는다
        if e.status_code == 401:
            uid = norm_user(body.user)
            await run_in_threadpool(desk.record, "auth.failed", {"actor": "SYSTEM", "detail": f"로그인 실패: 계정 {uid} · 접속 {ip}"})
            if a.locked(uid, ip):
                await run_in_threadpool(desk.record, "auth.locked", {"actor": "SYSTEM", "detail": f"로그인 잠금(1분): 계정 {uid} · 접속 {ip}"})
        raise
    CURRENT_USER.set(ident.user)
    await run_in_threadpool(desk.record, "auth.login", {"actor": ident.role, "detail": f"로그인: {ident.user}({ROLE_KO.get(ident.role, ident.role)})"})
    return await run_in_threadpool(_session, ident)


@app.get("/api/auth/oidc/start", dependencies=[Depends(verify_api_key)])
async def oidc_start():
    """v1.21(§15-1): 사내 SSO 로그인 시작 — IdP 로그인 주소(state·nonce·PKCE 포함)."""
    if not get_auth().enabled:
        raise HTTPException(404, "로그인 모드(AUTH_MODE=jwt)가 꺼져 있습니다.")
    return {"url": await run_in_threadpool(oidc.start)}


@app.post("/api/auth/oidc/callback", dependencies=[Depends(verify_api_key)])
async def oidc_callback(body: OidcCallbackIn, request: Request):
    if not get_auth().enabled:
        raise HTTPException(404, "로그인 모드(AUTH_MODE=jwt)가 꺼져 있습니다.")
    ip = request.client.host if request.client else "-"
    try:
        user, role, claims = await run_in_threadpool(oidc.callback, body.code, body.state)
    except HTTPException as e:
        await run_in_threadpool(desk.record, "auth.failed", {"actor": "SYSTEM", "detail": f"SSO 로그인 실패: {e.detail} · 접속 {ip}"})
        raise
    ident = Identity(user, role)
    CURRENT_USER.set(user)
    await run_in_threadpool(desk.record, "auth.login", {"actor": role, "detail": f"SSO 로그인({oidc.label}): {user}({ROLE_KO.get(role, role)})"})
    sess = await run_in_threadpool(_session, ident, "oidc")
    c = get_auth().claims(sess["token"])
    await run_in_threadpool(oidc.remember, c["sid"], claims.get("_raw", ""), float(c["auth_time"]) + get_auth().max_s, claims.get("sid"), claims.get("sub"))
    return sess


@app.post("/api/auth/oidc/backchannel")
async def oidc_backchannel(logout_token: str = Form(...)):
    """23차(§15-1 남은 일): IdP가 보내는 Back-Channel Logout. API 키 대신 IdP 서명으로 막는다(인그레스에서 IdP 주소만 허용 권장).
    그 IdP 세션(또는 사용자)의 SSO 로그인을 모두 끊는다 — 접근 토큰·리프레시 토큰. 열린 화면은 다음 갱신 때 로그인 창으로."""
    hits = await run_in_threadpool(oidc.backchannel, logout_token[:8000], lambda fn: _kv_update("oidc_bc_jti", fn))
    for sid, until in hits:
        get_auth().revoke_sid(sid, until)
    await run_in_threadpool(desk.record, "auth.backchannel_logout", {"actor": "SYSTEM", "detail": f"사내 SSO(IdP)가 로그아웃을 알림 — SSO 로그인 {len(hits)}개 끊음"})
    return JSONResponse({"ok": True, "sessions": len(hits)}, headers={"Cache-Control": "no-store"})


@app.post("/api/auth/token", dependencies=[Depends(verify_api_key)])
async def token_refresh(body: TokenIn):
    """v1.21(§15-1): 회전형 리프레시 토큰 — 새 접근·리프레시 토큰. 쓴 토큰을 다시 쓰면 그 로그인 전체 무효."""
    a = get_auth()
    if not a.enabled:
        raise HTTPException(404, "로그인 모드(AUTH_MODE=jwt)가 꺼져 있습니다.")
    try:
        access, rt, ident, left = await run_in_threadpool(a.rotate, body.refresh_token)
    except HTTPException as e:
        if "탈취" in str(e.detail):
            await run_in_threadpool(desk.record, "auth.refresh_reuse", {"actor": "SYSTEM", "detail": f"리프레시 토큰 재사용 감지 — 해당 로그인 전체 무효화"})
        raise
    return {"token": access, "refresh_token": rt, "user": ident.user, "role": ident.role, "expires_in": left}


@app.post("/api/auth/password", dependencies=auth)
async def change_password(body: PasswordIn, request: Request, who: Identity | None = WHO):
    """v1.21(§15-1): 비밀번호 변경 — 이전 토큰·리프레시 토큰(다른 기기 포함) 모두 무효, 바꾼 사람에게 새 로그인."""
    a = get_auth()
    if who is None:
        raise HTTPException(404, "로그인 모드(AUTH_MODE=jwt)가 꺼져 있습니다.")
    if a.claims(request.headers.get("authorization", "")[7:].strip()).get("idp") == "oidc":
        raise HTTPException(400, "사내 SSO 계정의 비밀번호는 사내 계정 시스템에서 바꿉니다.")
    ip = request.client.host if request.client else "-"
    try:
        await run_in_threadpool(a.change_password, who.user, body.current_password, body.new_password, ip)
    except HTTPException as e:
        if e.status_code == 401:
            await run_in_threadpool(desk.record, "auth.failed", {"actor": "SYSTEM", "detail": f"비밀번호 변경 실패(현재 비밀번호 틀림): 계정 {who.user} · 접속 {ip}"})
        raise
    await run_in_threadpool(desk.record, "auth.password_changed", {"actor": who.role, "detail": f"비밀번호 변경: {who.user} — 이전 로그인(다른 기기 포함) 모두 무효"})
    return await run_in_threadpool(_session, who)


@app.post("/api/auth/logout", dependencies=auth)
async def logout(request: Request, who: Identity | None = WHO):
    """P-03: 로그아웃하면 그 토큰을 서버에서 무효화(기존: 화면에서만 지워 15분간 계속 사용 가능)."""
    if who is None:
        return {"ok": True}
    tok = request.headers.get("authorization", "")[7:].strip()
    get_auth().revoke(tok)
    c = get_auth().claims(tok)
    url = await run_in_threadpool(oidc.logout_url, c.get("sid", "")) if c.get("idp") == "oidc" and oidc.enabled else None
    await run_in_threadpool(desk.record, "auth.logout", {"actor": who.role, "detail": f"로그아웃: {who.user}" + (" — 사내 SSO 로그아웃으로 이동" if url else "")})
    return {"ok": True, "logout_url": url}   # v1.22(§15-1): SSO 로그인이면 IdP 로그아웃 주소(화면이 이동)


@app.post("/api/auth/refresh", dependencies=[Depends(verify_api_key)])
async def refresh(request: Request):
    """Q-05(9차): 활동 중인 화면이 만료 전에 호출 → 새 토큰(로그인 시각은 그대로, 최대 SESSION_MAX_S)."""
    a = get_auth()
    if not a.enabled:
        raise HTTPException(404, "로그인 모드(AUTH_MODE=jwt)가 꺼져 있습니다.")
    h = request.headers.get("authorization", "")
    if not h.lower().startswith("bearer "):
        raise HTTPException(401, "로그인이 필요합니다.")
    token, ident, left = a.refresh(h[7:].strip())
    return {"token": token, "user": ident.user, "role": ident.role, "expires_in": left}


@app.get("/api/auth/me", dependencies=auth)
async def me(who: Identity | None = WHO):
    return {"auth": get_auth().mode, "user": who.user if who else None, "role": who.role if who else None}


@app.api_route("/api/health", methods=["GET", "HEAD"])   # X-02(12차): 가동 감시 도구는 HEAD를 많이 쓴다(기존 405)
async def health():
    try:
        await run_in_threadpool(desk.repo.ping)
    except StorageUnavailable:
        return JSONResponse(status_code=503, content={"status": "degraded", "repo": settings.repo, "detail": "저장소(데이터베이스)에 연결할 수 없습니다."})
    return {"status": "ok", "repo": settings.repo, "auth": get_auth().mode, "oidc": oidc.enabled, "oidc_label": oidc.label if oidc.enabled else None,
            "channel": "webhook" if desk.channel.webhook else "outbox",
            # v1.25: DB 연결 재사용·감사 기록 보호 트리거·보기 상태(운영자 확인용 — 트리거가 False면 schema.sql을 관리자 계정으로 적용)
            **({"db": {"opened": desk.repo.opened, "open": desk.repo.open_now, "idle": desk.repo._pool.qsize(), "waited": desk.repo.waited,
                      "guards": desk.repo.db_guards}} if hasattr(desk.repo, "_pool") else {})}


@app.post("/api/integrations/approval")
async def esign_callback(request: Request):
    """v1.21(§15-2): 전자결재 → 결재 결과 콜백. API 키 대신 HMAC 서명(ESIGN_SECRET)·5분 시각 창·event_id 멱등."""
    raw = await request.body()
    desk.channel.verify(request.headers.get("x-aurora-timestamp", ""), request.headers.get("x-aurora-signature", ""), raw)
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        raise HTTPException(422, "본문이 JSON이 아닙니다.") from None
    if not isinstance(body, dict):
        raise HTTPException(422, "본문이 JSON 객체가 아닙니다.")
    try:
        out = await run_in_threadpool(desk.channel.handle_decision, body)
    except NotFound as e:
        raise HTTPException(404, str(e) or "처리 건을 찾을 수 없습니다.") from None
    if not out.get("ok") and not out.get("duplicate"):
        raise HTTPException(403 if out.get("forbidden") else 409, out.get("error"))
    return out


@app.get("/api/integrations/deliveries", dependencies=auth)
async def deliveries(limit: int = Query(200, ge=1, le=200)):
    """v1.21(§15-2): 외부 채널 전송 기록(최근 200건) — 상태·시도 횟수·마지막 오류(보낸 본문은 빼고)."""
    doc = await run_in_threadpool(desk.repo.get, "kv", "deliveries")
    allx = list(((doc or {}).get("items") or {}).items())[::-1]   # 새것부터
    # 23차 AJ08: 실패한 전송은 늘 앞에(최근 성공 수십 건에 밀려 화면에서 사라지면 다시 보낼 수 없다), 나머지는 새것부터 limit건까지
    failed = [x for x in allx if x[1].get("status") == "failed"]
    rest = [x for x in allx if x[1].get("status") != "failed"][:max(0, limit - len(failed))]
    return {"mode": "webhook" if desk.channel.webhook else "outbox", "failed": len(failed), "total": len(allx),
            "items": [[k, {x: y for x, y in v.items() if x != "body"}] for k, v in failed + rest]}


class RetryIn(BaseModel):
    actor: str = "CONTRACT_OWNER"


@app.post("/api/integrations/deliveries/{eid}/retry", dependencies=auth)
async def retry_delivery(eid: str, body: RetryIn, who: Identity | None = WHO):
    """v1.22(§15-2 남은 일): 실패한 전송 다시 보내기(계약 담당·그룹 CEO)."""
    if who is not None:
        _may(who, "channel:retry")
        actor = who.role
    else:
        actor = body.actor
        if actor not in perm.roles_for("channel:retry"):
            raise HTTPException(403, f"다시 보내기는 {', '.join(ROLE_KO.get(r, r) for r in perm.roles_for('channel:retry'))}만 할 수 있습니다.")
    if not desk.channel.webhook:
        raise HTTPException(404, "외부 채널 연동(CHANNEL=webhook)이 꺼져 있습니다.")
    return await run_in_threadpool(desk.channel.retry, eid[:64], actor)


@app.get("/api/audit", dependencies=auth)
async def audit(offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=500), q: str = Query("", max_length=100)):
    """감사 로그 전체 열람(오래된 순, 검색·페이지). K-01: 기존에는 최근 200건 밖의 기록을 볼 방법이 없었음."""
    return await run_in_threadpool(desk.audit_page, offset, limit, q)


@app.get("/api/audit/verify", dependencies=auth)
async def audit_verify(anchor: list[str] = Query(default=[], max_length=50)):
    """v1.26(26차 AM04, §15 ⑧): 감사 기록 해시 체인 검증 — 고친 기록·지운 자리·끝이 잘린 것을 짚는다.
    v1.27(AN07): anchor=AU-0042:<해시>(여러 개 가능) — 메신저에 남은 머리값과 대조해, 체인 전체를 다시 계산한 위조도 짚는다."""
    # 28차 AO05: 형식이 틀린 머리값(콜론 없음·짧은 해시·16진수 아님·긴 값)을 '위조'로 판정하지 않고 거절
    bad = [a[:40] for a in anchor if not ANCHOR_RE.fullmatch(a.strip())]
    if bad:
        raise HTTPException(422, f"머리값 형식이 아닙니다: {', '.join(bad[:3])} — 'AU-0042:<64자 16진수 해시>'처럼 메신저 메시지의 값을 그대로 넣으세요.")
    return await run_in_threadpool(desk.verify_audit, [a.strip() for a in anchor])


ANCHOR_RE = re.compile(r"AU-\d{1,9}:[0-9a-f]{64}")


@app.post("/api/audit/anchor", dependencies=auth)
async def audit_anchor(body: ActorIn, who: Identity | None = WHO):
    """v1.27(AN07, §15 ⑧ 남은 일): 감사 기록 머리값을 메신저(밖)로 보낸다 — 그룹 CEO(주기 기록은 AUDIT_ANCHOR_S)."""
    return _unwrap(await run_in_threadpool(desk.run, AnchorAuditCommand(_as(who, body.actor, "감사 기록 머리값 보내기"))))


@app.get("/api/revision", dependencies=auth)
async def revision():
    """E-07: 화면 자동 갱신용 가벼운 변경 확인(수십 바이트). 서버를 다시 켜면 boot 값이 바뀐다."""
    # AB-01(15차): 전역 변경 번호·클러스터 ID — 어느 서버에 물어도 같은 값(서버가 여러 대여도 화면 자동 갱신)
    stamp, cid = await run_in_threadpool(lambda: (desk.stamp(), desk.cluster_id()))
    return {"boot": cid, "rev": stamp * 2 + desk.revision % 2, "ui": _ui_bundle()}


_UI: dict = {"mtime": None, "name": None}


def _ui_bundle() -> str | None:
    """X-03(12차): 지금 배포된 화면 번들 이름(index.html이 부르는 assets/index-*.js). 열려 있는 탭은 자기 번들과 비교해
    다르면 '새 버전' 안내를 띄운다. 화면을 이 서버가 내보내지 않으면(SERVE_FRONTEND=0) None."""
    if not settings.serve_frontend:
        return None
    f = Path(os.getenv("FRONTEND_DIST") or Path(__file__).resolve().parents[2] / "frontend" / "dist") / "index.html"
    try:
        m = f.stat().st_mtime
    except OSError:
        return None
    if _UI["mtime"] != m:
        import re as _re
        hit = _re.search(r'assets/(index-[\w-]+\.js)', f.read_text(encoding="utf-8"))
        _UI.update(mtime=m, name=hit.group(1) if hit else None)
    return _UI["name"]


@app.get("/api/snapshot", dependencies=auth)
async def snapshot():
    return Response(await run_in_threadpool(_snapshot_bytes), media_type="application/json")


_SNAP: dict = {"rev": None, "body": b""}


def _snapshot_bytes() -> bytes:
    """P-05: 변경 번호가 같으면 직전 스냅샷을 그대로 돌려준다(동시 접속 시 매번 다시 만들지 않음).
    변경 중(홀수)이거나 계산하는 사이 번호가 바뀌면 저장하지 않는다."""
    rev = (desk.revision, desk.stamp())        # AB-01: 다른 서버의 변경도 캐시를 무효화
    if _SNAP["rev"] == rev:
        return _SNAP["body"]
    # v1.25(AL06): 변경 번호와 내용을 같은 읽기 시점에서 — 캐시 열쇠는 '이 내용이 반영한 번호'
    local = desk.revision
    stamp, snap = desk.snapshot_stamped()
    body = json.dumps(snap, ensure_ascii=False, separators=(",", ":")).encode()
    if local % 2 == 0 and desk.revision == local:
        _SNAP.update(rev=(local, stamp), body=body)
    return body


@app.get("/api/facts", dependencies=auth)
async def facts():
    def _f():
        e = engine()
        ctx = Context(**desk._engine_ctx())
        return {**e.facts(), "cash": e.cash(ctx).to_dict(), "policy": get_dataroom().policy}
    return await run_in_threadpool(_f)


def _persist_job(job: dict) -> None:
    """AA-02(14차): 끝난 작업의 결과를 저장소(kv 'jobs', 최근 JOBS_MAX건)에도 남긴다. 기존에는 서버 메모리에만 있어
    재시작(재배포) 뒤 API·MCP가 결과를 물으면 404 '작업을 찾을 수 없습니다'였다."""
    try:
        with desk._lock, desk.repo.batch():   # AB-03: 서버 간에도 한 번에 하나씩(MySQL 행 잠금)
            doc = desk.repo.get("kv", "jobs") or {"id": "jobs", "items": {}}
            items = doc.get("items") or {}
            items[job["job_id"]] = {k: job[k] for k in ("job_id", "status", "message", "result")}
            while len(items) > JOBS_MAX:
                items.pop(next(iter(items)))
            desk.repo.put("kv", {"id": "jobs", "items": items})
    except Exception:  # noqa: BLE001 — 기록 실패가 접수 결과를 바꾸지는 않는다
        pass


def _run_job(job_id: str, ev: EventIn | None, user: str | None = None, fn=None):
    CURRENT_USER.set(user)
    JOBS[job_id]["status"] = "running"
    try:
        _run_job_inner(job_id, ev, fn)
    finally:
        if JOBS.get(job_id, {}).get("status") in ("done", "failed"):
            _persist_job(JOBS[job_id])


def _run_job_inner(job_id: str, ev: EventIn | None, fn=None):
    try:
        cases, info = fn() if fn else desk.intake_ex(ev.kind, ev.actor, ev.text)
        JOBS[job_id].update(status="done", message=info, result={**(JOBS[job_id].get("result") or {}), "case_ids": [c["id"] for c in cases if c]})
    except Duplicate as e:   # E-05: 중복 접수는 실패가 아니라 '이미 처리됨'으로 알려 준다
        JOBS[job_id].update(status="done", message=str(e), result={"case_ids": [], "duplicate": True})
    except StorageUnavailable as e:
        JOBS[job_id].update(status="failed", message=("데이터베이스가 잠시 잠겨 있어(백업·점검 중일 수 있음) 접수하지 못했습니다. 잠시 후 다시 시도하세요." if e.locked
                                                      else "저장소(데이터베이스)에 연결할 수 없어 접수하지 못했습니다. 잠시 후 다시 시도하세요."))
    except Exception as e:  # pragma: no cover
        JOBS[job_id].update(status="failed", message=str(e))


JOBS_MAX = 200   # 작업 기록은 최근 200건만 보관(오래 켜 둔 서버의 메모리 증가 방지)


@app.post("/api/events", dependencies=auth, status_code=202, response_model=JobOut)
async def post_event(ev: EventIn, bg: BackgroundTasks, who: Identity | None = WHO):
    if who is not None:
        _may(who, f"intake:{ev.kind}")
        ev = ev.model_copy(update={"actor": who.role})   # 접수자는 로그인한 사람
    job_id = uuid.uuid4().hex[:12]
    while len(JOBS) >= JOBS_MAX:
        JOBS.pop(next(iter(JOBS)))
    JOBS[job_id] = {"job_id": job_id, "status": "queued", "message": "처리 중입니다. 완료되면 결과를 조회할 수 있습니다.", "result": None}
    await run_in_threadpool(_persist_job, JOBS[job_id])   # AB-03(15차): 다른 서버에 물어도 '처리 중'으로 보이게(기존: 404)
    bg.add_task(_run_job, job_id, ev, who.user if who else None)
    return JOBS[job_id]


@app.post("/api/contracts", dependencies=auth, status_code=202, response_model=JobOut)
async def upload_contract(bg: BackgroundTasks, file: UploadFile = File(...), actor: str = Form("CONTRACT_OWNER"), who: Identity | None = WHO):
    """v1.21(PRD §15-3·4): 계약서(.md·.txt·.pdf, 2MB 이하) → 조항 추출 → 위약금·지급 조건 확인 → 자동 갱신 계약 건(같은 판단 엔진)."""
    from .contracts.extract import ContractError, extract, read_text_ex, run_ocr
    if who is not None:
        _may(who, "intake:CONTRACT_UPLOAD")
        actor = who.role
    elif actor not in perm.roles_for("intake:CONTRACT_UPLOAD"):
        raise HTTPException(403, f"계약서 업로드는 {', '.join(ROLE_KO.get(r, r) for r in perm.roles_for('intake:CONTRACT_UPLOAD'))}만 할 수 있습니다.")
    data = await file.read()
    fname = file.filename or "contract"
    try:   # PDF 글자층 읽기(빠름)는 여기서. 글자 인식(OCR)이 필요하면 23차(AJ05)부터 작업으로 넘긴다 — 응답이 글자 인식을 기다리지 않게
        text, meta = await run_in_threadpool(read_text_ex, fname, data, True)
        rec = None if meta.get("ocr") == "pending" else await run_in_threadpool(extract, text, fname, desk.ctx()["today"], meta.get("ocr", False))
    except ContractError as e:
        raise HTTPException(e.status, str(e)) from None
    job_id = uuid.uuid4().hex[:12]
    while len(JOBS) >= JOBS_MAX:
        JOBS.pop(next(iter(JOBS)))
    if rec:
        JOBS[job_id] = {"job_id": job_id, "status": "queued", "message": "계약서를 분석하고 있습니다.",
                        "result": {"contract_id": rec["terms"]["contract_id"], "terms": rec["terms"], "checks": rec["checks"], "masked": rec["masked"]}}
    else:
        JOBS[job_id] = {"job_id": job_id, "status": "queued", "message": f"스캔 PDF 글자 인식 중 0/{meta['read']}쪽", "result": None}
    await run_in_threadpool(_persist_job, JOBS[job_id])

    def work():
        from .contracts.summary import summarize
        r = rec
        if r is None:   # 스캔 PDF: 쪽마다 진행을 작업 안내에 남긴다(화면이 '글자 인식 중 3/11쪽'을 보여 줌)
            last = [0.0]

            def progress(k, n):
                JOBS[job_id]["message"] = f"스캔 PDF 글자 인식 중 {k}/{n}쪽" + (f"(전체 {meta['pages']}쪽 중 앞 {n}쪽)" if meta["pages"] > n else "")
                if time.monotonic() - last[0] >= 0.8 or k == n:   # 24차 AK06: 다른 서버에 물어도 진행이 보이게 저장소에도(1초에 한 번쯤)
                    last[0] = time.monotonic()
                    _persist_job(JOBS[job_id])
            try:
                txt, m2 = run_ocr(data, {"pages": meta["pages"], "read": meta["read"]}, progress)
                r = extract(txt, fname, desk.ctx()["today"], m2)
            except ContractError as e:
                raise RuntimeError(str(e)) from None
            JOBS[job_id]["message"] = "글자 인식 완료 — 조항을 분석하고 있습니다."
            JOBS[job_id]["result"] = {"contract_id": r["terms"]["contract_id"], "terms": r["terms"], "checks": r["checks"], "masked": r["masked"]}
        record = {k: r[k] for k in ("terms", "checks", "citations")}
        record["summary"] = summarize(record)          # v1.22(⑤): LLM 요약은 명령 잠금 밖(작업 스레드)에서, 값은 규칙 그대로
        JOBS[job_id]["result"]["summary"] = record["summary"]
        return _upload_info(desk.intake_ex("CONTRACT_UPLOAD", actor, None, {"record": record}))
    bg.add_task(_run_job, job_id, None, who.user if who else None, work)
    return JOBS[job_id]


def _upload_info(res):
    cases, _ = res
    c = cases[0] if cases else None
    if not c:
        return res
    d = c.get("decision") or {}
    return cases, f"{c['id']} 계약서 분석 완료 → {ROLE_KO.get(d.get('approver'), '확인 필요')} · {d.get('label', '')}"


@app.get("/api/jobs/{job_id}", dependencies=auth, response_model=JobOut)
async def get_job(job_id: str):
    if job_id in JOBS:
        return JOBS[job_id]
    saved = ((await run_in_threadpool(desk.repo.get, "kv", "jobs")) or {}).get("items", {}).get(job_id)   # AA-02: 재시작 전 작업
    if saved:
        return saved
    raise HTTPException(404, "작업을 찾을 수 없습니다(오래되어 정리됐거나 다른 서버의 작업입니다).")


@app.get("/api/cases/{case_id}", dependencies=auth)
async def get_case(case_id: str):
    c = await run_in_threadpool(desk.repo.get, "cases", case_id)
    if not c:
        raise HTTPException(404, "처리 건을 찾을 수 없습니다")
    return c


@app.post("/api/cases/{case_id}/decision", dependencies=auth)
async def decide(case_id: str, body: DecisionIn, who: Identity | None = WHO):
    return _unwrap(await run_in_threadpool(desk.run, DecideCommand(_as(who, body.actor, "결정"), case_id=case_id, action=body.action,
                                                                   comment=body.comment, expected_version=body.expected_version)))


@app.post("/api/cases/{case_id}/fix", dependencies=auth)
async def fix(case_id: str, body: FixIn, who: Identity | None = WHO):
    return _unwrap(await run_in_threadpool(desk.run, ApplyFixCommand(_as(who, body.actor, "카피 수정"), case_id=case_id, copy=body.copy_text)))


class FactsIn(BaseModel):
    actor: str = "FINANCE"
    annual_fee_krw: float | None = Field(None, gt=0, lt=1e13)
    auto_renew: bool | None = None
    notice_days: int | None = Field(None, ge=1, le=365)
    note: str = Field("", max_length=200)


@app.post("/api/contracts/{contract_id}/facts", dependencies=auth)
async def contract_facts(contract_id: str, body: FactsIn, who: Identity | None = WHO):
    """24차(AK04): 확인 필요로 멈춘 자동 갱신 계약에 확인한 값(원화 금액·자동 갱신 여부·통보 일수)을 넣고 다시 판단(재무팀·계약 담당·그룹 CEO)."""
    c = next((x for x in await run_in_threadpool(desk.repo.list, "cases") if x["type"] == "RENEWAL" and x["target_id"] == contract_id[:40]), None)
    if not c:
        raise HTTPException(404, "이 계약서로 만든 건을 찾을 수 없습니다.")
    return _unwrap(await run_in_threadpool(desk.run, ContractFactsCommand(_as(who, body.actor, "계약서 확인값 입력"), case_id=c["id"], annual_fee_krw=body.annual_fee_krw,
                                                                            auto_renew=body.auto_renew, notice_days=body.notice_days, note=body.note)))


class SummaryFeedbackIn(BaseModel):
    actor: str = "GROUP_CEO"
    rating: Literal["up", "down"]
    note: str = Field("", max_length=300)


@app.post("/api/cases/{case_id}/summary-feedback", dependencies=auth)
async def summary_feedback(case_id: str, body: SummaryFeedbackIn, who: Identity | None = WHO):
    """24차(AK03, ⑤ 남은 일): 계약서 요약 평가 — 한 사람 한 표(같은 사람이 다시 누르면 바뀜)."""
    return _unwrap(await run_in_threadpool(desk.run, SummaryFeedbackCommand(_as(who, body.actor, "요약 평가"), case_id=case_id, rating=body.rating, note=body.note)))


@app.get("/api/cases/{case_id}/summary-feedback", dependencies=auth)
async def summary_feedback_get(case_id: str):
    return await run_in_threadpool(desk.summary_feedback, case_id)


@app.get("/api/eval/summary-feedback", dependencies=auth)
async def summary_feedback_eval():
    """요약 품질 평가 집계(전체·LLM별 도움됨 비율, 최근 사유)."""
    return await run_in_threadpool(desk.summary_feedback, None)


@app.post("/api/replies", dependencies=auth)
async def reply(body: ReplyIn, who: Identity | None = WHO):
    _may(who, "reply")
    # Q-06(9차): 로그인 모드에서는 입력한 사람(토큰 역할)으로 기록 — 기존에는 본문 actor를 그대로 남겨 '그룹 CEO가 입력'으로 위장 가능
    actor = who.role if who else body.actor
    return _unwrap(await run_in_threadpool(desk.run, ReceiveReplyCommand(actor, reply_key=body.reply_key)))


@app.post("/api/tasks/{task_id}/done", dependencies=auth)
async def task_done(task_id: str, body: TaskDoneIn, who: Identity | None = WHO):
    return _unwrap(await run_in_threadpool(desk.run, CompleteTaskCommand(_as(who, body.actor, "작업 완료"), task_id=task_id)))


@app.post("/api/conditions", dependencies=auth)
async def condition(body: ConditionIn, who: Identity | None = WHO):
    return _unwrap(await run_in_threadpool(desk.run, ChangeConditionCommand(_as(who, body.actor, "조건 변경"), cash_assumption=body.cash_assumption)))


@app.post("/api/clock", dependencies=auth)
async def clock(body: ClockIn, who: Identity | None = WHO):
    _may(who, "clock")
    return _unwrap(await run_in_threadpool(desk.run, AdvanceClockCommand(who.role if who else body.actor, to=body.to)))


@app.post("/api/reset", dependencies=auth)
async def reset(who: Identity | None = WHO):
    _may(who, "reset")   # 모든 기록을 지우는 동작은 그룹 CEO만
    await run_in_threadpool(desk.reset)
    await run_in_threadpool(get_auth().persist)   # 초기화해도 로그아웃 무효화 목록은 지우지 않는다
    return {"ok": True}


# 프론트엔드 정적 파일(AXHub 단일 컨테이너 배포용)
DIST = Path(os.getenv("FRONTEND_DIST") or Path(__file__).resolve().parents[2] / "frontend" / "dist")
if settings.serve_frontend and DIST.exists():
    class _ImmutableAssets(StaticFiles):
        """X-02(12차): 해시가 붙은 파일은 내용이 바뀌면 이름도 바뀐다 → 1년 보관해도 안전(재방문 때 다시 받지 않음)."""
        async def get_response(self, path, scope):
            r = await super().get_response(path, scope)
            if r.status_code == 200:
                r.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return r

    app.mount("/assets", _ImmutableAssets(directory=DIST / "assets"), name="assets")

    ROOT_DIST = DIST.resolve()

    NO_CACHE = {"Cache-Control": "no-cache"}   # X-02: 화면 문서는 매번 서버에 확인(바뀌지 않았으면 304로 가볍게)

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def spa(path: str):
        # F-01: 경로 탐색 차단 — 기존에는 '..%2f'로 dist 밖의 소스·설정 파일을 내려받을 수 있었음
        f = (ROOT_DIST / path).resolve()
        if path and f.is_file() and f.is_relative_to(ROOT_DIST):
            return FileResponse(f, headers=NO_CACHE if f.suffix == ".html" else None)
        if path.startswith("api/"):
            raise HTTPException(404, "없는 API 경로입니다.")
        # X-02(12차): 기존에는 캐시 규칙이 없어 브라우저가 index.html을 추정 보관(파일 나이의 10%) → 재배포 뒤
        # 지워진 옛 번들을 불러 흰 화면이 됐다
        return FileResponse(ROOT_DIST / "index.html", headers=NO_CACHE)
