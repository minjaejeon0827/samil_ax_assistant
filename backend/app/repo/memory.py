"""메모리 저장소(+선택적 JSON 파일 영속화). 시연·테스트 기본값."""
from __future__ import annotations

import copy
import json
import threading
from contextlib import contextmanager
from pathlib import Path

from .base import COLLECTIONS, ConcurrencyError, Repository


class MemoryRepository(Repository):
    def __init__(self, path: str | None = None):
        self._lock = threading.RLock()
        self._path = Path(path) if path else None
        self._data: dict[str, dict[str, dict]] = {c: {} for c in COLLECTIONS}
        self._depth = 0          # P-02: batch 중첩 깊이 — 0이 될 때 한 번만 파일에 기록
        self._dirty = False
        if self._path and self._path.exists():
            self._data.update(json.loads(self._path.read_text(encoding="utf-8")))

    def _flush(self):
        if not self._path:
            return
        if self._depth:
            self._dirty = True
            return
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self._path)   # 원자적 교체(쓰다 죽어도 파일이 깨지지 않음)
        self._dirty = False

    @contextmanager
    def batch(self):
        # 잠금은 깊이 계산에만 쓴다 — 명령이 도는 동안 다른 사용자의 조회(get/list)를 막지 않기 위함
        with self._lock:
            self._depth += 1
        try:
            yield
        finally:
            with self._lock:
                self._depth -= 1
                if self._depth == 0 and self._dirty:
                    self._flush()

    def get(self, col, id_):
        with self._lock:
            d = self._data[col].get(id_)
            return copy.deepcopy(d) if d else None

    def list(self, col):
        with self._lock:
            return [copy.deepcopy(v) for v in self._data[col].values()]

    def tail(self, col, n):
        with self._lock:
            vals = list(self._data[col].values())   # dict는 삽입 순서를 지킨다(덮어쓰기는 자리 유지)
            return [copy.deepcopy(v) for v in vals[-n:]] if n > 0 else []

    def count(self, col):
        with self._lock:
            return len(self._data[col])

    def search(self, col, needle, text, offset, limit):
        n = needle.lower()
        with self._lock:   # 복사는 돌려줄 페이지만(기존: 5만 건 전부 깊은 복사 후 검색)
            hits = [v for v in self._data[col].values() if not n or n in text(v)]
            return len(hits), [copy.deepcopy(v) for v in hits[offset:offset + limit]]

    def put(self, col, doc, expected_version=None):
        with self._lock:
            cur = self._data[col].get(doc["id"])
            if expected_version is not None and cur and cur.get("version", 0) != expected_version:
                raise ConcurrencyError(f"{col}/{doc['id']} 이(가) 다른 사용자에 의해 먼저 변경되었습니다.")
            doc = copy.deepcopy(doc)
            doc["version"] = (cur.get("version", 0) if cur else 0) + 1
            self._data[col][doc["id"]] = doc
            self._flush()
            return copy.deepcopy(doc)

    def scan(self, col, size=2000):
        with self._lock:
            vals = list(self._data[col].values())
        for v in vals:
            yield copy.deepcopy(v)

    def find(self, col, field, value):
        with self._lock:
            return [copy.deepcopy(v) for v in self._data[col].values() if v.get(field) == value]

    def delete(self, col, id_):
        with self._lock:
            if self._data[col].pop(id_, None) is not None:
                self._flush()

    def reset(self):
        with self._lock:
            self._data = {c: {} for c in COLLECTIONS}
            self._flush()
