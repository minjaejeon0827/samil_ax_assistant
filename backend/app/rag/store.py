"""정책 문서 RAG — 하이브리드 검색(벡터 + 어휘).

- 인덱싱 대상: 원본 정책 문서 7종 + 법규 KB 조문 텍스트.
- 임베딩: 기본은 외부 호출이 없는 로컬 문자 n-gram 해싱 임베딩(재현 가능, 비용 0).
  OPENAI_API_KEY가 있으면 OpenAI 임베딩으로 바꿀 수 있다(EmbeddingStrategy).
- 벡터 저장소: FAISS(IndexFlatIP) 기본, chromadb가 설치돼 있으면 Chroma 선택 가능(VectorStore Strategy).
- 계약서 교훈: 검색을 좁혀 RAGAS를 올리면 판정 정확도가 떨어질 수 있다 → 벡터+어휘 하이브리드 유지.
"""
from __future__ import annotations

import hashlib
import math
import os
import re
import threading
from collections import Counter
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from ..domain.data import get_dataroom
from ..validation.text import normalize

DIM = 1024


@dataclass
class Chunk:
    chunk_id: str
    source: str
    text: str


def chunk_markdown(source: str, text: str, max_chars: int = 600) -> list[Chunk]:
    blocks = [b.strip() for b in re.split(r"\n(?=#+ )|\n\s*\n", text) if b.strip()]
    out, buf = [], ""
    for b in blocks:
        if len(buf) + len(b) > max_chars and buf:
            out.append(buf)
            buf = ""
        buf = (buf + "\n" + b).strip()
    if buf:
        out.append(buf)
    return [Chunk(f"{source}#{i}", source, t) for i, t in enumerate(out)]


def _tokens(text: str) -> list[str]:
    t = normalize(text)
    words = re.findall(r"[\w\-\.%]+", t)
    grams = []
    s = re.sub(r"\s+", "", t)
    for n in (2, 3):
        grams += [s[i:i + n] for i in range(max(0, len(s) - n + 1))]
    return words + grams


class EmbeddingStrategy(Protocol):
    def embed(self, texts: list[str]) -> np.ndarray: ...


class HashingEmbedding:
    """한국어에 강한 문자 2·3-gram + 단어 해싱 임베딩(TF 로그 가중, L2 정규화)."""

    def embed(self, texts: list[str]) -> np.ndarray:
        m = np.zeros((len(texts), DIM), dtype="float32")
        for r, t in enumerate(texts):
            for tok, c in Counter(_tokens(t)).items():
                h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
                m[r, h % DIM] += (1 if (h >> 64) & 1 else -1) * (1 + math.log(c))
        n = np.linalg.norm(m, axis=1, keepdims=True)
        n[n == 0] = 1
        return m / n


class VectorStore(Protocol):
    def add(self, vecs: np.ndarray) -> None: ...
    def search(self, q: np.ndarray, k: int) -> list[tuple[int, float]]: ...


class FaissStore:
    def __init__(self, dim: int = DIM):
        import faiss  # noqa: WPS433
        self.index = faiss.IndexFlatIP(dim)

    def add(self, vecs):
        self.index.add(vecs)

    def search(self, q, k):
        scores, ids = self.index.search(q.reshape(1, -1), k)
        return [(int(i), float(s)) for i, s in zip(ids[0], scores[0]) if i >= 0]


class NumpyStore:
    """faiss 미설치 환경(일부 배포 이미지)용 폴백 — 동일 결과."""

    def __init__(self, dim: int = DIM):
        self.m = np.zeros((0, dim), dtype="float32")

    def add(self, vecs):
        self.m = np.vstack([self.m, vecs])

    def search(self, q, k):
        s = self.m @ q
        idx = np.argsort(-s)[:k]
        return [(int(i), float(s[i])) for i in idx]


def make_store() -> VectorStore:
    pref = os.getenv("VECTOR_STORE", "faiss")
    if pref == "chroma":
        try:
            from .chroma_store import ChromaStore
            return ChromaStore()
        except Exception:  # pragma: no cover - 선택 의존성
            pass
    try:
        return FaissStore()
    except Exception:  # pragma: no cover
        return NumpyStore()


class PolicyRetriever:
    def __init__(self, embedding: EmbeddingStrategy | None = None):
        dr = get_dataroom()
        self.chunks: list[Chunk] = []
        for src, txt in dr.policy_docs():
            self.chunks += chunk_markdown(src, txt)
        for r in dr.legal_kb["rules"]:
            self.chunks.append(Chunk(f"legal_kb#{r['id']}", f"legal_kb:{r['law']}", f"{r['law']} {r['title']}\n{r['text']}"))
        self.embedding = embedding or HashingEmbedding()
        self.store = make_store()
        self.store.add(self.embedding.embed([c.text for c in self.chunks]))
        self.store_name = type(self.store).__name__
        self._df = Counter(tok for c in self.chunks for tok in set(_tokens(c.text)))
        self._toks = [Counter(_tokens(c.text)) for c in self.chunks]
        self._avg = sum(sum(t.values()) for t in self._toks) / len(self._toks)

    def _bm25(self, q: str, i: int, k1=1.4, b=0.75) -> float:
        tf, n = self._toks[i], len(self.chunks)
        ln = sum(tf.values())
        s = 0.0
        for tok in set(_tokens(q)):
            if tok not in tf:
                continue
            idf = math.log(1 + (n - self._df[tok] + 0.5) / (self._df[tok] + 0.5))
            s += idf * tf[tok] * (k1 + 1) / (tf[tok] + k1 * (1 - b + b * ln / self._avg))
        return s

    def retrieve(self, query: str, k: int = 4, alpha: float = 0.5, require: tuple[str, ...] = ()) -> list[dict]:
        """하이브리드(벡터 + BM25) 상위 k개.
        require(Y-02, 13차): 결정 사유가 된 문서의 출처 일부(예: 'legal_kb:화장품법 제13조…', 'covenant_terms'). 각 출처에서 질의와
        가장 가까운 조각 하나를 맨 앞에 넣고 나머지를 점수 순으로 채운다. 기존에는 '제안·라벨·권한 규칙'만으로 검색해,
        광고 규제로 막힌 기안의 근거에 해당 법 조항이, covenant 하회 기안의 근거에 차입 약정이 빠졌다(재현율 61.9%)."""
        qv = self.embedding.embed([query])[0]
        vec = dict(self.store.search(qv, min(len(self.chunks), 20)))
        bm = {i: self._bm25(query, i) for i in range(len(self.chunks))}
        mb = max(bm.values()) or 1.0
        scored = [(i, alpha * vec.get(i, 0.0) + (1 - alpha) * bm[i] / mb) for i in range(len(self.chunks))]
        ranked = sorted(scored, key=lambda x: -x[1])
        pinned = []
        for key in require:
            hit = next(((i, s) for i, s in ranked if key in self.chunks[i].source), None)
            if hit and hit[0] not in {i for i, _ in pinned}:
                pinned.append(hit)
        seen = {i for i, _ in pinned}
        top = pinned + [(i, s) for i, s in ranked if i not in seen][:max(0, k - len(pinned))]
        return [{"chunk_id": self.chunks[i].chunk_id, "source": self.chunks[i].source,
                 "text": self.chunks[i].text, "score": round(s, 4)} for i, s in top]


_ret: PolicyRetriever | None = None
_lk = threading.Lock()


def get_retriever() -> PolicyRetriever:
    global _ret
    if _ret is None:
        with _lk:
            if _ret is None:
                _ret = PolicyRetriever()
    return _ret
