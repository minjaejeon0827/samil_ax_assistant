"""7차 MCP E2E — 로그인 모드에서 MCP 계정(DESK_USER)의 권한.
사용: python e2e/mcp_e2e7.py http://localhost:8000 e2e-key <user> <password> → 결과 JSON 한 줄.
"""
import asyncio
import json
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

API, KEY, USER, PW = sys.argv[1:5]
BACKEND = str(Path(__file__).resolve().parents[1] / "backend")


def text(r) -> str:
    return "".join(getattr(c, "text", "") for c in r.content)


async def main():
    params = StdioServerParameters(command=sys.executable, args=["-m", "app.mcp_server"], cwd=BACKEND,
                                   env={"DESK_API_URL": API, "DESK_API_KEY": KEY, "DESK_USER": USER, "DESK_PASSWORD": PW,
                                        "PATH": "/usr/bin:/bin:/usr/local/bin"})
    out = {}
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            try:
                out["pending"] = text(await s.call_tool("list_pending_approvals", {"role": "GROUP_CEO"}))
                cid = (out["pending"].split(" | ")[0] or "CS-0001").strip()
                if not cid.startswith("CS-"):
                    cid = "CS-0001"
                out["decide"] = text(await s.call_tool("submit_decision", {"case_id": cid, "role": "GROUP_CEO", "action": "approve"}))
            except Exception as e:
                out["error"] = f"{type(e).__name__}: {e}"
    print(json.dumps(out, ensure_ascii=False))


asyncio.run(main())
