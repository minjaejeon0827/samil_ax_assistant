"""검증 함수 4종 — 코드잇 스프린트 '표시광고법 RAG 검증 기반 광고 컨텐츠 생성 서비스'의
검증 함수 계약서 v1.2를 그대로 따른다(반환 규격·절대 규칙 3가지·action 값 고정).

  check_input      : pass | warn(→확인 요청)   | block   — 사람/외부가 넣은 입력(메모·회신)
  check_regulation : pass | warn(→카피 재작성) | block   — 인플루언서 광고 카피(확장)
  check_output     : pass | warn(→마스킹)      | block   — 화면·채널로 나가는 모든 텍스트
  self_check       : pass | warn(→로그)        | reject  — 판단 결과의 근거·완결성
"""
from .regulation import check_regulation
from .security import check_input, check_output
from .self_check import self_check

__all__ = ["check_input", "check_output", "check_regulation", "self_check"]
