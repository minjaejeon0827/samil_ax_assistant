#!/usr/bin/env bash
# 전체 E2E 실행 — 프론트 3종 빌드(브라우저 단독 / API 모드 / 단일 컨테이너) 후 브라우저·API·MCP·풀스택 E2E를 순서대로 실행.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd frontend && npx vite build >/dev/null && VITE_ENABLE_API=1 VITE_API_URL=http://localhost:8000 VITE_API_KEY=e2e-key npx vite build --outDir dist-api >/dev/null && VITE_ENABLE_API=1 VITE_API_KEY=e2e-key npx vite build --outDir dist-docker >/dev/null)
fail=0
for s in ui api fullstack round2 round3 round4 round5 round6 round7 round8 round9 round10 round11 round12 round13 round14 round15 round16 round17 round18 round19 round20 round21 round22 round23 round24 round25 round26 round27 round28 round30 round32; do
  E2E_REPORT="$s" node --test --test-concurrency=1 --test-force-exit "e2e/$s.e2e.test.cjs" > "e2e/reports/$s.txt" 2>&1 || fail=1
  echo "$s: $(grep -E '^# (pass|fail)' "e2e/reports/$s.txt" | tr '\n' ' ')"
done
exit $fail
