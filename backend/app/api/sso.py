"""v1.21(PRD §15-1): 사내 SSO(OIDC) 로그인 · 회전형 리프레시 토큰 · 비밀번호 변경.

사내 SSO(OIDC, 인가 코드 + PKCE)
  1) 화면이 GET /api/auth/oidc/start → 서버가 state·nonce·PKCE 검증값을 만들어 저장(kv 'oidc_pending', 10분, 한 번만)하고
     IdP 로그인 주소를 돌려준다.
  2) IdP가 화면 주소로 ?code&state 를 붙여 돌려보내면 화면이 POST /api/auth/oidc/callback.
  3) 서버가 state를 꺼내 지우고(재사용 불가) 코드를 토큰으로 바꾼 뒤(client_secret + code_verifier) id_token을
     IdP 공개키(JWKS)로 검증한다: 서명(RS256)·iss·aud·exp·nonce. 역할은 OIDC_ROLE_CLAIM(기본 aurora_role) 또는
     OIDC_GROUP_ROLES(그룹 → 역할)로 정한다. 역할이 없으면 로그인시키지 않는다(403).
  4) 이후는 기존 로그인과 같은 접근 토큰(15분, sid)·감사 기록. 토큰에는 idp='oidc'가 들어간다.

회전형 리프레시 토큰(API·MCP 같은 프로그램용)
  - 로그인하면 접근 토큰과 함께 리프레시 토큰을 준다. 저장소에는 해시만 둔다(kv 'refresh').
  - POST /api/auth/token 으로 바꾸면 새 접근 토큰 + 새 리프레시 토큰을 주고 옛것은 '사용됨'으로 표시한다.
  - 이미 쓴 리프레시 토큰이 다시 오면(탈취 의심) 그 로그인(sid) 전체를 무효화한다.
  - 최대 수명은 로그인한 때부터 SESSION_MAX_S(기본 8시간) — 리프레시로 늘어나지 않는다. 로그아웃하면 함께 무효.
  - 화면은 이전처럼 '활동 중 연장'(/api/auth/refresh)을 쓴다(쉬면 만료 — 9차 요구 그대로).

비밀번호 변경(로컬 계정)
  - POST /api/auth/password: 현재 비밀번호 확인(틀리면 로그인 실패와 같이 잠금에 셈) → 규칙(10자 이상, 두 종류 이상의
    문자, 아이디·현재 비밀번호와 다름, 흔한 비밀번호 아님) → PBKDF2 해시를 저장소(kv 'passwords')에 저장하고 버전을 올린다.
  - 토큰에는 비밀번호 버전(pwv)이 들어가므로, 바꾸기 전에 받은 모든 토큰(다른 기기 포함)과 리프레시 토큰이 무효가 된다
    (서버 여러 대는 5초 안에). 바꾼 사람에게는 새 로그인(새 sid)을 준다. SSO 계정은 사내 계정 시스템에서 바꾼다.
"""
from __future__ import annotations

import base64
import hashlib
import os
import secrets
import time

import httpx
from fastapi import HTTPException

from .auth import ROLES, norm_user

PENDING_TTL_S = 600
COMMON = {"password", "password1", "password12", "1234567890", "qwerty1234", "aurora1234", "masil12345", "admin12345"}


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class OIDC:
    def __init__(self, load, update, sessions=None) -> None:
        self.issuer = os.getenv("OIDC_ISSUER", "").rstrip("/")
        self.client_id = os.getenv("OIDC_CLIENT_ID", "")
        self.secret = os.getenv("OIDC_CLIENT_SECRET", "")
        self.redirect = os.getenv("OIDC_REDIRECT_URI", "")
        self.role_claim = os.getenv("OIDC_ROLE_CLAIM", "aurora_role")
        self.groups = dict(x.split(":", 1) for x in filter(None, (y.strip() for y in os.getenv("OIDC_GROUP_ROLES", "").split(";"))) if ":" in x)
        self.label = os.getenv("OIDC_LABEL", "사내 SSO")
        self._load, self._update = load, update
        self._sessions = sessions or (lambda fn: None)
        self._disc: tuple[float, dict] | None = None
        self._jwk = None

    @property
    def enabled(self) -> bool:
        return bool(self.issuer and self.client_id and self.redirect)

    def discovery(self) -> dict:
        if self._disc and time.time() - self._disc[0] < 600:
            return self._disc[1]
        try:
            d = httpx.get(f"{self.issuer}/.well-known/openid-configuration", timeout=5).json()
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"사내 SSO(IdP)에 연결할 수 없습니다({type(e).__name__}). 잠시 후 다시 시도하거나 관리자에게 알리세요.") from None
        self._disc = (time.time(), d)
        return d

    def start(self) -> str:
        if not self.enabled:
            raise HTTPException(404, "사내 SSO(OIDC)가 설정되어 있지 않습니다.")
        d = self.discovery()
        state, nonce, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(16), secrets.token_urlsafe(48)
        challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
        now = time.time()

        def add(doc):
            items = {k: v for k, v in (doc.get("items") or {}).items() if v.get("exp", 0) > now}
            items[state] = {"verifier": verifier, "nonce": nonce, "exp": now + PENDING_TTL_S}
            doc["items"] = items
        self._update(add)
        q = httpx.QueryParams({"response_type": "code", "client_id": self.client_id, "redirect_uri": self.redirect,
                               "scope": "openid profile email", "state": state, "nonce": nonce,
                               "code_challenge": challenge, "code_challenge_method": "S256"})
        return f"{d['authorization_endpoint']}?{q}"

    def _pop(self, state: str) -> dict | None:
        box: dict = {}
        now = time.time()

        def take(doc):
            items = {k: v for k, v in (doc.get("items") or {}).items() if v.get("exp", 0) > now}
            box["v"] = items.pop(state, None)
            doc["items"] = items
        self._update(take)
        return box.get("v")

    def remember(self, sid: str, id_token: str, until: float, idp_sid: str | None = None, sub: str | None = None) -> None:
        """v1.22(§15-1 남은 일): 로그아웃 때 IdP에 넘길 id_token_hint를 로그인(sid)별로 보관(kv 'oidc_sessions', 만료분 정리)."""
        now = time.time()

        def put(doc):
            items = {k: v for k, v in (doc.get("items") or {}).items() if v.get("exp", 0) > now}
            items[sid] = {"id_token": id_token, "exp": until, "idp_sid": idp_sid, "sub": sub}   # 23차: 백채널 로그아웃이 IdP 세션(sid)·사용자(sub)로 찾음
            doc["items"] = items
        self._sessions(put)

    def logout_url(self, sid: str) -> str | None:
        """RP-initiated logout: IdP의 end_session_endpoint로 보낼 주소(id_token_hint·post_logout_redirect_uri·state). 없으면 None."""
        box: dict = {}

        def take(doc):
            items = doc.get("items") or {}
            box["v"] = items.pop(sid, None)
            doc["items"] = items
        self._sessions(take)
        rec = box.get("v")
        if not rec:
            return None
        try:
            ep = self.discovery().get("end_session_endpoint")
        except HTTPException:
            return None
        if not ep:
            return None
        q = httpx.QueryParams({"id_token_hint": rec["id_token"], "client_id": self.client_id, "state": secrets.token_urlsafe(12),
                               "post_logout_redirect_uri": os.getenv("OIDC_POST_LOGOUT_URI", self.redirect)})
        return f"{ep}?{q}"

    BC_EVENT = "http://schemas.openid.net/event/backchannel-logout"

    def backchannel(self, logout_token: str, jti_update) -> list[tuple[str, float]]:
        """23차(§15-1 남은 일): OIDC Back-Channel Logout 1.0 — IdP가 먼저 끊은 로그아웃. logout_token을 검증하고
        (RS256·iss·aud·iat, events에 backchannel-logout, nonce 없음, sid 또는 sub, jti 한 번만) 해당 SSO 로그인(이 서버의 sid)을 돌려준다.
        실패는 400(OIDC 규약)."""
        import jwt
        if not self.enabled:
            raise HTTPException(404, "사내 SSO(OIDC)가 설정되어 있지 않습니다.")
        d = self.discovery()
        try:
            if self._jwk is None or self._jwk.uri != d["jwks_uri"]:
                self._jwk = jwt.PyJWKClient(d["jwks_uri"], cache_keys=True, lifespan=600)
            key = self._jwk.get_signing_key_from_jwt(logout_token).key
            c = jwt.decode(logout_token, key, algorithms=["RS256"], audience=self.client_id, issuer=d.get("issuer", self.issuer), leeway=30,
                           options={"require": ["iat", "iss", "aud", "jti"], "verify_exp": False})
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"logout_token을 검증하지 못했습니다({type(e).__name__}).") from None
        if self.BC_EVENT not in (c.get("events") or {}):
            raise HTTPException(400, "logout_token에 back-channel logout 이벤트가 없습니다.")
        if "nonce" in c:
            raise HTTPException(400, "logout_token에는 nonce가 있으면 안 됩니다(신원 토큰을 로그아웃 토큰으로 쓰는 공격).")
        if not c.get("sid") and not c.get("sub"):
            raise HTTPException(400, "logout_token에 sid·sub가 모두 없습니다.")
        if time.time() - float(c["iat"]) > 600:
            raise HTTPException(400, "오래된 logout_token입니다(10분 초과).")
        now, box = time.time(), {}

        def once(doc):
            items = {k: v for k, v in (doc.get("items") or {}).items() if v > now}
            box["seen"] = c["jti"] in items
            items[c["jti"]] = now + 900
            doc["items"] = items
        jti_update(once)
        if box["seen"]:
            raise HTTPException(400, "이미 처리한 logout_token입니다(재전송).")

        def take(doc):
            items = doc.get("items") or {}
            hit = [k for k, v in items.items() if (c.get("sid") and v.get("idp_sid") == c["sid"]) or (not c.get("sid") and c.get("sub") and v.get("sub") == c["sub"])]
            box["hit"] = [(k, float(items[k].get("exp", now + 28800))) for k in hit]
            for k in hit:
                items.pop(k, None)
            doc["items"] = items
        self._sessions(take)
        return box["hit"]

    def callback(self, code: str, state: str) -> tuple[str, str, dict]:
        """→ (아이디, 역할, id_token 클레임). 실패는 HTTPException(사유는 감사 기록용으로 구체적)."""
        import jwt
        if not self.enabled:
            raise HTTPException(404, "사내 SSO(OIDC)가 설정되어 있지 않습니다.")
        pend = self._pop(state) if state else None
        if not pend:
            raise HTTPException(400, "SSO 로그인 요청이 만료되었거나 이미 사용되었습니다(state 불일치). 처음부터 다시 로그인하세요.")
        d = self.discovery()
        try:
            r = httpx.post(d["token_endpoint"], timeout=5, data={"grant_type": "authorization_code", "code": code, "redirect_uri": self.redirect,
                                                                  "client_id": self.client_id, "client_secret": self.secret, "code_verifier": pend["verifier"]})
        except Exception as e:  # noqa: BLE001
            raise HTTPException(502, f"사내 SSO(IdP) 토큰 교환에 실패했습니다({type(e).__name__}).") from None
        if r.status_code != 200:
            raise HTTPException(401, f"사내 SSO가 로그인 코드를 거부했습니다(HTTP {r.status_code}). 처음부터 다시 로그인하세요.")
        idt = (r.json() or {}).get("id_token", "")
        try:
            if self._jwk is None or self._jwk.uri != d["jwks_uri"]:
                self._jwk = jwt.PyJWKClient(d["jwks_uri"], cache_keys=True, lifespan=600)
            key = self._jwk.get_signing_key_from_jwt(idt).key
            claims = jwt.decode(idt, key, algorithms=["RS256"], audience=self.client_id, issuer=d.get("issuer", self.issuer), leeway=30,
                                options={"require": ["exp", "iat", "iss", "aud", "sub"]})
        except jwt.ExpiredSignatureError:
            raise HTTPException(401, "사내 SSO 신원 토큰이 만료되었습니다. 다시 로그인하세요.") from None
        except jwt.InvalidAudienceError:
            raise HTTPException(401, "사내 SSO 신원 토큰의 대상(aud)이 이 시스템이 아닙니다.") from None
        except jwt.InvalidIssuerError:
            raise HTTPException(401, "사내 SSO 신원 토큰의 발급자(iss)가 설정과 다릅니다.") from None
        except Exception as e:  # noqa: BLE001 — 서명 불일치·형식 오류
            raise HTTPException(401, f"사내 SSO 신원 토큰을 검증하지 못했습니다({type(e).__name__}).") from None
        if not secrets.compare_digest(str(claims.get("nonce", "")), pend["nonce"]):
            raise HTTPException(401, "사내 SSO 신원 토큰의 nonce가 이 로그인 요청과 다릅니다(재전송 의심).")
        claims["_raw"] = idt                   # 로그아웃 때 id_token_hint로 쓰려고(응답·감사에는 내보내지 않음)
        user = norm_user(str(claims.get("preferred_username") or claims.get("email") or claims["sub"]))
        role = self._role(claims)
        if not role:
            raise HTTPException(403, f"사내 SSO 계정({user})에 이 시스템의 역할이 없습니다. 관리자에게 역할({self.role_claim}) 부여를 요청하세요.")
        return user, role, claims

    def _role(self, claims: dict) -> str | None:
        v = claims.get(self.role_claim)
        for r in ([v] if isinstance(v, str) else list(v or [])):
            if r in ROLES:
                return r
        for g in claims.get("groups") or []:
            if self.groups.get(g) in ROLES:
                return self.groups[g]
        return None


# ---------------- 비밀번호 규칙 ----------------
def password_problems(user: str, new: str, current: str) -> list[str]:
    out = []
    if len(new) < 10:
        out.append("10자 이상이어야 합니다")
    if len(new) > 128:
        out.append("128자 이하여야 합니다")
    kinds = sum(bool(f(new)) for f in (lambda s: any(c.isalpha() for c in s), lambda s: any(c.isdigit() for c in s),
                                       lambda s: any(not c.isalnum() for c in s)))
    if kinds < 2:
        out.append("영문·숫자·기호 중 두 종류 이상을 섞어야 합니다")
    if user and user.split("@")[0].lower() in new.lower():
        out.append("아이디를 포함할 수 없습니다")
    if new == current:
        out.append("현재 비밀번호와 달라야 합니다")
    if new.lower() in COMMON:
        out.append("너무 흔한 비밀번호입니다")
    return out
