"""ASR 抽象基类。重型依赖在子类中惰性导入，首次转录时才加载模型。"""

from __future__ import annotations


class ASRBase:
    """ASR 接口：整段带时间戳转录 / 单段识别。"""

    def transcribe_with_timestamps(
        self, audio: str, language: str = "auto"
    ) -> list[tuple[float, float, str]] | None:
        """返回 ``[(start, end, text), ...]``；不支持时返回 None（调用方改走 VAD 分段）。"""
        raise NotImplementedError

    def transcribe(self, audio: str, language: str = "auto") -> str:
        """识别单段音频，返回文本。"""
        raise NotImplementedError


def create_asr(model: str, device: str = "cpu", whisper_model: str = "small") -> ASRBase:
    """按配置创建 ASR 实例。"""
    if model == "faster-whisper":
        from .faster_whisper_asr import FasterWhisperASR
        return FasterWhisperASR(model_name=whisper_model, device=device)
    if model == "sensevoice":
        from .sensevoice import SenseVoiceASR
        return SenseVoiceASR(device=device)
    raise ValueError(f"unknown asr model: {model}")
