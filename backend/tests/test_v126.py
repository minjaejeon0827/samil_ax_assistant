"""v1.26(26차 E2E) — 운영 DB 기능 × 기존 보장, §15 ⑧ 남은 일 회귀 테스트: 해시 체인·요약 평가 행·늦은 이전·연결 상한.
실제 MariaDB로 하는 시험(DB 재시작·무중단 배포·연결 한도·검색 정렬 규칙·위변조)은 e2e/round26."""
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
VAR = ROOT / "data" / "samples" / "contracts" / "variants"


def _upload(desk, name, folder=VAR, summary=False):
    from app.contracts.extract import extract, read_text
    p = folder / name
    r = extract(read_text(name, p.read_bytes()), name, "2026-07-01")
    rec = {k: r[k] for k in ("terms", "checks", "citations")}
    if summary:   # 서버는 업로드 때 요약을 만든다(main.py) — 여기서는 대신 넣음
        rec["summary"] = {"text": "■ 요약: 테스트", "llm": "offline", "judge": None}
    desk.intake("CONTRACT_UPLOAD", "CONTRACT_OWNER", None, {"record": rec})
    return next(c for c in desk.repo.list("cases") if c["type"] == "RENEWAL" and c["target_id"] == r["terms"]["contract_id"])


# ---- AM04: 감사 기록 해시 체인 ----
def _journey(desk):
    desk.intake("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER")
    desk.intake("BUDGET_PLAN_BATCH", "MARKETING_TEAM")
    return [a["id"] for a in desk.repo.list("audit")]


def test_AM04_chain_ok_then_detects_edit_delete_truncate(desk):
    ids = _journey(desk)
    v = desk.verify_audit()
    assert v["ok"] and v["checked"] == len(ids) and v["legacy"] == 0 and v["head"]
    data = desk.repo._data["audit"]
    data[ids[2]]["detail"] = "조작"                       # 고침
    del data[ids[5]]                                      # 중간을 지움
    v = desk.verify_audit()
    hit = {b["id"] for b in v["broken"]}
    assert not v["ok"] and ids[2] in hit and ids[6] in hit
    last = ids[-1]
    del data[last]                                        # 끝을 잘라 냄
    assert "(끝)" in {b["id"] for b in desk.verify_audit()["broken"]}


def test_AM04_rehashed_edit_breaks_next_link(desk):
    from app.workflow.service import audit_hash
    ids = _journey(desk)
    a = desk.repo._data["audit"][ids[3]]
    a["detail"] = "조작"
    a["hash"] = audit_hash(a)                             # 해시까지 다시 계산해도
    assert ids[4] in {b["id"] for b in desk.verify_audit()["broken"]}   # 다음 기록의 prev가 짚음


def test_AM04_legacy_records_are_counted_not_failed(desk):
    desk.repo.put("audit", {"id": "AU-OLD1", "topic": "x", "detail": "v1.25 기록", "sim_date": "2026-07-01"})
    desk.intake("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER")
    v = desk.verify_audit()
    assert v["ok"] and v["legacy"] == 1


def test_AM04_reset_starts_new_chain(desk):
    _journey(desk)
    desk.reset()
    v = desk.verify_audit()
    assert v["ok"] and v["checked"] == 1


# ---- AM05: 요약 평가 = 행 하나씩 ----
def test_AM05_feedback_is_rows_and_migrates(desk):
    from app.workflow.service import SummaryFeedbackCommand
    c = _upload(desk, "agency_media_renewal.md", ROOT / "data" / "samples" / "contracts", summary=True)
    desk.run(SummaryFeedbackCommand("GROUP_CEO", case_id=c["id"], rating="up"))
    desk.run(SummaryFeedbackCommand("FINANCE", case_id=c["id"], rating="down", note="금액 표기"))
    assert desk.repo.get("kv", "summary_feedback") is None
    assert {r["key"] for r in desk.repo.find("feedback", "case_id", c["id"])} == {"GROUP_CEO", "FINANCE"}
    desk.repo.put("kv", {"id": "summary_feedback", "items": {"CS-OLD": {"u1": {"rating": "up", "note": "", "role": "GROUP_CEO", "llm": "offline"}}}})
    s = desk.summary_feedback()                           # 구 서버가 쓴 옛 문서도 옮겨서 셈
    assert s["total"] == 3 and desk.repo.get("kv", "summary_feedback") is None


# ---- AM03: 무중단 배포 — 구 서버가 kv에 쓴 계약도 처리 ----
def test_AM03_late_kv_renewal_is_migrated_on_demand(desk):
    from app.workflow.service import ContractFactsCommand
    c = _upload(desk, "freight_en_usd.md")
    rec = desk.repo.get("renewals", c["target_id"])
    desk.repo.delete("renewals", c["target_id"])
    desk.repo.put("kv", {"id": "renewals", "items": {c["target_id"]: {k: v for k, v in rec.items() if k not in ("id", "version")}}})
    r = desk.run(ContractFactsCommand("FINANCE", case_id=c["id"], annual_fee_krw=1324800000, note="구 서버 계약"))
    assert r["ok"] and desk.repo.get("kv", "renewals") is None and desk.repo.get("renewals", c["target_id"])


# ---- AM02·AM06: 연결 상한·쉬던 연결 확인(가짜 연결) ----
class _Conn:
    def __init__(self):
        self.closed, self.dead = False, False
    def cursor(self):
        log = []
        class C:
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def execute(s, q, a=None): log.append(q); return 1
            def fetchone(s): return {"n": 0}
            def fetchall(s): return []
        return C()
    def commit(self): pass
    def rollback(self): pass
    def close(self): self.closed = True
    def ping(self, reconnect=False):
        if self.dead:
            import pymysql
            raise pymysql.err.OperationalError(2006, "gone")


@pytest.fixture()
def fake_repo(monkeypatch):
    from app.repo import mysql
    r = mysql.MySQLRepository({"host": "x"})
    monkeypatch.setattr(r, "_connect", lambda: (setattr(r, "opened", r.opened + 1), _Conn())[1])
    return r


def test_AM06_pool_max_waits_for_a_free_connection(fake_repo, monkeypatch):
    from app.repo import mysql
    monkeypatch.setattr(mysql, "POOL_MAX", 2)
    held = [fake_repo._acquire(), fake_repo._acquire()]
    got = []
    t = threading.Thread(target=lambda: got.append(fake_repo._acquire()))
    t.start()
    time.sleep(0.15)
    assert not got and fake_repo.waited == 1               # 상한에서 기다림(새로 열지 않음)
    fake_repo._release(held[0], True)
    t.join(2)
    assert got and fake_repo.opened == 2 and fake_repo.open_now == 2


def test_AM06_pool_max_times_out_with_503(fake_repo, monkeypatch):
    from app.repo import mysql
    from app.repo.base import StorageUnavailable
    monkeypatch.setattr(mysql, "POOL_MAX", 1)
    monkeypatch.setattr(mysql, "POOL_WAIT_S", 0.1)
    fake_repo._acquire()
    with pytest.raises(StorageUnavailable):
        fake_repo._acquire()


def test_AM02_idle_connection_checked_on_every_borrow(fake_repo):
    from app.repo import mysql
    assert mysql.POOL_PING_S == 0
    fake_repo.count("cases")
    conn, _ = fake_repo._pool.get_nowait()
    conn.dead = True                                      # DB 재시작으로 죽음
    fake_repo._pool.put((conn, time.monotonic()))   # 방금 쉰 연결이어도 확인
    fake_repo.count("cases")
    assert conn.closed and fake_repo.opened == 2 and fake_repo.open_now == 1


def test_AM05_schema_sql_has_feedback_and_bin_search():
    from app.repo.mysql import FEEDBACK_DDL, SEARCH_COLLATE
    sql = (ROOT / "backend" / "app" / "repo" / "schema.sql").read_text(encoding="utf-8")
    assert FEEDBACK_DDL in sql and f"search_text TEXT COLLATE {SEARCH_COLLATE}" in sql and SEARCH_COLLATE == "utf8mb4_bin"
