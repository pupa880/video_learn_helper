# video_learn_helper

视频（课程/演讲）学习辅助工具：本地/B站视频播放 + 字幕同步跳转 + ASR 转录 + AI 问答。

## 功能

- **视频**：本地视频上传播放；B站链接解析（yt-dlp），支持多P选集与清晰度选择，可在线串流播放或下载到本地（ffmpeg remux，未登录 360p~720p）。
- **字幕**：SRT 上传、B站官方字幕（需 cookies）、ASR 实时转录（边看边转）三种来源；列表与播放进度双向同步，点击跳转。
- **AI 问答**：OpenAI 兼容协议（DeepSeek/OpenAI），多轮对话、视频总结注入、可选「发送当前字幕」「发送当前视频帧」「思考」，SSE 流式输出。「⚙ 对话设置」可配置是否注入视频总结/完整字幕、当前字幕前后携带条数（设置存浏览器 localStorage）；每次回复会展示本次实际注入的上下文，可展开核对。

## 前置条件

- Python ≥ 3.13，[uv](https://docs.astral.sh/uv/)
- 系统安装 **ffmpeg**（`ffmpeg` / `ffprobe` 在 PATH 中）

## 安装与运行

```bash
# 核心依赖
uv sync

# （可选）ASR 转录功能，依赖体积 GB 级
uv sync --extra asr

# 启动
uv run python main.py --port 8000
# 打开 http://127.0.0.1:8000
```

## 配置

右上角「⚙ 设置」面板，运行期可改，持久化到 `data/config.json`：

- **LLM**：提供商选择、模型（可拉取列表）；「提供商设置 / 新增提供商」弹窗维护各提供商的 base_url、api_key、是否支持图像识别（deepseek 不支持图片，「发送当前视频帧」自动禁用）。也可用环境变量覆盖：`LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`。「思考」（渲染模型推理过程）在问答区按需临时开启。
- **B站 cookies**：上传 Netscape 格式 cookies.txt（存为 `data/cookies.txt`），用于拉取 B站官方字幕。
- **ASR**：模型（faster-whisper / sensevoice）、whisper 规格（默认 small）、设备（cpu/cuda）、语言（默认 auto）。首次转录会下载模型权重。

## 测试

```bash
uv run pytest
```

## 项目结构

见 `PLAN.md` 第三节。运行期产物（上传的视频、音频、字幕缓存、配置、cookies）都在 `data/` 下，已 gitignore。
