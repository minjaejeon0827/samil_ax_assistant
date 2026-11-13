#!/usr/bin/env bash
# 녹화 원본(webm) → 시연 영상 MP4(원본 해상도) + README용 GIF(가벼운 판).
# v1.2: GIF가 19.7MB라 느린 4G에서 내려받는 데 약 100초 걸렸다(2차 점검 P-04).
#       같은 해상도(960px)를 유지하면서 ① 거의 같은 프레임은 버리고 앞 프레임을 더 오래 보여 주기(mpdecimate + 가변 프레임),
#       ② 바뀐 사각형만 다시 칠하기(diff_mode=rectangle), ③ 화면 UI에 맞는 64색 팔레트로 줄인다.
# v1.21: 2부(서버 모드 — PRD §15 다음 단계, demo/record_next.cjs)가 있으면 1부 뒤에 이어 붙인다.
# v1.24: python3 demo/tts.py로 해설 음성을 먼저 만들고 녹화하면, MP4에 AI 음성 해설이 들어간다(GIF는 소리 없음).
set -euo pipefail
cd "$(dirname "$0")"
RAW=$(ls -t raw/*.webm | head -1)
NEXT=$(ls -t raw/next/*.webm 2>/dev/null | head -1 || true)
SRC="$RAW"
if [ -n "$NEXT" ]; then
  ffmpeg -y -loglevel error -i "$RAW" -i "$NEXT" -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[v]" -map "[v]" -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p raw/joined.mp4
  SRC=raw/joined.mp4
fi
# 24차: AI 음성 해설(자막이 뜬 시각에 맞춰) — raw/voice(tts.py)와 raw/timeline_*.json(녹화 스크립트)이 있으면 넣는다
if [ -f raw/voice/manifest.json ] && [ -f raw/timeline_part1.json ]; then
  python3 mix_voice.py "$SRC" "$RAW" aurora_demo.mp4
else
  ffmpeg -y -loglevel error -i "$SRC" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart aurora_demo.mp4
fi
ffmpeg -y -loglevel error -i "$SRC" -vf "fps=5,mpdecimate=hi=768:lo=320:frac=0.33,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" -fps_mode vfr aurora_demo.gif
ls -la aurora_demo.mp4 aurora_demo.gif
