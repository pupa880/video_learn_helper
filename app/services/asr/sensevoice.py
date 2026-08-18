"""FunASR/SenseVoiceSmall ASR（移植自 subtitle_pipeline/asr/funasr.py）。

不输出时间戳，需配合 silero-vad 先切段再逐段识别；输出含 <|...|> 特殊 token 需过滤。
"""

from __future__ import annotations

import re
import warnings

from .base import ASRBase

warnings.filterwarnings(
    "ignore",
    message=r"Setting `pad_token_id` to `eos_token_id`.*",
    category=UserWarning,
)


class SenseVoiceASR(ASRBase):
    def __init__(
        self,
        model_name: str = "iic/SenseVoiceSmall",
        device: str = "cpu",
    ) -> None:
        from funasr import AutoModel

        self.model_name = model_name
        self._model = AutoModel(
            model=model_name, device=device, disable_pbar=True, disable_update=True
        )

    @staticmethod
    def _strip_tags(text: str) -> str:
        """移除 SenseVoice 特殊 token（<|zh|>、<|NEUTRAL|> 等）。"""
        if not text:
            return ""
        text = re.sub(r"<\|[^|]+\|>", "", text)
        return re.sub(r"\s+", " ", text).strip()

    def transcribe(self, audio: str, language: str = "auto") -> str:
        try:
            res = self._model.generate(
                input=[audio], batch_size=1, language=language, use_itn=True
            )
        except Exception:
            return ""
        if not res or not isinstance(res, list):
            return ""
        text = res[0].get("text", "") if isinstance(res[0], dict) else str(res[0])
        return self._strip_tags(text)

    def transcribe_with_timestamps(
        self, audio: str, language: str = "auto"
    ) -> None:
        return None  # 不输出时间戳，调用方走 VAD 分段
