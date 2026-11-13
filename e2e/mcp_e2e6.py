"""6차 MCP E2E — 원격 전송 인증, 도구 입력 오류, 이상한 ID.
사용: python e2e/mcp_e2e6.py {remote|inputs|ids} http://localhost:8000 e2e-key → 결과 JSON 한 줄.
"""
import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import create_mcp_http_client, streamable_http_client

WHAT, API, KEY = sys.argv[1], sys.argv[2], sys.argv[3]
BACKEND = str(Path(__file__).resolve().parents[1] / "backend")
TOKEN, PORT = "e2e-mcp-token", "8767"


def text(r) -> str:
    return "".join(getattr(c, "text", "") for c in r.content)


async def stdio(calls):
    params = StdioServerParameters(command=sys.executable, args=["-m", "app.mcp_server"], cwd=BACKEND,
                                   env={"DESK_API_URL": API, "DESK_API_KEY": KEY, "PATH": "/usr/bin:/bin:/usr/local/bin"})
    out = {}
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            for key, tool, args in calls:
                try:
                    out[key] = text(await s.call_tool(tool, args))
                except Exception as e:  # 도구가 예외로 죽으면 그대로 기록
                    out[key] = f"예외: {type(e).__name__}: {e}"
    return out


async def remote():
    env = {**os.environ, "DESK_API_URL": API, "DESK_API_KEY": KEY, "MCP_TRANSPORT": "streamable-http",
           "MCP_HOST": "127.0.0.1", "MCP_PORT": PORT, "MCP_TOKEN": TOKEN}
    srv = subprocess.Popen([sys.executable, "-m", "app.mcp_server"], cwd=BACKEND, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out = {}
    try:
        url = f"http://127.0.0.1:{PORT}/mcp"
        for _ in range(60):
            if srv.poll() is not None:
                break
            try:
                urllib.request.urlopen(urllib.request.Request(url, method="POST", data=b"{}", headers={"Content-Type": "application/json"}), timeout=0.5)
                break
            except urllib.error.HTTPError as e:
                out["no_token_status"] = e.code
                break
            except Exception:
                time.sleep(0.25)
        if srv.poll() is not None:
            out["error"] = "MCP 서버가 시작되지 않음: " + (srv.stdout.read() or "")[-300:]
            return out
        out.setdefault("no_token_status", 200)
        async with create_mcp_http_client(headers={"Authorization": f"Bearer {TOKEN}"}) as http:
            async with streamable_http_client(url, http_client=http) as streams:
                async with ClientSession(streams[0], streams[1]) as s:
                    await s.initialize()
                    out["pending"] = text(await s.call_tool("list_pending_approvals", {"role": "GROUP_CEO"}))
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"[:300]
    finally:
        srv.terminate()
        try:
            srv.wait(5)
        except subprocess.TimeoutExpired:
            srv.kill()
    return out


def main():
    if WHAT == "remote":
        out = asyncio.run(remote())
    elif WHAT == "inputs":
        out = asyncio.run(stdio([
            ("bad_action", "submit_decision", {"case_id": "CS-0001", "role": "GROUP_CEO", "action": "approve!!"}),
            ("bad_role", "submit_decision", {"case_id": "CS-0001", "role": "CEO", "action": "approve"}),
            ("bad_kind", "inject_event", {"kind": "UNKNOWN_KIND"}),
            ("bad_reply", "receive_mock_reply", {"reply_key": "nope"}),
            ("bad_pending_role", "list_pending_approvals", {"role": "CEO"}),
        ]))
    else:
        out = asyncio.run(stdio([
            ("get_traversal", "get_case", {"case_id": "../snapshot"}),
            ("get_etc", "get_case", {"case_id": "../../etc"}),
            ("decide_traversal", "submit_decision", {"case_id": "../reset", "role": "GROUP_CEO", "action": "approve"}),
        ]))
    print(json.dumps(out, ensure_ascii=False))


main()
