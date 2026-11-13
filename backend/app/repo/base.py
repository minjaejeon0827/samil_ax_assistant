"""저장소 인터페이스 — 어댑터(Adapter) 패턴.

서비스는 이 인터페이스만 안다. 실제 저장은 MemoryRepository(시연·테스트) 또는
MySQLRepository(pymysql, 운영)로 바꿔 끼운다. 모든 엔티티는 id + JSON 문서로 저장한다.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from contextlib import contextmanager

COLLECTIONS = ("cases", "tasks", "audit", "outbox", "kv", "renewals", "feedback")   # v1.25: 계약 기록, v1.26: 요약 평가도 행 하나씩


class ConcurrencyError(Exception):
    """다른 사용자가 먼저 같은 건을 바꿨다(낙관적 잠금 충돌)."""


class StorageUnavailable(Exception):
    """저장소(DB)에 연결할 수 없음 → API는 503 + 한국어 안내(G-01: 기존에는 500 내부 오류).
    locked=True: DB가 잠겨 기다리다 시간이 지남(백업·점검 잠금 등, V-04)."""

    def __init__(self, msg: str = "", locked: bool = False):
        super().__init__(msg)
        self.locked = locked


class Repository(ABC):
    @abstractmethod
    def get(self, col: str, id_: str) -> dict | None: ...

    @abstractmethod
    def list(self, col: str) -> list[dict]: ...

    @abstractmethod
    def put(self, col: str, doc: dict, expected_version: int | None = None) -> dict: ...

    @abstractmethod
    def reset(self) -> None: ...

    @contextmanager
    def batch(self):
        """한 명령 안의 여러 쓰기를 묶는다. 메모리 저장소는 파일 기록을 한 번으로, MySQL은 트랜잭션 하나로."""
        yield

    @contextmanager
    def read_view(self):
        """v1.25(AL06): 여러 조회를 한 시점의 모습으로 읽는다(MySQL: 읽기 전용 일관 스냅샷 트랜잭션). 메모리 저장소는 할 일 없음."""
        yield

    def delete(self, col: str, id_: str) -> None:
        """문서 하나를 지운다(v1.25: kv 'renewals' → renewals 표 이전 뒤 옛 문서 정리용)."""
        raise NotImplementedError

    def scan(self, col: str, size: int = 2000):
        """v1.26: 기록 순서대로 하나씩(전부를 한 번에 올리지 않음 — 감사 기록 체인 검증용). 기본은 list()."""
        yield from self.list(col)

    def find(self, col: str, field: str, value) -> list[dict]:
        """v1.26: 한 칸의 값으로 찾기(요약 평가의 case_id 등). MySQL은 색인된 생성 열로."""
        return [d for d in self.list(col) if d.get(field) == value]

    def ping(self) -> bool:
        """저장소 상태 확인(/api/health). 메모리 저장소는 항상 정상."""
        return True

    # ---- v1.9(9차 E2E Q-02): 감사 로그처럼 계속 늘어나는 모음을 '전부 읽지 않고' 다루는 조회 ----
    # 기본 구현은 list()를 쓰므로 어떤 저장소든 동작한다. 메모리·MySQL 저장소는 빠른 구현으로 바꿔 끼운다.
    def prepare(self) -> None:
        """서버 기동 때 한 번(스키마 보강 등). 기본은 할 일 없음."""

    def tail(self, col: str, n: int) -> list[dict]:
        """기록된 순서(삽입 순)의 마지막 n건."""
        return self.list(col)[-n:] if n > 0 else []

    def count(self, col: str) -> int:
        return len(self.list(col))

    def search(self, col: str, needle: str, text, offset: int, limit: int) -> tuple[int, list[dict]]:
        """text(doc)(소문자 검색 문자열)에 needle(대소문자 무시)이 들어간 문서를 기록 순으로. (일치 건수, 해당 페이지)."""
        n = needle.lower()
        hits = [d for d in self.list(col) if not n or n in text(d)]
        return len(hits), hits[offset:offset + limit]
