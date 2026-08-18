"""字幕统一结构与 SRT / B站字幕解析。"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass


@dataclass
class Cue:
    start: float  # 秒
    end: float
    text: str

    def to_dict(self) -> dict:
        return asdict(self)


def _parse_ts(ts: str) -> float:
    """``00:01:02,500`` 或 ``00:01:02.500`` → 秒。"""
    m = re.match(r"(\d+):(\d{2}):(\d{2})[,.](\d+)", ts.strip())
    if not m:
        raise ValueError(f"bad timestamp: {ts!r}")
    h, mnt, s, ms = m.groups()
    ms = ms.ljust(3, "0")[:3]
    return int(h) * 3600 + int(mnt) * 60 + int(s) + int(ms) / 1000


def _fmt_ts(sec: float) -> str:
    # 用整毫秒换算，避免 59.9996 → 00:00:60,000 或 00:00:01,1000
    total_ms = int(round(max(0.0, sec) * 1000))
    h, rem = divmod(total_ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse_srt(text: str) -> list[Cue]:
    """解析 SRT 文本为 Cue 列表。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    cues: list[Cue] = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = [ln for ln in block.split("\n") if ln.strip()]
        if not lines:
            continue
        # 跳过序号行
        if re.fullmatch(r"\d+", lines[0].strip()) and len(lines) > 1:
            lines = lines[1:]
        if not lines or "-->" not in lines[0]:
            continue
        start_s, end_s = lines[0].split("-->", 1)
        start, end = _parse_ts(start_s), _parse_ts(end_s)
        cue_text = " ".join(ln.strip() for ln in lines[1:]).strip()
        if cue_text:
            cues.append(Cue(start, end, cue_text))
    cues.sort(key=lambda c: c.start)
    return cues


def to_srt(cues: list[Cue]) -> str:
    blocks = []
    for i, c in enumerate(cues, 1):
        blocks.append(f"{i}\n{_fmt_ts(c.start)} --> {_fmt_ts(c.end)}\n{c.text}")
    return "\n\n".join(blocks) + "\n"


def parse_bilibili_subtitle(data: dict) -> list[Cue]:
    """B站官方字幕 json（``body: [{from, to, content}]``）→ Cue 列表。"""
    cues = [
        Cue(float(item["from"]), float(item["to"]), item["content"].strip())
        for item in data.get("body", [])
        if item.get("content", "").strip()
    ]
    cues.sort(key=lambda c: c.start)
    return cues


def find_cue_index(cues: list[Cue], t: float) -> int:
    """返回时间点 t 对应的字幕索引（在区间内，或其后最近一条之前的一条）；无匹配返回 -1。"""
    idx = -1
    for i, c in enumerate(cues):
        if c.start <= t:
            idx = i
        else:
            break
    return idx


def context_window(cues: list[Cue], t: float, before: int = 10) -> list[Cue]:
    """当前时间点对应字幕 + 其前 before 条。"""
    idx = find_cue_index(cues, t)
    if idx < 0:
        return []
    return cues[max(0, idx - before): idx + 1]


def cues_to_text(cues: list[Cue], with_time: bool = False) -> str:
    if with_time:
        return "\n".join(f"[{_fmt_ts(c.start)}] {c.text}" for c in cues)
    return "\n".join(c.text for c in cues)
