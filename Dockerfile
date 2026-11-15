# Aurora 판단 데스크 — 단일 컨테이너(AXHub 배포용): React 빌드 결과를 FastAPI가 함께 서빙
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
COPY shared/ /shared/
ARG VITE_ENABLE_API=1
ARG VITE_API_KEY=demo-public-key
ENV VITE_ENABLE_API=$VITE_ENABLE_API VITE_API_KEY=$VITE_API_KEY
# 32차(31차 AR-01·AR-02): npm run build 끝에서 로그인 칸 예시 글자·권한표에 없는 역할 이름표가 든 번들이면 빌드가 멈춘다(scripts/check-bundle.cjs)
RUN npm run build && node scripts/check-bundle.cjs dist

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LLM_PROVIDER=offline REPO=memory REPO_PATH=/tmp/desk.json
# v1.22: 스캔 PDF 계약서 글자 인식(OCR) — PDF → 이미지(poppler) → 글자(tesseract 한국어·영어)
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-kor tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
# 30차(AP-01): 배포 이미지에 계약서 PDF 읽기·글자 인식 도구가 빠지면 빌드에서 바로 멈춘다(기존: 배포 뒤 업로드가 422)
RUN python -c "import pypdf, jwt, faiss, langgraph, pymysql, shutil, sys; sys.exit(0 if shutil.which('pdftoppm') and shutil.which('tesseract') else 'PDF 글자 인식 도구(poppler-utils·tesseract) 없음')" \
    && tesseract --list-langs 2>/dev/null | grep -qx kor
COPY backend/ backend/
COPY shared/ shared/
COPY data/ data/
COPY --from=web /web/dist frontend/dist
WORKDIR /app/backend
EXPOSE 8000
# API_KEYS·ALLOWED_ORIGINS는 배포 환경변수로 주입(코드에 비밀값 없음)
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
