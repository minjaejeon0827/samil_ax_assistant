"""계약서 조항 추출(v1.21, PRD §15-3).

흐름: 원문(.md/.txt/.pdf) → 조항 나누기(제n조·표·문단) → 항목마다 질의로 조항 검색(BM25, 기존 RAG와 같은 토큰화)
→ 찾은 조항 안에서 규칙(정규식)으로 값 추출 → 원문 인용(조항 번호·문장)과 함께 돌려준다 → 위약금·지급 조건 확인.

LLM을 쓰지 않는 이유: 금액·날짜·비율은 틀리면 회사가 책임지는 값이다(판단 엔진과 같은 원칙). 그래서 추출은 결정적
규칙으로 하고, 찾지 못한 항목은 '확인 필요'로 남긴다(지어내지 않음). 원문의 연락처·계좌·이메일은 저장 전에 가린다.
"""
from __future__ import annotations

import hashlib
import io
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from collections import Counter
from datetime import date, timedelta

from ..rag.store import _tokens
from ..validation import check_output

MAX_BYTES = 2 * 1024 * 1024
ALLOWED = (".md", ".txt", ".pdf")


class ContractError(ValueError):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


# ---------------- 원문 읽기 ----------------
MAX_PAGE_IN = 20.0          # 23차 AJ05: 한 변이 20인치(A3 긴 변 16.5인치)를 넘는 페이지는 스캔 계약서가 아님 → 그리지 않고 거절
OCR_PX = 2339               # 페이지 긴 변을 이 화소로 맞춰 그림(A4 200dpi) — 페이지가 커도 메모리는 일정


_READY: dict | None = None


def readiness() -> dict:
    """30차(AP-01): 계약서 PDF를 읽을 준비가 됐는가 — /api/health가 알려 배포 확인(읽기 전용)에서 업로드 없이 잡는다. 한 번만 확인."""
    global _READY
    if _READY is None:
        try:
            import pypdf  # noqa: F401
            pdf = True
        except ImportError:
            pdf = False
        ocr = bool(shutil.which("pdftoppm") and shutil.which("tesseract"))
        if ocr:
            try:
                langs = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=10).stdout.split()
                ocr = "kor" in langs
            except Exception:  # noqa: BLE001
                ocr = False
        _READY = {"pdf": pdf, "ocr": ocr}
    return _READY


def ocr_plan(data: bytes) -> dict:
    """글자 인식 전에 싸게 확인(수 ms): 쪽수·페이지 크기. 너무 큰 페이지는 ContractError(그리기 전에 거절)."""
    from pypdf import PdfReader
    pages = PdfReader(io.BytesIO(data)).pages
    for i, pg in enumerate(pages):
        w, h = float(pg.mediabox.width) / 72, float(pg.mediabox.height) / 72
        if max(w, h) > MAX_PAGE_IN:
            raise ContractError(f"PDF {i + 1}쪽의 페이지 크기가 {w:.0f}×{h:.0f}인치로 너무 큽니다(스캔 계약서는 A4·A3 크기). 원본을 A4로 다시 스캔해 올려 주세요.")
    total = len(pages)
    return {"pages": total, "read": min(total, int(os.getenv("OCR_MAX_PAGES", "20")))}


def ocr_pdf(data: bytes, max_pages: int | None = None, progress=None) -> str:
    """v1.22(§15-3 남은 일): 글자층이 없는 스캔 PDF → 페이지 이미지(pdftoppm) → 글자 인식(tesseract kor+eng, psm 4).
    23차(AJ05): ① 쪽마다 긴 변을 2339화소로 맞춰 그려 큰 페이지도 메모리 일정 ② 쪽을 CPU 수만큼 동시에(쪽당 1스레드)
    ③ progress(끝난 쪽, 전체)로 진행을 알림 ④ 전체 시간 OCR_BUDGET_S(기본 120초). 도구가 없으면 빈 문자열."""
    if not (shutil.which("pdftoppm") and shutil.which("tesseract")):
        return ""
    from concurrent.futures import ThreadPoolExecutor
    plan = ocr_plan(data)
    n = min(plan["pages"], max_pages or plan["read"])
    deadline = time.monotonic() + float(os.getenv("OCR_BUDGET_S", "120"))
    env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
    done = [0]
    lock = threading.Lock()
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "in.pdf")
        open(src, "wb").write(data)

        def page(i: int) -> str:
            left = deadline - time.monotonic()
            if left <= 1:
                raise ContractError(f"글자 인식이 {os.getenv('OCR_BUDGET_S', '120')}초 안에 끝나지 않았습니다(쪽수가 많거나 이미지가 큼). 필요한 쪽만 나눠 올려 주세요.")
            base = os.path.join(d, f"p{i}")
            subprocess.run(["pdftoppm", "-f", str(i), "-l", str(i), "-scale-to", str(OCR_PX), "-gray", "-png", "-singlefile", src, base],
                           check=True, timeout=min(60, left), capture_output=True)
            r = subprocess.run(["tesseract", base + ".png", "-", "-l", os.getenv("OCR_LANGS", "kor+eng"), "--psm", "4"],
                               timeout=min(90, left), capture_output=True, text=True, env=env)
            with lock:
                done[0] += 1
                if progress:
                    progress(done[0], n)
            return r.stdout
        with ThreadPoolExecutor(max_workers=max(1, min(int(os.getenv("OCR_WORKERS", "0")) or (os.cpu_count() or 2), 4))) as ex:
            return "\n".join(ex.map(page, range(1, n + 1)))


def run_ocr(data: bytes, plan: dict | None = None, progress=None) -> tuple[str, dict]:
    plan = plan or ocr_plan(data)
    try:
        text = ocr_pdf(data, plan["read"], progress)
    except ContractError:
        raise
    except Exception:  # noqa: BLE001 — 글자 인식 실패는 아래 안내로
        text = ""
    if len(text.strip()) < 20:
        raise ContractError("PDF에 읽을 수 있는 글자가 거의 없고 글자 인식(OCR)도 실패했습니다. 더 선명하게 스캔하거나 글자가 있는 PDF로 올려 주세요.")
    return text, {"ocr": True, "pages": plan["pages"], "read": plan["read"]}


def read_text(filename: str, data: bytes) -> str:
    return read_text_ex(filename, data)[0]


def read_text_ex(filename: str, data: bytes, defer_ocr: bool = False) -> tuple[str, dict]:
    """→ (원문, {"ocr": bool}). defer_ocr이면 글자 인식이 필요한 PDF는 ("", {"ocr": "pending", 쪽수})로 바로 돌려준다
    (23차 AJ05: 업로드 응답이 글자 인식을 기다리지 않게 — 작업에서 run_ocr로 마저 읽음)."""
    name = (filename or "").lower()
    if not name.endswith(ALLOWED):
        raise ContractError("계약서는 .md·.txt·.pdf 파일만 올릴 수 있습니다.", 415)
    if len(data) > MAX_BYTES:
        raise ContractError(f"계약서 파일이 너무 큽니다({MAX_BYTES // 1024 // 1024}MB 이하).", 413)
    if not data.strip():
        raise ContractError("빈 파일입니다.")
    if name.endswith(".pdf"):
        try:
            from pypdf import PdfReader
        except ImportError:   # 30차(AP-01): 서버 구성 문제를 '스캔 PDF라면…'처럼 사용자 파일 탓으로 안내하지 않는다
            raise ContractError("서버에 PDF 읽기 구성 요소가 없어 PDF를 읽지 못했습니다(관리자 확인: backend/requirements.txt로 다시 배포). "
                                "그동안은 계약서를 .md·.txt로 올려 주세요.", 503) from None
        try:
            text = "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(data)).pages)
        except Exception as e:  # noqa: BLE001
            raise ContractError(f"PDF에서 글자를 읽지 못했습니다({type(e).__name__}). 스캔 이미지 PDF라면 글자 인식(OCR) 후 올려 주세요.") from None
        if len(text.strip()) < 20:
            plan = ocr_plan(data)                 # 너무 큰 페이지는 여기서 바로 거절(그리지 않음)
            if defer_ocr:
                return "", {"ocr": "pending", **plan}
            return run_ocr(data, plan)
        return text, {"ocr": False}
    for enc in ("utf-8-sig", "cp949"):
        try:
            return data.decode(enc), {"ocr": False}
        except UnicodeDecodeError:
            continue
    raise ContractError("글자 인코딩을 알 수 없습니다(UTF-8 또는 CP949로 저장해 주세요).")


# ---------------- 조항 나누기 ----------------
_ARTICLE = re.compile(r"((?:제\s*\d+\s*조|Article\s+\d+|Section\s+\d+)(?:\s*\([^)]{1,40}\))?)")   # v1.22: 영문 조항


def split_clauses(text: str) -> list[dict]:
    """'제n조' 단위로 나누고, 없으면(통보서·표) 줄·표 행 단위로 나눈다."""
    text = text.replace("\r\n", "\n")
    parts = _ARTICLE.split(text)
    out: list[dict] = []
    if len(parts) > 1:
        head = parts[0].strip()
        if head:
            out.append({"ref": "머리말", "text": head})
        for i in range(1, len(parts), 2):
            out.append({"ref": re.sub(r"\s+", "", parts[i]), "text": (parts[i] + " " + parts[i + 1]).strip()})
    else:
        for n, line in enumerate(x.strip() for x in text.split("\n")):
            if len(line) >= 4 and not set(line) <= set("|-: "):
                out.append({"ref": f"{n + 1}행", "text": line})
    return out


class _BM25:
    def __init__(self, docs: list[str]):
        self.toks = [_tokens(d) for d in docs]
        self.df = Counter(t for ts in self.toks for t in set(ts))
        self.n = len(docs)
        self.avg = sum(len(t) for t in self.toks) / max(1, self.n)

    def scores(self, q: str) -> list[float]:
        qt = _tokens(q)
        out = []
        for ts in self.toks:
            tf = Counter(ts)
            s = 0.0
            for t in qt:
                if t not in tf:
                    continue
                idf = math.log(1 + (self.n - self.df[t] + 0.5) / (self.df[t] + 0.5))
                s += idf * tf[t] * 2.2 / (tf[t] + 1.2 * (0.25 + 0.75 * len(ts) / self.avg))
            out.append(s)
        return out


# ---------------- 값 읽기 ----------------
_DATE = re.compile(r"(\d{4})\s*(?:[-./]|년)\s*(\d{1,2})\s*(?:[-./]|월)\s*(\d{1,2})\s*일?")


_MONTHS = {m: i + 1 for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"])}
_EN_DATE = re.compile(r"\b(" + "|".join(_MONTHS) + r")\s+(\d{1,2}),?\s+(\d{4})|\b(\d{1,2})\s+(" + "|".join(_MONTHS) + r"),?\s+(\d{4})", re.I)


def dates_in(s: str) -> list[str]:
    """한국어·숫자 날짜와 영문 날짜(October 1, 2025 · 1 October 2025)를 나온 순서대로."""
    found = []
    for m in _DATE.finditer(s):
        try:
            found.append((m.start(), date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()))
        except ValueError:
            pass
    for m in _EN_DATE.finditer(s):
        mon, d, y = (m.group(1), m.group(2), m.group(3)) if m.group(1) else (m.group(5), m.group(4), m.group(6))
        try:
            found.append((m.start(), date(int(y), _MONTHS[mon.lower()], int(d)).isoformat()))
        except ValueError:
            pass
    return [x for _, x in sorted(found)]


_KRW = re.compile(r"(?:(\d[\d,]*(?:\.\d+)?)\s*억)?\s*(?:(\d[\d,]*)\s*천\s*만?)?\s*(?:(\d[\d,]*)\s*백\s*만?)?\s*(?:(\d[\d,]*)\s*만)?\s*(\d[\d,]*)?\s*원")


_KDIG = dict(zip("일이삼사오육칠팔구", "123456789"))


def kr_digits(s: str) -> str:
    """23차 AJ06: 한글로 쓴 금액의 숫자 자리('팔천만원', '일억 이천만원', '삼억원') → '8천만원', '1억 2천만원', '3억원'."""
    return re.sub(r"[일이삼사오육칠팔구십백천만억\s]+원", lambda m: re.sub(r"([일이삼사오육칠팔구])(?=\s*[십백천만억원])", lambda d: _KDIG[d.group(1)], m.group(0)), s)


_FX = re.compile(r"(USD|US\$|EUR|JPY|CNY|GBP|€|£|¥|\$)\s*(\d(?:[\d,]*\d)?(?:\.\d+)?)|(\d(?:[\d,]*\d)?(?:\.\d+)?)\s*(USD|EUR|JPY|CNY|GBP|달러|유로|엔)")
_FX_CODE = {"US$": "USD", "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "달러": "USD", "유로": "EUR", "엔": "JPY"}


def fx_values(s: str) -> list[tuple[str, float, str]]:
    """외화 금액 → [(통화, 금액, 원문)]. 원화로 바꾸지 않는다(환율은 재무팀이 정함)."""
    out = []
    for m in _FX.finditer(s):
        cur, num = (m.group(1), m.group(2)) if m.group(1) else (m.group(4), m.group(3))
        out.append((_FX_CODE.get(cur, cur), float(num.replace(",", "")), m.group(0).strip()))
    return out


def krw_values(s: str) -> list[tuple[float, str]]:
    """'12억원', '9억 6천만원', '9천만원', '1,200원', '1,200,000,000원', 'KRW 1,500,000,000', '₩1,500,000,000', '팔천만원' → 원 단위 숫자."""
    s = kr_digits(s)
    out = [(float(m.group(1).replace(",", "")), m.group(0)) for m in re.finditer(r"(?:KRW|₩)\s*(\d(?:[\d,]*\d)?(?:\.\d+)?)", s)]
    for m in _KRW.finditer(s):
        eok, cheon, baek, man, won_ = m.groups()
        if not any((eok, cheon, baek, man, won_)):
            continue
        f = lambda x: float(x.replace(",", "")) if x else 0.0  # noqa: E731
        v = f(eok) * 1e8 + f(cheon) * 1e7 + f(baek) * 1e6 + f(man) * 1e4 + f(won_)
        if eok or cheon or baek or man:
            if won_ and not man:   # '9천만 5000원' 같은 경우는 드묾 — 원 자리는 그대로 더함
                pass
        if v > 0:
            out.append((v, m.group(0).strip()))
    return out


def pct_values(s: str) -> list[float]:
    return [float(x) for x in re.findall(r"(\d+(?:\.\d+)?)\s*(?:%|퍼센트|percent\b)", s, re.I)]


def won_text(v: float) -> str:
    if v >= 1e8:
        return f"{v / 1e8:,.2f}".rstrip("0").rstrip(".") + "억원"
    if v >= 1e4:
        return f"{v / 1e4:,.0f}만원"
    return f"{v:,.0f}원"


# ---------------- 추출 ----------------
QUERIES = {   # v1.22: 영문 계약서 질의어 추가
    "term": "계약 기간 만료 만료일 부터 까지 term commence expire expiration until",
    "renewal": "자동 갱신 연장 동일한 조건 같은 조건 통보하지 않으면 해지 의사 automatically renew renewal notice non-renewal prior",
    "fee": "보수 고정 기본 운영료 수수료 연간 월 고정 피 지급한다 fee fees annual service fee KRW",
    "payment": "지급 조건 매월 분기 분할 지급 이내 선급 세금계산서 payment paid payable installments monthly quarter quarterly invoice advance",
    "penalty": "위약금 중도 해지 잔여 정산 early termination fee penalty liquidated damages remaining",
}


def extract(text: str, filename: str, today: str, ocr: bool | dict = False) -> dict:
    """계약서 원문 → 조건(terms)·확인 결과(checks)·인용(citations)."""
    clauses = split_clauses(text)
    if not clauses:
        raise ContractError("조항을 찾지 못했습니다(계약서 본문이 비어 있음).")
    bm = _BM25([c["text"] for c in clauses])
    found: dict[str, dict] = {}
    for key, q in QUERIES.items():
        sc = bm.scores(q)
        order = sorted(range(len(clauses)), key=lambda i: -sc[i])
        found[key] = [clauses[i] for i in order[:3] if sc[i] > 0]

    def first(key, pred):
        for c in found[key]:
            v = pred(c["text"])
            if v not in (None, [], ""):
                return v, c
        return None, None

    cite = {}
    t: dict = {"filename": filename}
    # 당사자(상대방)
    # 23차 AJ06: 한 줄에 '갑: …, 을: …'·'Party A: … Party B: …'로 적은 경우도(줄 머리가 아니어도)
    m = re.search(r"(?:^|[\s,;(])(?:을|수탁자|공급자|발신|Party\s*B|Supplier|Service\s+Provider)\s*[:：]\s*([^\n,;]+)", text, re.M | re.I)
    if m:
        t["counterparty"] = re.split(r"\s*[\(（]|\s+(?:Party\s*[A-Z]|갑)\s*[:：]", m.group(1).strip())[0].strip(" *") or None
    else:
        # 30차(O-3): 한 줄 당사자 문형 '주식회사 마실커머스(이하 "갑")와 주식회사 한결물류(이하 "을")'
        m2 = re.search(r"([^()（）\"“”:：\n]{1,40}?)\s*[\(（]\s*이하\s*[\"“”'‘’]?\s*을\s*[\"“”'‘’]?\s*[\)）]", text)
        name = re.sub(r"^\s*(?:와|과|및|그리고|,)\s*", "", m2.group(1)).strip(" *,") if m2 else ""
        t["counterparty"] = name or None
    # 기간·만료일
    exp, c = first("term", lambda s: (dates_in(s)[-1] if re.search(r"만료|까지|기간|expir|until|terminat|\bterm\b", s, re.I) and dates_in(s) else None))
    if exp:
        t["expiry"] = exp
        cite["expiry"] = c
    # 자동 갱신·통보 기한
    # 23차 AJ06: '갱신하지 않는다'고 분명히 적은 경우만 '자동 갱신 없음'. 갱신 조항을 못 찾으면 None('확인 필요') — 못 찾은 것을 '없음'으로 단정하지 않음
    neg = re.compile(r"(?:not|never)\s+(?:be\s+)?(?:automatically\s+)?(?:renewed|extended)(?:\s+automatically)?|no\s+automatic\s+(?:renewal|extension)|expire\w*\s+without\s+renewal|"
                     r"자동\s*(?:으로\s*)?(?:갱신|연장)\s*(?:되지|하지)\s*않|(?:갱신|연장)하지\s*않는다|(?:갱신|연장)되지\s*않는다", re.I)

    def renew(s):
        if neg.search(s):
            return None
        if re.search(r"자동\s*(?:으로\s*)?(?:갱신|연장)|(?:같은|동일한?)\s*조건으로\s*\d+\s*년|automatically\s+(?:be\s+)?(?:renew|extend)|(?:renew|extend)(?:ed|s)?\s+automatically|auto-?renew", s, re.I):
            return s
        return None
    rv, c = first("renewal", renew)
    nv = next((cl for cl in clauses if neg.search(cl["text"])), None)
    t["auto_renew"] = True if rv else (False if nv else None)
    if nv and not rv:
        cite["auto_renew"] = nv
    if rv:
        cite["auto_renew"] = c
        yrs = re.search(r"(\d+)\s*년", rv) or re.search(r"\(?(\d+)\)?\s*-?\s*years?", rv, re.I)
        t["renewal_years"] = int(yrs.group(1)) if yrs else None
        days = re.search(r"만료(?:일)?\s*(\d+)\s*일\s*전", rv) or re.search(r"\(?(\d+)\)?\s*(?:calendar\s+)?days?\s+(?:prior\s+to|before)", rv, re.I)
        explicit = [d for d in dates_in(rv)]
        if days and t.get("expiry"):
            t["notice_days"] = int(days.group(1))
            t["notice_deadline"] = (date.fromisoformat(t["expiry"]) - timedelta(days=int(days.group(1)))).isoformat()
            cite["notice_deadline"] = c
        elif explicit:
            t["notice_deadline"] = explicit[0]
            cite["notice_deadline"] = c
    if "notice_deadline" not in t:   # 통보서 표: '통보 기한 | 2026-07-17'
        for cl in clauses:
            if re.search(r"통보\s*기한", cl["text"]) and dates_in(cl["text"]):
                t["notice_deadline"] = dates_in(cl["text"])[0]
                cite["notice_deadline"] = cl
                break
    # 보수(연간 고정 금액)
    def fee(s):
        s = kr_digits(s)
        vals = krw_values(s)
        monthly = re.search(r"월\s*고정|월\s*\d|매월|monthly\s+(?:service\s+)?fee|per\s+month", s, re.I) and not re.search(r"연간|연\s*\d|annual|per\s+year", s, re.I)
        if not vals:
            fx = fx_values(s)   # 23차 AJ06: 외화 금액은 원화로 바꾸지 않고 표시만
            return ("fx", fx[0], "월" if monthly else "연") if fx else None
        if monthly:
            return ("monthly", vals[0])
        return ("annual", max(vals, key=lambda x: x[0]))
    fv, c = first("fee", fee)
    if fv and fv[0] == "fx":
        _, (cur, amt, raw), per = fv
        t["currency"] = cur
        t["fee_basis"] = f"{per} {raw}"
        cite["fee_basis"] = c
        fv = None
    if fv:
        kind, (v, raw) = fv
        t["annual_fee_krw"] = v * 12 if kind == "monthly" else v
        t["fee_basis"] = f"월 {raw} × 12" if kind == "monthly" else raw
        cite["annual_fee_krw"] = c
        var = [p for p in pct_values(c["text"])]
        if var:
            t["variable_fee"] = f"{var[0]:g}% 연동"
    # 지급 조건
    _sched = r"매월|분기|이내|선급|each\s+month|quarter|within\s|in\s+advance|upfront|monthly"   # 24차: 지급 '일정'이 있는 조항을 먼저
    pv, c = first("payment", lambda s: s if re.search(r"지급|\bpa(?:y|id|yable)\b|payment", s, re.I) and re.search(_sched, s, re.I) else None)
    if not pv:
        pv, c = first("payment", lambda s: s if re.search(r"지급|\bpa(?:y|id|yable)\b|payment", s, re.I) else None)
    if pv:
        cite["payment"] = c
        pay: dict = {}
        mm = re.search(r"매월\s*(말일|\d+\s*일)", pv)
        en = re.search(r"on\s+the\s+(\d+)(?:st|nd|rd|th)\s+(?:day\s+)?of\s+each\s+month|(last)\s+day\s+of\s+each\s+month", pv, re.I)
        qq = re.search(r"분기\s*(?:별\s*)?(?:말일|마지막\s*날)|(?:last\s+day|end)\s+of\s+(?:each|every)\s+(?:calendar\s+)?quarter|quarterly", pv, re.I)
        if mm:
            pay["monthly_day"] = "말일" if mm.group(1) == "말일" else int(re.sub(r"\D", "", mm.group(1)))
        elif en:
            pay["monthly_day"] = "말일" if en.group(2) else int(en.group(1))
        elif qq:   # 24차: 분기 지급(분기 말일)
            pay["quarterly"] = "말일"
        due = re.search(r"(\d+)\s*일\s*이내", pv) or re.search(r"within\s+(?:[a-z]+\s+)?\(?(\d+)\)?\s*days", pv, re.I)
        if due:
            pay["due_days"] = int(due.group(1))
        pre = (re.search(r"(\d+(?:\.\d+)?)\s*%\s*를?\s*[^.]{0,20}선급|선급[^.]{0,20}?(\d+(?:\.\d+)?)\s*%", pv)
               or re.search(r"(\d+(?:\.\d+)?)\s*%[^.]{0,40}(?:in\s+advance|upfront|prepaid)|advance\s+payment\s+of\s+(\d+(?:\.\d+)?)\s*%", pv, re.I))
        if pre:
            pay["prepay_pct"] = float(pre.group(1) or pre.group(2))
        t["payment"] = pay
    # 위약금
    pe, c = first("penalty", lambda s: s if re.search(r"위약금|termination\s+fee|penalty|liquidated\s+damages|terminat\w*[^.]{0,80}?\d\s*%\s*of\s+the\s+remaining", s, re.I) and pct_values(s) else None)
    if pe:
        t["penalty_pct"] = pct_values(pe)[0]
        base = re.search(r"(잔여\s*[^\s,.]+(?:\s*[^\s,.]+)?)", pe) or re.search(r"(remaining\s+[a-z ]{3,40}?fees?)", pe, re.I)
        t["penalty_base"] = base.group(1) if base else None
        cite["penalty_pct"] = c

    t["cash_out_dates"] = cash_out_dates(t, today)
    t["contract_id"] = "RC-" + hashlib.sha256(re.sub(r"\s+", "", text).encode()).hexdigest()[:8].upper()
    citations = {k: {"ref": v["ref"], "text": mask(v["text"])[:300]} for k, v in cite.items()}
    chk = checks(t, today)
    if ocr:   # v1.22: 글자 인식으로 읽은 값은 사람이 원본과 한 번 대조
        t["ocr"] = True
        chk.insert(0, {"id": "OCR_USED", "level": "watch", "text": "스캔 PDF를 글자 인식(OCR)으로 읽었습니다 — 금액·날짜·비율을 원본과 한 번 대조하세요"})
        if isinstance(ocr, dict) and ocr.get("read", 0) < ocr.get("pages", 0):   # 23차 AJ05: 쪽수 한도로 뒤쪽을 읽지 않았으면 그 사실을 남김
            t["ocr_pages"] = {"read": ocr["read"], "total": ocr["pages"]}
            chk.insert(1, {"id": "OCR_TRUNCATED", "level": "missing", "text": f"글자 인식은 앞 {ocr['read']}쪽만 읽었습니다(전체 {ocr['pages']}쪽) — 뒤쪽 조항(위약금·지급 등)은 원문에서 확인하세요"})
    return {"terms": t, "checks": chk, "citations": citations,
            "clauses": len(clauses), "masked": mask(text) != text}


def cash_out_dates(t: dict, today: str) -> list[str] | None:
    """갱신되면 생길 현금 유출일(갱신 시작일부터 1년) — 월 지급일·선급일. 모르면 None(권한 판정에서 '확인 필요')."""
    pay = t.get("payment") or {}
    if not t.get("expiry") or ("monthly_day" not in pay and "prepay_pct" not in pay and "quarterly" not in pay):
        return None
    start = date.fromisoformat(t["expiry"]) + timedelta(days=1)
    out = []
    if pay.get("prepay_pct"):
        out.append(start.isoformat())
    if pay.get("quarterly"):   # 분기 말일(3·6·9·12월 말일) 중 갱신 1년 안
        end = date(start.year + 1, start.month, 1)
        y, m = start.year, start.month
        while date(y, m, 1) < end:
            if m in (3, 6, 9, 12):
                out.append((date(y + (m // 12), m % 12 + 1, 1) - timedelta(days=1)).isoformat())
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    if "monthly_day" in pay:
        for i in range(12):
            y, m = start.year + (start.month - 1 + i) // 12, (start.month - 1 + i) % 12 + 1
            if pay["monthly_day"] == "말일":
                d = (date(y + (m // 12), m % 12 + 1, 1) - timedelta(days=1))
            else:
                d = date(y, m, min(int(pay["monthly_day"]), 28))
            out.append(d.isoformat())
    return sorted(set(out))


def checks(t: dict, today: str) -> list[dict]:
    """위약금·지급 조건·통보 기한 자동 확인. level: high|watch|info|missing."""
    out = []
    dl = t.get("notice_deadline")
    if t.get("auto_renew"):
        if dl:
            dd = (date.fromisoformat(dl) - date.fromisoformat(today)).days
            t["dday"] = dd
            if dd < 0:
                out.append({"id": "NOTICE_PASSED", "level": "high", "text": f"통보 기한 {dl}이 {-dd}일 지났습니다 — 이미 자동 갱신(승인 없는 체결)됐을 수 있습니다"})
            elif dd <= 14:
                out.append({"id": "NOTICE_URGENT", "level": "high", "text": f"통보 기한 {dl}까지 D-{dd} — 결정하지 않으면 동일 조건으로 자동 갱신됩니다"})
            elif dd <= 45:
                out.append({"id": "NOTICE_WATCH", "level": "watch", "text": f"통보 기한 {dl}까지 D-{dd}"})
        else:
            out.append({"id": "NOTICE_MISSING", "level": "missing", "text": "자동 갱신 조항은 있는데 통보 기한을 찾지 못했습니다 — 원문 확인 필요"})
    elif t.get("auto_renew") is False:
        out.append({"id": "NO_AUTO_RENEW", "level": "info", "text": "계약서에 자동 갱신하지 않는다고 적혀 있습니다 — 만료 관리만 필요"})
    else:   # 23차 AJ06: 못 찾은 것을 '없음'으로 단정하지 않음
        out.append({"id": "RENEWAL_MISSING", "level": "missing", "text": "자동 갱신 여부를 찾지 못했습니다 — 원문의 기간·갱신 조항 확인 필요(통보 기한이 있을 수 있음)"})
    p = t.get("penalty_pct")
    if p is None:
        out.append({"id": "PENALTY_MISSING", "level": "missing", "text": "위약금 조항을 찾지 못했습니다 — 원문 확인 필요"})
    elif p >= 30:
        out.append({"id": "PENALTY_HIGH", "level": "high", "text": f"중도 해지 위약금 {p:g}%({t.get('penalty_base') or '기준 미기재'}) — 갱신 뒤 되돌리기 비쌈(기준 30% 이상)"})
    else:
        out.append({"id": "PENALTY_OK", "level": "info", "text": f"중도 해지 위약금 {p:g}%({t.get('penalty_base') or '기준 미기재'})"})
    pay = t.get("payment") or {}
    if not pay:
        out.append({"id": "PAYMENT_MISSING", "level": "missing", "text": "지급 조건(지급일·분할)을 찾지 못했습니다 — 현금 유출일을 알 수 없음"})
    else:
        if pay.get("prepay_pct", 0) >= 30:
            out.append({"id": "PREPAY_HIGH", "level": "high", "text": f"갱신일에 연간 금액의 {pay['prepay_pct']:g}% 선급 — 현금 유출이 앞당겨짐(기준 30% 이상)"})
        if pay.get("due_days") and pay["due_days"] < 15:
            out.append({"id": "PAY_DUE_SHORT", "level": "watch", "text": f"지급 기한 {pay['due_days']}일 — 짧음"})
    if t.get("currency") and t.get("annual_fee_krw") is not None:   # 24차: 사람이 원화로 환산해 넣음
        out.append({"id": "FX_CONVERTED", "level": "info", "text": f"외화 금액({t['currency']})을 사람이 원화로 환산해 넣었습니다 — 환율 근거는 결재 서류의 '사람 입력'을 보세요"})
    elif t.get("currency"):
        out.append({"id": "FOREIGN_CURRENCY", "level": "missing", "text": f"금액이 외화입니다({t.get('fee_basis')}, {t['currency']}) — 원화로 바꾸지 않았습니다. 재무팀 환율로 환산해야 승인 권한을 정할 수 있습니다"})
    elif t.get("annual_fee_krw") is None:
        out.append({"id": "FEE_MISSING", "level": "missing", "text": "연간 금액을 찾지 못했습니다 — 승인 권한 판정 불가"})
    return out


def mask(text: str) -> str:
    v = check_output(text)
    return v.get("masked_text", text) if v.get("action") != "block" else "[차단된 내용]"
