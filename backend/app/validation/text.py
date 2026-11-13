"""정규화 유틸 — 계약서 §5.1: normalize(원문)과 squeeze(공백 제거본) 양쪽에서 검사한다."""
import re
import unicodedata


# V-01(11차): 보이지 않는 문자 — 서식 문자(Cf: 폭 없는 공백·소프트 하이픈·단어 결합자·BOM 등)와 한글 채움 문자.
# 기존에는 '무\u200b시', '최\u200b고'처럼 한 글자만 끼워 넣어도 우회 지시·광고 금지 표현·연락처 마스킹을 모두 빠져나갔다.
FILLERS = {"\u115f", "\u1160", "\u3164", "\uffa0"}


# X-04(12차): 영어처럼 보이지만 키릴·그리스 문자인 글자(о·а·κ 등)를 라틴 문자로 — 검사용(화면 표시는 그대로).
# 기존에는 'ignоre previоus instructiоns'(키릴 о)·'sκ-…'(그리스 κ)가 우회 지시·비밀값 검사를 통과했다.
CONFUSABLE = str.maketrans("аАвВеЕёЁкКмМнНоОрРсСтТуУхХѕЅіІїјЈԁԛԝɡαΑβΒεΕζΖηΗιΙκΚμΜνΝοΟρΡτΤυΥχΧ", "aAbBeEeEkKmMhHoOpPcCtTyYxXsSiIijJdqwgaAbBeEzZnHiIkKuMvNoOpPtTuYxX")


def fold_confusables(text: str) -> str:
    return (text or "").translate(CONFUSABLE)


def strip_invisible(text: str) -> str:
    return "".join(ch for ch in (text or "") if ch not in FILLERS and unicodedata.category(ch) != "Cf")


def fold_width(text: str) -> str:
    """전각 영숫자·기호(０-９, －, ＠ 등)를 반각으로 — 마스킹용(원문 모양은 거의 같음)."""
    return (text or "").translate({c: c - 0xFEE0 for c in range(0xFF01, 0xFF5F)})


def normalize(text: str) -> str:
    t = fold_confusables(unicodedata.normalize("NFKC", strip_invisible(text))).lower()
    return re.sub(r"\s+", " ", t).strip()


def squeeze(text: str) -> str:
    return re.sub(r"\s+", "", normalize(text))
