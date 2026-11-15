"""MCP 서버 — 채널 연동 아키텍처.

  [Claude Desktop / Cursor / 사내 메신저 봇(MCP 클라이언트)]
          │  MCP (stdio 로컬 · streamable-http 원격)
          ▼
  [aurora-desk MCP 서버]  ── httpx + X-API-Key ──▶  [FastAPI /api/*]  ──▶ OpsDesk(LangGraph·상태·작업)

채널(이메일·메신저·그룹 보고)은 MCP 도구로 노출된다. 승인자는 메신저에서
"내 승인 대기 보여줘" → list_pending_approvals → submit_decision 으로 웹 화면 없이 결정할 수 있다.
결정 권한·상태 전이 검사는 서버(OpsDesk)가 하므로 MCP 클라이언트가 우회할 수 없다.
MCP 규약 MUST: 입력 검증 · 접근 제어(API 키) · 호출 제한(분당 30회) · 출력 정제(check_output).

실행: python -m app.mcp_server            (stdio, Claude Desktop 등록용)
      MCP_TRANSPORT=streamable-http MCP_PORT=8765 python -m app.mcp_server   (원격: http://127.0.0.1:8765/mcp)
      외부 주소로 열 때: MCP_HOST=0.0.0.0 MCP_TOKEN=<긴 무작위 값> … → 요청마다 Authorization: Bearer <MCP_TOKEN>
"""
from __future__ import annotations

import hmac
import os
import re
import sys
import time
from collections import deque

import httpx

try:  # mcp 1.x (부트캠프 자료와 동일한 FastMCP)
    from mcp.server.fastmcp import FastMCP
except ModuleNotFoundError:  # mcp 2.x: FastMCP → MCPServer 이름 변경
    from mcp.server.mcpserver import MCPServer as FastMCP

from .validation import check_output

API = os.getenv("DESK_API_URL", "http://localhost:8000")
KEY = os.getenv("DESK_API_KEY", "dev-local-key")
# J-03: 서버가 로그인 모드(AUTH_MODE=jwt)면 MCP도 사람 계정으로 로그인해 그 역할로만 행동한다(기존: role 인자를 그대로 믿음)
# AA-03(14차): 비밀 파일·쿠버네티스 시크릿에서 읽으면 끝에 줄바꿈이 붙는다 → 아이디는 앞뒤 공백, 비밀번호는 끝 줄바꿈만 정리
DESK_USER, DESK_PASSWORD = os.getenv("DESK_USER", "").strip(), os.getenv("DESK_PASSWORD", "").rstrip("\r\n")
_session: dict = {"token": None, "refresh": None, "role": None, "error": None}
mcp = FastMCP("aurora-desk")
_calls: deque[float] = deque(maxlen=30)


# ---- 입력 검증(I-01·I-02: 기존에는 API의 영문 Pydantic 오류를 그대로 돌려주고, 이상한 ID로 다른 API 경로를 부를 수 있었음) ----
ROLES = ("MARKETING_TEAM", "MASIL_CEO", "GROUP_CEO", "FINANCE", "SCM", "CONTRACT_OWNER")
ACTIONS = ("approve", "reject", "request_info")
KINDS = ("CONTRACT_RENEWAL_NOTICE", "BUDGET_PLAN_BATCH", "AGENCY_COUNTER_OFFER", "MARKETING_CLAIM", "FINANCE_OVERDUE_AR", "FREE_TEXT")
REPLIES = ("agency_payment_schedule", "agency_accepts_termination")
CASE_ID = re.compile(r"^CS-\d{4,8}$")


def _bad(name: str, value: str, allowed: tuple[str, ...]) -> str | None:
    return None if value in allowed else f"'{value}'은(는) 올바른 {name}이 아닙니다. 허용 값: {', '.join(allowed)}"


def _bad_id(case_id: str) -> str | None:
    return None if CASE_ID.match(case_id or "") else f"건 ID 형식이 올바르지 않습니다: '{case_id}'(예: CS-0001)."


class _RateLimited(Exception):
    pass


def _limit() -> None:
    now = time.time()
    _calls.append(now)
    if len(_calls) == _calls.maxlen and now - _calls[0] < 60:
        raise _RateLimited("호출 한도 초과(분당 30회). 잠시 후 다시 시도하세요.")


def _login() -> None:
    # v1.21(§15-1): 리프레시 토큰이 있으면 비밀번호를 다시 보내지 않고 회전으로 새 토큰을 받는다(8시간 최대, 재사용 감지)
    if _session.get("refresh"):
        try:
            r = httpx.post(f"{API}/api/auth/token", json={"refresh_token": _session["refresh"]}, headers={"X-API-Key": KEY}, timeout=10)
            if r.status_code == 200:
                b = r.json()
                _session.update(token=b["token"], refresh=b.get("refresh_token"), role=b["role"], error=None)
                return
        except Exception:  # noqa: BLE001 — 실패하면 비밀번호 로그인으로
            pass
        _session["refresh"] = None
    try:
        r = httpx.post(f"{API}/api/auth/login", json={"user": DESK_USER, "password": DESK_PASSWORD}, headers={"X-API-Key": KEY}, timeout=10)
        b = r.json()
    except Exception as e:  # noqa: BLE001
        _session.update(token=None, role=None, error=f"로그인 실패: {e}")
        return
    if r.status_code == 200:
        _session.update(token=b["token"], refresh=b.get("refresh_token"), role=b["role"], error=None)
    else:
        _session.update(token=None, role=None, error=f"로그인 실패: {b.get('detail', r.status_code)}")


def _headers() -> dict:
    h = {"X-API-Key": KEY}
    if DESK_USER and not _session["token"]:
        _login()
    if _session["token"]:
        h["Authorization"] = f"Bearer {_session['token']}"
    return h


def _req(method: str, path: str, json: dict | None = None, count: bool = True, _retry: bool = True) -> dict:
    if count:   # 작업 완료 확인(폴링)은 사용자 호출이 아니므로 호출 한도에 세지 않는다
        try:
            _limit()
        except _RateLimited as e:
            return {"error": str(e), "status": 429}
    with httpx.Client(base_url=API, headers=_headers(), timeout=30) as c:
        try:
            r = c.request(method, path, json=json)
        except httpx.TransportError:   # E-09: 기존에는 httpx 예외 추적이 그대로 노출됨
            return {"error": f"서버에 연결할 수 없습니다({API}). FastAPI 서버가 켜져 있는지 확인하세요.", "status": 503}
        if r.status_code == 401 and DESK_USER and _retry:   # 토큰 만료 → 다시 로그인해 한 번 더
            _session["token"] = None
            return _req(method, path, json, count=False, _retry=False)
        try:
            body = r.json()
        except ValueError:   # HTML·빈 응답 등(기존: 예외로 도구가 멈춤)
            return {"error": f"서버 응답을 해석할 수 없습니다(HTTP {r.status_code}).", "status": r.status_code}
        if r.status_code >= 400:
            d = body.get("detail", r.text) if isinstance(body, dict) else body
            if isinstance(d, list):   # Pydantic 422 → 한국어 한 줄
                d = "입력값 오류: " + "; ".join(f"{(x.get('loc') or ['?'])[-1]} — 허용 값: {(x.get('ctx') or {}).get('expected', x.get('msg'))}" for x in d)
            return {"error": d, "status": r.status_code}
        return body


def _safe(text: str) -> str:
    v = check_output(text)
    return v["masked_text"] if v["action"] != "block" else "[차단된 출력]"


@mcp.tool()
def list_pending_approvals(role: str) -> str:
    """역할(MARKETING_TEAM·MASIL_CEO·GROUP_CEO)에게 승인 대기 중인 처리 건 목록."""
    if (b := _bad("역할", role, ROLES)):
        return b
    snap = _req("GET", "/api/snapshot")
    if "error" in snap:
        return str(snap["error"])
    rows = [c for c in snap.get("cases", [])
            if c["state"] == "PENDING_APPROVAL" and (c.get("approval") or {}).get("approver") == role]
    if not rows:
        return f"{role} 승인 대기 건이 없습니다."
    return _safe("\n".join(f"{c['id']} | {c['title']} | AI 권고: {c['approval']['label']} | 기한 {c['decision']['subject'].get('deadline')}"
                           for c in rows))


@mcp.tool()
def get_case(case_id: str) -> str:
    """처리 건의 결정 패키지(제안·AI 권고·승인자·근거) 요약."""
    if (b := _bad_id(case_id)):
        return b
    c = _req("GET", f"/api/cases/{case_id}")
    if "error" in c:
        return str(c["error"])
    d = c.get("decision") or {}
    ev = "\n".join(f"- [{e['kind']}] {e['text']}" for e in d.get("evidence", [])[:6])
    return _safe(f"{c['title']} ({c['state']})\n제안: {d.get('proposal')}\nAI 권고: {d.get('label')}\n승인자: {d.get('approver')}\n근거:\n{ev}")


@mcp.tool()
def submit_decision(case_id: str, role: str, action: str, comment: str = "") -> str:
    """승인(approve)·거절(reject)·확인요청(request_info). 권한이 없으면 서버가 거부한다."""
    if (b := _bad_id(case_id) or _bad("역할", role, ROLES) or _bad("행동", action, ACTIONS)):
        return f"거부됨: {b}"
    if DESK_USER:
        _headers()
        if _session["error"]:
            return f"거부됨: {_session['error']}"
        if _session["role"] and role != _session["role"]:
            return f"거부됨: 이 MCP 계정({DESK_USER})은 {_session['role']} 역할로만 결재할 수 있습니다({role} 불가)."
    r = _req("POST", f"/api/cases/{case_id}/decision", {"actor": role, "action": action, "comment": comment})
    if "error" in r:
        return f"거부됨: {r['error']}"
    return f"처리됨: {r['case']['state']} — 생성된 작업 {len(r.get('tasks', []))}건"


@mcp.tool()
def inject_event(kind: str, text: str = "") -> str:
    """사건 접수: CONTRACT_RENEWAL_NOTICE · BUDGET_PLAN_BATCH · AGENCY_COUNTER_OFFER · MARKETING_CLAIM · FINANCE_OVERDUE_AR · FREE_TEXT."""
    if (b := _bad("사건 종류", kind, KINDS)):
        return f"접수 실패: {b}"
    job = _req("POST", "/api/events", {"kind": kind, "text": text or None})
    if "error" in job:
        return f"접수 실패: {job['error']}"
    # E-09: 기존에는 작업 ID 딕셔너리만 돌려줘 결과를 알 수 없었음 → 끝날 때까지 기다려 결과 문장을 돌려준다
    for _ in range(150):
        j = _req("GET", f"/api/jobs/{job['job_id']}", count=False)
        if "error" in j or j.get("status") in ("done", "failed"):
            return _safe(str(j.get("error") or j.get("message")))
        time.sleep(0.2)
    return f"처리 중입니다(작업 {job['job_id']}). 잠시 후 list_pending_approvals로 확인하세요."


@mcp.tool()
def receive_mock_reply(reply_key: str) -> str:
    """외부(에이전시) 모의 회신 수신: agency_payment_schedule · agency_accepts_termination."""
    if (b := _bad("회신 종류", reply_key, REPLIES)):
        return b
    r = _req("POST", "/api/replies", {"reply_key": reply_key})
    return _safe(str(r.get("error") or f"회신 반영 — 재분석 {len(r.get('cases', []))}건"))


@mcp.tool()
def list_outbox() -> str:
    """채널 발송함(에이전시 이메일·사내 메신저 모의 발송 기록)."""
    snap = _req("GET", "/api/snapshot")
    if "error" in snap:
        return str(snap["error"])
    return _safe("\n".join(f"{m['id']} [{m['channel']}] {m['body']}" for m in snap.get("outbox", [])) or "발송 기록 없음")


def _with_token(app, token: str):
    """원격 MCP 접근 토큰 확인(I-03). Authorization: Bearer <MCP_TOKEN> 이 없으면 401."""
    expected = f"Bearer {token}".encode()

    async def guarded(scope, receive, send):
        if scope["type"] == "http":
            got = dict(scope.get("headers") or []).get(b"authorization", b"")
            if not hmac.compare_digest(got, expected):
                body = "접근 토큰이 필요합니다(Authorization: Bearer <MCP_TOKEN>).".encode()
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"text/plain; charset=utf-8"), (b"www-authenticate", b"Bearer")]})
                await send({"type": "http.response.body", "body": body})
                return
        await app(scope, receive, send)
    return guarded


def main() -> None:
    transport = os.getenv("MCP_TRANSPORT", "stdio")
    if transport == "stdio":
        mcp.run(transport="stdio")
        return
    # G-04: 원격 전송의 기본 포트가 FastAPI와 같은 8000이라 함께 띄우면 시작하지 못했음 → 별도 포트(기본 8765)
    host, port = os.getenv("MCP_HOST", "127.0.0.1"), int(os.getenv("MCP_PORT", "8765"))
    token = os.getenv("MCP_TOKEN", "")
    loopback = host in ("127.0.0.1", "localhost", "::1")
    if not token and not loopback:
        # I-03: 승인·결정 도구가 외부에 무방비로 열리지 않게 — 토큰 없이 외부 주소로는 시작하지 않는다
        sys.stderr.write(f"원격 MCP를 {host}에 열려면 MCP_TOKEN(접근 토큰)을 설정하세요. 토큰 없이는 이 컴퓨터(127.0.0.1)에서만 열 수 있습니다.\n")
        raise SystemExit(2)
    if not token:   # 이 컴퓨터 안에서만(개발용)
        if hasattr(mcp, "settings") and hasattr(mcp.settings, "port"):   # mcp 1.x FastMCP: 설정 객체로 지정
            mcp.settings.host, mcp.settings.port = host, port
            mcp.run(transport=transport)
        else:                                                             # mcp 2.x MCPServer: 실행 인자로 지정
            mcp.run(transport=transport, host=host, port=port)
        return
    import uvicorn
    try:
        app = mcp.streamable_http_app(host=host)   # mcp 2.x
    except TypeError:
        app = mcp.streamable_http_app()            # mcp 1.x
    uvicorn.run(_with_token(app, token), host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
