"""faster-whisper ASR（移植自 subtitle_pipeline/asr/faster_whisper_asr.py）。

原生输出句级时间戳，内置 VAD（vad_filter=True），非实时模式直接使用。
"""

from __future__ import annotations

from .base import ASRBase


class FasterWhisperASR(ASRBase):
    def __init__(
        self,
        model_name: str = "small",
        device: str = "cpu",
        compute_type: str = "default",
        beam_size: int = 5,
    ) -> None:
        from faster_whisper import WhisperModel

        self.model_name = model_name
        self.beam_size = beam_size
        self._model = WhisperModel(model_name, device=device, compute_type=compute_type)

    @staticmethod
    def _normalize_language(language: str) -> str | None:
        return None if language in ("auto", "", None) else language

    def transcribe_with_timestamps(
        self, audio: str, language: str = "auto"
    ) -> list[tuple[float, float, str]]:
        segments, _info = self._model.transcribe(
            audio,
            language=self._normalize_language(language),
            beam_size=self.beam_size,
            vad_filter=True,
        )
        return [
            (seg.start, seg.end, seg.text.strip())
            for seg in segments
            if seg.text.strip()
        ]

    def transcribe(self, audio: str, language: str = "auto") -> str:
        segments, _info = self._model.transcribe(
            audio,
            language=self._normalize_language(language),
            beam_size=self.beam_size,
            vad_filter=True,
        )
        return " ".join(seg.text.strip() for seg in segments if seg.text.strip())
