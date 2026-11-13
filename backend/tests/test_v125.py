"""v1.25(25차 E2E) — 운영 DB 회귀 테스트: 정규화(계약 기록 = 행 하나씩)·커넥션 풀·일관 스냅샷·감사 기록 보호·DDL 한 곳.
실제 MariaDB로 하는 시험(연결 수·트리거·보기·격리·백업 복구)은 e2e/round25."""
import re
from pathlib import Path

import pymysql
import pytest

ROOT = Path(__file__).resolve().parents[2]
VAR = ROOT / "data" / "samples" / "contracts" / "variants"


def _upload(desk, name):
    from app.contracts.extract import extract, read_text
    p = VAR / name
    r = extract(read_text(name, p.read_bytes()), name, "2026-07-01")
    desk.intake("CONTRACT_UPLOAD", "CONTRACT_OWNER", None, {"record": {k: r[k] for k in ("terms", "checks", "citations")}})
    return next(c for c in desk.repo.list("cases") if c["type"] == "RENEWAL" and c["target_id"] == r["terms"]["contract_id"])


# ---- AL03: 계약 기록은 renewals 모음의 행 하나씩, 명령은 필요한 행만 읽는다 ----
def test_AL03_renewal_is_one_row_not_one_kv_blob(desk):
    c = _upload(desk, "freight_en_usd.md")
    assert desk.repo.get("kv", "renewals") is None
    row = desk.repo.get("renewals", c["target_id"])
    assert row and row["status"] == "UNDER_REVIEW" and row["terms"]["contract_id"] == c["target_id"]


def test_AL03_engine_ctx_reads_only_needed_rows(desk, monkeypatch):
    c = _upload(desk, "freight_en_usd.md")
    calls = []
    orig_get, orig_list = desk.repo.get, desk.repo.list
    monkeypatch.setattr(desk.repo, "get", lambda col, i: (calls.append(("get", col, i)), orig_get(col, i))[1])
    monkeypatch.setattr(desk.repo, "list", lambda col: (calls.append(("list", col)), orig_list(col))[1])
    assert desk._engine_ctx()["renewals"] == {}                         # 기안·전속계약 판단은 계약 기록을 읽지 않음
    assert list(desk._engine_ctx([c])["renewals"]) == [c["target_id"]]
    assert not any(x[0] == "list" and x[1] == "renewals" for x in calls)  # 전체를 읽지 않음


def test_AL03_migrates_v124_kv_blob(desk):
    rec = {"terms": {"contract_id": "RC-OLD1", "counterparty": "옛 거래처"}, "checks": [], "citations": {}, "status": "UNDER_REVIEW"}
    desk.repo.put("kv", {"id": "renewals", "items": {"RC-OLD1": rec}})
    assert desk.migrate() == 1
    assert desk.repo.get("kv", "renewals") is None and desk._renewal("RC-OLD1")["terms"]["counterparty"] == "옛 거래처"
    assert desk.migrate() == 0                                           # 두 번 해도 같음


# ---- AL04: '처음부터'로 감사 기록을 지운 사실이 새 감사 기록으로 남음 ----
def test_AL04_reset_leaves_audit_trace(desk):
    desk.intake("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER")
    desk.reset()
    a = desk.repo.list("audit")
    assert len(a) == 1 and a[0]["topic"] == "desk.reset" and "처음부터" in a[0]["detail"] and "감사 기록" in a[0]["detail"]


# ---- DDL은 코드와 schema.sql이 같다(새 DB·기존 DB 모두 같은 트리거·보기) ----
def test_AL05_schema_sql_has_same_ddl_as_code():
    from app.repo.mysql import RENEWALS_DDL, TRIGGERS, VIEWS
    sql = (ROOT / "backend" / "app" / "repo" / "schema.sql").read_text(encoding="utf-8")
    assert RENEWALS_DDL in sql and all(t in sql for t in TRIGGERS.values()) and all(v + ";" in sql for v in VIEWS.values())
    assert re.search(r"DELIMITER //.*audit_no_delete.*DELIMITER ;", sql, re.S)


# ---- AL02·AL06: 커넥션 풀과 읽기 시점(가짜 연결로 동작 확인) ----
class _Cur:
    def __init__(self, log): self.log = log
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def execute(self, q, a=None): self.log.append(q); return 1
    def fetchone(self): return {"n": 0, "doc": "{}", "version": 1}
    def fetchall(self): return []


class _Conn:
    n = 0

    def __init__(self):
        _Conn.n += 1
        self.log, self.closed, self.dead = [], False, False
    def cursor(self): return _Cur(self.log)
    def commit(self): self.log.append("COMMIT")
    def rollback(self): self.log.append("ROLLBACK")
    def close(self): self.closed = True
    def ping(self, reconnect=False):
        if self.dead:
            raise pymysql.err.OperationalError(2006, "gone")


@pytest.fixture()
def fake_repo(monkeypatch):
    from app.repo import mysql
    r = mysql.MySQLRepository({"host": "x"})
    monkeypatch.setattr(r, "_connect", lambda: (setattr(r, "opened", r.opened + 1), _Conn())[1])
    return r


def test_AL02_pool_reuses_connection(fake_repo):
    for _ in range(20):
        fake_repo.count("cases")
    assert fake_repo.opened == 1


def test_AL02_broken_connection_is_not_returned(fake_repo):
    with pytest.raises(Exception):
        with fake_repo._conn():
            raise pymysql.err.OperationalError(2013, "lost")
    assert fake_repo._pool.qsize() == 0
    fake_repo.count("cases")
    assert fake_repo.opened == 2


def test_AL02_stale_idle_connection_is_pinged(fake_repo, monkeypatch):
    from app.repo import mysql
    fake_repo.count("cases")
    conn, _ = fake_repo._pool.get_nowait()
    conn.dead = True
    fake_repo._pool.put((conn, 0.0))                     # 아주 오래 쉰 연결
    monkeypatch.setattr(mysql, "POOL_PING_S", 1)
    fake_repo.count("cases")
    assert conn.closed and fake_repo.opened == 2


def test_AL06_read_view_uses_one_consistent_transaction(fake_repo):
    with fake_repo.read_view():
        fake_repo.get("kv", "ctx")
        fake_repo.list("cases")
        fake_repo.count("audit")
    assert fake_repo.opened == 1
    log = fake_repo._pool.get_nowait()[0].log
    assert log[0].startswith("START TRANSACTION WITH CONSISTENT SNAPSHOT") and log.count("COMMIT") == 1


def test_AL04_reset_clears_session_flag(fake_repo):
    fake_repo.reset()
    log = fake_repo._pool.get_nowait()[0].log
    assert log[0] == "SET @aurora_reset = 1" and log[-2] == "SET @aurora_reset = NULL"
