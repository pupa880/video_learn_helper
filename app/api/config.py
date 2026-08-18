"""配置 API：LLM/ASR 配置读写、提供商管理、B站 cookies 上传、模型列表。"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel

from .. import config as app_config
from ..services import llm

router = APIRouter(prefix="/api/config", tags=["config"])

# 提供商名称允许中文/字母/数字/下划线/连字符（只用作配置键，不进 URL）
_PROVIDER_NAME_RE = re.compile(r"^[a-zA-Z0-9_一-龥][a-zA-Z0-9_一-龥-]{0,31}$")


@router.get("")
def get_config():
    return app_config.public_config()


@router.put("")
def put_config(patch: dict[str, Any]):
    # 只接受白名单字段，避免前端误写其他键
    allowed_llm = {"provider", "enable_thinking", "providers"}
    allowed_provider = {"api_key", "base_url", "model", "supports_image"}
    allowed_asr = {"model", "whisper_model", "device", "language"}
    clean: dict[str, Any] = {}
    if isinstance(patch.get("llm"), dict):
        clean["llm"] = {k: v for k, v in patch["llm"].items() if k in allowed_llm}
        if isinstance(clean["llm"].get("providers"), dict):
            providers: dict[str, Any] = {}
            for name, p in clean["llm"]["providers"].items():
                if not isinstance(p, dict):
                    continue
                entry = {k: v for k, v in p.items() if k in allowed_provider}
                # 空字符串 api_key 表示不修改
                if entry.get("api_key") == "":
                    entry.pop("api_key")
                providers[name] = entry
            clean["llm"]["providers"] = providers
    if isinstance(patch.get("asr"), dict):
        clean["asr"] = {k: v for k, v in patch["asr"].items() if k in allowed_asr}
    try:
        app_config.update_config(clean)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return app_config.public_config()


class ProviderCreate(BaseModel):
    name: str
    base_url: str
    api_key: str = ""
    model: str = ""
    supports_image: bool = False
    protocol: str = "openai"  # 目前仅支持 OpenAI 兼容协议


@router.post("/providers", status_code=201)
def create_provider(req: ProviderCreate):
    """新增一个 OpenAI 兼容协议的提供商，key 独立保存。"""
    name = req.name.strip()
    if not _PROVIDER_NAME_RE.match(name):
        raise HTTPException(400, "提供商名称须为中文/字母/数字/下划线/连字符，不超过 32 字符")
    if req.protocol != "openai":
        raise HTTPException(400, "暂只支持 OpenAI 兼容协议")
    base_url = req.base_url.strip()
    if not base_url.startswith(("http://", "https://")):
        raise HTTPException(400, "Base URL 须以 http:// 或 https:// 开头")
    try:
        app_config.add_provider(name, base_url, req.api_key.strip(),
                                req.model.strip(), req.supports_image)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return app_config.public_config()


class ProviderRename(BaseModel):
    name: str


@router.post("/providers/{name}/rename")
def rename_provider(name: str, req: ProviderRename):
    """重命名提供商（名称是配置键，整体迁移配置项）。"""
    new = req.name.strip()
    if not _PROVIDER_NAME_RE.match(new):
        raise HTTPException(400, "提供商名称须为中文/字母/数字/下划线/连字符，不超过 32 字符")
    try:
        app_config.rename_provider(name, new)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return app_config.public_config()


@router.delete("/providers/{name}")
def delete_provider(name: str):
    """删除提供商；至少保留一个，删除激活项时自动切换到剩余的第一个。"""
    try:
        app_config.delete_provider(name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return app_config.public_config()


class ModelsQuery(BaseModel):
    provider: str
    base_url: str = ""
    api_key: str = ""  # 空则使用该提供商已保存的 key


@router.post("/models")
def list_models(req: ModelsQuery):
    """拉取指定提供商的模型列表（前端当前选中的，而非已保存的激活项）。

    表单里填了 base_url / api_key 则优先用表单值，否则用该提供商已保存的配置。
    """
    saved = app_config.load_config()["llm"].get("providers", {}).get(req.provider, {})
    base_url = req.base_url.strip() or saved.get("base_url", "")
    api_key = req.api_key.strip() or saved.get("api_key", "")
    try:
        return {"models": llm.list_models(base_url, api_key)}
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/cookies")
async def upload_cookies(file: UploadFile):
    content = await file.read()
    if b"netscape" not in content[:200].lower() and b".bilibili.com" not in content:
        raise HTTPException(400, "请上传 Netscape 格式的 cookies 文件")
    app_config.save_cookies(content)
    return {"ok": True, "cookies_uploaded": True}
