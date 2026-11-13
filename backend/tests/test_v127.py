"""v1.27(27차 E2E) — v1.26 기능 × 기존 보장, §15 ⑧ 남은 일(머리값을 밖에 기록) 회귀 테스트.
실제 MariaDB로 하는 시험(서버 2대 체인·5만 건 검증·스키마 이전 × 무중단 배포·백업 복구·화면·정기 기록 × 서버 2대)은 e2e/round27."""
import json


def _journey(desk):
    desk.intake("CONTRACT_RENEWAL_NOTICE", "CONTRACT_OWNER")
    desk.intake("BUDGET_PLAN_BATCH", "MARKETING_TEAM")


# ---- AN07: 머리값을 밖(메신저)에 기록 ----
def test_AN07_anchor_sends_full_hash_and_needs_group_ceo(desk):
    from app.workflow.service import AnchorAuditCommand
    _journey(desk)
    deny = desk.run(AnchorAuditCommand("MARKETING_TEAM"))
    assert not deny["ok"] and deny["forbidden"]
    r = desk.run(AnchorAuditCommand("GROUP_CEO"))
    a = r["anchor"]
    assert r["ok"] and a["hash"] in r["message"]["body"] and r["message"]["channel"] == "messenger"
    assert any(x["topic"] == "audit.anchor" and a["hash"] in x["detail"] for x in desk.repo.list("audit"))


def test_AN07_recomputed_chain_caught_only_with_anchor(desk):
    from app.workflow.service import AnchorAuditCommand, audit_hash
    _journey(desk)
    a = desk.run(AnchorAuditCommand("GROUP_CEO"))["anchor"]
    data = desk.repo._data["audit"]
    head = ""
    for i, (k, d) in enumerate(data.items()):    # 기록 하나를 고치고 체인 전체를 다시 계산(머리값까지)
        if i == 1:
            d["detail"] = "조작"
        d["prev"] = head
        d["hash"] = head = audit_hash(d)
    s = desk.repo._data["kv"]["seq"]
    s["audit_head"] = head
    assert desk.verify_audit()["ok"] is True                       # 머리값 없이는 못 찾음(한계 확인)
    v = desk.verify_audit([f"{a['id']}:{a['hash']}"])
    assert not v["ok"] and v["broken"][0]["id"] == a["id"]


def test_AN08_auto_anchor_skips_when_nothing_new_or_too_soon(desk):
    from app.workflow.service import AnchorAuditCommand
    _journey(desk)
    first = desk.run(AnchorAuditCommand("SYSTEM", auto=True, every_s=0))
    assert first["anchor"]
    assert desk.run(AnchorAuditCommand("SYSTEM", auto=True, every_s=0))["anchor"] is None      # 그사이 새 기록 없음
    desk.intake("FREE_TEXT", "MARKETING_TEAM", "새 메모")
    assert desk.run(AnchorAuditCommand("SYSTEM", auto=True, every_s=3600))["anchor"] is None   # 주기 전
    assert desk.run(AnchorAuditCommand("SYSTEM", auto=True, every_s=0))["anchor"]             # 새 기록 + 주기 지남


def test_AN07_missing_anchor_record_is_reported(desk):
    _journey(desk)
    v = desk.verify_audit(["AU-9999:abc"])
    assert not v["ok"] and "기록이 없음" in v["broken"][0]["reason"]


# ---- AN04: 정렬 규칙만 다른 검색 열은 고치지 않고 검색 때 COLLATE ----
class _Cur:
    def __init__(self, log, row): self.log, self.row = log, row
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def execute(self, q, a=None): self.log.append(q); return 1
    def fetchone(self): return self.row
    def fetchall(self): return []


class _Conn:
    def __init__(self, log, row): self.log, self.row = log, row
    def cursor(self): return _Cur(self.log, self.row)
    def commit(self): pass
    def rollback(self): pass
    def close(self): pass
    def ping(self, reconnect=False): pass


def test_AN04_old_collation_column_not_rebuilt_and_search_uses_bin(monkeypatch):
    from app.repo import mysql
    r = mysql.MySQLRepository({"host": "x"})
    log = []
    old = {"g": "lower(concat_ws(' ', ... '$.user' ...))", "c": "utf8mb4_unicode_ci", "n": 0}
    monkeypatch.setattr(r, "_connect", lambda: _Conn(log, old))
    assert r._ensure_search_text() is True
    assert not any(q.startswith("ALTER TABLE audit") for q in log)            # 표를 복사하지 않음
    r.search("audit", "café", lambda d: "", 0, 10)
    assert any("LIKE %s COLLATE utf8mb4_bin" in q for q in log)


# ---- AN03: 검증이 다른 요청에 차례를 넘김 ----
def test_AN03_verify_yields_between_pages(desk, monkeypatch):
    import app.workflow.service as svc
    _journey(desk)
    for i in range(1200):
        desk.intake("FREE_TEXT", "MARKETING_TEAM", f"m{i}") if i < 3 else None
    seq = desk.repo.get("kv", "seq")
    head = seq.get("audit_head", "")
    for i in range(1200):                       # 체인을 이어 1,200건 덧붙임
        d = {"id": f"AU-X{i:05d}", "sim_date": "2026-07-01", "at": "", "topic": "seed", "actor": "SYSTEM", "case_id": None, "detail": str(i), "user": None, "prev": head}
        d["hash"] = head = svc.audit_hash(d)
        desk.repo.put("audit", d)
    seq["audit_head"] = head
    desk.repo.put("kv", seq)
    slept = []
    monkeypatch.setattr(svc.time, "sleep", lambda s: slept.append(s))
    v = desk.verify_audit()
    assert v["ok"] and len(slept) >= 2
    json.dumps(v)
