"""요청·응답 Pydantic 모델 — 입력은 여기서 먼저 걸러진다(422)."""
from __future__ import annotations

from datetime import date
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, Field, field_validator


def _whole_unicode(v: str | None) -> str | None:
    """V-03(11차): 짝 없는 서로게이트(깨진 유니코드)는 저장·응답 때 UTF-8로 바꿀 수 없어 500 내부 오류가 났다 → 422 안내."""
    if v is not None and any("\ud800" <= ch <= "\udfff" for ch in v):
        raise ValueError("깨진 문자가 들어 있습니다(복사 과정에서 글자가 손상됨). 해당 부분을 지우고 다시 입력하세요.")
    return v


Text = Annotated[str, AfterValidator(_whole_unicode)]

CLOCK_MIN, CLOCK_MAX = date(2026, 7, 1), date(2027, 6, 30)   # 기준일 ~ 계약 갱신 1년

Role = Literal["MARKETING_TEAM", "MASIL_CEO", "GROUP_CEO", "FINANCE", "SCM", "CONTRACT_OWNER", "TEST_AURORA", "AGENCY", "SYSTEM"]
EventKind = Literal["CONTRACT_RENEWAL_NOTICE", "BUDGET_PLAN_BATCH", "AGENCY_COUNTER_OFFER", "MARKETING_CLAIM",
                    "FINANCE_OVERDUE_AR", "FREE_TEXT"]


class LoginIn(BaseModel):
    user: Text = Field(min_length=1, max_length=64)
    password: Text = Field(min_length=1, max_length=256)


class TokenIn(BaseModel):          # v1.21: 리프레시 토큰 회전
    refresh_token: str = Field(min_length=10, max_length=200)


class OidcCallbackIn(BaseModel):   # v1.21: 사내 SSO 돌아온 값
    code: str = Field(min_length=1, max_length=2048)
    state: str = Field(min_length=1, max_length=200)


class PasswordIn(BaseModel):       # v1.21: 비밀번호 변경
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)


class EventIn(BaseModel):
    kind: EventKind
    actor: Role = "SYSTEM"
    text: Text | None = Field(default=None, max_length=2000)


class DecisionIn(BaseModel):
    actor: Role
    action: Literal["approve", "reject", "request_info"]
    comment: Text = Field(default="", max_length=500)
    expected_version: int | None = None


class ReplyIn(BaseModel):
    actor: Role = "AGENCY"
    reply_key: Literal["agency_payment_schedule", "agency_accepts_termination"]


class FixIn(BaseModel):
    actor: Role = "MARKETING_TEAM"
    copy_text: Text | None = Field(default=None, max_length=500)


class TaskDoneIn(BaseModel):
    actor: Role


class ActorIn(BaseModel):           # v1.27: 본문이 역할뿐인 명령(감사 기록 머리값 보내기)
    actor: Role = "GROUP_CEO"


class ConditionIn(BaseModel):
    actor: Role = "FINANCE"
    cash_assumption: Literal["AS_IS", "CONSERVATIVE", "LEGACY45"]


class ClockIn(BaseModel):
    actor: Role = "SYSTEM"
    to: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")

    @field_validator("to")
    @classmethod
    def _real_date(cls, v: str) -> str:
        """F-04: 형식만 보던 검사를 실제 날짜 + 시뮬레이션 범위로 강화(기존: '2026-13-45'·'9999-12-31'도 통과)."""
        try:
            d = date.fromisoformat(v)
        except ValueError as e:
            raise ValueError("존재하지 않는 날짜입니다") from e
        if not (CLOCK_MIN <= d <= CLOCK_MAX):
            raise ValueError(f"시계는 {CLOCK_MIN}~{CLOCK_MAX} 범위에서만 옮길 수 있습니다")
        return v


class JobOut(BaseModel):
    job_id: str
    status: Literal["queued", "running", "done", "failed"]
    message: str
    result: dict | None = None
