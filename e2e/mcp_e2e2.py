"""MCP 2차 E2E — 오류 경로(없는 건, 중복 접수, 서버 중단)를 실제 MCP 클라이언트(stdio)로 호출한다.
사용: python e2e/mcp_e2e2.py http://localhost:8000 e2e-key → 결과 JSON 한 줄.
"""
import asyncio
import json
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

API, KEY = sys.argv[1], sys.argv[2]
BACKEND = str(Path(__file__).resolve().parents[1] / "backend")


def text(r) -> str:
    return "".join(getattr(c, "text", "") for c in r.content)


async def session(api_url: str, fn):
    params = StdioServerParameters(command=sys.executable, args=["-m", "app.mcp_server"], cwd=BACKEND,
                                   env={"DESK_API_URL": api_url, "DESK_API_KEY": KEY, "PATH": "/usr/bin:/bin:/usr/local/bin"})
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            return await fn(s)


async def main():
    out = {}

    async def live(s):
        out["missing"] = text(await s.call_tool("get_case", {"case_id": "CS-9999"}))
        out["first"] = text(await s.call_tool("inject_event", {"kind": "CONTRACT_RENEWAL_NOTICE"}))
        out["dup"] = text(await s.call_tool("inject_event", {"kind": "CONTRACT_RENEWAL_NOTICE"}))

    async def down(s):
        out["down"] = text(await s.call_tool("list_pending_approvals", {"role": "GROUP_CEO"}))

    await session(API, live)
    await session("http://localhost:8999", down)   # 아무 서버도 없는 주소
    print(json.dumps(out, ensure_ascii=False))


asyncio.run(main())
