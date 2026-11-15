"""로그인 모드(AUTH_MODE=jwt) — '누가' 결정했는지 서버가 정한다.

7차 E2E에서 확인한 결함(J-01): API는 요청 본문의 actor(역할)를 그대로 믿었다. API 키를 가진 누구나(공개 데모는 키가
화면 코드에 들어 있음) 'GROUP_CEO'라고 적기만 하면 그룹 CEO로 결재할 수 있었다.

- AUTH_MODE=apikey(기본): 기존과 같음(브라우저 시연·개발용). actor는 호출자가 정한다.
- AUTH_MODE=jwt(운영): POST /api/auth/login 으로 받은 토큰(HS256, 기본 15분)이 있어야 조회·결정할 수 있고,
  역할은 토큰이 정한다. 본문의 actor가 토큰 역할과 다르면 403 + 감사 로그(역할 사칭 거부).
  비밀번호는 PBKDF2-SHA256으로 해시해 메모리에만 두고, 5번 틀리면 1분 잠근다(계정 존재 여부는 드러내지 않음).
- 사용자: USERS="아이디:비밀번호:역할;..." (운영에서는 비밀 관리 도구로 주입). JWT_SECRET은 32자 이상 권장.
  비밀번호 자리에 해시(`pbkdf2_sha256$반복$솔트$해시`, `python -m app.api.auth hash`로 생성)를 넣을 수 있다.

v1.8(8차 E2E):
- 로그아웃하면 그 토큰(jti)을 서버에서 무효화한다(P-03: 기존에는 15분간 계속 쓸 수 있었음).
- 잠금은 '계정 + 접속 주소' 단위 5회/분, 계정 전체 30회/분(P-05: 기존에는 남이 일부러 틀려 정당한 사용자를 잠글 수 있었음).
- 비밀번호 해시는 처음 로그인할 때 만든다(P-08: 기존에는 기동 때 전원 해시 → 사용자 200명 3.4초, 1,000명 13초).

v1.9(9차 E2E):
- Q-05: 활동 중 자동 연장. POST /api/auth/refresh 로 같은 로그인 시각(auth_time)의 새 토큰을 받는다. 기존에는 일하는
  중에도 15분마다 로그인 창이 떴다. 쉬고 있으면(화면이 연장을 요청하지 않으면) 그대로 만료되고, 처음 로그인부터
  SESSION_MAX_S(기본 8시간)가 지나면 연장되지 않는다(토큰 만료도 그 시각을 넘지 않음).

v1.10(10차 E2E):
- R-01: 토큰에 로그인 한 번을 뜻하는 sid를 넣고(연장해도 그대로), 로그아웃은 sid 전체를 무효화한다. 기존에는 마지막
  토큰(jti)만 무효화해, 연장 전에 받은 토큰으로 계속 쓰고 다시 연장까지 할 수 있었다(8시간 동안 로그아웃 무력화).
  같은 계정의 다른 기기 로그인(다른 sid)은 그대로 둔다.

v1.14(14차 E2E):
- AA-01: 로그아웃 무효화 목록(jti·sid)을 저장소(kv 'revoked')에도 기록한다. 기존에는 서버 메모리에만 있어 재시작(재배포)하면
  로그아웃한 토큰이 다시 통했고, 연장까지 되어 최대 8시간 쓸 수 있었다. 여러 대일 때를 위해 5초마다 다시 읽는다.
- AA-03: 아이디는 앞뒤 공백을 지우고 소문자로 비교한다(휴대폰 자동 대문자, 비밀 파일 끝 줄바꿈). 잠금도 정리한 아이디 기준이라
  대소문자를 바꿔 가며 틀려도 잠금을 피할 수 없다.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import threading
import time
from collections import defaultdict, deque
from contextvars import ContextVar
from dataclasses import dataclass

from fastapi import HTTPException, Request

ROLES = {"MARKETING_TEAM", "MASIL_CEO", "GROUP_CEO", "FINANCE", "SCM", "CONTRACT_OWNER"}
CURRENT_USER: ContextVar[str | None] = ContextVar("current_user", default=None)   # 감사 로그의 '누가'
_ITER = 100_000
LOCK_AFTER, LOCK_WINDOW_S, LOCK_ACCOUNT_MAX = 5, 60, 30


@dataclass(frozen=True)
class Identity:
    user: str
    role: str


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _hash(pw: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, _ITER)


def norm_user(uid: str) -> str:
    """AA-03: 아이디 비교용 — 앞뒤 공백·줄바꿈 제거, 소문자."""
    return (uid or "").strip().lower()


class Auth:
    def __init__(self) -> None:
        self.mode = os.getenv("AUTH_MODE", "apikey").lower()
        self.ttl = int(os.getenv("TOKEN_TTL_S", "900"))
        self.max_s = int(os.getenv("SESSION_MAX_S", "28800"))   # 로그인 한 번으로 쓸 수 있는 최대 시간(8시간)
        secret = os.getenv("JWT_SECRET", "")
        if self.mode == "jwt" and len(secret) < 16:
            sys.stderr.write("경고: JWT_SECRET이 없거나 짧아 임시 비밀값을 만듭니다(서버를 다시 켜면 모든 로그인이 풀립니다).\n")
            secret = secrets.token_urlsafe(32)
        self.secret = secret.encode()
        # uid → [역할, 반복 횟수, 솔트, 해시 | None, 평문 | None] — 평문 항목은 처음 로그인 때 해시로 바꾼다
        self.users: dict[str, list] = {}
        for item in filter(None, (x.strip() for x in os.getenv("USERS", "").split(";"))):
            uid, pw, role = (item.rsplit(":", 1)[0].split(":", 1) + [""])[:2] + [item.rsplit(":", 1)[-1]]
            uid = norm_user(uid)
            if role not in ROLES:
                raise ValueError(f"USERS의 역할이 올바르지 않습니다: {uid} → {role}")
            if pw.startswith("pbkdf2_sha256$"):
                _, it, salt, digest = pw.split("$")
                self.users[uid] = [role, int(it), _unb64(salt), _unb64(digest), None]
            else:
                self.users[uid] = [role, _ITER, None, None, pw]
        if self.mode == "jwt":
            self._warn_users()
        self._fails: dict[tuple[str, str], deque[float]] = defaultdict(deque)
        self._acct: dict[str, deque[float]] = defaultdict(deque)
        self._revoked: dict[str, float] = {}     # jti → 만료 시각(지나면 정리)
        self._revoked_sid: dict[str, float] = {} # sid(로그인 한 번) → 그 로그인의 최대 만료 시각
        self._lock = threading.Lock()
        self._dummy = (secrets.token_bytes(16), b"")
        self._load = self._save = None
        self._loaded_at = 0.0
        self._fail_load = self._fail_update = None
        # v1.21(§15-1): 비밀번호 변경(kv 'passwords': 아이디 → {hash, ver})·리프레시 토큰(kv 'refresh': 해시 → 정보)
        self._pw_load = self._pw_update = None
        self._pw: dict[str, dict] = {}
        self._pw_at = 0.0
        self._rt_update = None

    def _warn_users(self) -> None:
        """AP-02(29차): 배포 주소에서 6개 계정이 같은 약한 평문 비밀번호였다(로그인 창 예시 글자로 노출). 막지는 않되(시연·시험 계정)
        기동할 때 운영자에게 알린다 — 비밀번호 값과 아이디는 로그에 쓰지 않고 개수만."""
        from .sso import password_problems
        plain = {uid: v[4] for uid, v in self.users.items() if v[4] is not None}
        if not plain:
            return
        weak = sum(1 for uid, pw in plain.items() if password_problems(uid, pw, ""))
        groups: dict[str, int] = defaultdict(int)
        for pw in plain.values():
            groups[pw] += 1
        shared = sum(n for n in groups.values() if n > 1)
        parts = [f"평문 비밀번호 {len(plain)}개"]
        if weak:
            parts.append(f"비밀번호 규칙(10자 이상·영문·숫자·기호 중 두 종류) 미달 {weak}개")
        if shared:
            parts.append(f"여러 계정이 같은 비밀번호를 공용으로 씀 {shared}개 계정")
        sys.stderr.write("경고: USERS — " + " · ".join(parts) + ". 공개 주소라면 계정마다 다른 비밀번호를 정해 "
                         "`python -m app.api.auth hash`로 해시해 넣고, 로그인 화면·문서·번들에 적지 마세요.\n")

    # ---- AB-02(15차): 로그인 실패 기록 공유 ----
    def attach_fails(self, load, update) -> None:
        self._fail_load, self._fail_update = load, update

    @staticmethod
    def _prune(doc: dict, now: float) -> None:
        for k in ("pair", "acct"):
            m = doc.get(k) or {}
            doc[k] = {key: [t for t in ts if now - t <= LOCK_WINDOW_S] for key, ts in m.items()}
            doc[k] = {key: ts for key, ts in doc[k].items() if ts}

    def _shared_counts(self, uid: str, ip: str) -> tuple[list, list] | None:
        if not self._fail_load:
            return None
        try:
            doc = self._fail_load() or {}
        except Exception:  # noqa: BLE001 — 저장소 장애면 이 서버의 기록으로
            return None
        now = time.time()
        pair = [t for t in (doc.get("pair") or {}).get(f"{uid}|{ip}", []) if now - t <= LOCK_WINDOW_S]
        acct = [t for t in (doc.get("acct") or {}).get(uid, []) if now - t <= LOCK_WINDOW_S]
        return pair, acct

    # ---- v1.21: 비밀번호 변경·리프레시 토큰 저장소 연결 ----
    def attach_passwords(self, load, update) -> None:
        self._pw_load, self._pw_update = load, update
        self._reload_pw(force=True)

    def attach_refresh(self, update) -> None:
        self._rt_update = update

    def _reload_pw(self, force: bool = False) -> None:
        if not self._pw_load or (not force and time.time() - self._pw_at < 5):
            return
        try:
            doc = self._pw_load() or {}
        except Exception:  # noqa: BLE001
            return
        with self._lock:
            self._pw = dict(doc.get("users") or {})
            self._pw_at = time.time()

    def pw_version(self, uid: str) -> int:
        return int((self._pw.get(uid) or {}).get("ver", 0))

    # ---- AA-01: 무효화 목록 저장 ----
    def attach(self, load, save) -> None:
        """저장소에 무효화 목록을 읽고 쓰는 함수를 연결한다(main.py). 연결하면 곧바로 저장된 목록을 읽는다."""
        self._load, self._save = load, save
        self._reload(force=True)

    def _reload(self, force: bool = False) -> None:
        if not self._load or (not force and time.time() - self._loaded_at < 5):
            return
        try:
            doc = self._load() or {}
        except Exception:  # noqa: BLE001 — 저장소 장애여도 메모리 목록으로 계속
            return
        now = time.time()
        with self._lock:
            self._revoked.update({j: float(e) for j, e in (doc.get("jti") or {}).items() if float(e) > now})
            self._revoked_sid.update({s: float(e) for s, e in (doc.get("sid") or {}).items() if float(e) > now})
            self._loaded_at = now

    def persist(self) -> None:
        if not self._save:
            return
        with self._lock:
            doc = {"id": "revoked", "jti": dict(self._revoked), "sid": dict(self._revoked_sid)}
        try:
            self._save(doc)
        except Exception:  # noqa: BLE001
            pass

    @property
    def enabled(self) -> bool:
        return self.mode == "jwt"

    # ---- 토큰 ----
    def issue(self, ident: Identity, auth_time: int | None = None, sid: str | None = None, idp: str | None = None) -> str:
        head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
        now = int(time.time())
        at = auth_time or now
        exp = min(now + self.ttl, at + self.max_s)
        claims = {"sub": ident.user, "role": ident.role, "iat": now, "exp": exp, "auth_time": at,
                  "sid": sid or secrets.token_hex(8), "jti": secrets.token_hex(8)}
        if idp:
            claims["idp"] = idp              # v1.21: 'oidc' = 사내 SSO 로그인(로컬 계정 목록과 무관)
        else:
            claims["pwv"] = self.pw_version(ident.user)   # v1.21: 비밀번호를 바꾸면 이전 토큰 무효
        body = _b64(json.dumps(claims).encode())
        sig = _b64(hmac.new(self.secret, f"{head}.{body}".encode(), hashlib.sha256).digest())
        return f"{head}.{body}.{sig}"

    def verify(self, token: str) -> Identity:
        try:
            head, body, sig = token.split(".")
            good = _b64(hmac.new(self.secret, f"{head}.{body}".encode(), hashlib.sha256).digest())
            if not hmac.compare_digest(sig, good):
                raise ValueError("sig")
            claims = json.loads(_unb64(body))
        except Exception:  # noqa: BLE001 — 형식 오류·위조
            raise HTTPException(401, "로그인 정보가 올바르지 않습니다. 다시 로그인하세요.") from None
        if claims.get("exp", 0) < time.time():
            raise HTTPException(401, "로그인 시간이 지났습니다. 다시 로그인하세요.")
        self._reload()
        if claims.get("jti") in self._revoked or (claims.get("sid") and claims["sid"] in self._revoked_sid):
            raise HTTPException(401, "로그아웃한 로그인 정보입니다. 다시 로그인하세요.")
        if claims.get("idp") == "oidc":        # v1.21: SSO 로그인은 IdP가 역할을 정함(토큰 수명·로그아웃·최대 시간은 같음)
            if claims.get("role") not in ROLES:
                raise HTTPException(401, "로그인 정보가 올바르지 않습니다. 다시 로그인하세요.")
            return Identity(claims["sub"], claims["role"])
        u = self.users.get(claims.get("sub", ""))
        if not u or u[0] != claims.get("role"):   # 계정이 지워졌거나 역할이 바뀐 토큰
            raise HTTPException(401, "로그인 정보가 바뀌었습니다. 다시 로그인하세요.")
        self._reload_pw()
        if int(claims.get("pwv", 0)) != self.pw_version(claims["sub"]):
            raise HTTPException(401, "비밀번호가 바뀌어 이전 로그인은 쓸 수 없습니다. 새 비밀번호로 다시 로그인하세요.")
        return Identity(claims["sub"], claims["role"])

    @staticmethod
    def claims(token: str) -> dict:
        return json.loads(_unb64(token.split(".")[1]))

    def refresh(self, token: str) -> tuple[str, Identity, int]:
        """Q-05: 유효한 토큰을 같은 로그인 시각의 새 토큰으로. 최대 시간이 지났으면 401."""
        ident = self.verify(token)
        c = self.claims(token)
        at = int(c.get("auth_time") or c.get("iat") or 0)
        now = int(time.time())
        if now - at >= self.max_s - 1:
            raise HTTPException(401, f"로그인한 지 {self.max_s // 3600 or 1}시간이 지나 다시 로그인해야 합니다." if self.max_s >= 3600 else "최대 로그인 시간이 지나 다시 로그인해야 합니다.")
        new = self.issue(ident, auth_time=at, sid=c.get("sid"), idp=c.get("idp"))
        return new, ident, int(self.claims(new)["exp"]) - now

    # ---- v1.21: 회전형 리프레시 토큰 ----
    @staticmethod
    def _rt_hash(rt: str) -> str:
        return hashlib.sha256(rt.encode()).hexdigest()

    def new_refresh(self, ident: Identity, sid: str, auth_time: int, idp: str | None = None) -> str | None:
        if not self._rt_update:
            return None
        rt = secrets.token_urlsafe(32)
        now = time.time()
        info = {"user": ident.user, "role": ident.role, "sid": sid, "auth_time": auth_time, "idp": idp,
                "pwv": None if idp else self.pw_version(ident.user), "exp": auth_time + self.max_s, "used": False}

        def add(doc):
            items = {k: v for k, v in (doc.get("items") or {}).items() if v.get("exp", 0) > now}
            items[self._rt_hash(rt)] = info
            doc["items"] = items
        self._rt_update(add)
        return rt

    def rotate(self, rt: str) -> tuple[str, str, Identity, int]:
        """리프레시 토큰 → (새 접근 토큰, 새 리프레시 토큰, 신원, 남은 초). 재사용이면 그 로그인 전체 무효화."""
        if not self._rt_update or not rt:
            raise HTTPException(401, "리프레시 토큰이 없습니다. 다시 로그인하세요.")
        h, now, box = self._rt_hash(rt), time.time(), {}

        def take(doc):
            items = doc.get("items") or {}
            info = items.get(h)
            box["info"] = dict(info) if info else None
            if info and not info.get("used") and info.get("exp", 0) > now:
                info["used"] = True
            doc["items"] = items
        self._rt_update(take)
        info = box.get("info")
        if not info:
            raise HTTPException(401, "리프레시 토큰이 올바르지 않습니다. 다시 로그인하세요.")
        if info.get("used"):    # 이미 쓴 토큰이 다시 옴 → 탈취 의심, 그 로그인(sid) 전체 무효
            self._revoke_sid(info["sid"], float(info["auth_time"]) + self.max_s)
            raise HTTPException(401, "이미 사용한 리프레시 토큰입니다(탈취 의심). 이 로그인을 모두 끊었으니 다시 로그인하세요.")
        if info.get("exp", 0) <= now:
            raise HTTPException(401, f"로그인한 지 {self.max_s // 3600 or 1}시간이 지나 다시 로그인해야 합니다.")
        self._reload()
        if info["sid"] in self._revoked_sid:
            raise HTTPException(401, "로그아웃한 로그인입니다. 다시 로그인하세요.")
        ident = Identity(info["user"], info["role"])
        if not info.get("idp"):
            u = self.users.get(info["user"])
            self._reload_pw(force=True)
            if not u or u[0] != info["role"] or info.get("pwv") != self.pw_version(info["user"]):
                raise HTTPException(401, "계정 정보(역할·비밀번호)가 바뀌어 다시 로그인해야 합니다.")
        access = self.issue(ident, auth_time=int(info["auth_time"]), sid=info["sid"], idp=info.get("idp"))
        new_rt = self.new_refresh(ident, info["sid"], int(info["auth_time"]), info.get("idp"))
        return access, new_rt or "", ident, int(self.claims(access)["exp"]) - int(now)

    def revoke_sid(self, sid: str, until: float) -> None:
        """23차: 한 로그인(sid)의 모든 토큰을 끊는다(IdP 백채널 로그아웃)."""
        self._revoke_sid(sid, until)

    def _revoke_sid(self, sid: str, until: float) -> None:
        with self._lock:
            self._revoked_sid[sid] = until
        self.persist()

    # ---- v1.21: 비밀번호 변경 ----
    def change_password(self, uid: str, current: str, new: str, ip: str = "-") -> int:
        from .sso import password_problems
        uid = norm_user(uid)
        if uid not in self.users:
            raise HTTPException(400, "사내 SSO 계정의 비밀번호는 사내 계정 시스템에서 바꿉니다.")
        if self.locked(uid, ip):
            raise HTTPException(429, "로그인 시도가 너무 많습니다. 1분 뒤 다시 시도하세요.")
        self._reload_pw(force=True)
        if not self._check(uid, current):
            self.login(uid, current, ip)       # 실패 횟수에 넣고 같은 401을 낸다(잠금 우회 방지)
        bad = password_problems(uid, new, current)
        if bad:
            raise HTTPException(422, "새 비밀번호: " + ", ".join(bad) + ".")
        if not self._pw_update:
            raise HTTPException(503, "비밀번호를 저장할 저장소가 연결되어 있지 않습니다.")
        box = {}

        def put(doc):
            users = doc.get("users") or {}
            ver = int((users.get(uid) or {}).get("ver", 0)) + 1
            users[uid] = {"hash": make_hash(new), "ver": ver, "changed_at": int(time.time())}
            doc["users"] = users
            box["ver"] = ver
        self._pw_update(put)
        self._reload_pw(force=True)
        return box["ver"]

    def revoke(self, token: str) -> None:
        try:
            claims = json.loads(_unb64(token.split(".")[1]))
        except Exception:  # noqa: BLE001
            return
        now = time.time()
        with self._lock:
            self._revoked = {j: e for j, e in self._revoked.items() if e > now}   # 만료된 기록 정리
            self._revoked_sid = {s: e for s, e in self._revoked_sid.items() if e > now}
            self._revoked[claims.get("jti", "")] = float(claims.get("exp", now))
            if claims.get("sid"):   # R-01: 이 로그인에서 연장으로 받은 모든 토큰
                self._revoked_sid[claims["sid"]] = float(claims.get("auth_time", now)) + self.max_s
        self.persist()

    # ---- 로그인(무차별 대입 잠금) ----
    @staticmethod
    def _trim(q: deque, now: float) -> deque:
        while q and now - q[0] > LOCK_WINDOW_S:
            q.popleft()
        return q

    def locked(self, uid: str, ip: str) -> bool:
        uid = norm_user(uid)
        shared = self._shared_counts(uid, ip)
        if shared is not None:
            return len(shared[0]) >= LOCK_AFTER or len(shared[1]) >= LOCK_ACCOUNT_MAX
        now = time.time()
        with self._lock:
            return len(self._trim(self._fails[(uid, ip)], now)) >= LOCK_AFTER or len(self._trim(self._acct[uid], now)) >= LOCK_ACCOUNT_MAX

    def _check(self, uid: str, pw: str) -> str:
        u = self.users.get(uid)
        if u is None:
            _hash(pw, self._dummy[0])          # 없는 계정도 같은 시간만큼 계산(존재 여부를 드러내지 않음)
            return ""
        self._reload_pw()
        over = (self._pw.get(uid) or {}).get("hash")
        if over:                               # v1.21: 바꾼 비밀번호가 있으면 그것만(환경변수 비밀번호는 더 이상 통하지 않음)
            _, it, salt, digest = over.split("$")
            return u[0] if hmac.compare_digest(hashlib.pbkdf2_hmac("sha256", pw.encode(), _unb64(salt), int(it)), _unb64(digest)) else ""
        role, it, salt, digest, plain = u
        if digest is None:                     # 처음 로그인: 평문을 해시로 바꾸고 평문은 버린다
            with self._lock:
                if u[3] is None:
                    u[2] = secrets.token_bytes(16)
                    u[3] = hashlib.pbkdf2_hmac("sha256", (plain or "").encode(), u[2], it)
                    u[4] = None
            role, it, salt, digest, _ = u
        return role if hmac.compare_digest(hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, it), digest) else ""

    def login(self, uid: str, pw: str, ip: str = "-") -> Identity:
        uid = norm_user(uid)
        if self.locked(uid, ip):
            now = time.time()
            shared = self._shared_counts(uid, ip)
            if shared is not None:
                first = (shared[0] if len(shared[0]) >= LOCK_AFTER else shared[1] or [now])[0]
            else:
                with self._lock:
                    q = self._fails[(uid, ip)]
                    first = q[0] if len(q) >= LOCK_AFTER else self._acct[uid][0]
            wait = int(LOCK_WINDOW_S - (now - first)) + 1
            raise HTTPException(429, f"로그인 시도가 너무 많습니다. 약 {wait}초(1분 이내) 뒤 다시 시도하세요.")
        role = self._check(uid, pw)
        if not role:
            now = time.time()
            with self._lock:
                self._fails[(uid, ip)].append(now)
                self._acct[uid].append(now)
            if self._fail_update:
                def add(doc):
                    self._prune(doc, now)
                    doc.setdefault("pair", {}).setdefault(f"{uid}|{ip}", []).append(now)
                    doc.setdefault("acct", {}).setdefault(uid, []).append(now)
                try:
                    self._fail_update(add)
                except Exception:  # noqa: BLE001
                    pass
            raise HTTPException(401, "아이디 또는 비밀번호가 맞지 않습니다.")
        with self._lock:
            self._fails.pop((uid, ip), None)
        if self._fail_update and self._shared_counts(uid, ip) and self._shared_counts(uid, ip)[0]:
            try:
                self._fail_update(lambda doc: (doc.setdefault("pair", {}).pop(f"{uid}|{ip}", None), self._prune(doc, time.time())))
            except Exception:  # noqa: BLE001
                pass
        return Identity(uid, role)


_AUTH: Auth | None = None


def get_auth() -> Auth:
    global _AUTH
    if _AUTH is None:
        _AUTH = Auth()
    return _AUTH


async def require_identity(request: Request) -> Identity | None:
    """로그인 모드면 토큰을 확인해 Identity를 돌려주고, 감사 로그용 사용자 이름을 기록한다."""
    a = get_auth()
    if not a.enabled:
        return None
    h = request.headers.get("authorization", "")
    if not h.lower().startswith("bearer "):
        raise HTTPException(401, "로그인이 필요합니다.")
    ident = a.verify(h[7:].strip())
    CURRENT_USER.set(ident.user)
    return ident


def make_hash(password: str, iterations: int = _ITER) -> str:
    salt = secrets.token_bytes(16)
    return f"pbkdf2_sha256${iterations}${_b64(salt)}${_b64(hashlib.pbkdf2_hmac('sha256', password.encode(), salt, iterations))}"


if __name__ == "__main__":   # python -m app.api.auth hash → USERS에 넣을 해시 출력
    import getpass
    if sys.argv[1:2] == ["hash"]:
        print(make_hash(getpass.getpass("비밀번호: ")))
