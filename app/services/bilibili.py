"""yt-dlp 封装：B站链接解析、双轨下载 + ffmpeg remux 缓存、官方字幕拉取。"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import yt_dlp

from .. import config as app_config
from . import media


class BilibiliError(RuntimeError):
    pass


def _ydl_opts(**extra) -> dict[str, Any]:
    opts: dict[str, Any] = {"quiet": True, "no_warnings": True, "noplaylist": True}
    cookiefile = app_config.cookies_path()
    if cookiefile:
        opts["cookiefile"] = cookiefile
    opts.update(extra)
    return opts


def page_from_url(url: str) -> int:
    """从链接里读 ``p`` 分P序号，缺省为 1。"""
    m = re.search(r"[?&]p=(\d+)", url or "")
    return int(m.group(1)) if m else 1


def with_page(url: str, page: int) -> str:
    """给 B站链接补或替换 ``?p=N`` 分P参数（page<=1 时原样返回，不剥已有 p=）。"""
    if page <= 1:
        return url
    parsed = urlparse(url)
    qs = parse_qs(parsed.query, keep_blank_values=True)
    qs["p"] = [str(page)]
    return urlunparse(parsed._replace(query=urlencode(qs, doseq=True)))


def extract_info(url: str) -> dict[str, Any]:
    """解析链接，返回元信息（title/duration/uploader/可用清晰度/分P列表）。

    多P视频（合集）会枚举所有分P，``parts`` 非空；单P视频 ``parts`` 为空。
    """
    opts = _ydl_opts(skip_download=True)
    opts["noplaylist"] = False  # 需要枚举分P
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:
        raise BilibiliError(f"链接解析失败: {exc}") from exc
    parts: list[dict[str, Any]] = []
    requested_page = page_from_url(url)
    if info.get("_type") == "playlist" and info.get("entries"):
        entries = [e for e in info["entries"] if e]
        parts = [
            {"page": i + 1, "title": e.get("title", ""), "duration": e.get("duration") or 0}
            for i, e in enumerate(entries)
        ]
        main_title = info.get("title", "")  # 多P时主标题在 playlist 层
        # 链接带 ?p=N 时用对应分P 的清晰度/时长，而不是永远取 P1
        idx = min(max(requested_page, 1), len(entries)) - 1
        info = entries[idx]
    else:
        main_title = ""
    heights = sorted({
        f.get("height") for f in info.get("formats", [])
        if f.get("vcodec") not in (None, "none") and f.get("height")
    })
    return {
        "title": main_title or info.get("title", ""),
        "duration": info.get("duration", 0),
        "uploader": info.get("uploader", ""),
        "upload_date": upload_date_of(info),
        "webpage_url": info.get("webpage_url", url),
        "bvid": _extract_bvid(info.get("webpage_url", url)),
        "heights": heights,
        "qualities": _extract_qualities(info),
        "has_subtitles": bool(info.get("subtitles")),
        "parts": parts,
        "page": requested_page if parts else 1,
    }


def upload_date_of(info: dict) -> str:
    """yt-dlp 的 upload_date（YYYYMMDD）或 timestamp → ``YYYY-MM-DD``；没有则空串。"""
    raw = info.get("upload_date")
    if raw and re.fullmatch(r"\d{8}", str(raw)):
        s = str(raw)
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    ts = info.get("timestamp") or info.get("release_timestamp")
    if ts:
        try:
            return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%d")
        except (TypeError, ValueError, OSError, OverflowError):
            return ""
    return ""


def _extract_bvid(url: str) -> str | None:
    m = re.search(r"(BV[a-zA-Z0-9]+)", url or "")
    return m.group(1) if m else None


# B站清晰度档位（qn）→ 显示名。同一档位的实际像素高度随视频宽高比变化
# （如 480P 档在窄画面上只有 312px 高），所以展示名必须按 qn 取，不能按 height。
# qn 取自 avc/hev 的 300xx 格式 id（30032 → qn 32 → 480P）。
QN_LABELS = {
    6: "240P", 16: "360P", 32: "480P", 64: "720P", 74: "720P60",
    80: "1080P", 112: "1080P+", 116: "1080P60", 120: "4K", 127: "8K",
}


def _extract_qualities(info: dict) -> list[dict[str, Any]]:
    """从 formats 提取清晰度档位：[{"height": 实际像素高, "label": "480P"}]，升序。"""
    by_height: dict[int, str | None] = {}
    for f in info.get("formats", []):
        if f.get("vcodec") in (None, "none") or not f.get("height"):
            continue
        fid = str(f.get("format_id") or "")
        qn = int(fid) % 1000 if fid.isdigit() else 0
        label = QN_LABELS.get(qn)
        h = f["height"]
        # 同高度有 avc/hev/av1 多个格式，只有 300xx id 能给出正确档位名
        if h not in by_height or (label and not by_height[h]):
            by_height[h] = label
    return [
        {"height": h, "label": by_height[h] or f"{h}P"}
        for h in sorted(by_height)
    ]


def resolve_stream(url: str, max_height: int = 720, page: int = 1) -> dict[str, Any]:
    """解析出可直接播放的流地址（不下载）。

    返回 ``kind`` 为 ``muxed``（单流，可直接代理并支持拖动）或
    ``dash``（视频轨 + 音频轨，由 ffmpeg 实时混流）。``page`` 指定分P。
    """
    url = with_page(url, page)
    try:
        with yt_dlp.YoutubeDL(_ydl_opts(skip_download=True)) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:
        raise BilibiliError(f"链接解析失败: {exc}") from exc
    if info.get("_type") == "playlist" and info.get("entries"):
        info = info["entries"][0]
    formats = info.get("formats", [])
    base = {
        "title": info.get("title", ""),
        "duration": info.get("duration", 0),
        "uploader": info.get("uploader", ""),
        "upload_date": upload_date_of(info),
        "webpage_url": info.get("webpage_url", url),
        "bvid": _extract_bvid(info.get("webpage_url", url)),
        "has_subtitles": bool(info.get("subtitles")),
        "max_height": max_height,
        "qualities": _extract_qualities(info),
    }
    default_headers = info.get("http_headers") or {}

    def headers_of(f: dict) -> dict[str, str]:
        return {k: str(v) for k, v in (f.get("http_headers") or default_headers).items()}

    # 优先音视频合并的单流（可直接代理，支持 Range 拖动）
    muxed = [f for f in formats
             if f.get("url")
             and f.get("vcodec") not in (None, "none")
             and f.get("acodec") not in (None, "none")
             and (f.get("height") or 0) <= max_height]
    if muxed:
        best = max(muxed, key=lambda f: (f.get("height") or 0, f.get("tbr") or 0))
        return {**base, "kind": "muxed", "url": best["url"],
                "headers": headers_of(best), "height": best.get("height") or 0}

    videos = [f for f in formats
              if f.get("url")
              and f.get("vcodec") not in (None, "none")
              and f.get("acodec") in (None, "none")
              and (f.get("height") or 0) <= max_height]
    audios = [f for f in formats
              if f.get("url")
              and f.get("acodec") not in (None, "none")
              and f.get("vcodec") in (None, "none")]
    if not videos or not audios:
        raise BilibiliError("未找到可播放的流地址")
    # 浏览器对 avc(H.264) 兼容性最好（hev/av1 在部分浏览器无法解码），同档位优先 avc
    pool = [f for f in videos if (f.get("vcodec") or "").startswith("avc")] or videos
    v = max(pool, key=lambda f: (f.get("height") or 0, f.get("tbr") or 0))
    a = max(audios, key=lambda f: f.get("abr") or 0)
    # vcodec/acodec/宽高/带宽等供后端生成 MPD 清单（浏览器 dash.js 直接播放双轨）
    return {**base, "kind": "dash",
            "video_url": v["url"], "audio_url": a["url"],
            "headers": headers_of(v), "height": v.get("height") or 0,
            "vcodec": v.get("vcodec") or "avc1",
            "acodec": a.get("acodec") or "mp4a.40.2",
            "width": v.get("width") or 0,
            "fps": v.get("fps") or 0,
            "vbr": int((v.get("vbr") or v.get("tbr") or 0) * 1000),
            "abr": int((a.get("abr") or a.get("tbr") or 0) * 1000),
            "asr": a.get("asr") or 0}


def _height_selector(max_height: int) -> str:
    return (
        f"bv[height<={max_height}]+ba/bv+ba/b"
    )


def download_and_remux(url: str, out_dir: str | Path, max_height: int = 720,
                       progress_hook=None, page: int = 1) -> Path:
    """下载 B站 DASH 双轨并 remux 为单个 mp4，返回缓存文件路径。

    yt-dlp 直接以 ``bv+ba`` 格式下载并用 ffmpeg 合并输出 mp4。
    ``progress_hook`` 透传 yt-dlp 的进度回调（上报下载百分比用）。
    ``page`` 指定分P。
    """
    url = with_page(url, page)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_tmpl = str(out_dir / "video.%(ext)s")
    opts = _ydl_opts(
        format=_height_selector(max_height),
        outtmpl=out_tmpl,
        merge_output_format="mp4",
    )
    if progress_hook:
        opts["progress_hooks"] = [progress_hook]
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as exc:
        raise BilibiliError(f"视频下载失败: {exc}") from exc
    out_path = out_dir / "video.mp4"
    if not out_path.exists():
        # yt-dlp 合并失败或命名不同时兜底查找
        candidates = sorted(out_dir.glob("video.*"), key=lambda p: p.stat().st_mtime)
        if not candidates:
            raise BilibiliError("下载完成但未找到输出文件")
        out_path = candidates[-1]
    return out_path


def download_audio(url: str, out_dir: str | Path,
                   progress_hook=None, page: int = 1) -> Path:
    """只下载音频轨并转为 16kHz 单声道 wav（转录用，比下载整个视频快得多）。"""
    url = with_page(url, page)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    opts = _ydl_opts(format="ba/b", outtmpl=str(out_dir / "audio_src.%(ext)s"))
    if progress_hook:
        opts["progress_hooks"] = [progress_hook]
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.extract_info(url, download=True)
    except Exception as exc:
        raise BilibiliError(f"音频下载失败: {exc}") from exc
    candidates = sorted(out_dir.glob("audio_src.*"), key=lambda p: p.stat().st_mtime)
    if not candidates:
        raise BilibiliError("下载完成但未找到音频文件")
    out = out_dir / "audio.wav"
    media.extract_audio(candidates[-1], out)
    for p in candidates:
        p.unlink(missing_ok=True)
    return out


_WIND_CONTROL_RE = re.compile(
    r"风控|拦截|[-]412|\b412\b|precondition failed|risk control|too many requests|频繁",
    re.I,
)
_LOGIN_RE = re.compile(
    r"未登录|[-]101|\blogin\b|unauthorized|cookie.*invalid|invalid.*cookie|expired",
    re.I,
)


def classify_subtitle_error(message: str, has_cookies: bool) -> str:
    """把字幕失败原因说清楚：缺 cookies、cookies 失效、还是接口风控。"""
    text = (message or "").strip()
    wind = bool(_WIND_CONTROL_RE.search(text))
    login = bool(_LOGIN_RE.search(text))
    if wind:
        if has_cookies:
            return "官方字幕拉取失败：接口风控（请求被拦截）。请稍后再试。"
        return (
            "官方字幕拉取失败：接口风控（请求被拦截）。"
            "未上传 cookies 时更容易触发，请先在设置中上传 cookies.txt。"
        )
    if not has_cookies:
        return "官方字幕拉取失败：未上传 B站 cookies。请在设置中上传 cookies.txt 后再试。"
    if login:
        return "官方字幕拉取失败：cookies 无效或已过期，请重新上传。"
    if text:
        return f"官方字幕拉取失败：{text}"
    return "官方字幕拉取失败：未知原因。"


def _parse_subtitle_formats(ydl, formats: list) -> list:
    """从 yt-dlp 的某种语言字幕 formats 里解析出 Cue 列表。失败抛错，不吞掉原因。"""
    from .subtitle import parse_bilibili_subtitle, parse_srt

    inline = next((f for f in formats if f.get("data")), None)
    if inline:
        return parse_srt(inline["data"])

    chosen = next(
        (f for f in formats if f.get("ext") in ("json", "json3") and f.get("url")),
        next((f for f in formats if f.get("url")), None),
    )
    if not chosen:
        return []

    url = chosen["url"]
    headers = chosen.get("http_headers") or {}
    if headers:
        import urllib.request
        raw = ydl.urlopen(urllib.request.Request(url, headers=headers)).read()
    else:
        raw = ydl.urlopen(url).read()
    text = raw.decode("utf-8", errors="replace")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return parse_srt(text)

    if isinstance(data, dict) and "body" not in data:
        code = data.get("code")
        if code not in (0, None):
            msg = data.get("message") or data.get("msg") or ""
            raise RuntimeError(f"{code} {msg}".strip())
    if isinstance(data, dict) and "body" in data:
        return parse_bilibili_subtitle(data)
    return []


def fetch_subtitles(url: str) -> dict[str, list]:
    """拉取官方字幕，返回 ``{语言: [Cue...]}``。

    新版 yt-dlp 把 B站字幕以内联 SRT 文本（``data`` 字段）返回；
    旧版给 json/json3 下载地址，两种形态都兼容。下载走 yt-dlp 会话，以便带上 cookies。
    """
    has_cookies = bool(app_config.cookies_path())
    try:
        with yt_dlp.YoutubeDL(_ydl_opts(skip_download=True, writesubtitles=True)) as ydl:
            info = ydl.extract_info(url, download=False)
            if info.get("_type") == "playlist" and info.get("entries"):
                info = info["entries"][0]

            subs = info.get("subtitles") or {}
            if not subs:
                if not has_cookies:
                    raise BilibiliError(
                        "官方字幕拉取失败：未上传 B站 cookies。请在设置中上传 cookies.txt 后再试。"
                    )
                raise BilibiliError("该视频没有可用的官方字幕。")

            result: dict[str, list] = {}
            errors: list[str] = []
            for lang, formats in subs.items():
                try:
                    cues = _parse_subtitle_formats(ydl, formats or [])
                except Exception as exc:
                    errors.append(f"{lang}: {exc}")
                    continue
                if cues:
                    result[lang] = cues
            if not result:
                detail = "; ".join(errors) if errors else "字幕内容为空"
                raise BilibiliError(classify_subtitle_error(detail, has_cookies))
            return result
    except BilibiliError:
        raise
    except Exception as exc:
        raise BilibiliError(classify_subtitle_error(str(exc), has_cookies)) from exc
