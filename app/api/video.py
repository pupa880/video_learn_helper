"""视频 API：本地上传、B站链接解析/秒开串流/下载、视频文件服务。"""

from __future__ import annotations

import ast
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from xml.sax.saxutils import quoteattr

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from .. import state
from ..services import bilibili, media

router = APIRouter(prefix="/api/video", tags=["video"])

ALLOWED_SUFFIX = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".flv", ".ts"}

# 串流信息中需要持久化到 meta 的键（MPD 生成、代理播放、清晰度切换共用）
_STREAM_KEYS = ("kind", "url", "video_url", "audio_url", "headers", "height",
                "vcodec", "acodec", "width", "fps", "vbr", "abr", "asr")


def _has_audio(video_id: str) -> bool:
    try:
        return state.audio_path(video_id).exists()
    except state.InvalidVideoId:
        return False


def _stream_headers(stream: dict) -> dict[str, str]:
    """取 CDN 防盗链请求头；兼容旧 meta 把 dict 存成 repr 字符串的情况。"""
    h = stream.get("headers") or {}
    if isinstance(h, str):
        try:
            h = ast.literal_eval(h)
        except Exception:
            h = {}
    return {str(k): str(v) for k, v in dict(h).items()}


class BilibiliRequest(BaseModel):
    url: str = ""
    max_height: int = 720
    page: int = 1  # 多P视频的分P序号（从 1 开始）
    video_id: str | None = None  # 串流中的视频要下载/切清晰度时复用已有 id
    audio_only: bool = False  # 只下载音频（转录用，比下载整个视频快得多）


@router.get("/list")
def list_videos():
    return {"videos": state.list_videos()}


@router.post("/upload")
async def upload_video(file: UploadFile):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_SUFFIX:
        raise HTTPException(400, f"不支持的视频格式: {suffix}")
    video_id = state.new_video_id()
    dst = state.video_dir(video_id) / f"video{suffix}"
    size = 0
    with open(dst, "wb") as f:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            f.write(chunk)
    meta = {
        "name": file.filename,
        "source": "local",
        "duration": media.get_duration(dst),
        "size": size,
    }
    state.save_meta(video_id, meta)
    return {"video_id": video_id, **meta}


@router.post("/bilibili/info")
def bilibili_info(req: BilibiliRequest):
    """解析 B站链接，返回元信息（不下载）。"""
    if not req.url:
        raise HTTPException(400, "缺少视频链接")
    return bilibili.extract_info(req.url)


@router.post("/bilibili/load")
def bilibili_load(req: BilibiliRequest):
    """解析播放地址并立即返回，播放器直接串流，不下载完整视频。

    传 video_id 时复用已有视频条目（切换清晰度场景）：只更新串流地址，
    字幕、总结等数据保留。
    """
    if req.video_id:
        meta = state.load_meta(req.video_id)
        url = req.url or meta.get("url")
        if not url:
            raise HTTPException(400, "缺少视频链接")
        info = bilibili.resolve_stream(url, req.max_height)  # meta 里的 url 已带分P
        meta["stream"] = {k: info[k] for k in _STREAM_KEYS if k in info}
        if info.get("qualities"):
            meta["qualities"] = info["qualities"]
        meta["duration"] = meta.get("duration") or info.get("duration", 0)
        state.save_meta(req.video_id, meta)
        return {"video_id": req.video_id, "name": meta.get("name"), "url": meta.get("url"),
                "has_file": False, "kind": info["kind"], "height": info.get("height", 0),
                "duration": meta.get("duration", 0),
                "has_audio": _has_audio(req.video_id),
                "qualities": meta.get("qualities") or []}

    if not req.url:
        raise HTTPException(400, "缺少视频链接")
    info = bilibili.resolve_stream(req.url, req.max_height, page=req.page)
    video_id = state.new_video_id()
    meta = {
        "name": info.get("title") or "bilibili",
        "source": "bilibili",
        # 记录分P后的链接，后续拉字幕/补下载都作用于同一P
        "url": bilibili.with_page(info.get("webpage_url", req.url), req.page),
        "page": req.page,
        "uploader": info.get("uploader", ""),
        "duration": info.get("duration", 0),
        # 串流地址（会过期，仅供本次会话播放；转录等场景走下载）
        "stream": {k: info[k] for k in _STREAM_KEYS if k in info},
        "qualities": info.get("qualities") or [],
    }
    state.save_meta(video_id, meta)
    return {"video_id": video_id, "name": meta["name"], "url": meta["url"],
            "has_file": False, "kind": info["kind"], "height": info.get("height", 0),
            "duration": meta["duration"],
            "has_audio": False,
            "qualities": meta["qualities"]}


@router.post("/bilibili/download")
def bilibili_download(req: BilibiliRequest):
    """后台下载 B站视频并 remux 为 mp4，返回任务 id，轮询 /api/tasks/{id}。

    传入 video_id 时复用该视频的已存链接（串流 → 转录前补下载的场景）。
    """
    video_id = req.video_id or state.new_video_id()
    existing = state.load_meta(video_id) if req.video_id else {}
    url = existing.get("url") or req.url
    if not url:
        raise HTTPException(400, "缺少视频链接")
    task_id = state.create_task("bilibili")

    def _audio_hook(d: dict):
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            if total:
                pct = done / total * 100
                state.update_task(task_id, progress=f"下载音频中 {pct:.0f}%",
                                  percent=round(pct, 1))
            else:
                state.update_task(task_id, progress=f"下载音频中 {done / 1e6:.0f}MB")
        elif d.get("status") == "finished":
            state.update_task(task_id, progress="转换音频格式...", percent=100)

    if req.audio_only:
        # 只下载音频轨转 16k wav（转录用），不动视频流，meta 基本不变
        def _work_audio():
            bilibili.download_audio(url, state.video_dir(video_id),
                                    progress_hook=_audio_hook, page=req.page)
            meta = state.load_meta(video_id)
            meta["has_audio"] = True
            state.save_meta(video_id, meta)
            return {"video_id": video_id, "audio_only": True}

        state.run_in_thread(task_id, _work_audio)
        return {"task_id": task_id}

    def _work():
        meta = dict(existing)
        if not meta:
            state.update_task(task_id, progress="解析链接...")
            info = bilibili.extract_info(url)
            name = info.get("title") or "bilibili"
            parts = info.get("parts") or []
            if req.page > 1 and len(parts) >= req.page:
                name = f"{name} P{req.page} {parts[req.page - 1]['title']}"
            meta = {
                "name": name,
                "source": "bilibili",
                "url": bilibili.with_page(info.get("webpage_url", url), req.page),
                "page": req.page,
                "uploader": info.get("uploader", ""),
            }

        def hook(d: dict):
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                done = d.get("downloaded_bytes") or 0
                if total:
                    pct = done / total * 100
                    state.update_task(task_id, progress=f"下载中 {pct:.0f}%",
                                      percent=round(pct, 1))
                else:
                    state.update_task(task_id, progress=f"下载中 {done / 1e6:.0f}MB")
            elif d.get("status") == "finished":
                state.update_task(task_id, progress="合并音视频...", percent=100)

        out = bilibili.download_and_remux(url, state.video_dir(video_id),
                                          req.max_height, progress_hook=hook,
                                          page=req.page)
        meta["duration"] = meta.get("duration") or media.get_duration(out)
        state.save_meta(video_id, meta)
        return {"video_id": video_id, "name": meta.get("name"), "has_file": True}

    state.run_in_thread(task_id, _work)
    return {"task_id": task_id}


def _proxy_muxed(stream: dict, range_header: str | None) -> StreamingResponse:
    """音视频合并单流：透传 Range 转发，浏览器可随意拖动进度。"""
    headers = _stream_headers(stream)
    if range_header:
        headers["Range"] = range_header
    client = httpx.Client(follow_redirects=True, timeout=30)
    resp = client.send(client.build_request("GET", stream["url"], headers=headers),
                       stream=True)
    out_headers = {}
    for h in ("content-length", "content-range", "content-type"):
        if h in resp.headers:
            out_headers[h] = resp.headers[h]
    out_headers["Accept-Ranges"] = "bytes"

    def gen():
        try:
            yield from resp.iter_bytes(64 * 1024)
        finally:
            resp.close()
            client.close()

    return StreamingResponse(gen(), status_code=resp.status_code,
                             headers=out_headers,
                             media_type=resp.headers.get("content-type", "video/mp4"))


def _stream_dash(stream: dict) -> StreamingResponse:
    """DASH 双轨：ffmpeg 实时混流为 fragmented mp4（只解封装不转码）。

    无需等下载即可播放；代价是只能顺序播，最多拖到已缓冲的位置。
    （保留作备用，前端实际走 HLS。）
    """
    hdr = "".join(f"{k}: {v}\r\n" for k, v in _stream_headers(stream).items())
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-headers", hdr, "-i", stream["video_url"],
        "-headers", hdr, "-i", stream["audio_url"],
        "-c", "copy", "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def gen():
        try:
            while True:
                # read1：有多少吐多少，避免 read() 等满缓冲区导致首字节迟迟不下发
                chunk = proc.stdout.read1(64 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            proc.kill()

    return StreamingResponse(gen(), media_type="video/mp4")


# ---------- DASH 双轨直读：MPD 清单 + 分片代理（浏览器 dash.js 随拖随播） ----------

# 分片代理由 dash.js 高频调用（每次取几秒），复用一个 client 避免反复建连
_seg_client = httpx.Client(follow_redirects=True, timeout=30)


def _fmt_fps(fps: float) -> str:
    return f"{fps:.3f}".rstrip("0").rstrip(".")


def _build_mpd(video_id: str, meta: dict, stream: dict) -> str:
    """为双轨串流生成 MPD 清单（on-demand profile，SegmentBase + sidx）。

    分片索引不写在清单里：B站 m4s 自带 sidx 索引盒，dash.js 会经代理发
    Range 请求自行读取。BaseURL 指向本站代理，防盗链头在代理侧附加。
    """
    dur = float(meta.get("duration") or 0)
    vcodec = stream.get("vcodec") or "avc1"
    acodec = stream.get("acodec") or "mp4a.40.2"
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    vbr = int(stream.get("vbr") or 0) or 1_000_000
    abr = int(stream.get("abr") or 0) or 128_000
    fps = float(stream.get("fps") or 0)
    asr = int(stream.get("asr") or 0)
    base = f"/api/video/{video_id}/segment"
    size_attrs = f' width="{width}" height="{height}"' if width and height else ""
    fps_attr = f' frameRate="{_fmt_fps(fps)}"' if fps else ""
    asr_attr = f' audioSamplingRate="{asr}"' if asr else ""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
     mediaPresentationDuration="PT{dur:.3f}S" minBufferTime="PT2S"
     profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video" segmentAlignment="true">
      <Representation id="v" codecs={quoteattr(vcodec)} bandwidth="{vbr}"{size_attrs}{fps_attr}>
        <BaseURL>{base}?track=video</BaseURL>
        <SegmentBase/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" contentType="audio" segmentAlignment="true">
      <Representation id="a" codecs={quoteattr(acodec)} bandwidth="{abr}"{asr_attr}>
        <BaseURL>{base}?track=audio</BaseURL>
        <SegmentBase/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
"""


def _refresh_stream(video_id: str) -> dict | None:
    """CDN 地址过期（403）时按已存链接重新解析，回写 meta。返回新 stream 或 None。"""
    meta = state.load_meta(video_id)
    url = meta.get("url")  # 已带分P参数
    if not url:
        return None
    old = meta.get("stream") or {}
    try:
        info = bilibili.resolve_stream(url, int(old.get("height") or 720))
    except Exception:
        return None
    if info.get("kind") != "dash":
        return None
    meta["stream"] = {k: info[k] for k in _STREAM_KEYS if k in info}
    state.save_meta(video_id, meta)
    return meta["stream"]


@router.get("/{video_id}/manifest.mpd")
def dash_manifest(video_id: str):
    meta = state.load_meta(video_id)
    stream = meta.get("stream")
    if not stream or stream.get("kind") != "dash":
        raise HTTPException(404, "该视频不是 DASH 串流")
    return Response(_build_mpd(video_id, meta, stream),
                    media_type="application/dash+xml",
                    headers={"Cache-Control": "no-store"})


@router.get("/{video_id}/segment")
def dash_segment(video_id: str, track: str, request: Request):
    """透传代理单条轨（video/audio）的字节范围请求；遇 403 先刷新过期地址重试一次。"""
    meta = state.load_meta(video_id)
    stream = meta.get("stream")
    if not stream or stream.get("kind") != "dash":
        raise HTTPException(404, "该视频不是 DASH 串流")
    range_header = request.headers.get("range")

    def _fetch(st: dict) -> httpx.Response:
        url = st["video_url"] if track == "video" else st.get("audio_url")
        if not url:
            raise HTTPException(404, "轨道地址不可用")
        headers = _stream_headers(st)
        if range_header:
            headers["Range"] = range_header
        return _seg_client.send(_seg_client.build_request("GET", url, headers=headers),
                                stream=True)

    resp = _fetch(stream)
    if resp.status_code == 403:
        resp.close()
        fresh = _refresh_stream(video_id)
        if not fresh:
            raise HTTPException(502, "串流地址已过期且刷新失败，请重新加载视频")
        resp = _fetch(fresh)
    if resp.status_code not in (200, 206):
        resp.close()
        raise HTTPException(resp.status_code, "CDN 分片请求失败")

    out_headers = {}
    for h in ("content-length", "content-range", "content-type"):
        if h in resp.headers:
            out_headers[h] = resp.headers[h]
    out_headers["Accept-Ranges"] = "bytes"
    out_headers["Cache-Control"] = "no-store"

    def gen():
        try:
            yield from resp.iter_bytes(64 * 1024)
        finally:
            resp.close()

    return StreamingResponse(gen(), status_code=resp.status_code, headers=out_headers)


# ---------- DASH → HLS 实时混流（浏览器可拖动进度） ----------

_hls_procs: dict[str, subprocess.Popen] = {}
_hls_lock = threading.Lock()


def _hls_dir(video_id: str) -> Path:
    return state.video_dir(video_id) / "hls"


def _hls_complete(hls_dir: Path) -> bool:
    """播放列表含 ENDLIST 即混流已全部完成，可直接当静态文件服务。"""
    pl = hls_dir / "index.m3u8"
    return pl.exists() and "#EXT-X-ENDLIST" in pl.read_text("utf-8", errors="ignore")


def _ensure_hls(video_id: str, stream: dict) -> None:
    """保证该视频的 HLS 混流在进行中或已完成。

    串流地址的清晰度变化时（切换清晰度）废弃旧目录重起混流。
    直接一条 ffmpeg 把两条 m4s 按 keyframe 切成 ts 分片写盘：
    首个分片生成后即可开播（几秒），边产边播，可拖动到已产出的任意位置。
    """
    with _hls_lock:
        hls_dir = _hls_dir(video_id)
        height = str(stream.get("height") or 0)
        marker = hls_dir / "height"
        if hls_dir.exists():
            if _hls_complete(hls_dir) and marker.exists() and marker.read_text() == height:
                return  # 已完成且清晰度未变，纯缓存
            proc = _hls_procs.get(video_id)
            if proc and proc.poll() is None \
                    and marker.exists() and marker.read_text() == height:
                return  # 正在混流
            if proc:
                proc.kill()
            shutil.rmtree(hls_dir, ignore_errors=True)
        hls_dir.mkdir(parents=True, exist_ok=True)
        marker.write_text(height)
        hdr = "".join(f"{k}: {v}\r\n" for k, v in _stream_headers(stream).items())
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-headers", hdr, "-i", stream["video_url"],
            "-headers", hdr, "-i", stream["audio_url"],
            "-map", "0:v", "-map", "1:a", "-c", "copy",
            "-f", "hls", "-hls_time", "6", "-hls_list_size", "0",
            "-hls_playlist_type", "event",
            "-hls_segment_filename", str(hls_dir / "seg_%05d.ts"),
            str(hls_dir / "index.m3u8"),
        ]
        _hls_procs[video_id] = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


@router.get("/{video_id}/hls/index.m3u8")
def hls_playlist(video_id: str):
    """DASH 视频的 HLS 播放列表；首个分片未就绪时短暂等待（ffmpeg 启动 + 首个 keyframe 切点）。"""
    stream = state.load_meta(video_id).get("stream")
    if not stream or stream.get("kind") != "dash":
        raise HTTPException(404, "该视频不是 DASH 串流")
    _ensure_hls(video_id, stream)
    pl = _hls_dir(video_id) / "index.m3u8"
    deadline = time.time() + 30
    while time.time() < deadline:
        if pl.exists() and ".ts" in pl.read_text("utf-8", errors="ignore"):
            return FileResponse(pl, media_type="application/vnd.apple.mpegurl",
                                headers={"Cache-Control": "no-store"})
        if (proc := _hls_procs.get(video_id)) and proc.poll() not in (None, 0):
            raise HTTPException(502, "串流混流失败（地址可能已过期，请重新加载视频）")
        time.sleep(0.5)
    raise HTTPException(504, "混流启动超时，请重试")


@router.get("/{video_id}/hls/{segment}")
def hls_segment(video_id: str, segment: str):
    if not re.fullmatch(r"seg_\d+\.ts", segment):
        raise HTTPException(404, "分片不存在")
    p = _hls_dir(video_id) / segment
    if not p.exists():
        raise HTTPException(404, "分片不存在")
    return FileResponse(p, media_type="video/mp2t")


@router.get("/{video_id}/file")
def video_file(video_id: str, request: Request):
    p = state.video_path(video_id)
    if p:
        return FileResponse(p)
    # 无本地文件：B站串流模式，直接代理播放地址
    stream = state.load_meta(video_id).get("stream")
    if not stream:
        raise HTTPException(404, "视频不存在")
    if stream.get("kind") == "muxed" and stream.get("url"):
        return _proxy_muxed(stream, request.headers.get("range"))
    if stream.get("kind") == "dash":
        return _stream_dash(stream)
    raise HTTPException(404, "串流地址不可用，请重新加载")
