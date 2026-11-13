"""MySQL 저장소(pymysql). 스키마: backend/app/repo/schema.sql

- 문서형(JSON 컬럼) 저장 + version 컬럼 낙관적 잠금 → 멀티유저 동시 승인 시 덮어쓰기 방지.
- 연결은 스레드마다 하나씩 빌려 쓰고 돌려준다(v1.25 커넥션 풀, DB_POOL_SIZE). 한 연결을 두 스레드가 동시에 쓰지 않는다.
  기존에는 요청마다 연결을 새로 맺고 끊어 화면 갱신 100번에 연결 701개(스냅샷 한 번에 7개)였다.
- v1.25(AL06): 화면(스냅샷)은 read_view() 안에서 한 시점의 모습으로 읽는다(다른 서버의 커밋이 반쯤 섞이지 않게).
- v1.25(AL04·AL05): 감사 기록 append only를 DB 트리거가 지키고, 사람이 SQL로 볼 수 있는 보기(v_*)를 둔다(DDL은 아래 상수와 schema.sql이 같다).
- v1.4(G-03): 한 명령 안의 쓰기는 batch()로 묶어 연결 1개·트랜잭션 1개로 처리 → 기안 25건 일괄 2.1s → 수백 ms,
  중간에 실패하면 전부 되돌림(부분 반영 없음). 다른 사용자의 조회는 커밋된 내용만 본다.
- v1.4(G-01): DB에 연결할 수 없으면 StorageUnavailable로 바꿔 API가 503과 한국어 안내를 돌려준다.
"""
from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
from contextlib import contextmanager

import pymysql

from .base import COLLECTIONS, ConcurrencyError, Repository, StorageUnavailable


def search_expr() -> str:
    """audit.search_text 생성식 — workflow.service.audit_text와 같은 규칙(빈 칸은 건너뜀).
    내용 · 역할 코드 · 역할 한국어명 · 로그인 사용자 · 건 ID · 주제 · 날짜(2026-07-02) · 날짜(7월 2일)."""
    from ..workflow.service import ROLE_KO
    j = lambda f: f"NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '$.{f}')), 'null'), '')"   # noqa: E731
    roles = " ".join(f"WHEN '{k}' THEN '{v}'" for k, v in ROLE_KO.items())
    d = "JSON_UNQUOTE(JSON_EXTRACT(doc, '$.sim_date'))"
    return (f"LOWER(CONCAT_WS(' ', {j('detail')}, {j('actor')}, CASE JSON_UNQUOTE(JSON_EXTRACT(doc, '$.actor')) {roles} ELSE NULL END, "
            f"{j('user')}, {j('case_id')}, {j('topic')}, {j('sim_date')}, "
            f"CONCAT(CAST(SUBSTRING({d}, 6, 2) AS UNSIGNED), '월 ', CAST(SUBSTRING({d}, 9, 2) AS UNSIGNED), '일')))")


# v1.26(AM08): 검색 열은 글자 그대로 비교(utf8mb4_bin). 소문자 변환은 생성식의 LOWER가 한다. 기존 표 기본값(utf8mb4_unicode_ci)은
# 'cafe'로 'Café'를, 'abc'로 전각 'ＡＢＣ'를 찾아 메모리 저장소·브라우저와 결과가 달랐다(검색 규칙은 한 가지 — 10차).
SEARCH_COLLATE = "utf8mb4_bin"
LOCK_WAIT_S = int(os.getenv("DB_LOCK_WAIT_S", "4"))      # V-04(11차): 백업 잠금(메타데이터 잠금)을 기다리는 최대 시간
CMD_WAIT_S = int(os.getenv("DB_CMD_WAIT_S", "20"))       # AB-04(15차): 다른 서버의 명령이 끝나기를 기다리는 최대 시간(행 잠금)
DB_TIMEOUT_S = int(os.getenv("DB_TIMEOUT_S", "15"))      # 응답 없는 DB를 기다리는 최대 시간(읽기·쓰기)
LOCKED = {1205, 1213, 3572}                               # 잠금 대기 초과 · 교착 · NOWAIT
POOL_SIZE = int(os.getenv("DB_POOL_SIZE", "8"))           # v1.25(AL02): 쉬는 연결을 최대 몇 개까지 남겨 둘지(0이면 풀 없음)
# v1.26(AM02): 30초 → 0(빌려줄 때마다 확인, HikariCP 등 일반 풀의 기본과 같음 — 같은 기계 DB면 0.1ms 안팎). 기존에는 30초 안쪽으로 쉰 연결은
# 확인 없이 빌려줘, DB를 다시 켜면 쉬던 연결 수(8)만큼 요청이 503이었다(1초로 줄여도 DB가 1초 안에 다시 뜨면 같은 일 — 26차 시험 중 확인).
POOL_PING_S = float(os.getenv("DB_POOL_PING_S", "0"))     # 이만큼 쉰 연결은 빌려주기 전에 살아 있는지 확인(DB 재시작·wait_timeout)
# v1.26(AM06): 한 서버가 동시에 여는 연결의 상한. 기존에는 상한이 없어 요청이 몰리면 스레드 수(40)만큼 연결을 열어
# 서버 2대가 DB max_connections(30)를 넘겼다('Too many connections' → 503 23/160). 상한에 닿으면 연결이 돌아올 때까지 기다린다.
POOL_MAX = int(os.getenv("DB_POOL_MAX", "10"))            # 0이면 상한 없음. 서버 수 × DB_POOL_MAX < DB max_connections
POOL_WAIT_S = float(os.getenv("DB_POOL_WAIT_S", "5"))     # 상한에 닿았을 때 연결을 기다리는 최대 시간(넘으면 503 '잠시 뒤 다시')
log = logging.getLogger("aurora.repo")

# ---- v1.25 DDL(schema.sql과 같은 문장 — pytest가 확인). 이미 만든 DB는 서버 기동 때 prepare()가 없으면 만든다. ----
RENEWALS_DDL = ("CREATE TABLE IF NOT EXISTS renewals (\n"
                "  id VARCHAR(40) PRIMARY KEY, seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE, doc JSON NOT NULL, version INT NOT NULL DEFAULT 1,\n"
                "  status VARCHAR(30) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc, '$.status'))) STORED,\n"
                "  created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), INDEX idx_status (status)\n)")
FEEDBACK_DDL = ("CREATE TABLE IF NOT EXISTS feedback (\n"
                "  id VARCHAR(200) PRIMARY KEY, seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE, doc JSON NOT NULL, version INT NOT NULL DEFAULT 1,\n"
                "  case_id VARCHAR(40) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(doc, '$.case_id'))) STORED,\n"
                "  created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), INDEX idx_case (case_id)\n)")
FIND_COLUMNS = {("feedback", "case_id"), ("renewals", "status")}   # find()가 색인된 생성 열로 찾는 (표, 칸)
AUDIT_GUARD = "audit is append-only: 감사 기록은 추가만 할 수 있습니다(고치기·지우기 불가)"
TRIGGERS = {
    "audit_no_update": f"CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit FOR EACH ROW\n"
                       f"  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '{AUDIT_GUARD}'",
    # '처음부터'(그룹 CEO, OpsDesk.reset)만 지울 수 있다 — reset()이 같은 연결에서 @aurora_reset=1을 켰다 끈다
    "audit_no_delete": f"CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit FOR EACH ROW\n"
                       f"BEGIN\n  IF COALESCE(@aurora_reset, 0) <> 1 THEN\n    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '{AUDIT_GUARD}';\n  END IF;\nEND",
}
# 보기는 SQL SECURITY INVOKER — 조회하는 사람의 권한으로 돈다. 기존(DEFINER)에는 서버 기동 때 앱 계정이 보기를 다시 만들어
# 보기가 앱 계정 권한에 묶였고, 다른 DB로 복구하면 관리자(root)도 조회하지 못했다(25차 시연 녹화 중 발견, AL08에 고정).
_u = lambda path: f"NULLIF(JSON_UNQUOTE(JSON_EXTRACT(doc, '{path}')), 'null')"   # noqa: E731 — JSON null → SQL NULL
VIEWS = {
    "v_cases": (f"CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_cases AS SELECT id, seq, version, state, {_u('$.type')} AS type, {_u('$.kind')} AS kind, "
                f"{_u('$.title')} AS title, {_u('$.target_id')} AS target_id, {_u('$.approval.approver')} AS approver, "
                f"{_u('$.approval.decision')} AS decision, {_u('$.approval.decided_by')} AS decided_by, {_u('$.received_on')} AS received_on, "
                f"created_at FROM cases"),
    "v_tasks": (f"CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_tasks AS SELECT id, seq, version, {_u('$.case_id')} AS case_id, dept, {_u('$.kind')} AS kind, "
                f"{_u('$.status')} AS status, {_u('$.title')} AS title, {_u('$.due')} AS due, {_u('$.created_on')} AS created_on, created_at FROM tasks"),
    "v_audit": (f"CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_audit AS SELECT id, seq, {_u('$.sim_date')} AS sim_date, {_u('$.at')} AS at_time, {_u('$.topic')} AS topic, "
                f"{_u('$.actor')} AS actor, {_u('$.user')} AS user_name, {_u('$.case_id')} AS case_id, {_u('$.detail')} AS detail FROM audit"),
    "v_renewals": (f"CREATE OR REPLACE SQL SECURITY INVOKER VIEW v_renewals AS SELECT id, seq, version, status, {_u('$.terms.counterparty')} AS counterparty, "
                   f"{_u('$.terms.expiry')} AS expiry, {_u('$.terms.auto_renew')} AS auto_renew, "
                   f"CAST({_u('$.terms.annual_fee_krw')} AS DECIMAL(20,0)) AS annual_fee_krw, {_u('$.terms.currency')} AS currency, "
                   f"{_u('$.terms.notice_deadline')} AS notice_deadline, {_u('$.uploaded_on')} AS uploaded_on FROM renewals"),
}


def _unavailable(e: Exception) -> StorageUnavailable:
    code = e.args[0] if e.args and isinstance(e.args[0], int) else None
    if code in LOCKED:
        return StorageUnavailable(f"DB 잠금 대기 시간 초과({code})", locked=True)
    return StorageUnavailable(f"저장소(데이터베이스) 연결 오류: {e.args[0] if e.args else e}")


class MySQLRepository(Repository):
    def __init__(self, dsn: dict | None = None):
        self.dsn = dsn or {
            "host": os.getenv("MYSQL_HOST", "localhost"),
            "port": int(os.getenv("MYSQL_PORT", "3306")),
            "user": os.getenv("MYSQL_USER", "aurora"),
            "password": os.getenv("MYSQL_PASSWORD", ""),
            "database": os.getenv("MYSQL_DB", "aurora_desk"),
            "charset": "utf8mb4",
        }
        self._tl = threading.local()   # 스레드마다 batch·read_view 연결을 따로 둔다
        self._pool: queue.LifoQueue = queue.LifoQueue()   # 쉬는 연결(가장 최근에 쓴 것부터 다시 빌려준다)
        self.opened = 0                                     # 지금까지 새로 맺은 연결 수(/api/health·시험용)
        self.open_now = 0                                   # 지금 열려 있는 연결 수(빌려준 것 + 쉬는 것) ≤ DB_POOL_MAX
        self.waited = 0                                     # 상한 때문에 연결을 기다린 횟수(/api/health)
        self._cv = threading.Condition()
        self.db_guards: dict = {}                           # prepare() 결과: 트리거·보기를 만들었는지(권한 없으면 False)

    def _connect(self):
        self.opened += 1
        try:
            # V-04: 기존에는 백업 잠금(FLUSH TABLES WITH READ LOCK) 중 쓰기가 끝없이 기다려 화면이 멈추고, 서버의 다른
            # 쓰기도 줄줄이 대기했다 → 잠금은 LOCK_WAIT_S초, 응답 없는 DB는 DB_TIMEOUT_S초까지만 기다린다
            return pymysql.connect(**self.dsn, cursorclass=pymysql.cursors.DictCursor, autocommit=False, connect_timeout=3,
                                   read_timeout=DB_TIMEOUT_S, write_timeout=DB_TIMEOUT_S,
                                   init_command=f"SET SESSION lock_wait_timeout={LOCK_WAIT_S}, innodb_lock_wait_timeout={CMD_WAIT_S}")
        except (pymysql.err.OperationalError, pymysql.err.InterfaceError) as e:
            raise StorageUnavailable(f"저장소(데이터베이스)에 연결할 수 없습니다: {e.args[0] if e.args else e}") from e

    # ---- v1.25(AL02) 커넥션 풀 ----
    def _acquire(self):
        deadline, waited = time.monotonic() + POOL_WAIT_S, False
        while True:
            try:
                conn, idle_since = self._pool.get_nowait()
            except queue.Empty:
                conn = None
            if conn is not None:
                if time.monotonic() - idle_since >= POOL_PING_S:
                    try:
                        conn.ping(reconnect=False)      # 쉰 연결은 살아 있는지 확인(죽었으면 버리고 다음 것)
                    except Exception:  # noqa: BLE001
                        self._discard(conn)
                        continue
                return conn
            with self._cv:
                if POOL_MAX <= 0 or self.open_now < POOL_MAX:
                    self.open_now += 1
                    break
                left = deadline - time.monotonic()
                if left <= 0:
                    raise StorageUnavailable(f"DB 연결이 모두 사용 중입니다(DB_POOL_MAX={POOL_MAX}, {POOL_WAIT_S:g}초 대기). 잠시 뒤 다시 시도하세요.", locked=True)
                if not waited:
                    waited, self.waited = True, self.waited + 1
                self._cv.wait(min(left, 0.05))
        try:
            return self._connect()
        except Exception:
            with self._cv:
                self.open_now -= 1
                self._cv.notify()
            raise

    def _release(self, conn, healthy: bool) -> None:
        """다 쓴 연결을 돌려준다. 오류가 난 연결·풀이 찬 경우는 닫는다(트랜잭션은 항상 끝난 상태로만 돌아온다)."""
        if healthy and POOL_SIZE > 0 and self._pool.qsize() < POOL_SIZE:
            self._pool.put((conn, time.monotonic()))
            with self._cv:
                self._cv.notify()
        else:
            self._discard(conn)

    def _discard(self, conn) -> None:
        self._close(conn)
        with self._cv:
            self.open_now = max(0, self.open_now - 1)
            self._cv.notify()

    @staticmethod
    def _close(conn) -> None:
        try:
            conn.close()
        except Exception:  # noqa: BLE001 — 이미 끊긴 연결
            pass

    def close_pool(self) -> None:
        while True:
            try:
                self._discard(self._pool.get_nowait()[0])
            except queue.Empty:
                return

    @contextmanager
    def _conn(self):
        shared = getattr(self._tl, "conn", None)
        if shared is not None:          # batch·read_view 안: 같은 연결·트랜잭션을 그대로 사용(커밋은 바깥이)
            yield shared
            return
        conn, healthy = self._acquire(), False
        try:
            yield conn
            conn.commit()                # 읽기만 했어도 커밋 → 다음에 빌려 갈 때 옛 읽기 시점이 남지 않음
            healthy = True
        except (pymysql.err.OperationalError, pymysql.err.InterfaceError) as e:
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001
                pass
            raise _unavailable(e) from e
        except Exception:
            try:
                conn.rollback()
                healthy = True           # 앱 오류(낙관적 잠금 충돌 등) — 연결 자체는 멀쩡
            except Exception:  # noqa: BLE001
                pass
            raise
        finally:
            self._release(conn, healthy)

    @contextmanager
    def read_view(self):
        """v1.25(AL06): 스냅샷의 여러 조회(ctx·처리 건·작업·감사·발송함)를 한 시점의 모습으로 — 읽기 전용 일관 스냅샷 트랜잭션.
        기존에는 조회마다 연결·트랜잭션이 달라, 다른 서버가 '처리 건 + 작업'을 한 번에 커밋하는 순간 둘 중 하나만 바뀐 화면이 나왔다."""
        if getattr(self._tl, "conn", None) is not None:
            yield
            return
        conn, healthy = self._acquire(), False
        self._tl.conn = conn
        try:
            with conn.cursor() as cur:
                cur.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
            yield
            conn.commit()
            healthy = True
        except (pymysql.err.OperationalError, pymysql.err.InterfaceError) as e:
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001
                pass
            raise _unavailable(e) from e
        except Exception:
            try:
                conn.rollback()
                healthy = True
            except Exception:  # noqa: BLE001
                pass
            raise
        finally:
            self._tl.conn = None
            self._release(conn, healthy)

    @contextmanager
    def batch(self):
        if getattr(self._tl, "conn", None) is not None:   # 중첩 batch → 바깥 트랜잭션에 합류
            yield
            return
        conn, healthy = self._acquire(), False
        self._tl.conn = conn
        try:
            # AB-04(15차): 서버가 여러 대여도 명령은 한 번에 하나씩 — 모든 명령 트랜잭션이 kv 'ctx' 행을 먼저 잠근다.
            # 기존에는 프로세스 안의 잠금(RLock)뿐이라, 두 서버가 같은 건을 동시에 승인·거절하면 둘 다 성공했고
            # 번호(seq)도 같은 값을 받아 서로 덮어쓸 수 있었다. 잠금 뒤의 읽기는 다른 서버가 커밋한 최신 값을 본다.
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM kv WHERE id='ctx' FOR UPDATE")
            yield
            conn.commit()
            healthy = True
        except Exception as e:
            try:
                conn.rollback()
                healthy = not isinstance(e, (pymysql.err.OperationalError, pymysql.err.InterfaceError))
            except Exception:  # noqa: BLE001 — 연결이 이미 끊긴 경우
                pass
            if isinstance(e, (pymysql.err.OperationalError, pymysql.err.InterfaceError)):
                raise _unavailable(e) from e     # 기존: 한 명령 안(batch)의 DB 오류는 500 내부 오류로 나감
            raise
        finally:
            self._tl.conn = None
            self._release(conn, healthy)

    def ping(self) -> bool:
        with self._conn() as c, c.cursor() as cur:
            cur.execute("SELECT 1")
            return True

    @staticmethod
    def _check(col: str) -> str:
        if col not in COLLECTIONS:  # 테이블명은 화이트리스트로만(SQL 인젝션 방지)
            raise ValueError(col)
        return col

    def get(self, col, id_):
        with self._conn() as c, c.cursor() as cur:
            cur.execute(f"SELECT doc, version FROM {self._check(col)} WHERE id=%s", (id_,))
            r = cur.fetchone()
            return {**json.loads(r["doc"]), "version": r["version"]} if r else None

    def list(self, col):
        with self._conn() as c, c.cursor() as cur:
            cur.execute(f"SELECT doc, version FROM {self._check(col)} ORDER BY seq")
            return [{**json.loads(r["doc"]), "version": r["version"]} for r in cur.fetchall()]

    def tail(self, col, n):
        if n <= 0:
            return []
        with self._conn() as c, c.cursor() as cur:   # seq 내림차순 n건만 읽고 다시 오름차순으로(기존: 전 건 읽기)
            cur.execute(f"SELECT doc, version FROM {self._check(col)} ORDER BY seq DESC LIMIT %s", (int(n),))
            return [{**json.loads(r["doc"]), "version": r["version"]} for r in reversed(cur.fetchall())]

    def count(self, col):
        with self._conn() as c, c.cursor() as cur:
            cur.execute(f"SELECT COUNT(*) AS n FROM {self._check(col)}")
            return int(cur.fetchone()["n"])

    SEARCH_EXPR = search_expr()

    def prepare(self) -> None:
        try:
            self._ensure_search_text()
            self._ensure_v125()
        except StorageUnavailable:   # DB가 아직 안 떠 있으면 첫 검색 때 다시 시도
            self._has_search_text = None

    def _ensure_v125(self) -> dict:
        """v1.25: renewals 표·감사 기록 보호 트리거·보기를 없으면 만든다(이미 만든 DB를 위해). 권한이 없으면(MySQL 8에서 바이너리
        로그가 켜져 있고 SUPER가 없는 등) 서버는 그대로 뜨고 /api/health의 db_guards가 False — 운영자가 schema.sql을 root로 적용."""
        g = {}
        with self._conn() as c, c.cursor() as cur:
            cur.execute(RENEWALS_DDL)
            cur.execute(FEEDBACK_DDL)     # v1.26: 요약 평가 = 행 하나씩
            cur.execute("SELECT TRIGGER_NAME AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='audit'")
            have = {r["n"] for r in cur.fetchall()}
            for name, ddl in TRIGGERS.items():
                if name not in have:
                    try:
                        cur.execute(ddl)
                    except pymysql.err.MySQLError as e:
                        log.warning("감사 기록 보호 트리거 %s를 만들지 못함: %s", name, e)
                g[name] = name in have or self._has_trigger(cur, name)
            for name, ddl in VIEWS.items():
                try:
                    cur.execute(ddl)
                    g[name] = True
                except pymysql.err.MySQLError as e:
                    log.warning("보기 %s를 만들지 못함: %s", name, e)
                    g[name] = False
        self.db_guards = g
        return g

    @staticmethod
    def _has_trigger(cur, name: str) -> bool:
        cur.execute("SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=%s", (name,))
        return int(cur.fetchone()["n"]) > 0

    def _ensure_search_text(self) -> bool:
        """audit.search_text 열을 현재 규칙으로 맞춘다(서버 기동 때 한 번). 권한이 없으면 느린 검색으로.
        Q-02(9차): 열이 없으면 추가. R-02(10차): v1.9 규칙(역할 코드만·빈 값이 'null')의 열이면 새 규칙으로 다시 만든다."""
        if getattr(self, "_has_search_text", None) is not None:
            return self._has_search_text
        try:
            with self._conn() as c, c.cursor() as cur:
                cur.execute("SELECT GENERATION_EXPRESSION AS g, COLLATION_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='audit' AND COLUMN_NAME='search_text'")
                row = cur.fetchone()
                col = f"search_text TEXT COLLATE {SEARCH_COLLATE} GENERATED ALWAYS AS ({self.SEARCH_EXPR}) STORED"
                if not row:
                    cur.execute(f"ALTER TABLE audit ADD COLUMN {col}")
                elif "$.user" not in (row["g"] or ""):
                    cur.execute(f"ALTER TABLE audit DROP COLUMN search_text, ADD COLUMN {col}")
                # v1.27(AN04): 정렬 규칙만 다른 v1.9~v1.25 열(utf8mb4_unicode_ci)은 고치지 않는다 — 검색 때 COLLATE로 글자 그대로 비교.
                # v1.26은 서버가 뜰 때 이 열을 다시 만들어(표 복사) 감사 12만 건에서 다른 서버의 쓰기가 2.8초 멈췄다(무중단 배포 중).
            self._has_search_text = True
        except pymysql.err.MySQLError:
            self._has_search_text = False
        return self._has_search_text

    def search(self, col, needle, text, offset, limit):
        t = self._check(col)
        if needle and not (col == "audit" and self._ensure_search_text()):
            return super().search(col, needle, text, offset, limit)     # 검색 열이 없으면 문서를 읽어 같은 규칙으로
        where, args = "", []
        if needle:
            esc = needle.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")   # LIKE 특수문자는 글자 그대로
            where, args = f" WHERE search_text LIKE %s COLLATE {SEARCH_COLLATE}", [f"%{esc}%"]   # 열의 정렬 규칙과 무관하게 글자 그대로(AN04)
        with self._conn() as c, c.cursor() as cur:
            cur.execute(f"SELECT COUNT(*) AS n FROM {t}{where}", args)
            total = int(cur.fetchone()["n"])
            cur.execute(f"SELECT doc, version FROM {t}{where} ORDER BY seq LIMIT %s OFFSET %s", [*args, int(limit), int(offset)])
            return total, [{**json.loads(r["doc"]), "version": r["version"]} for r in cur.fetchall()]

    def put(self, col, doc, expected_version=None):
        t = self._check(col)
        body = json.dumps({k: v for k, v in doc.items() if k != "version"}, ensure_ascii=False)
        with self._conn() as c, c.cursor() as cur:
            if expected_version is None:
                cur.execute(f"INSERT INTO {t} (id, doc, version) VALUES (%s, %s, 1) "
                            f"ON DUPLICATE KEY UPDATE doc=VALUES(doc), version=version+1", (doc["id"], body))
            else:
                n = cur.execute(f"UPDATE {t} SET doc=%s, version=version+1 WHERE id=%s AND version=%s",
                                (body, doc["id"], expected_version))
                if n == 0:
                    raise ConcurrencyError(f"{col}/{doc['id']} 이(가) 다른 사용자에 의해 먼저 변경되었습니다.")
            cur.execute(f"SELECT version FROM {t} WHERE id=%s", (doc["id"],))
            return {**doc, "version": cur.fetchone()["version"]}

    def scan(self, col, size=2000):
        """seq 순서로 size건씩(키셋 페이지 — OFFSET 없이). read_view 안에서 부르면 한 시점의 모습."""
        t, last = self._check(col), 0
        while True:
            with self._conn() as c, c.cursor() as cur:
                cur.execute(f"SELECT seq, doc, version FROM {t} WHERE seq > %s ORDER BY seq LIMIT %s", (last, int(size)))
                rows = cur.fetchall()
            for r in rows:
                yield {**json.loads(r["doc"]), "version": r["version"]}
            if len(rows) < size:
                return
            last = rows[-1]["seq"]

    def find(self, col, field, value):
        if (col, field) not in FIND_COLUMNS:
            return super().find(col, field, value)
        with self._conn() as c, c.cursor() as cur:
            cur.execute(f"SELECT doc, version FROM {self._check(col)} WHERE {field}=%s ORDER BY seq", (value,))
            return [{**json.loads(r["doc"]), "version": r["version"]} for r in cur.fetchall()]

    def delete(self, col, id_):
        with self._conn() as c, c.cursor() as cur:
            cur.execute(f"DELETE FROM {self._check(col)} WHERE id=%s", (id_,))

    def reset(self):
        """'처음부터'(그룹 CEO) — 감사 기록 삭제는 이 연결에서만 트리거가 허용한다(@aurora_reset). 지운 사실은 서비스가 새 감사 기록으로 남긴다."""
        with self._conn() as c, c.cursor() as cur:
            cur.execute("SET @aurora_reset = 1")
            try:
                for t in COLLECTIONS:
                    cur.execute(f"DELETE FROM {t}")
            finally:
                cur.execute("SET @aurora_reset = NULL")   # 풀로 돌아간 연결에 허용이 남지 않게
