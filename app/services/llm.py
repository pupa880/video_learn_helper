"""OpenAI 兼容 LLM 客户端：总结生成、多轮问答、流式输出、多模态消息。"""

from __future__ import annotations

from typing import Any, Generator

from openai import OpenAI

from .. import config as app_config

SUMMARY_PROMPT = (
    "你是一个学习助手。下面是视频的字幕全文，请用中文生成一份结构化总结，"
    "包含：1) 主题概述（2-3 句）；2) 关键要点（分条）；3) 值得记住的结论。"
)

QA_SYSTEM_PROMPT = (
    "你是一个视频学习助手。用户正在观看一个视频，"
    "你可以参考视频总结和用户提供的字幕上下文来回答问题。"
    "回答用中文，简洁准确；如果问题与视频内容无关，正常回答即可。"
)


def get_client() -> tuple[OpenAI, dict[str, Any]]:
    """返回当前激活提供商的客户端与其配置（合并 enable_thinking 等全局项）。"""
    llm_cfg = app_config.load_config()["llm"]
    name = llm_cfg.get("provider", "deepseek")
    p = dict(llm_cfg.get("providers", {}).get(name, {}))
    if not p.get("api_key"):
        raise RuntimeError(f"提供商「{name}」未配置 API Key，请先在设置面板中填写。")
    p["provider"] = name
    p["enable_thinking"] = bool(llm_cfg.get("enable_thinking", False))
    client = OpenAI(api_key=p["api_key"], base_url=p.get("base_url") or None)
    return client, p


def supports_image() -> bool:
    llm_cfg = app_config.load_config()["llm"]
    provider = llm_cfg.get("provider", "deepseek")
    p = llm_cfg.get("providers", {}).get(provider, {})
    return bool(p.get("supports_image",
                     app_config.BUILTIN_PROVIDERS.get(provider, {}).get("supports_image", False)))


def make_image_content(image_b64: str) -> dict:
    """base64 帧图 → 多模态 content 块。"""
    if image_b64.startswith("data:"):
        url = image_b64
    else:
        url = f"data:image/jpeg;base64,{image_b64}"
    return {"type": "image_url", "image_url": {"url": url}}


def generate_summary(subtitle_text: str) -> str:
    """由字幕全文生成视频总结（调用方负责缓存）。"""
    client, cfg = get_client()
    resp = client.chat.completions.create(
        model=cfg["model"],
        messages=[
            {"role": "system", "content": SUMMARY_PROMPT},
            {"role": "user", "content": subtitle_text[:60000]},
        ],
        stream=False,
    )
    return resp.choices[0].message.content or ""


def build_qa_messages(
    messages: list[dict],
    summary: str | None = None,
    subtitle_context: str | None = None,
    current_subtitle: str | None = None,
    image_b64: str | None = None,
    full_subtitles: str | None = None,
) -> list[dict]:
    """在多轮 messages 基础上注入总结 / 完整字幕 / 字幕上下文 / 当前帧。

    - ``messages``：前端维护的多轮历史（role: user/assistant），最后一条是当前问题。
    - 总结与字幕上下文以 system/user 补充形式注入，不改动历史。
    - ``full_subtitles`` 是带时间戳的字幕全文（可能已被调用方截断）；注入完整字幕后
      一般不再注入 ``subtitle_context``（由调用方取舍），避免内容重复。
    - ``subtitle_context`` 是当前播放位置前后的若干条字幕；``current_subtitle``
      是用户当前停留的那一条，单独标注，用户说“这句话/这句”时通常指它。
    - 图片附加到当前（最后一条）user 消息上，构造多模态消息。
    """
    out: list[dict] = [{"role": "system", "content": QA_SYSTEM_PROMPT}]
    if summary:
        out.append({"role": "system", "content": f"【当前视频总结】\n{summary}"})
    if full_subtitles:
        out.append({"role": "system", "content": f"【视频完整字幕】\n{full_subtitles}"})
    if subtitle_context:
        out.append({"role": "system", "content": f"【当前播放位置前后的字幕】\n{subtitle_context}"})
    if current_subtitle:
        out.append({"role": "system", "content": (
            "【当前字幕】用户当前停留在这一句；"
            f"用户说“这句话”“这句”时通常指它。\n{current_subtitle}"
        )})

    history = [dict(m) for m in messages]
    if image_b64 and history:
        last = history[-1]
        content = last.get("content", "")
        if isinstance(content, str):
            last["content"] = [
                {"type": "text", "text": content},
                make_image_content(image_b64),
            ]
    out.extend(history)
    return out


def stream_chat(
    messages: list[dict], enable_thinking: bool | None = None
) -> Generator[tuple[str, str], None, None]:
    """流式问答，逐段产出 (kind, text)：kind 为 content 或 reasoning。

    ``enable_thinking`` 为 None 时用全局配置；否则按本次请求决定是否转发
    reasoning（OpenAI 兼容协议的 ``reasoning_content`` 字段，如
    deepseek-reasoner / Qwen3 等）。
    """
    client, cfg = get_client()
    show_reasoning = bool(cfg.get("enable_thinking")) if enable_thinking is None else enable_thinking
    stream = client.chat.completions.create(
        model=cfg["model"],
        messages=messages,
        stream=True,
    )
    for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if not delta:
            continue
        reasoning = getattr(delta, "reasoning_content", None)
        if reasoning and show_reasoning:
            yield "reasoning", reasoning
        if delta.content:
            yield "content", delta.content


def list_models(base_url: str, api_key: str) -> list[str]:
    """按指定的 base_url/api_key 拉取模型列表（设置面板用）。

    使用前端当前选中的提供商参数，而不是已保存的激活提供商。
    """
    if not api_key:
        raise RuntimeError("该提供商未配置 API Key，请先填写并保存。")
    client = OpenAI(api_key=api_key, base_url=base_url or None)
    try:
        return sorted(m.id for m in client.models.list().data)
    except Exception as exc:
        raise RuntimeError(f"拉取模型列表失败: {exc}") from exc
