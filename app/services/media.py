"""ffmpeg 封装：抽音频、切片、remux、取时长。"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path


class FFmpegError(RuntimeError):
    pass


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FFmpegError(f"{' '.join(cmd[:3])}... failed: {proc.stderr[-500:]}")
    return proc


def get_duration(video_path: str | Path) -> float:
    """用 ffprobe 取媒体时长（秒），失败返回 0。"""
    proc = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(video_path)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return 0.0
    try:
        return float(json.loads(proc.stdout)["format"]["duration"])
    except Exception:
        return 0.0


def extract_audio(video_path: str | Path, out_wav: str | Path) -> Path:
    """抽出 16kHz 单声道 wav（供 VAD/ASR 使用）。"""
    out_wav = Path(out_wav)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    _run([
        "ffmpeg", "-y", "-i", str(video_path),
        "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", str(out_wav),
    ])
    return out_wav


def slice_audio(wav_path: str | Path, start: float, end: float, out_wav: str | Path) -> Path:
    """按时间段从 16k wav 切片。"""
    out_wav = Path(out_wav)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    _run([
        "ffmpeg", "-y", "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
        "-i", str(wav_path), "-ac", "1", "-ar", "16000", "-f", "wav", str(out_wav),
    ])
    return out_wav


def remux(video_path: str | Path, audio_path: str | Path, out_mp4: str | Path) -> Path:
    """B站 DASH 双轨 remux 为单个 mp4（-c copy，不转码）。"""
    out_mp4 = Path(out_mp4)
    out_mp4.parent.mkdir(parents=True, exist_ok=True)
    _run([
        "ffmpeg", "-y",
        "-i", str(video_path), "-i", str(audio_path),
        "-c", "copy", "-movflags", "+faststart", str(out_mp4),
    ])
    return out_mp4
