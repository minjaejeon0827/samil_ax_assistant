"""설정(환경변수). 비밀값은 코드에 두지 않는다."""
from __future__ import annotations

import os
from functools import lru_cache

from pydantic import BaseModel


class Settings(BaseModel):
    allowed_origins: list[str]
    api_keys: set[str]
    repo: str
    repo_path: str | None
    serve_frontend: bool


@lru_cache
def get_settings() -> Settings:
    return Settings(
        allowed_origins=[o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o.strip()],
        api_keys={k.strip() for k in os.getenv("API_KEYS", "dev-local-key").split(",") if k.strip()},
        repo=os.getenv("REPO", "memory"),          # memory | mysql
        repo_path=os.getenv("REPO_PATH"),           # memory 저장소를 JSON 파일로 영속화할 경로(선택)
        serve_frontend=os.getenv("SERVE_FRONTEND", "1") == "1",
    )
