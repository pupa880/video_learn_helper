"""AI 问答 API：多轮、总结/完整字幕作 system 背景、当前字幕写入 user、图片帧，SSE 流式。

字幕/总结/视频信息由前端用户库提供，后端不读盘。
"""

from __future__ import annotations

import json
from typing import Any, Generator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..services import llm
from ..services.subtitle import Cue, cues_to_text, find_cue_index

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatMessage(BaseModel):
    role: str  # user / assistant
    content: str


class CueIn(BaseModel):
    start: float
    end: float
    text: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    cues: list[CueIn] = []
    summary: str | None = None
    video_meta: dict[str, Any] | None = None
    include_subtitles: bool = False
    current_time: float = 0.0
    image_b64: str | None = None
    enable_thinking: bool | None = None  # 本次请求是否转发思考过程；None 用全局配置
    include_summary: bool = True         # 是否注入视频总结
    include_video_info: bool = True      # 是否注入标题 / UP / 发布时间
    include_full_subtitles: bool = False  # 是否注入完整字幕（带时间戳，过长截断）
    subtitle_before: int = 10            # 「发送当前字幕」时附带当前句之前的条数
    subtitle_after: int = 0              # 「发送当前字幕」时附带当前句之后的条数


# 注入完整字幕的字符上限（与总结生成的截断长度对齐）
FULL_SUBTITLE_MAX_CHARS = 60000


def _cues(raw: list[CueIn]) -> list[Cue]:
    return [Cue(c.start, c.end, c.text) for c in raw]


def resolve_injections(
    cues: list[Cue],
    *,
    include_full_subtitles: bool,
    include_subtitles: bool,
    current_time: float,
    subtitle_before: int,
    subtitle_after: int,
) -> dict[str, Any]:
    """由前端提供的字幕算出本轮要注入的完整字幕 / 当前句 / 前后文。"""
    full_subtitles = None
    full_truncated = False
    if include_full_subtitles and cues:
        full_subtitles = cues_to_text(cues, with_time=True)
        if len(full_subtitles) > FULL_SUBTITLE_MAX_CHARS:
            full_subtitles = full_subtitles[:FULL_SUBTITLE_MAX_CHARS]
            full_truncated = True

    subtitle_ctx = None
    current_subtitle = None
    if include_subtitles and cues:
        idx = find_cue_index(cues, current_time)
        if idx >= 0:
            current_subtitle = cues_to_text([cues[idx]], with_time=True)
            if not full_subtitles:
                before = max(0, subtitle_before)
                after = max(0, subtitle_after)
                window = cues[max(0, idx - before): idx] + cues[idx + 1: idx + 1 + after]
                if window:
                    subtitle_ctx = cues_to_text(window, with_time=True)
    return {
        "full_subtitles": full_subtitles,
        "full_truncated": full_truncated,
        "subtitle_ctx": subtitle_ctx,
        "current_subtitle": current_subtitle,
    }


def _sanitize_messages(messages: list[dict]) -> list[dict]:
    """调试用：回传实际发给模型的列表，图片换成占位避免撑爆 SSE。"""
    out: list[dict] = []
    for raw in messages:
        msg = dict(raw)
        content = msg.get("content")
        if isinstance(content, list):
            blocks = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "image_url":
                    blocks.append({"type": "image_url", "image_url": {"url": "[image]"}})
                else:
                    blocks.append(block)
            msg["content"] = blocks
        out.append(msg)
    return out


class SummaryRequest(BaseModel):
    cues: list[CueIn]


@router.post("")
def chat(req: ChatRequest) -> StreamingResponse:
    if req.image_b64 and not llm.supports_image():
        raise HTTPException(400, "当前模型不支持图片理解（deepseek 不支持发送视频帧）")

    cues = _cues(req.cues)
    inj = resolve_injections(
        cues,
        include_full_subtitles=req.include_full_subtitles,
        include_subtitles=req.include_subtitles,
        current_time=req.current_time,
        subtitle_before=req.subtitle_before,
        subtitle_after=req.subtitle_after,
    )

    def event_source() -> Generator[str, None, None]:
        try:
            summary = req.summary if req.include_summary else None
            generated = False
            if req.include_summary and not summary and cues:
                yield f"data: {json.dumps({'type': 'status', 'text': '首次对话，正在自动生成视频总结…'}, ensure_ascii=False)}\n\n"
                summary = llm.generate_summary(cues_to_text(cues))
                generated = True
            if generated and summary:
                yield f"data: {json.dumps({'type': 'summary', 'text': summary}, ensure_ascii=False)}\n\n"
            video_info = None
            if req.include_video_info:
                video_info = llm.format_video_info(req.video_meta)
            messages = llm.build_qa_messages(
                [m.model_dump() for m in req.messages],
                summary=summary,
                subtitle_context=inj["subtitle_ctx"],
                current_subtitle=inj["current_subtitle"],
                image_b64=req.image_b64,
                full_subtitles=inj["full_subtitles"],
                video_info=video_info,
            )
            # 仅回传未写入历史的 system 背景；当前字幕已在 user 里
            injected = []
            if video_info:
                injected.append({"label": "视频信息", "text": video_info})
            if summary:
                injected.append({"label": "视频总结", "text": summary,
                                 "note": "由字幕自动生成并注入，可在 ⚙ 对话设置中关闭"})
            if inj["full_subtitles"]:
                injected.append({"label": "完整字幕", "text": inj["full_subtitles"],
                                 "truncated": inj["full_truncated"]})
            if injected:
                yield f"data: {json.dumps({'type': 'context', 'items': injected}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'messages', 'messages': _sanitize_messages(messages)}, ensure_ascii=False)}\n\n"
            for kind, delta in llm.stream_chat(messages, enable_thinking=req.enable_thinking):
                ev = {"type": "reasoning" if kind == "reasoning" else "delta", "text": delta}
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'text': str(exc)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_source(), media_type="text/event-stream")


@router.post("/summary")
def summary(req: SummaryRequest):
    """由前端提供的字幕生成视频总结；缓存由前端负责。"""
    cues = _cues(req.cues)
    if not cues:
        raise HTTPException(400, "没有字幕，无法生成总结")
    try:
        text = llm.generate_summary(cues_to_text(cues))
    except Exception as exc:
        raise HTTPException(400, f"总结生成失败: {exc}") from exc
    return {"summary": text, "cached": False}
