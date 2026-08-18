"""视频会话与后台任务的集中管理。

每个视频一个目录 ``data/videos/<id>/``：
- ``video.mp4``  视频文件（本地上传或 B站 remux 缓存）
- ``audio.wav``  ffmpeg 抽出的 16kHz 单声道音频（转录用）
- ``meta.json``  元信息（名称、来源、时长、B站链接等）
- ``subtitles.json``  字幕缓存
- ``summary.txt``  AI 视频总结缓存
"""

from __future__ import annotations

import json
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from .config import DATA_DIR
from .services.subtitle import Cue

VIDEOS_DIR = DATA_DIR / "videos"
_VIDEO_ID_RE = re.compile(r"^[0-9a-f]{12}$")

_lock = threading.Lock()
_tasks: dict[str, dict[str, Any]] = {}


class InvalidVideoId(ValueError):
    """video_id 非法（防止路径穿越）。"""


def new_video_id() -> str:
    return uuid.uuid4().hex[:12]


def _check_video_id(video_id: str) -> str:
    if not _VIDEO_ID_RE.fullmatch(video_id or ""):
        raise InvalidVideoId("非法视频 id")
    return video_id


def video_dir(video_id: str) -> Path:
    d = VIDEOS_DIR / _check_video_id(video_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def video_path(video_id: str) -> Path | None:
    d = VIDEOS_DIR / _check_video_id(video_id)
    for p in d.glob("video.*"):
        if p.suffix in (".mp4", ".mkv", ".webm", ".mov", ".avi", ".flv", ".ts"):
            return p
    return None


def audio_path(video_id: str) -> Path:
    return VIDEOS_DIR / _check_video_id(video_id) / "audio.wav"


def save_meta(video_id: str, meta: dict[str, Any]) -> None:
    (video_dir(video_id) / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), "utf-8"
    )


def load_meta(video_id: str) -> dict[str, Any]:
    p = VIDEOS_DIR / _check_video_id(video_id) / "meta.json"
    if p.exists():
        try:
            return json.loads(p.read_text("utf-8"))
        except Exception:
            pass
    return {}


def list_videos() -> list[dict[str, Any]]:
    out = []
    if not VIDEOS_DIR.exists():
        return out
    for d in sorted(VIDEOS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not d.is_dir() or not _VIDEO_ID_RE.fullmatch(d.name):
            continue
        meta = load_meta(d.name)
        if not meta:
            continue
        has_file = video_path(d.name) is not None
        has_audio = audio_path(d.name).exists()
        stream = meta.get("stream") or {}
        if not has_file and meta.get("source") != "bilibili" and not stream:
            continue
        out.append({
            "id": d.name,
            "name": meta.get("name") or d.name,
            "source": meta.get("source"),
            "url": meta.get("url"),
            "duration": meta.get("duration") or 0,
            "has_file": has_file,
            "has_audio": has_audio,
            "kind": stream.get("kind"),
            "height": stream.get("height") or 0,
            "qualities": meta.get("qualities") or [],
        })
    return out


def save_subtitles(video_id: str, cues: list[Cue]) -> None:
    (video_dir(video_id) / "subtitles.json").write_text(
        json.dumps([c.to_dict() for c in cues], ensure_ascii=False), "utf-8"
    )


def load_subtitles(video_id: str) -> list[Cue]:
    p = VIDEOS_DIR / _check_video_id(video_id) / "subtitles.json"
    if not p.exists():
        return []
    try:
        return [Cue(**item) for item in json.loads(p.read_text("utf-8"))]
    except Exception:
        return []


def load_summary(video_id: str) -> str | None:
    p = VIDEOS_DIR / _check_video_id(video_id) / "summary.txt"
    return p.read_text("utf-8") if p.exists() else None


def save_summary(video_id: str, summary: str) -> None:
    (video_dir(video_id) / "summary.txt").write_text(summary, "utf-8")


# ---------- 后台任务（B站下载、转录） ----------

def create_task(kind: str) -> str:
    task_id = uuid.uuid4().hex[:12]
    with _lock:
        _tasks[task_id] = {
            "id": task_id,
            "kind": kind,
            "status": "pending",  # pending/running/done/error
            "progress": "",
            "result": None,
            "error": None,
            "created_at": time.time(),
        }
    return task_id


def update_task(task_id: str, **fields) -> None:
    with _lock:
        if task_id in _tasks:
            _tasks[task_id].update(fields)


def get_task(task_id: str) -> dict[str, Any] | None:
    with _lock:
        t = _tasks.get(task_id)
        return dict(t) if t else None


def run_in_thread(task_id: str, fn: Callable[[], Any]) -> None:
    """在后台线程执行任务，结果/异常写回任务状态。"""
    def _wrap():
        update_task(task_id, status="running")
        try:
            result = fn()
            update_task(task_id, status="done", result=result)
        except Exception as exc:
            update_task(task_id, status="error", error=str(exc))

    threading.Thread(target=_wrap, daemon=True).start()


def tail_lines(path: Path, n: int = 200) -> str:
    """读取任务日志文件末尾几行（转录进度展示用）。"""
    if not path.exists():
        return ""
    lines = path.read_text("utf-8", errors="ignore").splitlines()
    return "\n".join(lines[-n:])


def cleanup_upload(src: Path) -> None:
    try:
        src.unlink(missing_ok=True)
    except Exception:
        pass


def move_file(src: str | Path, dst: str | Path) -> None:
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
