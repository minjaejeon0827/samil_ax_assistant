"""모의 사내 SSO(OIDC IdP) — 21차 E2E(v1.21, PRD §15-1).
표준 엔드포인트: /.well-known/openid-configuration · /authorize · /token · /jwks (RS256, kid).
로그인 화면 대신 POST /__user 로 정한 사용자로 바로 동의한다(시험 자동화). PKCE(S256)·client_secret·redirect_uri를 확인하고
인가 코드는 한 번만 쓸 수 있다. POST /__mode {"mode": ...} 로 잘못된 신원 토큰을 재현한다:
  ok · bad_sig(다른 키로 서명) · wrong_aud · expired · wrong_nonce · no_role · wrong_iss
23차: id_token에 IdP 세션 sid를 넣고, POST /__backchannel {"to": RP 주소, "sub", "sid"?, "mode": ok|bad_sig|no_event|with_nonce|replay}
      로 OIDC Back-Channel Logout 1.0의 logout_token(RS256, events, jti)을 만들어 RP에 직접 보낸다(IdP가 먼저 끊는 로그아웃).
사용: python e2e/mock_oidc.py 8950 <client_id> <client_secret>
"""
import base64
import hashlib
import json
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

PORT = int(sys.argv[1] if len(sys.argv) > 1 else 8950)
CLIENT_ID = sys.argv[2] if len(sys.argv) > 2 else "aurora-desk"
CLIENT_SECRET = sys.argv[3] if len(sys.argv) > 3 else "oidc-secret"
ISS = f"http://127.0.0.1:{PORT}"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PEM = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
OTHER_PEM = OTHER.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
JWK = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key()))
JWK.update(kid="k1", use="sig", alg="RS256")
STATE = {"mode": "ok", "user": {"sub": "u-1001", "preferred_username": "kim.ceo@aurora.example", "aurora_role": "GROUP_CEO"},
         "codes": {}, "token_calls": 0, "logouts": [], "sessions": {}, "last_logout_token": None}
LOCK = threading.Lock()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, body, headers=None):
        b = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/.well-known/openid-configuration":
            return self._json(200, {"issuer": ISS, "authorization_endpoint": f"{ISS}/authorize", "token_endpoint": f"{ISS}/token",
                                    "jwks_uri": f"{ISS}/jwks", "response_types_supported": ["code"], "id_token_signing_alg_values_supported": ["RS256"],
                                    "code_challenge_methods_supported": ["S256"], "end_session_endpoint": f"{ISS}/logout"})
        if u.path == "/jwks":
            return self._json(200, {"keys": [JWK]})
        if u.path == "/__stats":
            return self._json(200, {"mode": STATE["mode"], "codes": len(STATE["codes"]), "token_calls": STATE["token_calls"], "logouts": STATE["logouts"]})
        if u.path == "/logout":   # 22차: RP-initiated logout — id_token_hint(이 IdP가 서명, aud=이 클라이언트)를 확인하고 돌려보냄
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                c = jwt.decode(q.get("id_token_hint", ""), KEY.public_key(), algorithms=["RS256"], audience=CLIENT_ID, options={"verify_exp": False})
                ok = True
            except Exception:  # noqa: BLE001
                c, ok = {}, False
            back = q.get("post_logout_redirect_uri", "")
            with LOCK:
                STATE["logouts"].append({"ok": ok, "sub": c.get("sub"), "redirect": back})
            if not ok or not back.startswith("http://localhost"):
                return self._json(400, {"error": "invalid_request"})
            sep = "&" if "?" in back else "?"
            self.send_response(302)
            self.send_header("Location", f"{back}{sep}{urlencode({'state': q.get('state', '')})}" if q.get("state") else back)
            self.end_headers()
            return
        if u.path == "/authorize":
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            if q.get("client_id") != CLIENT_ID or q.get("response_type") != "code" or q.get("code_challenge_method") != "S256":
                return self._json(400, {"error": "invalid_request"})
            code = secrets.token_urlsafe(16)
            with LOCK:
                sid = "idp-" + secrets.token_hex(6)                  # 23차: IdP 로그인 세션(백채널 로그아웃에서 씀)
                STATE["sessions"][sid] = STATE["user"].get("sub")
                STATE["codes"][code] = {"challenge": q["code_challenge"], "redirect": q["redirect_uri"], "nonce": q.get("nonce", ""), "user": dict(STATE["user"]), "idp_sid": sid}
            sep = "&" if "?" in q["redirect_uri"] else "?"
            self.send_response(302)
            self.send_header("Location", f"{q['redirect_uri']}{sep}{urlencode({'code': code, 'state': q.get('state', '')})}")
            self.end_headers()
            return
        self._json(404, {})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n) if n else b""
        if self.path == "/__mode":
            with LOCK:
                STATE["mode"] = json.loads(raw or b"{}").get("mode", "ok")
            return self._json(200, {"mode": STATE["mode"]})
        if self.path == "/__user":
            with LOCK:
                STATE["user"] = json.loads(raw or b"{}")
            return self._json(200, STATE["user"])
        if self.path == "/__backchannel":
            import httpx
            c = json.loads(raw or b"{}")
            mode = c.get("mode", "ok")
            if mode == "replay" and STATE["last_logout_token"]:
                tok = STATE["last_logout_token"]
            else:
                sid = c.get("sid") or next((k for k, v in reversed(list(STATE["sessions"].items())) if v == c.get("sub")), None)
                claims = {"iss": ISS, "aud": CLIENT_ID, "iat": int(time.time()), "jti": secrets.token_hex(8), "sub": c.get("sub"),
                          "events": {"http://schemas.openid.net/event/backchannel-logout": {}}}
                if sid and not c.get("no_sid"):
                    claims["sid"] = sid
                if mode == "no_event":
                    claims.pop("events")
                if mode == "with_nonce":
                    claims["nonce"] = "n"
                tok = jwt.encode(claims, OTHER_PEM if mode == "bad_sig" else PEM, algorithm="RS256", headers={"kid": "k1", "typ": "logout+jwt"})
                if mode == "ok":
                    STATE["last_logout_token"] = tok
            r = httpx.post(c["to"], data={"logout_token": tok}, timeout=10)
            return self._json(200, {"status": r.status_code, "body": r.text[:300]})
        if self.path == "/token":
            f = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
            with LOCK:
                STATE["token_calls"] += 1
                c = STATE["codes"].pop(f.get("code", ""), None)    # 한 번만
            if f.get("client_id") != CLIENT_ID or f.get("client_secret") != CLIENT_SECRET:
                return self._json(401, {"error": "invalid_client"})
            if not c or c["redirect"] != f.get("redirect_uri"):
                return self._json(400, {"error": "invalid_grant"})
            ch = base64.urlsafe_b64encode(hashlib.sha256(f.get("code_verifier", "").encode()).digest()).rstrip(b"=").decode()
            if ch != c["challenge"]:
                return self._json(400, {"error": "invalid_grant", "error_description": "PKCE"})
            now, mode = int(time.time()), STATE["mode"]
            claims = {"iss": ISS if mode != "wrong_iss" else "http://evil.example", "aud": CLIENT_ID if mode != "wrong_aud" else "other-app",
                      "iat": now - (7200 if mode == "expired" else 0), "exp": now + (300 if mode != "expired" else -3600),
                      "nonce": c["nonce"] if mode != "wrong_nonce" else "x", "sid": c["idp_sid"], **c["user"]}
            if mode == "no_role":
                claims.pop("aurora_role", None)
            tok = jwt.encode(claims, OTHER_PEM if mode == "bad_sig" else PEM, algorithm="RS256", headers={"kid": "k1"})
            return self._json(200, {"id_token": tok, "access_token": secrets.token_urlsafe(16), "token_type": "Bearer", "expires_in": 300})
        self._json(404, {})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
