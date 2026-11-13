"""API 키 인증 — CORS는 브라우저만 막으므로 curl 같은 직접 호출은 API 키로 막는다.
401 = 헤더 없음(누구인지 모름), 403 = 키가 틀림."""
from fastapi import Depends, HTTPException
from fastapi.security import APIKeyHeader

from ..config import get_settings

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def verify_api_key(api_key: str | None = Depends(api_key_header)) -> str:
    if api_key is None:
        raise HTTPException(status_code=401, detail="X-API-Key 헤더가 필요합니다")
    if api_key not in get_settings().api_keys:
        raise HTTPException(status_code=403, detail="유효하지 않은 API 키입니다")
    return api_key
