"""FastAPI app：路由注册、静态托管、任务查询。"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import state
from .api import chat, config, subtitle, transcribe, video
from .services.bilibili import BilibiliError
from .state import InvalidVideoId

STATIC_DIR = Path(__file__).resolve().parent / "static"


def create_app() -> FastAPI:
    app = FastAPI(title="video_learn_helper")

    @app.exception_handler(BilibiliError)
    def bilibili_error_handler(_req: Request, exc: BilibiliError):
        """B站解析/下载/字幕的已知错误以 400 + 原文返回，前端能展示具体原因。"""
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(InvalidVideoId)
    def invalid_video_id_handler(_req: Request, exc: InvalidVideoId):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    app.include_router(video.router)
    app.include_router(subtitle.router)
    app.include_router(transcribe.router)
    app.include_router(chat.router)
    app.include_router(config.router)

    @app.get("/api/tasks/{task_id}")
    def get_task(task_id: str):
        task = state.get_task(task_id)
        if not task:
            raise HTTPException(404, "任务不存在")
        return task

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/history")
    def history_page():
        return FileResponse(STATIC_DIR / "history.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


app = create_app()
