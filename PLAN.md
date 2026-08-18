# video_learn_helper 开发计划

视频（课程/演讲）学习辅助工具：本地/B站视频播放 + 字幕同步跳转 + ASR 转录 + AI 问答。

## 一、功能拆解

### 1. 视频区域
- 本地视频：上传本地文件（mp4 等），用 HTML5 `<video>` 播放。
- B站视频：填写 B站链接（BV 号/URL），用 **yt-dlp**（Python 库模式）解析取流，自己的 `<video>` 播放，可完全控制进度。已实测（yt-dlp 2026.07.04）：
  - `yt_dlp.YoutubeDL({"skip_download": True}).extract_info(url)` 一次返回 title/duration/uploader/formats/subtitles，无需手写 BV→cid、wbi 签名。
  - 未登录可拿到 360p~720p 直链（m4s）。
  - B站格式为 DASH 分离流：视频轨与音频轨分开，没有音视频合一的格式 → 后端用 ffmpeg 将两轨 remux（`-c copy`，不转码）缓存为单个 mp4，再当本地文件播放（后续 ASR 复用同一文件）。
  - 直链要求 `Referer: https://www.bilibili.com/video/<BV>` 请求头，浏览器无法设置 → 由后端下载，不直连前端。
  - 官方字幕：yt-dlp 可取，但未登录时接口拒绝（实测警告 "Subtitles are only available when logged in"）→ 配置中提供 B站 cookies（cookies 文件路径）后可用；无 cookies 时该来源不可用，用 ASR 转录或手动上传 SRT。

### 2. 字幕区域
- 字幕来源三种：
  1. 本地上传 `.srt`；
  2. 视频转录（ASR，见第 4 节）；
  3. B站视频的字幕：yt-dlp 拉取官方字幕（json → 统一字幕结构），需配置 B站 cookies。
- 交互：字幕列表与播放进度双向同步（当前句高亮、自动滚动）；点击某条字幕 → 视频跳转到对应 `start` 时间点。

### 3. AI 问答
- 协议：OpenAI 兼容协议 + DeepSeek（DeepSeek 本身就是 OpenAI 兼容协议，`base_url=https://api.deepseek.com`），后端统一用 `openai` Python SDK，区别只在配置（api_key/base_url/model）；前端请求一律走后端，不直连模型 API。
- 上下文构造：发送问题时，默认附带「当前视频总结」（由字幕全文生成一次并缓存）+ 用户问题。
- 可勾选「发送当前字幕」：附加上下文为当前播放时间戳对应字幕 + 其上 10 条字幕。
- 多轮问答：前端维护 messages 历史，随请求发送（含必要的上下文注入）。
- 可勾选「发送当前视频帧」：前端 canvas 截取当前帧 → base64 图片随消息发送（多模态 user message）。
  - 仅当所选模型支持图片理解时可用；DeepSeek 目前不支持 → 选择 deepseek 时禁用该选项。
- 流式输出：SSE（`stream=True`）。

### 4. 视频转录（ASR）
- 两种模式：
  - **非实时转录**：先对整个视频音频一次性转录完成，再展示完整字幕。
  - **实时转录**：边看边转。以当前播放进度为锚点，向前推进：silero-vad 将后续音频切成若干语音段（每段对应一条字幕），逐段送 ASR，转完一段出一条字幕，前端增量渲染。
- 两种模型：
  - `faster-whisper`：原生输出句级时间戳，非实时模式直接用；内置 VAD（`vad_filter=True`）。
  - `FunASR/SenseVoiceSmall`：不输出时间戳，必须 silero-vad 先切段再逐段识别；输出含 `<|...|>` 特殊 token 需过滤。
- 参考实现：`/home/pupa/subtitle_pipeline`（可直接借鉴/移植）：
  - `asr/faster_whisper_asr.py` — `WhisperModel.transcribe(..., vad_filter=True)`，物化 segments 取 `(start, end, text)`。
  - `asr/funasr.py` — `funasr.AutoModel(model="iic/SenseVoiceSmall")`，`generate(input=..., language=..., use_itn=True)`，正则剥 `<|...|>` 标签。
  - `vad/silero.py` — `silero_vad.load_silero_vad()` + `get_speech_timestamps(...)`，返回采样点级 start/end。

### 5. 配置管理（设置面板）
- 前端提供「设置」面板（modal），后端提供配置接口，运行期可改、持久化到 `data/config.json`（启动时加载，env 可覆盖）。
- 配置项：
  - LLM：提供商（`deepseek` / `openai` 兼容）、api_key、base_url（按提供商给默认值，可改）、model（手填或拉取模型列表）。提供商决定能力开关：deepseek → 禁用「发送当前视频帧」。
  - B站 cookies：上传 Netscape 格式 cookies 文件（存 `data/cookies.txt`），yt-dlp 以 `cookiefile` 参数使用；上传状态在设置面板显示（未上传时 B站官方字幕来源置灰提示）。
  - ASR：模型选择（faster-whisper / SenseVoiceSmall）、设备（cpu/cuda）、语言；未安装 asr 依赖组时置灰。
- 接口：`GET /api/config`（返回脱敏配置，api_key 打码）、`PUT /api/config`、`POST /api/config/cookies`（文件上传）。

## 二、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 包管理 | uv | 已有 pyproject.toml，依赖用 `uv add` 管理 |
| 后端 | FastAPI + uvicorn | 文件上传、字幕/转录/问答 API、SSE 流式 |
| 前端 | 原生 HTML/CSS/JS（单页，FastAPI 静态托管） | 不引入构建链，保持简单；视频用原生 `<video>` |
| LLM | openai Python SDK | 兼容 OpenAI 与 DeepSeek（仅换 base_url/api_key/model） |
| ASR | faster-whisper、funasr（SenseVoiceSmall） | 模型较重，做成 uv optional 依赖组 |
| VAD | silero-vad（pip 包） | 实时转录分段 + SenseVoice 时间戳对齐 |
| 音视频处理 | ffmpeg（系统命令） | 从视频抽 16kHz 单声道 wav、按时间段切片、B站双轨 remux |
| B站 | yt-dlp（Python 库模式） | 链接解析、元信息、直链、官方字幕（字幕需 cookies） |

### 依赖草案（pyproject.toml）
- 核心：`fastapi uvicorn openai httpx python-multipart yt-dlp`
- 可选组 `[project.optional-dependencies] asr`：`faster-whisper funasr silero-vad torch torchaudio soundfile numpy`
  - torch 体积大，用户按需 `uv sync --extra asr`；不装 ASR 组时转录功能置灰。

## 三、项目结构（规划）

```
video_learn_helper/
├── pyproject.toml            # uv 管理，依赖见上
├── PLAN.md                   # 本文件
├── main.py                   # 入口：启动 uvicorn
├── app/
│   ├── server.py             # FastAPI app、路由注册、静态托管
│   ├── config.py             # 配置（api_key/base_url/model、ASR 模型、设备），env + config.yaml
│   ├── api/
│   │   ├── video.py          # 上传本地视频、B站链接解析（取直链 + 元信息）
│   │   ├── subtitle.py       # SRT 上传解析、B站字幕拉取、字幕查询（当前时间 → 字幕索引）
│   │   ├── transcribe.py     # 转录任务：非实时（整段）/ 实时（按进度增量），SSE 推送进度与字幕
│   │   ├── chat.py           # AI 问答（多轮、总结注入、字幕上下文、图片帧），SSE 流式
│   │   └── config.py         # 配置读写（LLM/ASR）、B站 cookies 上传
│   ├── services/
│   │   ├── asr/
│   │   │   ├── base.py           # ASR 抽象：transcribe / transcribe_with_timestamps
│   │   │   ├── faster_whisper_asr.py  # 移植自 subtitle_pipeline/asr/faster_whisper_asr.py
│   │   │   └── sensevoice.py          # 移植自 subtitle_pipeline/asr/funasr.py
│   │   ├── vad/
│   │   │   └── silero.py         # 移植自 subtitle_pipeline/vad/silero.py
│   │   ├── bilibili.py       # yt-dlp 封装：extract_info 取元信息/直链/字幕，ffmpeg remux 缓存
│   │   ├── media.py          # ffmpeg 封装：抽音频、切片、（备用）抽帧
│   │   ├── subtitle.py       # SRT 解析/生成、B站字幕 json → 统一 Subtitle(start,end,text) 结构
│   │   └── llm.py            # OpenAI 兼容客户端：总结生成、多轮问答、流式、多模态消息
│   └── static/               # 前端
│       ├── index.html        # 三栏布局：视频区 | 字幕区 | AI 问答区（按线框图）
│       ├── style.css
│       └── main.js           # 播放器控制、字幕同步/跳转、问答 UI、截帧、SSE 消费
├── data/                     # 运行期产物（gitignore）：上传的视频、音频、字幕缓存、模型缓存
└── tests/
```

## 四、实施阶段

1. **骨架与基础播放**
   - uv 初始化核心依赖；FastAPI 骨架 + 静态页三栏布局 + 设置面板。
   - 本地视频上传与播放；SRT 上传解析；字幕列表渲染、当前句高亮、点击跳转。
   - 配置接口：LLM/ASR 配置读写、B站 cookies 上传，持久化到 `data/config.json`。
2. **AI 问答**
   - llm.py：OpenAI/DeepSeek 配置切换、多轮 messages、SSE 流式。
   - 视频总结生成与缓存；「发送当前字幕」（当前 + 前 10 条）注入；「发送当前视频帧」（canvas 截帧 base64，deepseek 时禁用）。
3. **非实时转录**
   - ffmpeg 抽音频；faster-whisper 整段转录；SenseVoice + silero-vad 分段转录；转录进度 SSE 推送，结果写入字幕区并可导出 SRT。
4. **实时转录**
   - 播放进度上报 → 后端维护「转录游标」，silero-vad 从游标向后切段、逐段 ASR、增量产出字幕（SSE），前端边播边显示。
5. **B站支持**
   - yt-dlp 解析链接 → ffmpeg remux 缓存 mp4 → 接入与本地视频一致的播放/字幕/转录流程；官方字幕拉取接入字幕区。
6. **收尾**
   - README（安装、ffmpeg 前置、运行方式）；简单测试（SRT 解析、字幕定位、上下文构造）。

## 五、参考文档与项目链接

- DeepSeek API 文档：https://api-docs.deepseek.com/zh-cn/
- OpenAI API 参考：https://platform.openai.com/docs/api-reference （chat/completions、多模态消息格式）
- faster-whisper：https://github.com/SYSTRAN/faster-whisper
- FunASR：https://github.com/modelscope/FunASR
- SenseVoice：https://github.com/FunAudioLLM/SenseVoice
- silero-vad：https://github.com/snakers4/silero-vad
- FastAPI：https://fastapi.tiangolo.com/zh/
- uv：https://docs.astral.sh/uv/
- yt-dlp（含 Python API 说明）：https://github.com/yt-dlp/yt-dlp#embedding-yt-dlp
- ffmpeg：https://ffmpeg.org/documentation.html
- 本项目 ASR 参考实现：`/home/pupa/subtitle_pipeline`（`asr/`、`vad/` 目录）

## 六、已知风险与前置条件

- **B站直链**：未登录仅 360p~720p；官方字幕必须 cookies；接口有风控/失效可能，需明确错误提示。
- **模型体积**：torch/funasr/faster-whisper 依赖较大（GB 级），用 uv optional extras 隔离；首次运行需下载模型权重。
- **ffmpeg**：需用户系统预装，README 中注明。
- **实时转录性能**：CPU 上 SenseVoiceSmall 较快、faster-whisper 视模型大小而定；转录游标需领先播放进度，否则字幕出现延迟，需在 UI 上提示「转录中」。
