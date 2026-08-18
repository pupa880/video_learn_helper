"""转录 API：非实时（整段）/ 实时（按播放进度增量），SSE 推送进度与字幕。"""

from __future__ import annotations

import json
import queue
import threading
from pathlib import Path
from typing import Any, Generator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import config as app_config
from .. import state
from ..services import media
from ..services.subtitle import Cue

router = APIRouter(prefix="/api/transcribe", tags=["transcribe"])

# task_id -> {"events": Queue, "position": float, "stop": bool}
_sessions: dict[str, dict[str, Any]] = {}
_sessions_lock = threading.Lock()

_asr_cache: dict[tuple, Any] = {}
_vad_instance = None
_model_lock = threading.Lock()

WINDOW_S = 30.0  # 实时转录每次向后切 30s 窗口做 VAD


class StartRequest(BaseModel):
    video_id: str
    mode: str = "full"  # full / realtime
    start_position: float = 0.0


class PositionReport(BaseModel):
    task_id: str
    position: float


class StopRequest(BaseModel):
    task_id: str


def _get_asr():
    cfg = app_config.load_config()["asr"]
    key = (cfg["model"], cfg["device"], cfg.get("whisper_model", "small"))
    with _model_lock:
        if key not in _asr_cache:
            from ..services.asr.base import create_asr
            _asr_cache[key] = create_asr(cfg["model"], cfg["device"], cfg.get("whisper_model", "small"))
        return _asr_cache[key]


def _get_vad():
    global _vad_instance
    with _model_lock:
        if _vad_instance is None:
            from ..services.vad.silero import SileroVAD
            _vad_instance = SileroVAD()
        return _vad_instance


def _ensure_audio(video_id: str) -> Path:
    wav = state.audio_path(video_id)
    if not wav.exists():
        video = state.video_path(video_id)
        if not video:
            raise RuntimeError("视频文件不存在")
        media.extract_audio(video, wav)
    return wav


def _load_audio(wav: Path):
    import soundfile as sf
    data, _sr = sf.read(str(wav), dtype="float32", always_2d=False)
    if getattr(data, "ndim", 1) > 1:
        data = data.mean(axis=1)
    return data


def _emit(task_id: str, event: dict) -> None:
    with _sessions_lock:
        sess = _sessions.get(task_id)
    if sess:
        sess["events"].put(event)


def _transcribe_full(task_id: str, video_id: str) -> None:
    """非实时：整段音频一次性转录。"""
    cfg = app_config.load_config()["asr"]
    language = cfg.get("language", "auto")
    _emit(task_id, {"type": "progress", "text": "抽取音频..."})
    wav = _ensure_audio(video_id)
    asr = _get_asr()

    _emit(task_id, {"type": "progress", "text": "模型转录中（首次运行需下载模型权重）..."})
    segments = asr.transcribe_with_timestamps(str(wav), language)
    if segments is None:
        # 模型不输出时间戳 → VAD 切段 + 逐段识别
        _emit(task_id, {"type": "progress", "text": "VAD 切分语音段..."})
        audio = _load_audio(wav)
        spans = _get_vad().detect(audio)
        total = len(spans)
        results = []
        for i, (start, end) in enumerate(spans):
            clip = audio[int(start * 16000): int(end * 16000)]
            tmp = state.video_dir(video_id) / f"seg_{task_id}.wav"
            import soundfile as sf
            sf.write(str(tmp), clip, 16000)
            try:
                text = asr.transcribe(str(tmp), language)
            finally:
                tmp.unlink(missing_ok=True)
            if text:
                results.append((start, end, text))
            _emit(task_id, {
                "type": "progress",
                "text": f"识别中 {i + 1}/{total}",
                "percent": round((i + 1) / total * 100, 1),
            })
        segments = results

    cues = [Cue(s, e, t) for s, e, t in segments]
    state.save_subtitles(video_id, cues)
    for cue in cues:
        _emit(task_id, {"type": "cue", "cue": cue.to_dict()})
    _emit(task_id, {"type": "done", "count": len(cues)})


def _transcribe_realtime(task_id: str, video_id: str, start_position: float) -> None:
    """实时：以播放进度为锚点向前推进，逐段产出字幕。"""
    cfg = app_config.load_config()["asr"]
    language = cfg.get("language", "auto")
    _emit(task_id, {"type": "progress", "text": "抽取音频..."})
    wav = _ensure_audio(video_id)
    audio = _load_audio(wav)
    duration = len(audio) / 16000
    asr = _get_asr()
    vad = _get_vad()

    cursor = max(0.0, start_position)
    # 从当前进度开始转：保留游标之前已有的字幕，避免把官方字幕/上次结果整份覆盖掉
    existing = state.load_subtitles(video_id)
    cues = [c for c in existing if c.start < cursor]
    if len(cues) != len(existing):
        state.save_subtitles(video_id, cues)
    _emit(task_id, {"type": "progress", "text": "实时转录已启动"})

    while True:
        with _sessions_lock:
            sess = _sessions.get(task_id)
            if not sess or sess["stop"]:
                break
            position = sess["position"]
            last_pos = sess.get("_last_pos", position)
            sess["_last_pos"] = position
        # 播放进度连续推进时不要把游标往前跳：ASR 慢于实时是常态，
        # 跳过去会丢掉用户正在听的那一段。只在明显拖动进度条时跟随。
        if abs(position - last_pos) > 5.0:
            cursor = max(0.0, position)
            cues[:] = [c for c in cues if c.start < cursor]
            state.save_subtitles(video_id, cues)
            _emit(task_id, {"type": "trim", "before": cursor,
                            "cues": [c.to_dict() for c in cues]})
        if cursor >= duration:
            break

        window_start = cursor
        end = min(window_start + WINDOW_S, duration)
        clip = audio[int(window_start * 16000): int(end * 16000)]
        for seg_start, seg_end in vad.detect(clip):
            abs_start, abs_end = window_start + seg_start, window_start + seg_end
            if abs_end <= window_start + 0.05:
                continue
            seg_clip = audio[int(abs_start * 16000): int(abs_end * 16000)]
            tmp = state.video_dir(video_id) / f"seg_{task_id}.wav"
            import soundfile as sf
            sf.write(str(tmp), seg_clip, 16000)
            try:
                text = asr.transcribe(str(tmp), language)
            finally:
                tmp.unlink(missing_ok=True)
            if text:
                cue = Cue(abs_start, abs_end, text)
                cues.append(cue)
                state.save_subtitles(video_id, cues)
                _emit(task_id, {"type": "cue", "cue": cue.to_dict()})
        cursor = end
        _emit(task_id, {
            "type": "progress",
            "text": f"转录游标 {cursor:.1f}s / {duration:.1f}s",
            "cursor": cursor,
            "percent": round(cursor / duration * 100, 1) if duration else 100,
        })

    _emit(task_id, {"type": "done", "count": len(cues)})


def _worker(task_id: str, video_id: str, mode: str, start_position: float) -> None:
    try:
        if mode == "realtime":
            _transcribe_realtime(task_id, video_id, start_position)
        else:
            _transcribe_full(task_id, video_id)
    except Exception as exc:
        _emit(task_id, {"type": "error", "text": str(exc)})
    finally:
        threading.Timer(300, lambda: _sessions.pop(task_id, None)).start()


@router.post("/start")
def start(req: StartRequest):
    if not app_config.asr_available():
        raise HTTPException(
            400, "未安装 ASR 依赖组，请先执行: uv sync --extra asr"
        )
    if not state.video_path(req.video_id) and not state.audio_path(req.video_id).exists():
        if state.load_meta(req.video_id).get("stream"):
            raise HTTPException(400, "转录需要音频文件：该视频当前为在线播放，请先完成音频下载")
        raise HTTPException(404, "视频不存在")
    if req.mode not in ("full", "realtime"):
        raise HTTPException(400, "mode 只能是 full 或 realtime")

    task_id = state.create_task("transcribe")
    with _sessions_lock:
        _sessions[task_id] = {
            "events": queue.Queue(),
            "position": req.start_position,
            "_last_pos": req.start_position,
            "stop": False,
        }
    threading.Thread(
        target=_worker,
        args=(task_id, req.video_id, req.mode, req.start_position),
        daemon=True,
    ).start()
    return {"task_id": task_id}


@router.get("/stream/{task_id}")
def stream(task_id: str) -> StreamingResponse:
    with _sessions_lock:
        sess = _sessions.get(task_id)
    if not sess:
        raise HTTPException(404, "转录任务不存在")

    def event_source() -> Generator[str, None, None]:
        q: queue.Queue = sess["events"]
        while True:
            try:
                event = q.get(timeout=60)
            except queue.Empty:
                yield ": keepalive\n\n"
                continue
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            if event.get("type") in ("done", "error"):
                break

    return StreamingResponse(event_source(), media_type="text/event-stream")


@router.post("/position")
def report_position(req: PositionReport):
    """实时转录中前端上报播放进度。"""
    with _sessions_lock:
        sess = _sessions.get(req.task_id)
        if sess:
            sess["position"] = req.position
    return {"ok": True}


@router.post("/stop")
def stop(req: StopRequest):
    with _sessions_lock:
        sess = _sessions.get(req.task_id)
        if sess:
            sess["stop"] = True
    return {"ok": True}
