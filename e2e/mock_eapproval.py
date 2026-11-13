"""모의 전자결재·메신저 — 21차 E2E(v1.21, PRD §15-2).
받기: POST /hooks/approval · /hooks/messenger — 서명(X-Aurora-Signature = sha256=HMAC(secret, ts.본문))을 확인하고 기록.
제어: POST /__mode {"fail": n, "delay": 초} → 처음 n건은 HTTP 500(재시도 시험), 응답 지연(느린 외부 시스템)
      GET /__received → 받은 것(서명 확인 결과 포함) · POST /__reset
보내기(결재 결과 콜백): POST /__callback {"target": "http://.../api/integrations/approval", "body": {...}, "secret": "...", "ts_offset": 0, "bad_sig": false}
사용: python e2e/mock_eapproval.py 8960 <secret>
"""
import hashlib
import hmac
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

PORT = int(sys.argv[1] if len(sys.argv) > 1 else 8960)
SECRET = sys.argv[2] if len(sys.argv) > 2 else "channel-secret"
STATE = {"fail": 0, "delay": 0.0, "received": [], "attempts": 0}
LOCK = threading.Lock()


def sign(secret, ts, body):
    return "sha256=" + hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, body):
        b = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/__received":
            return self._json(200, {"received": STATE["received"], "attempts": STATE["attempts"]})
        self._json(404, {})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n) if n else b""
        if self.path == "/__mode":
            with LOCK:
                STATE.update({k: v for k, v in json.loads(raw or b"{}").items() if k in ("fail", "delay")})
            return self._json(200, STATE | {"received": len(STATE["received"])})
        if self.path == "/__reset":
            with LOCK:
                STATE.update(fail=0, delay=0.0, received=[], attempts=0)
            return self._json(200, {})
        if self.path == "/__callback":
            c = json.loads(raw)
            body = json.dumps(c["body"], ensure_ascii=False).encode()
            ts = str(int(time.time()) + int(c.get("ts_offset", 0)))
            sig = sign(c.get("secret", SECRET) + ("x" if c.get("bad_sig") else ""), ts, body)
            r = httpx.post(c["target"], content=body, headers={"Content-Type": "application/json", "X-Aurora-Timestamp": ts, "X-Aurora-Signature": sig}, timeout=10)
            return self._json(200, {"status": r.status_code, "body": r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text})
        if self.path in ("/hooks/approval", "/hooks/messenger"):
            with LOCK:
                STATE["attempts"] += 1
                fail = STATE["fail"] > 0
                if fail:
                    STATE["fail"] -= 1
                delay = STATE["delay"]
            if delay:
                time.sleep(delay)
            if fail:
                return self._json(500, {"error": "mock outage"})
            ts = self.headers.get("X-Aurora-Timestamp", "")
            ok = hmac.compare_digest(self.headers.get("X-Aurora-Signature", ""), sign(SECRET, ts, raw))
            with LOCK:
                STATE["received"].append({"path": self.path, "sig_ok": ok, "idem": self.headers.get("Idempotency-Key"), "event": self.headers.get("X-Aurora-Event"),
                                          "body": json.loads(raw or b"{}"), "at": time.time()})
            return self._json(200 if ok else 401, {"ok": ok})
        self._json(404, {})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
