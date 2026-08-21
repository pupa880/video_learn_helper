"""字幕 API：SRT 解析、B站官方字幕拉取。结果交前端入库，后端不当事。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel

from .. import state
from ..services import bilibili
from ..services.subtitle import parse_srt

router = APIRouter(prefix="/api/subtitle", tags=["subtitle"])


class BilibiliSubtitleRequest(BaseModel):
    url: str
    lang: str | None = None  # 不指定时优先中文，否则第一种语言


@router.get("/{video_id}")
def get_subtitles(video_id: str):
    """读工作缓存里的旧字幕（迁移用）。用户库以浏览器为准。"""
    cues = state.load_subtitles(video_id)
    return {"cues": [c.to_dict() for c in cues]}


@router.post("/parse")
async def parse_srt_file(file: UploadFile):
    """解析 SRT，只返回 cues，不写盘。"""
    if not (file.filename or "").lower().endswith(".srt"):
        raise HTTPException(400, "仅支持 .srt 字幕文件")
    text = (await file.read()).decode("utf-8-sig", errors="ignore")
    try:
        cues = parse_srt(text)
    except ValueError as exc:
        raise HTTPException(400, f"SRT 解析失败: {exc}") from exc
    if not cues:
        raise HTTPException(400, "字幕文件为空")
    return {"count": len(cues), "cues": [c.to_dict() for c in cues]}


@router.post("/upload")
async def upload_srt(video_id: str, file: UploadFile):
    """兼容旧前端：解析 SRT。不再写入工作缓存。"""
    data = await parse_srt_file(file)
    return data


@router.post("/bilibili")
def bilibili_subtitle(req: BilibiliSubtitleRequest):
    """拉取 B站官方字幕（需设置面板上传 cookies）。"""
    url = (req.url or "").strip()
    if not url:
        raise HTTPException(400, "缺少视频链接")
    subs = bilibili.fetch_subtitles(url)
    if not subs:
        raise HTTPException(400, "没有可用的官方字幕")
    if req.lang and req.lang in subs:
        cues = subs[req.lang]
        lang = req.lang
    else:
        lang = next((l for l in subs if "zh" in l), next(iter(subs)))
        cues = subs[lang]
    return {
        "lang": lang,
        "available_langs": list(subs.keys()),
        "count": len(cues),
        "cues": [c.to_dict() for c in cues],
    }
