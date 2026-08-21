"""视频工作缓存与后台任务。

用户库（列表、字幕、总结、对话、本地文件）在浏览器 IndexedDB/OPFS。
后端 ``data/videos/<id>/`` 只是算力/代理用的临时缓存：
- ``video.*``   转录前暂存的媒体（本地文件上传或 B站 remux）
- ``audio.wav`` ffmpeg 抽出的 16kHz 单声道音频（转录用）
- ``meta.json`` 串流地址、清晰度等（CDN 直链会过期）
- ``hls/``      DASH→HLS 混流分片
旧版写入的 ``subtitles.json`` / ``summary.txt`` 仅供一次性迁到前端。
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


def check_video_id(video_id: str) -> str:
    """校验 video_id（12 位 hex），非法则抛 InvalidVideoId。"""
    if not _VIDEO_ID_RE.fullmatch(video_id or ""):
        raise InvalidVideoId("非法视频 id")
    return video_id


def _check_video_id(video_id: str) -> str:
    return check_video_id(video_id)


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
            "page": meta.get("page") or 1,
            "uploader": meta.get("uploader") or "",
            "upload_date": meta.get("upload_date") or "",
            "duration": meta.get("duration") or 0,
            "has_file": has_file,
            "has_audio": has_audio,
            "kind": stream.get("kind"),
            "height": stream.get("height") or 0,
            "qualities": meta.get("qualities") or [],
        })
    return out


def export_library() -> list[dict[str, Any]]:
    """旧版磁盘用户库快照（含字幕/总结），供前端一次性迁入 IndexedDB。"""
    items = []
    for v in list_videos():
        vid = v["id"]
        items.append({
            **v,
            "cues": [c.to_dict() for c in load_subtitles(vid)],
            "summary": load_summary(vid),
        })
    return items


def remove_video(video_id: str) -> None:
    """删除该 id 的工作缓存目录（用户库由前端删除）。"""
    d = VIDEOS_DIR / _check_video_id(video_id)
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)


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
