"""24차: 녹화 영상(1부+2부)에 AI 음성 해설을 자막이 뜬 시각에 맞춰 깐다.
입력: raw/timeline_part1.json · raw/timeline_part2.json(녹화 스크립트가 기록) · raw/voice/*.wav(tts.py) · 이어 붙인 영상
출력: MP4(H.264 + AAC) · narration.json(줄마다 영상 속 시작 시각·길이 — 24차 AK09가 확인)"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"


def dur(f: Path) -> float:
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)], text=True))


def main(video: str, part1_video: str, out: str) -> None:
    d1 = dur(Path(part1_video))
    lines = []
    for part, off in (("part1", 0.0), ("part2", d1)):
        f = RAW / f"timeline_{part}.json"
        if f.exists():
            for x in json.loads(f.read_text(encoding="utf-8")):
                lines.append({**x, "at": round(x["at"] + off, 2)})
    lines = [x for x in lines if x.get("file")]
    total = dur(Path(video))
    # 앞 줄이 끝나기 전에 다음 줄이 시작하면(녹화 지연) 뒤로 민다 — 해설이 겹치지 않게
    t = 0.0
    for x in lines:
        x["at"] = round(max(x["at"], t), 2)
        t = x["at"] + x["dur"] + 0.1
    inputs, filt = ["-i", video], []
    for i, x in enumerate(lines, start=1):
        inputs += ["-i", str(RAW / "voice" / x["file"])]
        ms = int(x["at"] * 1000)
        filt.append(f"[{i}:a]aresample=44100,adelay={ms}|{ms},volume=1.8[a{i}]")
    mix = "".join(f"[a{i}]" for i in range(1, len(lines) + 1)) + f"amix=inputs={len(lines)}:normalize=0:dropout_transition=0,apad,atrim=0:{total:.2f}[aout]"
    cmd = ["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(filt + [mix]), "-map", "0:v", "-map", "[aout]",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True)
    (HERE / "narration.json").write_text(json.dumps([{k: x[k] for k in ("part", "title", "text", "at", "dur")} for x in lines], ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"해설 {len(lines)}줄 · 영상 {total:.1f}초 · 마지막 해설 끝 {lines[-1]['at'] + lines[-1]['dur']:.1f}초")


if __name__ == "__main__":
    main(*sys.argv[1:4])
