"""모의 LLM 서버(OpenAI 호환 /v1/chat/completions + Anthropic 호환 /v1/messages) — 외부 LLM의 정상·환각·장애·지연을 재현한다.
사용: python e2e/mock_llm.py 8900   → 모드는 POST /__mode {"mode": "...", "latency": 초} 로 바꾼다.
  ok           : 숫자 없이 근거를 인용하는 설명문 + 판사 JSON(충실도 1.0)
  hallucinate  : 사실 목록에 없는 금액(37.5억원·99.9%)을 섞은 설명문 + '관대한' 판사 JSON(충실도 1.0)
  contradict   : 숫자는 하나도 틀리지 않았지만 결론이 규칙 판단과 반대('승인을 권고합니다')인 설명문 + 관대한 판사(12차)
  long         : 숫자 없이 2만 자 넘게 늘어놓은 설명문(14차)
  english      : 한국어가 아닌 영어 설명문(14차)
  html         : 태그·스크립트·마크다운 링크가 섞인 설명문(14차)
  error        : HTTP 500
  hang         : 응답하지 않고 오래 대기(타임아웃 시험)
  echo         : ok 설명문 끝에 프롬프트의 '승인자'를 그대로 옮겨 씀 → 설명이 어느 판단으로 쓰였는지 확인(17차)
  "limit": n   : (모드와 함께) 동시에 n건을 넘는 요청은 HTTP 429 + Retry-After: 1 — 실제 제공자의 사용량 한도(17차)
  "tpm": n, "window": s : 분당(시험에서는 s초당) 토큰 한도 — 메시지 글자 수 ÷ 2를 토큰으로 셈, 넘으면 429 + Retry-After(22차)
  "headers": true : (tpm과 함께) 응답마다 x-ratelimit-limit-tokens·remaining-tokens·reset-tokens 헤더(OpenAI 방식, 24차)
호출 수는 GET /__stats 로 본다(r429: 429 응답 수, max_inflight: 최대 동시 요청).
"""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {"mode": "ok", "latency": 0.0, "calls": 0, "explain": 0, "judge": 0, "limit": 0, "inflight": 0, "max_inflight": 0, "r429": 0,
         "tpm": 0, "window": 60.0, "tokens": [], "tok_total": 0}
LOCK = threading.Lock()


def _reply(text: str) -> dict:
    return {"id": "mock", "object": "chat.completion", "created": int(time.time()), "model": "mock",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}


EXPLAIN_OK = "■ 결론: 사실 목록과 정책 발췌에 따른 권고\n■ 근거: 사실 목록의 근거를 그대로 인용 [approval_authority_policy]\n■ 정책 근거: 승인 권한표"
EXPLAIN_BAD = "■ 결론: 승인 권고\n■ 근거: 예상 순이익 37.5억원, 성공 확률 99.9%로 매우 유리함\n■ 승인자: 그룹 CEO"
EXPLAIN_CONTRADICT = "■ 결론: 원안대로 승인을 권고합니다 — 지금 그대로 진행하는 것이 유리합니다\n■ 근거: 사실 목록의 근거를 그대로 인용 [approval_authority_policy]\n■ 정책 근거: 승인 권한표"
EXPLAIN_LONG = "■ 결론: 사실 목록과 정책 발췌에 따른 권고\n■ 근거: [approval_authority_policy] " + "검토 의견을 덧붙입니다. " * 2000
EXPLAIN_EN = "Conclusion: follow the policy excerpt.\nEvidence: cited facts [approval_authority_policy]\nApprover: see authority table."
EXPLAIN_HTML = "■ 결론: 사실 목록과 정책 발췌에 따른 권고 <script>alert(1)</script>\n■ 근거: <img src=x onerror=alert(1)> [자세히](http://evil.example/phish) [approval_authority_policy]"
JUDGE_OK = '{"faithfulness": 1.0, "policy_grounded": 1.0, "issues": []}'


def _anthropic(text: str) -> dict:
    return {"id": "msg_mock", "type": "message", "role": "assistant", "model": "mock",
            "content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 1}}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # 조용히
        pass

    def _json(self, code: int, body: dict):
        b = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        if code == 200 and STATE["tpm"] and STATE.get("headers") and self.command == "POST":   # 24차: OpenAI식 남은 토큰 헤더
            with LOCK:
                now = time.time()
                toks = [(t, n) for t, n in STATE["tokens"] if now - t < STATE["window"]]
                rem = max(0, STATE["tpm"] - sum(n for _, n in toks))
                reset = (toks[0][0] + STATE["window"] - now) if toks else 0.0
            self.send_header("x-ratelimit-limit-tokens", str(STATE["tpm"]))
            self.send_header("x-ratelimit-remaining-tokens", str(rem))
            self.send_header("x-ratelimit-reset-tokens", f"{max(reset, 0.0):.3f}s")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/__stats":
            return self._json(200, {k: v for k, v in STATE.items() if k != "tokens"})
        self._json(404, {})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/__mode":
            with LOCK:
                STATE.update(mode=body.get("mode", "ok"), latency=float(body.get("latency", 0)), calls=0, explain=0, judge=0,
                             limit=int(body.get("limit", 0)), max_inflight=0, r429=0,
                             tpm=int(body.get("tpm", 0)), window=float(body.get("window", 60)), tokens=[], tok_total=0, headers=bool(body.get("headers", False)))
            return self._json(200, STATE)
        anthropic = self.path.endswith("/messages")
        msgs = body.get("messages", [])
        if anthropic:   # Anthropic: system은 최상위 필드(문자열 또는 블록 목록)
            sysv = body.get("system", "")
            system = sysv if isinstance(sysv, str) else " ".join(b.get("text", "") for b in sysv)
        else:
            system = " ".join(m.get("content", "") for m in msgs if m.get("role") == "system")
        is_judge = "감사인" in system
        est = sum(len(m.get("content") if isinstance(m.get("content"), str) else json.dumps(m.get("content"), ensure_ascii=False)) for m in msgs) // 2
        if anthropic:
            est += len(system) // 2
        retry_after = "1"
        with LOCK:
            mode, lat, limit = STATE["mode"], STATE["latency"], STATE["limit"]
            now = time.time()
            STATE["tokens"] = [(t, n) for t, n in STATE["tokens"] if now - t < STATE["window"]]
            used = sum(n for _, n in STATE["tokens"])
            if STATE["tpm"] and used + est > STATE["tpm"] and STATE["tokens"]:
                STATE["r429"] += 1
                retry_after = str(max(1, int(STATE["tokens"][0][0] + STATE["window"] - now + 0.999)))
                over = True
            elif limit and STATE["inflight"] >= limit:
                STATE["r429"] += 1
                over = True
            else:
                over = False
                STATE["calls"] += 1
                STATE["judge" if is_judge else "explain"] += 1
                STATE["inflight"] += 1
                STATE["max_inflight"] = max(STATE["max_inflight"], STATE["inflight"])
                if STATE["tpm"]:
                    STATE["tokens"].append((now, est))
                STATE["tok_total"] += est
        if over:
            b = json.dumps({"error": {"message": "Rate limit reached (mock)", "type": "rate_limit_error" if anthropic else "requests", "code": "rate_limit_exceeded"}}).encode()
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", retry_after)
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        try:
            return self._answer(mode, lat, is_judge, anthropic, msgs, body)
        finally:
            with LOCK:
                STATE["inflight"] -= 1

    def _answer(self, mode, lat, is_judge, anthropic, msgs, body):
        if mode == "hang":
            time.sleep(120)
        if lat:
            time.sleep(lat)
        if mode == "error":
            if anthropic:
                return self._json(500, {"type": "error", "error": {"type": "api_error", "message": "mock upstream failure"}})
            return self._json(500, {"error": {"message": "mock upstream failure", "type": "server_error"}})
        if mode == "echo" and not is_judge:
            human = " ".join(m.get("content", "") if isinstance(m.get("content"), str) else "" for m in msgs if m.get("role") in ("user", "human"))
            ap = next((ln.split(":", 1)[1].strip() for ln in human.split("\n") if ln.startswith("승인자:")), "?")
            text = EXPLAIN_OK + f"\n■ 승인자: {ap}"
            return self._json(200, _anthropic(text) if anthropic else _reply(text))
        text = JUDGE_OK if is_judge else {"hallucinate": EXPLAIN_BAD, "contradict": EXPLAIN_CONTRADICT, "long": EXPLAIN_LONG, "english": EXPLAIN_EN, "html": EXPLAIN_HTML}.get(mode, EXPLAIN_OK)
        return self._json(200, _anthropic(text) if anthropic else _reply(text))


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1] if len(sys.argv) > 1 else 8900)), H).serve_forever()
