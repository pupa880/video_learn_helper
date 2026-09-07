/* 视频学习助手前端：播放器控制、字幕同步/跳转、问答、截帧、SSE 消费 */

const $ = (id) => document.getElementById(id);

const state = {
  videoId: null,
  video: null,        // 当前用户库记录
  cues: [],
  summary: null,      // 当前视频总结（用户库）
  messages: [],       // 当前视频的问答历史 {role, content, ui?}
  config: null,
  transcribeTask: null,
  transcribeMode: null,
  lastPosReport: 0,
  sending: false,
  nosubDismissed: false,
  nosubNoted: false,
  kind: null,         // B站串流类型：dash（走 HLS）/ muxed（直接代理）
  streaming: false,   // B站在线串流（无本地文件）
  hls: null,          // Hls.js 实例，换视频时销毁
  dash: null,         // dash.js 实例，换视频时销毁
  blobUrl: null,      // 本地文件的 object URL
  pendingAttach: null, // 重新选择本地文件时要绑回的库记录
  resumeAt: null,     // 片源挂上后要恢复的秒数
  resumePlay: false,  // 切清晰度后是否继续播
  mediaUpload: null,  // 本地文件后台上传 Promise
};

// 调试：Console 里 `state.messages`（历史）/ `lastLlmMessages`（含 system 的完整列表）
window.state = state;
window.lastChatPayload = null;
window.lastLlmMessages = null;

/* ---------- Markdown 渲染（markdown-it + CJK 友好插件，CDN 动态加载） ---------- */

let md = null; // null 时降级为纯文本
(async () => {
  try {
    const [{ default: MarkdownIt }, { default: cjkFriendly }] = await Promise.all([
      import('https://cdn.jsdelivr.net/npm/markdown-it@14/+esm'),
      import('https://cdn.jsdelivr.net/npm/markdown-it-cjk-friendly/+esm'),
    ]);
    md = new MarkdownIt({ html: false, linkify: true }).use(cjkFriendly);
  } catch { /* CDN 不可用时保持纯文本渲染 */ }
})();

function renderMd(text) {
  if (md) return md.render(text);
  return escapeHtml(text).replace(/\n/g, '<br>');
}

/* ---------- 通用 ---------- */

async function api(path, opts = {}) {
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    let detail = resp.statusText;
    try { detail = (await resp.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return resp.json();
}

function fmtTime(sec) {
  if (!Number.isFinite(sec)) sec = 0;
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* 有效时长：DASH 串流（ffmpeg 实时混流）的 duration 是 Infinity，回落到解析出的元信息时长 */
function videoDuration() {
  const d = $('player').duration;
  return Number.isFinite(d) && d > 0 ? d : (state.duration || 0);
}

function setHint(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.style.color = isError ? '#dc2626' : '';
}

/* 置灰控件的悬浮提示：有 .tip 包裹层就写到 data-tip（disabled 按钮不触发原生 title） */
function setTip(id, text) {
  const el = $(id);
  const wrap = el.closest('.tip');
  if (wrap) wrap.dataset.tip = text || '';
  else el.title = text || '';
}

/* 读取 POST SSE 流，逐事件回调 */
async function consumeSSE(resp, onEvent) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try { onEvent(JSON.parse(line.slice(6))); } catch {}
    }
  }
}

/* 通用进度条：percent 为 null 时显示不确定动画，否则显示百分比 */
function createProgress(boxId, barId, textId) {
  const box = $(boxId), bar = $(barId), text = $(textId);
  return {
    update(percent, msg) {
      box.hidden = false;
      if (msg != null) text.textContent = msg;
      if (percent == null) {
        box.classList.add('indeterminate');
        bar.style.width = '';
      } else {
        box.classList.remove('indeterminate');
        bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      }
    },
    hide() {
      box.hidden = true;
      box.classList.remove('indeterminate');
      bar.style.width = '0';
    },
  };
}

/* fetch 拿不到上传进度，大文件上传用 XHR（upload.onprogress） */
function uploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total * 100);
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.detail || '上传失败'));
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(formData);
  });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

