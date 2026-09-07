"""运行期配置：持久化到 data/config.json，env 可覆盖。"""

from __future__ import annotations

import copy
import json
import os
import threading
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CONFIG_PATH = DATA_DIR / "config.json"
COOKIES_PATH = DATA_DIR / "cookies.txt"

# 内置提供商的默认参数（新增提供商时均为 OpenAI 兼容协议，这里只提供预设值）
BUILTIN_PROVIDERS: dict[str, dict[str, Any]] = {
    "deepseek": {
        "base_url": "https://api.deepseek.com",
        "default_model": "deepseek-chat",
        "supports_image": False,
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "default_model": "gpt-4o-mini",
        "supports_image": True,
    },
}

DEFAULT_CONFIG: dict[str, Any] = {
    "llm": {
        "provider": "deepseek",  # 当前激活的提供商名称
        "enable_thinking": False,  # 开启后转发并渲染模型的推理过程（需模型支持，如 deepseek-reasoner）
        # 每个提供商独立保存 base_url / api_key / model
        "providers": {
            "deepseek": {
                "base_url": BUILTIN_PROVIDERS["deepseek"]["base_url"],
                "api_key": "",
                "model": BUILTIN_PROVIDERS["deepseek"]["default_model"],
                "supports_image": BUILTIN_PROVIDERS["deepseek"]["supports_image"],
            },
        },
    },
    "asr": {
        "model": "sensevoice",  # sensevoice（Silero VAD + FunASR）/ faster-whisper
        "whisper_model": "small",
        "device": "cpu",
        "language": "auto",
    },
}

_lock = threading.Lock()
_config: dict[str, Any] | None = None


def _deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _migrate_llm(cfg: dict[str, Any]) -> None:
    """旧格式（llm.api_key/base_url/model 平铺）迁移为按提供商分别保存。"""
    llm = cfg["llm"]
    providers = llm.setdefault("providers", {})
    provider = llm.get("provider", "deepseek")
    info = BUILTIN_PROVIDERS.get(provider, {})
    # 平铺的旧字段合并进激活提供商，优先级高于默认值
    flat = {k: llm.pop(k) for k in ("api_key", "base_url", "model") if k in llm}
    if flat:
        entry = providers.setdefault(provider, {
            "base_url": info.get("base_url", ""),
            "api_key": "",
            "model": info.get("default_model", ""),
            "supports_image": info.get("supports_image", False),
        })
        for k, v in flat.items():
            if v:
                entry[k] = v
    for name, entry in providers.items():
        entry.setdefault("supports_image",
                         BUILTIN_PROVIDERS.get(name, {}).get("supports_image", False))


def load_config() -> dict[str, Any]:
    global _config
    with _lock:
        if _config is not None:
            return _config
        cfg = copy.deepcopy(DEFAULT_CONFIG)
        if CONFIG_PATH.exists():
            try:
                cfg = _deep_merge(cfg, json.loads(CONFIG_PATH.read_text("utf-8")))
            except Exception:
                cfg = copy.deepcopy(DEFAULT_CONFIG)
        _migrate_llm(cfg)
        # env 覆盖（作用于当前激活的提供商）
        active = cfg["llm"].get("provider", "deepseek")
        entry = cfg["llm"]["providers"].setdefault(active, {"base_url": "", "api_key": "", "model": ""})
        if os.environ.get("LLM_API_KEY"):
            entry["api_key"] = os.environ["LLM_API_KEY"]
        if os.environ.get("LLM_BASE_URL"):
            entry["base_url"] = os.environ["LLM_BASE_URL"]
        if os.environ.get("LLM_MODEL"):
            entry["model"] = os.environ["LLM_MODEL"]
        _config = cfg
        return cfg


def save_config(cfg: dict[str, Any]) -> None:
    global _config
    with _lock:
        _config = cfg
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")


def update_config(patch: dict[str, Any]) -> dict[str, Any]:
    cfg = load_config()
    merged = _deep_merge(cfg, patch)
    provider = merged["llm"].get("provider", "deepseek")
    if provider not in merged["llm"].get("providers", {}):
        raise ValueError(f"未知的提供商: {provider}")
    save_config(merged)
    return merged


def add_provider(name: str, base_url: str, api_key: str = "",
                 model: str = "", supports_image: bool = False) -> dict[str, Any]:
    """新增一个 OpenAI 兼容协议的提供商。名称冲突或参数非法时抛 ValueError。"""
    cfg = load_config()
    providers = cfg["llm"].setdefault("providers", {})
    if name in providers:
        raise ValueError(f"提供商已存在: {name}")
    preset = BUILTIN_PROVIDERS.get(name, {})
    providers[name] = {
        "base_url": base_url or preset.get("base_url", ""),
        "api_key": api_key,
        "model": model or preset.get("default_model", ""),
        "supports_image": bool(supports_image),
    }
    save_config(cfg)
    return cfg


def rename_provider(old: str, new: str) -> dict[str, Any]:
    """重命名提供商（名称是配置键，整体迁移）；若它是激活提供商则同步更新。"""
    if old == new:
        return load_config()
    cfg = load_config()
    providers = cfg["llm"].get("providers", {})
    if old not in providers:
        raise ValueError(f"提供商不存在: {old}")
    if new in providers:
        raise ValueError(f"提供商已存在: {new}")
    providers[new] = providers.pop(old)
    if cfg["llm"].get("provider") == old:
        cfg["llm"]["provider"] = new
    save_config(cfg)
    return cfg


def delete_provider(name: str) -> dict[str, Any]:
    """删除提供商；至少保留一个。删除激活提供商时切换到剩余的第一个。"""
    cfg = load_config()
    providers = cfg["llm"].get("providers", {})
    if name not in providers:
        raise ValueError(f"提供商不存在: {name}")
    if len(providers) <= 1:
        raise ValueError("至少保留一个提供商")
    del providers[name]
    if cfg["llm"].get("provider") == name:
        cfg["llm"]["provider"] = next(iter(providers))
    save_config(cfg)
    return cfg


def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return key[:2] + "****"
    return key[:4] + "****" + key[-4:]


def public_config() -> dict[str, Any]:
    """返回给前端的脱敏配置。providers 中每个提供商的 api_key 单独脱敏。"""
    cfg = load_config()
    llm = cfg["llm"]
    provider = llm.get("provider", "deepseek")
    providers = llm.get("providers", {})
    active = providers.get(provider, {})
    return {
        "llm": {
            "provider": provider,
            "enable_thinking": bool(llm.get("enable_thinking", False)),
            "supports_image": bool(active.get("supports_image", False)),
            "providers": {
                name: {
                    "base_url": p.get("base_url", ""),
                    "model": p.get("model", ""),
                    "api_key_masked": _mask_key(p.get("api_key", "")),
                    "api_key_set": bool(p.get("api_key")),
                    "supports_image": bool(p.get("supports_image", False)),
                }
                for name, p in providers.items()
            },
        },
        "asr": dict(cfg.get("asr", {})),
        "bilibili": {"cookies_uploaded": bool(cookies_path())},
        "asr_available": asr_available(),
        "asr_model_cached": asr_model_cached(),
    }


def asr_available() -> bool:
    try:
        import funasr  # noqa: F401
        return True
    except Exception:
        pass
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def _asr_marker_path(model: str, whisper_model: str = "small") -> Path:
    name = f"{model}-{whisper_model}" if model == "faster-whisper" else (model or "sensevoice")
    return DATA_DIR / f".asr-ready-{name}"


def mark_asr_model_cached(model: str, whisper_model: str = "small") -> None:
    """首次成功加载模型后打标，前端下次不再弹出下载提示。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _asr_marker_path(model, whisper_model).touch()


def asr_model_cached() -> bool:
    """当前所选 ASR 模型权重是否已在本地（标记文件或常见缓存目录）。"""
    cfg = load_config().get("asr", {})
    model = cfg.get("model") or "sensevoice"
    whisper = cfg.get("whisper_model") or "small"
    if _asr_marker_path(model, whisper).exists():
        return True
    home = Path.home()
    if model == "faster-whisper":
        hf = Path(os.environ.get("HF_HOME", home / ".cache" / "huggingface"))
        slug = f"models--Systran--faster-whisper-{whisper}"
        hub = hf / "hub" / slug
        return hub.is_dir() and any(hub.rglob("*.bin"))
    ms = Path(os.environ.get("MODELSCOPE_CACHE", home / ".cache" / "modelscope"))
    for name in ("SenseVoiceSmall", "sensevoicesmall"):
        for p in (ms / "hub" / "models" / "iic" / name, ms / "hub" / "iic" / name):
            if p.is_dir() and any(p.iterdir()):
                return True
    return False


def save_cookies(content: bytes) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    COOKIES_PATH.write_bytes(content)


def cookies_path() -> str | None:
    try:
        if COOKIES_PATH.is_file() and COOKIES_PATH.stat().st_size > 0:
            return str(COOKIES_PATH)
    except OSError:
        return None
    return None
