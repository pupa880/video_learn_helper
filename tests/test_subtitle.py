"""SRT 解析 / 字幕定位 / 上下文构造的简单测试。"""

from app.services.subtitle import (
    Cue,
    context_window,
    cues_to_text,
    find_cue_index,
    parse_bilibili_subtitle,
    parse_srt,
    to_srt,
)

SRT_SAMPLE = """1
00:00:01,000 --> 00:00:03,500
大家好，欢迎来到课程。

2
00:00:04,000 --> 00:00:06,000
今天我们讲
多行字幕的解析。

3
00:01:02.500 --> 00:01:05.000
支持点号毫秒。
"""


def test_parse_srt():
    cues = parse_srt(SRT_SAMPLE)
    assert len(cues) == 3
    assert cues[0].start == 1.0
    assert cues[0].end == 3.5
    assert cues[0].text == "大家好，欢迎来到课程。"
    assert cues[1].text == "今天我们讲 多行字幕的解析。"
    assert cues[2].start == 62.5


def test_parse_srt_crlf_and_bom():
    text = "﻿1\r\n00:00:01,000 --> 00:00:02,000\r\n你好\r\n"
    cues = parse_srt(text)
    assert len(cues) == 1
    assert cues[0].text == "你好"


def test_to_srt_roundtrip():
    cues = parse_srt(SRT_SAMPLE)
    again = parse_srt(to_srt(cues))
    assert [c.text for c in again] == [c.text for c in cues]
    assert [c.start for c in again] == [c.start for c in cues]


def test_to_srt_ms_rounding_no_overflow():
    """毫秒四舍五入后进位必须进到分/时，不能出现 00:00:60 或 ,1000。"""
    srt = to_srt([Cue(59.9996, 61.9996, "x")])
    assert "00:01:00,000 --> 00:01:02,000" in srt
    assert ",1000" not in srt
    assert ":60," not in srt


def test_find_cue_index():
    cues = [Cue(1, 3, "a"), Cue(5, 7, "b"), Cue(10, 12, "c")]
    assert find_cue_index(cues, 0.5) == -1
    assert find_cue_index(cues, 2) == 0
    assert find_cue_index(cues, 8) == 1
    assert find_cue_index(cues, 99) == 2


def test_context_window():
    cues = [Cue(i * 2, i * 2 + 1, f"line{i}") for i in range(20)]
    window = context_window(cues, t=25, before=10)
    # t=25 → 第 12 条（start=24），加上前 10 条 → 索引 2..12
    assert len(window) == 11
    assert window[-1].text == "line12"
    assert window[0].text == "line2"
    assert context_window(cues, t=-1) == []


def test_parse_bilibili_subtitle():
    data = {"body": [
        {"from": 0.5, "to": 2.0, "content": "第一句"},
        {"from": 2.5, "to": 4.0, "content": "第二句"},
    ]}
    cues = parse_bilibili_subtitle(data)
    assert len(cues) == 2
    assert cues[1].start == 2.5
    assert cues_to_text(cues) == "第一句\n第二句"


def test_format_video_info():
    from app.services.llm import format_video_info

    text = format_video_info({
        "name": "02 - 应用视角的操作系统",
        "uploader": "绿导师原谅你了",
        "upload_date": "20260315",
        "page": 2,
        "url": "https://www.bilibili.com/video/BVxxxx",
        "duration": 5275,
    })
    assert "标题：02 - 应用视角的操作系统" in text
    assert "UP主：绿导师原谅你了" in text
    assert "发布时间：2026-03-15" in text
    assert "分P：第 2 集" in text
    assert "http" not in text
    assert "时长" not in text
    assert "BVxxxx" not in text

    local = format_video_info({"name": "乔布斯演讲.mp4", "source": "local"})
    assert "标题：乔布斯演讲.mp4" in local
    assert "UP主" not in local
    assert format_video_info({}) is None
    assert format_video_info(None) is None


def test_compose_user_content():
    from app.services.llm import compose_user_content

    text = compose_user_content(
        "这个指的是什么",
        current_subtitle="[00:18:45,000] 但没有人知道这个是不是真的",
        subtitle_context="[00:18:40,000] 前一句",
    )
    assert text.startswith("【当前字幕】")
    assert "[00:18:45,000]" in text
    assert "【当前播放位置前后的字幕】" in text
    assert text.endswith("这个指的是什么")

    assert compose_user_content("hi") == "hi"


def test_estimate_tokens_and_overflow_detect():
    from app.services.llm import estimate_tokens, is_context_overflow

    assert estimate_tokens("") == 0
    assert estimate_tokens("abcd") == 2
    assert is_context_overflow("Error code: 400 - maximum context length is 256000")
    assert is_context_overflow("prompt is too long")
    assert is_context_overflow("超出上下文窗口限制")
    assert not is_context_overflow("rate limit exceeded")


def test_flatten_chat_for_compress_skips_dividers():
    from app.services.llm import flatten_chat_for_compress

    text = flatten_chat_for_compress([
        {"role": "divider", "kind": "new"},
        {"role": "compact", "content": "旧摘要"},
        {"role": "user", "content": "什么是进程"},
        {"role": "assistant", "content": "进程是资源分配单位"},
        {"role": "user", "content": [
            {"type": "text", "text": "那线程呢"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,xx"}},
        ]},
    ])
    assert "学生：什么是进程" in text
    assert "助手：进程是资源分配单位" in text
    assert "那线程呢" in text
    assert "旧摘要" not in text
    assert "data:image" not in text


def test_resolve_injections_uses_client_cues():
    from app.api.chat import resolve_injections
    from app.services.subtitle import Cue

    cues = [Cue(0, 1, "零"), Cue(2, 3, "一"), Cue(4, 5, "二")]
    inj = resolve_injections(
        cues,
        include_full_subtitles=True,
        include_subtitles=True,
        current_time=2.5,
        subtitle_before=10,
        subtitle_after=10,
    )
    assert "一" in inj["current_subtitle"]
    assert inj["subtitle_ctx"] is None  # 已注入全文则不再带前后文
    assert "零" in inj["full_subtitles"] and "二" in inj["full_subtitles"]

    inj2 = resolve_injections(
        cues,
        include_full_subtitles=False,
        include_subtitles=True,
        current_time=2.5,
        subtitle_before=1,
        subtitle_after=1,
    )
    assert "一" in inj2["current_subtitle"]
    assert "零" in inj2["subtitle_ctx"] and "二" in inj2["subtitle_ctx"]


def test_build_qa_messages():
    from app.services.llm import build_qa_messages, compose_user_content

    msgs = build_qa_messages(
        [{"role": "user", "content": "刚才讲了什么？"}],
        summary="这是总结",
        video_info="【当前视频信息】\n标题：某课",
        subtitle_context="[00:00] 附近字幕",
        current_subtitle="[00:00] 当前这句",
        image_b64="aW1hZ2U=",
    )
    assert msgs[0]["role"] == "system"
    assert msgs[1]["role"] == "system"
    assert "当前视频信息" in msgs[1]["content"]
    assert msgs[2]["role"] == "system"
    assert "总结" in msgs[2]["content"]
    # 字幕并进 user，不再占一条 system
    assert all("【当前字幕】" not in m["content"] for m in msgs if m["role"] == "system")
    last = msgs[-1]
    assert last["role"] == "user"
    assert isinstance(last["content"], list)
    text = last["content"][0]["text"]
    assert "刚才讲了什么？" in text
    assert "附近字幕" in text
    assert "当前这句" in text
    assert last["content"][1]["type"] == "image_url"
    assert last["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,")

    # 无图时保持纯文本
    msgs2 = build_qa_messages([{"role": "user", "content": "hi"}])
    assert msgs2[-1]["content"] == "hi"

    # 前端已写入本条时不要再包一层
    composed = compose_user_content("为啥？", current_subtitle="[00:20:57,000] 这意味着")
    msgs3 = build_qa_messages(
        [
            {"role": "user", "content": compose_user_content(
                "这个指的是什么", current_subtitle="[00:18:45,000] 旧的一句"
            )},
            {"role": "assistant", "content": "先前的回答"},
            {"role": "user", "content": composed},
        ],
        current_subtitle="[00:20:57,000] 这意味着",
        subtitle_context="[00:20:50,000] 前后文",
    )
    users = [m["content"] for m in msgs3 if m["role"] == "user"]
    assert users[0].count("【当前字幕】") == 1
    assert "旧的一句" in users[0]
    assert users[1].count("【当前字幕】") == 1
    assert "这意味着" in users[1]
    assert "【当前播放位置前后的字幕】" not in users[1]
