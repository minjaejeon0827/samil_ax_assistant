"""MCP 원격 전송(streamable-http) E2E — MCP 서버를 원격 모드로 띄우고 HTTP MCP 클라이언트로 도구를 호출한다.
사용: python e2e/mcp_http_e2e.py http://localhost:8000 e2e-key → 결과 JSON 한 줄.
MCP 서버 주소는 리더 가이드 기준(MCP_HOST=127.0.0.1, MCP_PORT=8765, 경로 /mcp).
"""
import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

API, KEY = sys.argv[1], sys.argv[2]
BACKEND = str(Path(__file__).resolve().parents[1] / "backend")
PORT = "8765"
URL = f"http://127.0.0.1:{PORT}/mcp"


async def call():
    async with streamable_http_client(URL) as streams:
        r, w = streams[0], streams[1]
        async with ClientSession(r, w) as s:
            await s.initialize()
            res = await s.call_tool("list_pending_approvals", {"role": "GROUP_CEO"})
            return "".join(getattr(c, "text", "") for c in res.content)


def main():
    env = {**os.environ, "DESK_API_URL": API, "DESK_API_KEY": KEY, "MCP_TRANSPORT": "streamable-http", "MCP_HOST": "127.0.0.1", "MCP_PORT": PORT}
    srv = subprocess.Popen([sys.executable, "-m", "app.mcp_server"], cwd=BACKEND, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out = {}
    try:
        for _ in range(60):
            if srv.poll() is not None:
                break
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=0.5)
                break
            except urllib.error.HTTPError:
                break          # 서버는 떠 있음(경로만 다름)
            except Exception:
                time.sleep(0.25)
        if srv.poll() is not None:
            out["error"] = "MCP 서버가 시작되지 않음: " + (srv.stdout.read() or "")[-300:].replace("\n", " ")
        else:
            out["pending"] = asyncio.run(call())
    except Exception as e:  # 연결 실패 등
        out["error"] = f"{type(e).__name__}: {e}"[:300]
    finally:
        srv.terminate()
        try:
            srv.wait(5)
        except subprocess.TimeoutExpired:
            srv.kill()
    print(json.dumps(out, ensure_ascii=False))


main()
