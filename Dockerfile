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
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LLM_PROVIDER=offline REPO=memory REPO_PATH=/tmp/desk.json
# v1.22: 스캔 PDF 계약서 글자 인식(OCR) — PDF → 이미지(poppler) → 글자(tesseract 한국어·영어)
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-kor tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY shared/ shared/
COPY data/ data/
COPY --from=web /web/dist frontend/dist
WORKDIR /app/backend
EXPOSE 8000
# API_KEYS·ALLOWED_ORIGINS는 배포 환경변수로 주입(코드에 비밀값 없음)
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
