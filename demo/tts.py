"""24차: 시연 영상 AI 음성 해설 합성 — demo/narration_src.json(자막 제목 → 해설 한 줄)을 한국어 음성(wav)으로.
모델: sherpa-onnx VITS 한국어(KSS, mimic3 변환) — 오프라인, 무료. 받기:
  curl -L -o kss.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-mimic3-ko_KO-kss_low.tar.bz2
  mkdir -p demo/tts_model && tar xjf kss.tar.bz2 -C demo/tts_model
  pip install "sherpa-onnx==1.12.40" soundfile    (2.0.x는 이 모델의 한국어 발음 변환이 동작하지 않음)
사용: python demo/tts.py  → demo/raw/voice/NN.wav + manifest.json(제목 → 파일·길이)
"""
import json
import os
import sys
from pathlib import Path

import sherpa_onnx
import soundfile as sf

HERE = Path(__file__).resolve().parent
MODEL = Path(os.getenv("TTS_MODEL_DIR", HERE / "tts_model" / "vits-mimic3-ko_KO-kss_low"))
OUT = HERE / "raw" / "voice"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    # 32차: 말 빠르기 1.05 → 1.0(제출 장면 순서로 다시 짜며 5분 미만을 지키려고). 더 느리게 들으려면 TTS_LENGTH=1.05
    cfg = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(vits=sherpa_onnx.OfflineTtsVitsModelConfig(
        model=str(MODEL / "ko_KO-kss_low.onnx"), tokens=str(MODEL / "tokens.txt"), data_dir=str(MODEL / "espeak-ng-data"),
        noise_scale=0.333, length_scale=float(os.getenv("TTS_LENGTH", "1.0"))), num_threads=2))
    tts = sherpa_onnx.OfflineTts(cfg)
    src = json.loads((HERE / "narration_src.json").read_text(encoding="utf-8"))
    man, total = {}, 0.0
    for i, (title, text) in enumerate(src.items()):
        a = tts.generate(text, sid=0, speed=1.0)
        if not len(a.samples):
            sys.exit(f"합성 실패: {title}")
        f = OUT / f"{i:02d}.wav"
        sf.write(str(f), a.samples, a.sample_rate)
        dur = len(a.samples) / a.sample_rate
        man[title] = {"file": f.name, "dur": round(dur, 3), "text": text}
        total += dur
    (OUT / "manifest.json").write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(man)}줄, 해설 합계 {total:.1f}초")


if __name__ == "__main__":
    main()
