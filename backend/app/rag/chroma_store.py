"""Chroma 벡터 저장소 어댑터(선택). `pip install chromadb` 후 VECTOR_STORE=chroma 로 사용."""
from __future__ import annotations

import numpy as np


class ChromaStore:
    def __init__(self, name: str = "aurora_policy"):
        import chromadb
        self.client = chromadb.EphemeralClient()
        self.col = self.client.get_or_create_collection(name, metadata={"hnsw:space": "ip"})
        self.n = 0

    def add(self, vecs: np.ndarray) -> None:
        ids = [str(self.n + i) for i in range(len(vecs))]
        self.col.add(ids=ids, embeddings=vecs.tolist())
        self.n += len(vecs)

    def search(self, q: np.ndarray, k: int):
        r = self.col.query(query_embeddings=[q.tolist()], n_results=k)
        return [(int(i), 1 - float(dist)) for i, dist in zip(r["ids"][0], r["distances"][0])]
