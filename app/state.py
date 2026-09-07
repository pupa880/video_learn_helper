"""用户库与后台任务。

每条视频在 ``data/videos/<id>/``：
- ``meta.json``      列表信息、播放进度、串流地址
- ``subtitles.json`` 字幕
- ``summary.txt``    视频总结
- ``chat.json``      问答历史
- ``video.*``        本地上传或 B站 remux 的媒体
- ``audio.wav``      转录用 16kHz 单声道音频
- ``hls/``           DASH→HLS 混流分片
布局、倍速、字幕开关等 UI 状态仍由浏览器 localStorage 保存。
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


def _ts(value: Any, default: float | None = None) -> float:
    """把毫秒/秒时间戳统一成秒。"""
    if value in (None, ""):
        return time.time() if default is None else default
    try:
        n = float(value)
    except (TypeError, ValueError):
        return time.time() if default is None else default
    return n / 1000.0 if n > 1e12 else n


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


def patch_meta(video_id: str, **fields: Any) -> dict[str, Any]:
    meta = load_meta(video_id)
    for key, value in fields.items():
        if value is None:
            continue
        meta[key] = value
    save_meta(video_id, meta)
    return meta


def touch_video(video_id: str) -> dict[str, Any]:
    return patch_meta(video_id, updated_at=time.time())


def public_video(video_id: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """列表/详情用的用户库记录（不含字幕、对话正文）。"""
    video_id = _check_video_id(video_id)
    meta = meta if meta is not None else load_meta(video_id)
    stream = meta.get("stream") or {}
    d = VIDEOS_DIR / video_id
    return {
        "id": video_id,
        "name": meta.get("name") or video_id,
        "source": meta.get("source"),
        "url": meta.get("url") or "",
        "page": meta.get("page") or 1,
        "uploader": meta.get("uploader") or "",
        "upload_date": meta.get("upload_date") or "",
        "duration": meta.get("duration") or 0,
        "position": float(meta.get("position") or 0),
        "updated_at": _ts(meta.get("updated_at"), d.stat().st_mtime if d.exists() else 0),
        "has_file": video_path(video_id) is not None,
        "has_audio": audio_path(video_id).exists(),
        "has_subtitles": (d / "subtitles.json").exists(),
        "has_chat": (d / "chat.json").exists(),
        "kind": stream.get("kind") or meta.get("kind"),
        "height": stream.get("height") or meta.get("height") or 0,
        "qualities": meta.get("qualities") or [],
    }


def list_videos() -> list[dict[str, Any]]:
    out = []
    if not VIDEOS_DIR.exists():
        return out
    for d in VIDEOS_DIR.iterdir():
        if not d.is_dir() or not _VIDEO_ID_RE.fullmatch(d.name):
            continue
        meta = load_meta(d.name)
        if not meta:
            continue
        out.append(public_video(d.name, meta))
    out.sort(key=lambda v: v.get("updated_at") or 0, reverse=True)
    return out


def import_library_item(item: dict[str, Any]) -> dict[str, Any]:
    """把浏览器用户库的一条记录写入磁盘（有则合并）。"""
    video_id = check_video_id(item["id"]) if item.get("id") else new_video_id()
    meta = load_meta(video_id)
    for key in ("name", "source", "url", "page", "uploader", "upload_date",
                "duration", "kind", "height", "qualities"):
        if item.get(key) not in (None, ""):
            meta[key] = item[key]
    if item.get("position") is not None:
        meta["position"] = float(item.get("position") or 0)
    if item.get("updated_at") is not None or item.get("updatedAt") is not None:
        meta["updated_at"] = _ts(item.get("updated_at", item.get("updatedAt")))
    else:
        meta.setdefault("updated_at", time.time())
    created = item.get("created_at", item.get("createdAt"))
    if created is not None:
        meta.setdefault("created_at", _ts(created))
    save_meta(video_id, meta)
    cues_raw = item.get("cues") or []
    if cues_raw:
        save_subtitles(video_id, [Cue(**c) if not isinstance(c, Cue) else c for c in cues_raw])
    if item.get("summary"):
        save_summary(video_id, item["summary"])
    messages = item.get("messages")
    if messages:
        save_chat(video_id, messages)
    return public_video(video_id)


def remove_video(video_id: str) -> None:
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


def save_summary(video_id: str, summary: str | None) -> None:
    p = video_dir(video_id) / "summary.txt"
    if not summary:
        p.unlink(missing_ok=True)
        return
    p.write_text(summary, "utf-8")


def load_chat(video_id: str) -> list[dict[str, Any]]:
    p = VIDEOS_DIR / _check_video_id(video_id) / "chat.json"
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text("utf-8"))
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and isinstance(data.get("messages"), list):
            return data["messages"]
    except Exception:
        return []
    return []


def save_chat(video_id: str, messages: list[dict[str, Any]] | None) -> None:
    p = video_dir(video_id) / "chat.json"
    if not messages:
        p.unlink(missing_ok=True)
        return
    p.write_text(json.dumps(messages, ensure_ascii=False), "utf-8")


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
