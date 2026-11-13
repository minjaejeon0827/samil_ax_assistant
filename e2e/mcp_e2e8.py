"""8차 MCP E2E — 로그인 토큰이 만료돼도 MCP가 다시 로그인해 이어서 동작하는지.
사용: python e2e/mcp_e2e8.py http://localhost:8002 e2e-key <user> <password> → 결과 JSON 한 줄.
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
            out["first"] = text(await s.call_tool("list_pending_approvals", {"role": "GROUP_CEO"}))
            await asyncio.sleep(3.2)   # 토큰 수명 2초 → 만료
            out["second"] = text(await s.call_tool("list_pending_approvals", {"role": "GROUP_CEO"}))
    print(json.dumps(out, ensure_ascii=False))


asyncio.run(main())
