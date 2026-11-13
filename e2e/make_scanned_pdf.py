"""22차 E2E: 글자층이 없는 '스캔' PDF 만들기 — 계약서 원문을 이미지로 그려 PDF로 저장(글자 추출 불가 → OCR 필요).
사용: python e2e/make_scanned_pdf.py <원문.md> <출력.pdf>"""
import sys
from PIL import Image, ImageDraw, ImageFont

src, out = sys.argv[1], sys.argv[2]
font = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 45, index=1)   # 23차: 300dpi
lines = []
for raw in open(src, encoding="utf-8").read().splitlines():
    raw = raw.replace("**", "").lstrip("#> ").strip()
    while len(raw) > 44:
        cut = raw.rfind(" ", 0, 44)
        cut = cut if cut > 20 else 44
        lines.append(raw[:cut]); raw = raw[cut:].strip()
    lines.append(raw)
W, H, LH = 2481, 3508, 69                       # A4 300dpi(23차: 흑백 문서 스캔의 흔한 해상도)
pages, page, y = [], None, 0
for ln in lines:
    if page is None or y > H - 180:
        page = Image.new("RGB", (W, H), "white"); pages.append(page); y = 165
    ImageDraw.Draw(page).text((165, y), ln, fill="black", font=font); y += LH
pages = [pg.convert("1") for pg in pages]          # 23차: 흑백(팩스·문서 스캔처럼 쪽당 수십~백 KB) — 여러 쪽도 2MB 안에
pages[0].save(out, save_all=True, append_images=pages[1:], resolution=300)
print(out, len(pages))
