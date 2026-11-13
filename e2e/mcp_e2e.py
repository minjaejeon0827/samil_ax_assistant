"""MCP 서버 E2E — 실제 MCP 클라이언트(stdio)로 서버 프로세스를 띄워 도구를 호출한다.
사용: python e2e/mcp_e2e.py http://localhost:8000 e2e-key   → 결과 JSON을 표준출력에 한 줄로.
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


async def main():
    params = StdioServerParameters(command=sys.executable, args=["-m", "app.mcp_server"], cwd=BACKEND,
                                   env={"DESK_API_URL": API, "DESK_API_KEY": KEY, "PATH": "/usr/bin:/bin:/usr/local/bin"})
    out = {}
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            out["tools"] = sorted(t.name for t in (await s.list_tools()).tools)
            out["inject"] = text(await s.call_tool("inject_event", {"kind": "CONTRACT_RENEWAL_NOTICE"}))
            await asyncio.sleep(1.0)
            out["pending"] = text(await s.call_tool("list_pending_approvals", {"role": "GROUP_CEO"}))
            cid = out["pending"].split(" | ")[0].strip()
            out["denied"] = text(await s.call_tool("submit_decision", {"case_id": cid, "role": "MARKETING_TEAM", "action": "approve"}))
            out["approved"] = text(await s.call_tool("submit_decision", {"case_id": cid, "role": "GROUP_CEO", "action": "approve", "comment": "MCP 승인"}))
            out["case"] = text(await s.call_tool("get_case", {"case_id": cid}))
            out["reply_without_wait"] = text(await s.call_tool("receive_mock_reply", {"reply_key": "agency_payment_schedule"}))
            out["outbox"] = text(await s.call_tool("list_outbox", {}))
    print(json.dumps(out, ensure_ascii=False))


asyncio.run(main())
