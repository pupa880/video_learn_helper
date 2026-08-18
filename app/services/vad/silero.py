"""Silero VAD（移植自 subtitle_pipeline/vad/silero.py）。"""

from __future__ import annotations


class SileroVAD:
    """将 16kHz 单声道音频切成语音段，返回秒级 (start, end)。"""

    def __init__(
        self,
        sample_rate: int = 16000,
        threshold: float = 0.5,
        min_speech_duration_ms: int = 250,
        max_speech_duration_s: float = 15.0,
        min_silence_duration_ms: int = 500,
        speech_pad_ms: int = 30,
    ) -> None:
        from silero_vad import load_silero_vad

        self.sample_rate = sample_rate
        self.threshold = threshold
        self.min_speech_duration_ms = min_speech_duration_ms
        self.max_speech_duration_s = max_speech_duration_s
        self.min_silence_duration_ms = min_silence_duration_ms
        self.speech_pad_ms = speech_pad_ms
        self._model = load_silero_vad()

    def detect(self, audio) -> list[tuple[float, float]]:
        """``audio`` 为 numpy float32 数组（16kHz），返回 ``[(start_s, end_s), ...]``。"""
        import torch
        from silero_vad import get_speech_timestamps

        if not isinstance(audio, torch.Tensor):
            audio = torch.from_numpy(audio)
        timestamps = get_speech_timestamps(
            audio,
            self._model,
            sampling_rate=self.sample_rate,
            threshold=self.threshold,
            min_speech_duration_ms=self.min_speech_duration_ms,
            max_speech_duration_s=self.max_speech_duration_s,
            min_silence_duration_ms=self.min_silence_duration_ms,
            speech_pad_ms=self.speech_pad_ms,
        )
        return [
            (ts["start"] / self.sample_rate, ts["end"] / self.sample_rate)
            for ts in timestamps
        ]
