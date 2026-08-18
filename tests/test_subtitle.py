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


def test_build_qa_messages():
    from app.services.llm import build_qa_messages

    msgs = build_qa_messages(
        [{"role": "user", "content": "刚才讲了什么？"}],
        summary="这是总结",
        subtitle_context="[00:00] 附近字幕",
        image_b64="aW1hZ2U=",
    )
    assert msgs[0]["role"] == "system"
    assert "总结" in msgs[1]["content"]
    assert "字幕" in msgs[2]["content"]
    last = msgs[-1]
    assert isinstance(last["content"], list)
    assert last["content"][0]["type"] == "text"
    assert last["content"][1]["type"] == "image_url"
    assert last["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,")

    # 无图时保持纯文本
    msgs2 = build_qa_messages([{"role": "user", "content": "hi"}])
    assert msgs2[-1]["content"] == "hi"
