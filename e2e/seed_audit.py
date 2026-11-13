"""9차 E2E 합성 데이터 — 오래 운영한 서버를 흉내 낸다(감사 기록 N건 누적).

사용: REPO=memory REPO_PATH=/tmp/x.json python e2e/seed_audit.py 50000
      REPO=mysql MYSQL_HOST=... python e2e/seed_audit.py 50000
- 계약 갱신 통보·기안 25건을 실제로 접수해 결재할 건을 만든 뒤, 과거 기록 N건을 덧붙인다.
- SEED_CHAIN=1이면 v1.26 해시 체인(prev·hash)까지 이어 붙인다(27차).
- 출력: {"audit": 총 건수, "pending": [{"id", "approver"}...]} 한 줄(JSON).
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
os.environ.setdefault("LLM_PROVIDER", "offline")

from app.config import get_settings  # noqa: E402
from app.repo.memory import MemoryRepository  # noqa: E402
from app.workflow.service import OpsDesk  # noqa: E402

N = int(sys.argv[1])
s = get_settings()
if s.repo == "mysql":
    from app.repo.mysql import MySQLRepository
    repo = MySQLRepository()
else:
    repo = MemoryRepository(s.repo_path)
desk = OpsDesk(repo)
desk.reset()
desk.intake_ex("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER", None)
desk.intake_ex("BUDGET_PLAN_BATCH", "MARKETING_TEAM", None)

seq = repo.get("kv", "seq")
start = seq["audit"]
docs = [{"id": f"AU-{start + i + 1:04d}", "sim_date": "2026-07-01", "at": "2026-07-01T09:00:00", "topic": "seed.history",
         "actor": "SYSTEM", "case_id": None, "detail": f"과거 운영 기록 #{i + 1} (합성 데이터)", "user": None} for i in range(N)]
if os.getenv("SEED_CHAIN") == "1":   # 27차: v1.26 이후 운영처럼 해시 체인까지 이어 붙인다(검증 속도 시험용)
    from app.workflow.service import audit_hash  # noqa: E402
    head = seq.get("audit_head", "")
    for d in docs:
        d["prev"] = head
        d["hash"] = head = audit_hash(d)
    seq["audit_head"] = head
if s.repo == "mysql":
    with repo._conn() as c, c.cursor() as cur:
        cur.executemany("INSERT INTO audit (id, doc, version) VALUES (%s, %s, 1)",
                        [(d["id"], json.dumps(d, ensure_ascii=False)) for d in docs])
else:
    with repo.batch():
        for d in docs:
            repo.put("audit", d)
seq["audit"] = start + N
repo.put("kv", seq)
pending = [{"id": c["id"], "approver": (c.get("approval") or {}).get("approver"), "version": c["version"]}
           for c in sorted(repo.list("cases"), key=lambda c: c["id"]) if c["state"] == "PENDING_APPROVAL"]
print(json.dumps({"audit": len(repo.list("audit")), "pending": pending}, ensure_ascii=False))
