/* 视频学习助手前端：播放器控制、字幕同步/跳转、问答、截帧、SSE 消费 */

const $ = (id) => document.getElementById(id);

const state = {
  videoId: null,
  cues: [],
  messages: [],       // 多轮问答历史 {role, content}
  config: null,
  transcribeTask: null,
  transcribeMode: null,
  lastPosReport: 0,
  sending: false,
  nosubDismissed: false,
  nosubNoted: false,
  kind: null,         // B站串流类型：dash（走 HLS）/ muxed（直接代理）
  hls: null,          // Hls.js 实例，换视频时销毁
  dash: null,         // dash.js 实例，换视频时销毁
};

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

/* ---------- 播放器自定义控制条（不遮挡画面） ---------- */

function togglePlay() {
  const v = $('player');
  if (!state.videoId) return;
  v.paused ? v.play() : v.pause();
}

$('btn-play').addEventListener('click', togglePlay);
$('player').addEventListener('click', togglePlay);
$('player').addEventListener('play', () => { $('btn-play').textContent = '⏸'; });
$('player').addEventListener('pause', () => { $('btn-play').textContent = '▶'; });

$('seek-bar').addEventListener('input', () => {
  const v = $('player');
  const dur = videoDuration();
  if (dur) v.currentTime = ($('seek-bar').value / 1000) * dur;
});

$('player').addEventListener('timeupdate', () => {
  const v = $('player');
  const dur = videoDuration();
  if (dur) {
    $('seek-bar').value = Math.round((v.currentTime / dur) * 1000);
    $('time-display').textContent = `${fmtTime(v.currentTime)} / ${fmtTime(dur)}`;
  }
});
$('player').addEventListener('loadedmetadata', () => {
  $('time-display').textContent = `00:00 / ${fmtTime(videoDuration())}`;
});
/* 视频文件加载失败（404/网络/格式不支持）：标题栏给出明确错误 */
$('player').addEventListener('error', () => {
  if (state.videoId && $('player').src) {
    setHint('video-title', '视频加载失败，请重试或检查文件', true);
  }
});

function updateMuteIcon() {
  const v = $('player');
  $('btn-mute').textContent = v.muted || v.volume === 0 ? '🔇' : '🔊';
}
$('btn-mute').addEventListener('click', () => {
  $('player').muted = !$('player').muted;
  updateMuteIcon();
});
$('volume-bar').addEventListener('input', () => {
  $('player').volume = Number($('volume-bar').value);
  $('player').muted = false;
  updateMuteIcon();
});

$('btn-fullscreen').addEventListener('click', () => {
  const box = $('player-box');
  if (document.fullscreenElement) document.exitFullscreen();
  else if (box.requestFullscreen) box.requestFullscreen();
});

/* ---------- 视频 ---------- */

const videoProgress = createProgress('dl-progress', 'dl-bar-inner', 'dl-text');
const landingProgress = createProgress('landing-progress', 'landing-bar-inner', 'landing-text');
const transcribeProgress = createProgress('ts-progress', 'ts-bar-inner', 'ts-text');

const captionPref = {
  on: (() => {
    try { return localStorage.getItem('vlh-caption') !== '0'; } catch { return true; }
  })(),
};

function setWorkspace(on) {
  document.body.classList.toggle('has-video', !!on);
  if (on) window.dispatchEvent(new Event('resize'));
}

function syncCaptionUI() {
  $('btn-caption').classList.toggle('is-on', captionPref.on);
  $('btn-caption').setAttribute('aria-pressed', captionPref.on ? 'true' : 'false');
  $('menu-caption').setAttribute('aria-checked', captionPref.on ? 'true' : 'false');
  updateVideoCaption();
}

function setCaptionOn(on) {
  captionPref.on = !!on;
  try { localStorage.setItem('vlh-caption', on ? '1' : '0'); } catch { /* 隐私模式 */ }
  syncCaptionUI();
}

function updateVideoCaption() {
  const el = $('video-caption');
  if (!captionPref.on || !state.cues.length) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const t = $('player').currentTime || 0;
  const cue = state.cues.find((c) => t >= c.start && t < c.end)
    || null;
  if (!cue) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.textContent = cue.text;
  el.hidden = false;
}

function updateComposerCue() {
  const el = $('composer-cue');
  if (!$('chk-subtitles').checked) {
    el.hidden = true;
    return;
  }
  const cue = currentCueAt($('player').currentTime || 0);
  if (!cue) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = `${fmtTime(cue.start)}  ${cue.text}`;
}

/* 挂载播放源：DASH 串流优先走 dash.js 直读双轨（可随意拖动），失败回退 HLS 混流；
   本地文件/muxed 代理直接设 src */
function attachSource() {
  const v = $('player');
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  if (state.dash) {
    state.dash.destroy();
    state.dash = null;
  }
  v.removeAttribute('src');
  v.load();
  if (state.kind === 'dash' && state.needsDownload) {
    if (window.dashjs) {
      state.dash = dashjs.MediaPlayer().create();
      const mpd = new URL(`/api/video/${state.videoId}/manifest.mpd`, location.origin).href;
      state.dash.initialize(v, mpd, false);
      state.dash.on(dashjs.MediaPlayer.events.ERROR, () => {
        // dash.js 链路失败（如 CDN 索引读取异常）时回退到 HLS 混流
        if (!state.dash) return;
        state.dash.destroy();
        state.dash = null;
        attachHls(v);
      });
      return;
    }
    attachHls(v);
    return;
  }
  v.src = `/api/video/${state.videoId}/file?t=${Date.now()}`;
}

function attachHls(v) {
  const url = `/api/video/${state.videoId}/hls/index.m3u8`;
  if (window.Hls && Hls.isSupported()) {
    state.hls = new Hls();
    state.hls.loadSource(url);
    state.hls.attachMedia(v);
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = url; // Safari 原生 HLS
  }
}

function setVideo(videoId, name, opts = {}) {
  // 换视频时停掉进行中的转录，避免旧任务的字幕串入新视频
  if (state.transcribeTask) {
    api('/api/transcribe/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: state.transcribeTask }),
    }).catch(() => {});
    state.transcribeTask = null;
    state.transcribeMode = null;
  }
  transcribeProgress.hide();
  setHint('transcribe-status', '');
  state.videoId = videoId;
  state.videoUrl = opts.url || null;
  state.needsDownload = !!opts.needsDownload;
  state.hasAudio = !!opts.hasAudio;
  state.duration = opts.duration || 0;
  state.kind = opts.kind || null;
  state.qualities = opts.qualities || null;
  state.height = opts.height || 0;
  state.cues = [];
  attachSource();
  $('time-display').textContent = `00:00 / ${fmtTime(state.duration)}`;
  setHint('video-title', name || '');
  $('btn-summary').disabled = false;
  setTip('btn-summary', '');
  updateSubtitleControls();
  state.nosubDismissed = false;
  state.nosubNoted = false;
  updateQualitySelect();
  renderSubtitles();
  updateVideoCaption();
  updateComposerCue();
  updateNoSubHint();
  setWorkspace(true);
  // B站视频：加载后自动拉取官方字幕（已有缓存字幕时不重复拉）
  loadSubtitles().then(() => {
    if (opts.autoSubtitles && !state.cues.length) autoLoadBiliSubtitle();
    updateVideoCaption();
    updateComposerCue();
  });
  refreshRecentVideos();
}

function closeVideo() {
  if (state.transcribeTask) {
    api('/api/transcribe/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: state.transcribeTask }),
    }).catch(() => {});
    state.transcribeTask = null;
    state.transcribeMode = null;
  }
  const v = $('player');
  v.pause();
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  if (state.dash) { state.dash.destroy(); state.dash = null; }
  v.removeAttribute('src');
  v.load();
  state.videoId = null;
  state.cues = [];
  state.nosubDismissed = false;
  state.nosubNoted = false;
  state.kind = null;
  state.needsDownload = false;
  setHint('video-title', '');
  $('btn-summary').disabled = true;
  setTip('btn-summary', '请先加载视频');
  renderSubtitles();
  updateVideoCaption();
  updateComposerCue();
  updateNoSubHint();
  setWorkspace(false);
  refreshRecentVideos();
}

/* 控制条清晰度选择：仅 B站串流（未下载到本地）且有解析到的档位时显示 */
function updateQualitySelect() {
  const sel = $('quality-select');
  const q = state.qualities;
  if (!state.videoId || !state.needsDownload || !q?.length) {
    sel.hidden = true;
    return;
  }
  sel.hidden = false;
  fillSelect(sel, [...q].reverse().map((x) => [String(x.height), x.label]),
             String(state.height || q[q.length - 1].height));
}

/* 切换清晰度：复用同一 video_id 换串流地址，保持播放位置和字幕 */
$('quality-select').addEventListener('change', async (e) => {
  const h = Number(e.target.value);
  if (!h || !state.videoId) return;
  const v = $('player');
  const t = v.currentTime;
  const playing = !v.paused;
  $('quality-select').disabled = true;
  try {
    const data = await api('/api/video/bilibili/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: state.videoId, max_height: h }),
    });
    state.height = data.height;
    state.kind = data.kind;
    if (data.qualities?.length) state.qualities = data.qualities;
    const resume = () => {
      v.currentTime = t;
      if (playing) v.play();
      v.removeEventListener('loadedmetadata', resume);
    };
    v.addEventListener('loadedmetadata', resume);
    attachSource();
  } catch (err) {
    setHint('video-title', `切换清晰度失败：${err.message}`, true);
    // 实际档位未变，恢复下拉选中值，避免显示与实际不一致
    $('quality-select').value = String(state.height || '');
  } finally {
    $('quality-select').disabled = false;
  }
});

/* B站视频加载后自动拉官方字幕；未上传 cookies 时提示可手动选其他来源 */
async function autoLoadBiliSubtitle() {
  if (!state.config?.bilibili.cookies_uploaded) {
    setHint('transcribe-status', '未上传 B站 cookies，无法自动拉取官方字幕，可在字幕菜单中选择其他方式');
    return;
  }
  await loadBilibiliSubtitle();
}

$('file-video').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  const onLanding = !document.body.classList.contains('has-video');
  const prog = onLanding ? landingProgress : videoProgress;
  if (!onLanding) setHint('video-title', `上传中：${file.name}`);
  prog.update(0, '上传中 0%');
  try {
    const data = await uploadWithProgress('/api/video/upload', fd, (pct) => {
      if (pct >= 100) prog.update(null, '上传完成，处理中…');
      else prog.update(pct, `上传中 ${Math.floor(pct)}%`);
    });
    prog.hide();
    setVideo(data.video_id, data.name);
  } catch (err) {
    prog.hide();
    if (onLanding) landingProgress.update(null, `上传失败：${err.message}`);
    else setHint('video-title', `上传失败：${err.message}`, true);
  }
  e.target.value = '';
});

/* ---------- B站加载弹窗：解析一次拿到标题/分P/清晰度，再选在线播放或下载 ---------- */

const biliState = { info: null, parseTimer: null, parseSeq: 0 };

function updateBiliModal() {
  const info = biliState.info;
  $('bili-info').hidden = !info;
  $('btn-bili-stream').disabled = !info;
  if (!info) return;
  $('bili-info-title').textContent =
    `${info.title}${info.uploader ? ` — ${info.uploader}` : ''}` +
    (info.duration ? `（${fmtTime(info.duration)}）` : '');
  // 分P：仅多P视频显示
  const parts = info.parts || [];
  $('bili-part-row').hidden = parts.length <= 1;
  if (parts.length > 1) {
    fillSelect($('bili-part'),
      parts.map((p) => [String(p.page), `P${p.page} ${p.title}`.slice(0, 60)]),
      String(info.page || 1));
  }
  // 清晰度：用解析到的真实档位（label 按 B站 qn 档显示，value 是该档实际像素高）
  const quals = info.qualities?.length
    ? info.qualities
    : [360, 480, 720].map((h) => ({ height: h, label: `${h}P` }));
  const def = quals.find((q) => q.label === '720P') || quals[quals.length - 1];
  fillSelect($('bili-quality'),
    [...quals].reverse().map((q) => [String(q.height), q.label]),
    String(def.height));
}

async function parseBiliInfo(url) {
  const seq = ++biliState.parseSeq;
  const status = $('bili-modal-status');
  status.textContent = '解析中';
  status.classList.add('waiting');
  status.style.color = '';
  try {
    const info = await api('/api/video/bilibili/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (seq !== biliState.parseSeq) return;  // 已过期（用户又改了链接）
    biliState.info = info;
    status.textContent = '';
  } catch (err) {
    if (seq !== biliState.parseSeq) return;
    biliState.info = null;
    status.textContent = `解析失败：${err.message}`;
    status.style.color = '#dc2626';
  } finally {
    status.classList.remove('waiting');
    if (seq === biliState.parseSeq) updateBiliModal();
  }
}

$('btn-bili').addEventListener('click', () => {
  // 重置上次的状态（按钮禁用态、残留提示），已解析过的链接直接复用结果
  $('bili-modal-status').textContent = '';
  $('bili-modal-status').style.color = '';
  updateBiliModal();
  $('bili-modal').hidden = false;
  $('bili-url').focus();
  const url = $('bili-url').value.trim();
  if (url && !biliState.info) parseBiliInfo(url);
});
$('btn-bili-cancel').addEventListener('click', () => { $('bili-modal').hidden = true; });

$('bili-url').addEventListener('input', () => {
  biliState.info = null;
  updateBiliModal();
  clearTimeout(biliState.parseTimer);
  const url = $('bili-url').value.trim();
  if (!url) { $('bili-modal-status').textContent = ''; return; }
  biliState.parseTimer = setTimeout(() => parseBiliInfo(url), 600);
});

$('bili-part').addEventListener('change', () => {
  const info = biliState.info;
  if (!info) return;
  const parts = info.parts || [];
  const page = Number($('bili-part').value) || 1;
  const part = parts.find((p) => p.page === page);
  const dur = part?.duration || info.duration;
  $('bili-info-title').textContent =
    `${info.title}${info.uploader ? ` — ${info.uploader}` : ''}` +
    (part?.title ? ` · P${page} ${part.title}` : '') +
    (dur ? `（${fmtTime(dur)}）` : '');
});

function biliRequestBody() {
  return {
    url: $('bili-url').value.trim(),
    max_height: Number($('bili-quality').value) || 720,
    page: Number($('bili-part').value) || 1,
  };
}

/* 秒开：只解析播放地址，直接串流播放，不下载完整视频 */
$('btn-bili-stream').addEventListener('click', async () => {
  if (!biliState.info) return;
  $('btn-bili-stream').disabled = true;
  setHint('bili-modal-status', '获取播放地址…');
  try {
    const data = await api('/api/video/bilibili/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(biliRequestBody()),
    });
    $('bili-modal').hidden = true;
    setVideo(data.video_id, data.name, {
      needsDownload: !data.has_file,
      url: data.url,
      autoSubtitles: true,
      duration: data.duration,
      qualities: data.qualities || biliState.info.qualities,
      height: data.height,
      kind: data.kind,
      hasAudio: data.has_audio,
    });
  } catch (err) {
    setHint('bili-modal-status', `失败：${err.message}`, true);
  } finally {
    $('btn-bili-stream').disabled = false;
  }
});

/* 轮询下载任务进度（进度条 + 文本），完成后 resolve(task.result) */
function pollDownloadTask(task_id) {
  videoProgress.update(0, '下载中…');
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      const done = (err, task) => {
        clearInterval(timer);
        videoProgress.hide();
        err ? reject(err) : resolve(task?.result);
      };
      try {
        const task = await api(`/api/tasks/${task_id}`);
        videoProgress.update(task.percent ?? null, task.progress || '下载中…');
        if (task.status === 'done') done(null, task);
        else if (task.status === 'error') done(new Error(task.error || '下载失败'));
      } catch (e) {
        done(e);
      }
    }, 1000);
  });
}

/* 转录前补下载：只下载音频轨（远快于整视频），不影响继续在线播放 */
async function downloadCurrentAudio() {
  const { task_id } = await api('/api/video/bilibili/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: state.videoId, audio_only: true }),
  });
  await pollDownloadTask(task_id);
  state.hasAudio = true;
}

async function openRecent(v) {
  if (v.source === 'bilibili' && !v.has_file) {
    const onLanding = !document.body.classList.contains('has-video');
    if (onLanding) landingProgress.update(null, '正在打开…');
    try {
      const data = await api('/api/video/bilibili/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_id: v.id, url: v.url || '' }),
      });
      if (onLanding) landingProgress.hide();
      setVideo(data.video_id, data.name, {
        needsDownload: !data.has_file,
        url: data.url,
        autoSubtitles: true,
        duration: data.duration,
        height: data.height,
        kind: data.kind,
        qualities: data.qualities || v.qualities,
        hasAudio: data.has_audio || v.has_audio,
      });
    } catch (err) {
      if (onLanding) landingProgress.update(null, `加载失败：${err.message}`);
      else setHint('video-title', `加载失败：${err.message}`, true);
    }
    return;
  }
  setVideo(v.id, v.name, {
    duration: v.duration,
    kind: v.has_file ? null : v.kind,
    needsDownload: !v.has_file,
    hasAudio: v.has_audio,
    qualities: v.qualities,
  });
}

function dedupeVideos(videos) {
  const seen = new Set();
  const out = [];
  for (const v of videos) {
    const key = v.url || `${v.source || ''}:${v.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

async function refreshRecentVideos() {
  try {
    const { videos } = await api('/api/video/list');
    const unique = dedupeVideos(videos);
    const landing = $('landing-recent');
    const landingList = $('landing-recent-list');
    const menu = $('menu-recent');
    landingList.innerHTML = '';
    menu.innerHTML = '';
    if (!unique.length) {
      landing.hidden = true;
      const empty = document.createElement('div');
      empty.className = 'menu-empty';
      empty.textContent = '暂无';
      menu.append(empty);
      return;
    }
    landing.hidden = false;
    for (const v of unique.slice(0, 8)) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'rv-name';
      name.textContent = v.name || v.id;
      const meta = document.createElement('span');
      meta.className = 'rv-meta';
      meta.textContent = v.duration ? fmtTime(v.duration) : '';
      li.append(name, meta);
      li.addEventListener('click', () => openRecent(v));
      landingList.append(li);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = (v.name || v.id).slice(0, 36);
      btn.addEventListener('click', () => openRecent(v));
      menu.append(btn);
    }
  } catch {}
}

/* ---------- 字幕 ---------- */

function renderSubtitles() {
  const list = $('subtitle-list');
  list.innerHTML = '';
  // 无字幕时给出占位提示，避免用户对着空白区域疑惑
  if (!state.cues.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = state.videoId
      ? '暂无字幕，点右上角 ⋮ 加载'
      : '加载视频后可在此查看和定位字幕';
    list.appendChild(li);
    updateNoSubHint();
    return;
  }
  state.cues.forEach((cue, i) => {
    const li = document.createElement('li');
    li.dataset.index = i;
    li.innerHTML = `<span class="ts">${fmtTime(cue.start)}</span>${escapeHtml(cue.text)}`;
    li.addEventListener('click', () => { $('player').currentTime = cue.start + 0.01; });
    list.appendChild(li);
  });
  updateNoSubHint();
}

function appendCue(cue) {
  state.cues.push(cue);
  const li = document.createElement('li');
  li.dataset.index = state.cues.length - 1;
  li.innerHTML = `<span class="ts">${fmtTime(cue.start)}</span>${escapeHtml(cue.text)}`;
  li.addEventListener('click', () => { $('player').currentTime = cue.start + 0.01; });
  $('subtitle-list').appendChild(li);
  updateVideoCaption();
  updateNoSubHint();
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

async function loadSubtitles() {
  if (!state.videoId) return;
  try {
    const { cues } = await api(`/api/subtitle/${state.videoId}`);
    state.cues = cues;
    renderSubtitles();
    updateVideoCaption();
    updateComposerCue();
  } catch {}
}

/* 用户手动滚动/触摸后暂停自动跟随，4 秒无操作恢复 */
let lastUserScroll = 0;
for (const evt of ['wheel', 'touchmove', 'pointerdown']) {
  $('subtitle-list').addEventListener(evt, () => { lastUserScroll = Date.now(); }, { passive: true });
}

let lastCueIdx = -1;

function scrollCueToCenter(li) {
  const list = $('subtitle-list');
  list.scrollTo({
    top: li.offsetTop - list.clientHeight / 2 + li.clientHeight / 2,
    behavior: 'smooth',
  });
}

$('player').addEventListener('timeupdate', () => {
  const t = $('player').currentTime;
  // 高亮当前句
  let idx = -1;
  for (let i = 0; i < state.cues.length; i++) {
    if (state.cues[i].start <= t) idx = i; else break;
  }
  const items = $('subtitle-list').children;
  for (const li of items) li.classList.toggle('current', Number(li.dataset.index) === idx);
  // 当前句变化时滚动到字幕区中间（用户正在手动浏览时不打扰）
  if (idx !== lastCueIdx) {
    if (idx >= 0 && items[idx] && Date.now() - lastUserScroll > 4000) {
      scrollCueToCenter(items[idx]);
    }
    lastCueIdx = idx;
  }
  updateVideoCaption();
  updateComposerCue();
  // 实时转录：节流上报播放进度
  if (state.transcribeTask && state.transcribeMode === 'realtime' && t - state.lastPosReport > 2) {
    state.lastPosReport = t;
    api('/api/transcribe/position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: state.transcribeTask, position: t }),
    }).catch(() => {});
  }
});

$('file-srt').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !state.videoId) return setHint('transcribe-status', '请先加载视频', true);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const resp = await fetch(`/api/subtitle/upload?video_id=${state.videoId}`, { method: 'POST', body: fd });
    if (!resp.ok) throw new Error((await resp.json()).detail || '上传失败');
    const data = await resp.json();
    state.cues = data.cues;
    renderSubtitles();
    updateVideoCaption();
    updateComposerCue();
    setHint('transcribe-status', `已加载 ${data.cues.length} 条字幕`);
  } catch (err) {
    setHint('transcribe-status', `SRT 上传失败：${err.message}`, true);
  }
  e.target.value = '';
});

/* 导出当前字幕为 SRT 文件 */
$('btn-export-srt').addEventListener('click', () => {
  if (!state.cues.length) return setHint('transcribe-status', '没有可导出的字幕', true);
  const ts = (sec) => {
    let ms = Math.round(Math.max(0, sec) * 1000);
    const h = Math.floor(ms / 3600000); ms %= 3600000;
    const m = Math.floor(ms / 60000); ms %= 60000;
    const s = Math.floor(ms / 1000); ms %= 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  const srt = state.cues
    .map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}`)
    .join('\n\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([srt], { type: 'text/plain;charset=utf-8' }));
  a.download = `${($('video-title').textContent || 'subtitles').replace(/[\\/:*?"<>|]/g, '_')}.srt`;
  a.click();
  URL.revokeObjectURL(a.href);
  setHint('transcribe-status', `已导出 ${state.cues.length} 条字幕`);
});

async function loadBilibiliSubtitle() {
  if (!state.videoId) return;
  transcribeProgress.update(null, '拉取 B站官方字幕中…');
  try {
    const data = await api('/api/subtitle/bilibili', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: state.videoId }),
    });
    state.cues = data.cues;
    renderSubtitles();
    updateVideoCaption();
    updateComposerCue();
    setHint('transcribe-status', `已加载 ${data.cues.length} 条字幕`);
  } catch (err) {
    setHint('transcribe-status', `拉取失败：${err.message}`, true);
  } finally {
    transcribeProgress.hide();
  }
}

/* ---------- 转录 ---------- */

function updateSubtitleControls() {
  const c = state.config;
  const busy = !!state.transcribeTask;
  $('btn-transcribe-stop').hidden = !busy;
  $('menu-transcribe').disabled = busy || !c?.asr_available;
  $('menu-bili-sub').disabled = !c?.bilibili.cookies_uploaded;
  $('menu-srt').disabled = busy;
  $('menu-transcribe').title = !c?.asr_available ? '需安装 ASR 依赖组' : '';
  $('menu-bili-sub').title = !c?.bilibili.cookies_uploaded ? '需上传 B站 cookies' : '';
}

async function startTranscribe(mode) {
  if (!state.videoId) return;
  // 在线串流的视频没有本地文件，转录前需补下载音频（已下载过则跳过）
  if (state.needsDownload && !state.hasAudio) {
    if (!confirm('转录需要先把音频下载到本地（只下载音频，可继续在线播放），现在开始吗？')) return;
    try {
      await downloadCurrentAudio();
    } catch (err) {
      setHint('transcribe-status', `音频下载失败：${err.message}`, true);
      return;
    }
  }
  // 实时：保留当前进度之前的字幕；整段：清空后重来，避免和旧字幕叠在一起
  if (mode === 'realtime') {
    const t = $('player').currentTime || 0;
    state.cues = state.cues.filter((c) => c.start < t);
  } else {
    state.cues = [];
  }
  renderSubtitles();
  updateVideoCaption();
  updateComposerCue();

  try {
    const { task_id } = await api('/api/transcribe/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: state.videoId,
        mode,
        start_position: $('player').currentTime || 0,
      }),
    });
    state.transcribeTask = task_id;
    state.transcribeMode = mode;
    state.lastPosReport = 0;
    updateSubtitleControls();
    setHint('transcribe-status', '');
    transcribeProgress.update(null, mode === 'realtime' ? '实时转录启动中…' : '转录启动中…');

    const resp = await fetch(`/api/transcribe/stream/${task_id}`);
    if (!resp.ok) {
      let detail = resp.statusText;
      try { detail = (await resp.json()).detail || detail; } catch {}
      throw new Error(detail);
    }
    await consumeSSE(resp, (ev) => {
      // 任务已被停止或用户切换了视频，忽略残留事件
      if (state.transcribeTask !== task_id) return;
      if (ev.type === 'progress') transcribeProgress.update(ev.percent ?? null, ev.text);
      else if (ev.type === 'trim') {
        state.cues = ev.cues || state.cues.filter((c) => c.start < ev.before);
        renderSubtitles();
        updateVideoCaption();
        updateComposerCue();
      }
      else if (ev.type === 'cue') appendCue(ev.cue);
      else if (ev.type === 'done') {
        transcribeProgress.hide();
        setHint('transcribe-status', `转录完成，共 ${ev.count} 条`);
        state.transcribeTask = null;
        updateSubtitleControls();
      } else if (ev.type === 'error') {
        transcribeProgress.hide();
        setHint('transcribe-status', `转录失败：${ev.text}`, true);
        state.transcribeTask = null;
        updateSubtitleControls();
      }
    });
    // 流在没有 done/error 的情况下结束（服务中断等）：明确提示而不是让进度条一直转
    if (state.transcribeTask === task_id) {
      state.transcribeTask = null;
      transcribeProgress.hide();
      setHint('transcribe-status', '转录连接中断，请重新开始', true);
      updateSubtitleControls();
    }
  } catch (err) {
    transcribeProgress.hide();
    setHint('transcribe-status', `转录失败：${err.message}`, true);
    state.transcribeTask = null;
    updateSubtitleControls();
  }
}

$('btn-transcribe-stop').addEventListener('click', async () => {
  if (!state.transcribeTask) return;
  await api('/api/transcribe/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: state.transcribeTask }),
  }).catch(() => {});
});

function updateNoSubHint() {
  const box = $('chat-nosub');
  if (!box) return;
  const need = !!(state.videoId && !state.cues.length && !state.nosubDismissed);
  box.hidden = !need;
  const asrOk = !!state.config?.asr_available;
  $('nosub-transcribe').disabled = !asrOk;
  $('nosub-transcribe').title = asrOk ? '' : '需安装 ASR 依赖组';
  const subChip = $('chk-subtitles');
  subChip.disabled = !state.cues.length;
  if (!state.cues.length) subChip.checked = false;
  subChip.parentElement.title = state.cues.length
    ? '把当前这句字幕一并发给 AI'
    : '当前没有字幕，可先转录或上传 SRT';
  $('btn-summary').disabled = !state.videoId || !state.cues.length;
  setTip('btn-summary',
    !state.videoId ? '请先加载视频'
      : !state.cues.length ? '需要先有字幕才能生成总结'
        : '');
  updateComposerCue();
}

/* ---------- AI 问答 ---------- */

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role === 'assistant') {
    const c = document.createElement('div');
    c.className = 'md';
    c.innerHTML = renderMd(text || '');
    div.appendChild(c);
  } else {
    const t = document.createElement('div');
    t.className = 'msg-text';
    t.textContent = text;
    div.appendChild(t);
  }
  $('chat-messages').appendChild(div);
  scrollChatToBottom();
  return div;
}

function addUserMessage(text, { cue, image } = {}) {
  const div = document.createElement('div');
  div.className = 'msg user';
  if (cue) {
    const quote = document.createElement('div');
    quote.className = 'quote';
    quote.textContent = `${fmtTime(cue.start)}  ${cue.text}`;
    div.append(quote);
  }
  if (image) {
    const box = document.createElement('div');
    box.className = 'frame';
    const cap = document.createElement('div');
    cap.className = 'frame-cap';
    cap.textContent = `当前视频帧 ${fmtTime($('player').currentTime || 0)}`;
    const img = document.createElement('img');
    img.src = image;
    box.append(cap, img);
    div.append(box);
  }
  const t = document.createElement('div');
  t.className = 'msg-text';
  t.textContent = text;
  div.append(t);
  $('chat-messages').appendChild(div);
  scrollChatToBottom();
  return div;
}

function addPendingAssistant() {
  const div = document.createElement('div');
  div.className = 'msg assistant is-pending';
  const typing = document.createElement('div');
  typing.className = 'typing';
  typing.setAttribute('aria-label', '正在回复');
  typing.innerHTML = '<i></i><i></i><i></i>';
  const status = document.createElement('div');
  status.className = 'pending-status';
  const md = document.createElement('div');
  md.className = 'md';
  md.hidden = true;
  div.append(typing, status, md);
  $('chat-messages').appendChild(div);
  scrollChatToBottom();
  return div;
}

function revealAssistant(div) {
  div.classList.remove('is-pending');
  div.querySelector('.typing')?.remove();
  div.querySelector('.pending-status')?.remove();
  const md = div.querySelector('.md');
  if (md) md.hidden = false;
}

/* 取 assistant 气泡中的 markdown 容器 */
function mdContainer(msgDiv) {
  return msgDiv.querySelector('.md');
}

function scrollChatToBottom() {
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

/* 取播放时间 t 对应的当前字幕（与高亮逻辑一致）；无匹配返回 null */
function currentCueAt(t) {
  let idx = -1;
  for (let i = 0; i < state.cues.length; i++) {
    if (state.cues[i].start <= t) idx = i; else break;
  }
  return idx >= 0 ? state.cues[idx] : null;
}

function captureFrame() {
  const video = $('player');
  if (!video.videoWidth) return null;
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 960 / video.videoWidth);
  canvas.width = video.videoWidth * scale;
  canvas.height = video.videoHeight * scale;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

/* ---------- 对话上下文设置（localStorage 持久化，随请求发给后端） ---------- */

const chatCtx = loadChatCtx();

function clampInt(v, min, max, dflt) {
  v = parseInt(v, 10);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, v));
}

function loadChatCtx() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem('chatCtx') || '{}'); } catch {}
  return {
    summary: raw.summary !== false,                 // 默认开
    fullSubtitles: raw.fullSubtitles === true,      // 默认关
    before: clampInt(raw.before, 0, 100, 10),
    after: clampInt(raw.after, 0, 100, 0),
  };
}

function saveChatCtx() {
  localStorage.setItem('chatCtx', JSON.stringify(chatCtx));
}

/* 用一句话说明当前的前后条数设置实际会发什么 */
function updateCsPreview() {
  const parts = [];
  if (chatCtx.before > 0) parts.push(`当前这句之前的 ${chatCtx.before} 条`);
  parts.push('当前这句');
  if (chatCtx.after > 0) parts.push(`之后的 ${chatCtx.after} 条`);
  $('cs-preview').textContent = `实际发送：${parts.join(' ＋ ')}（均以字幕条数计）`;
}

/* 完整字幕 + 总结同时开启会重复消耗上下文，勾选第二个时弹窗确认；取消则还原勾选 */
function confirmBothCtx(toggled) {
  if (!chatCtx.summary || !chatCtx.fullSubtitles) return true;
  const ok = confirm('同时注入完整字幕和视频总结会消耗较多上下文（两者内容有重叠），建议只保留一个。确定要同时开启吗？');
  if (!ok) toggled.checked = false;
  return ok;
}

function initChatSettings() {
  $('cs-summary').checked = chatCtx.summary;
  $('cs-full-subtitles').checked = chatCtx.fullSubtitles;
  $('cs-before').value = chatCtx.before;
  $('cs-after').value = chatCtx.after;
  updateCsPreview();

  $('cs-summary').addEventListener('change', (e) => {
    chatCtx.summary = e.target.checked;
    if (e.target.checked && !confirmBothCtx(e.target)) chatCtx.summary = false;
    saveChatCtx();
  });
  $('cs-full-subtitles').addEventListener('change', (e) => {
    chatCtx.fullSubtitles = e.target.checked;
    if (e.target.checked && !confirmBothCtx(e.target)) chatCtx.fullSubtitles = false;
    saveChatCtx();
  });
  $('cs-before').addEventListener('change', (e) => {
    chatCtx.before = clampInt(e.target.value, 0, 100, 10);
    e.target.value = chatCtx.before;
    saveChatCtx();
    updateCsPreview();
  });
  $('cs-after').addEventListener('change', (e) => {
    chatCtx.after = clampInt(e.target.value, 0, 100, 0);
    e.target.value = chatCtx.after;
    saveChatCtx();
    updateCsPreview();
  });

  $('btn-chat-settings').addEventListener('click', () => { $('chat-settings-modal').hidden = false; });
  $('btn-chat-settings-close').addEventListener('click', () => { $('chat-settings-modal').hidden = true; });
}
initChatSettings();

/* 注入上下文贴在用户气泡开头（与发给模型的顺序一致）；当前字幕已有引用块，不再重复 */
function attachContextChips(userDiv, items) {
  if (!items?.length) return;
  const rest = items.filter((it) => it.label !== '当前字幕');
  if (!rest.length) return;
  const row = document.createElement('div');
  row.className = 'ctx-chips';
  let preview = null;
  for (const it of rest) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-chip';
    b.textContent = it.label;
    b.title = `${(it.text || '').length.toLocaleString()} 字符${it.truncated ? '，已截断' : ''}`;
    b.addEventListener('click', () => {
      const open = b.classList.toggle('is-open');
      row.querySelectorAll('.ctx-chip').forEach((x) => { if (x !== b) x.classList.remove('is-open'); });
      if (!open) {
        preview?.remove();
        preview = null;
        return;
      }
      if (!preview) {
        preview = document.createElement('div');
        preview.className = 'ctx-preview';
        row.after(preview);
      }
      preview.textContent = it.text || '';
    });
    row.append(b);
  }
  userDiv.prepend(row);
}

async function sendChat() {
  if (state.sending) return;  // 发送中（含 Enter 触发）不重复发送
  const text = $('chat-text').value.trim();
  if (!text) return;
  $('chat-text').value = '';

  if (state.videoId && !state.cues.length && !state.nosubNoted) {
    state.nosubNoted = true;
    addMessage('system-note', '当前视频没有字幕，这次提问不会带上视频内容。要结合讲解来问，请先转录或上传 SRT。');
  }

  const curTime = $('player').currentTime || 0;
  const cue = $('chk-subtitles').checked ? currentCueAt(curTime) : null;
  const image = $('chk-frame').checked ? captureFrame() : null;
  const userDiv = addUserMessage(text, { cue, image });
  state.messages.push({ role: 'user', content: text });

  const assistantDiv = addPendingAssistant();
  const contentEl = mdContainer(assistantDiv);
  const statusEl = assistantDiv.querySelector('.pending-status');
  let thinkEl = null;
  let thinkBody = null;
  let fullThink = '';
  let full = '';
  let revealed = false;
  const showAnswer = () => {
    if (revealed) return;
    revealAssistant(assistantDiv);
    revealed = true;
  };
  state.sending = true;
  $('btn-send').disabled = true;
  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: state.messages.slice(-20),
        video_id: state.videoId,
        include_subtitles: $('chk-subtitles').checked,
        current_time: curTime,
        image_b64: image,
        enable_thinking: $('chk-thinking').checked,
        include_summary: chatCtx.summary,
        include_full_subtitles: chatCtx.fullSubtitles,
        subtitle_before: chatCtx.before,
        subtitle_after: chatCtx.after,
      }),
    });
    if (!resp.ok) throw new Error((await resp.json()).detail || '请求失败');
    await consumeSSE(resp, (ev) => {
      if (ev.type === 'status') {
        if (statusEl) statusEl.textContent = ev.text;
      } else if (ev.type === 'context') {
        attachContextChips(userDiv, ev.items);
      } else if (ev.type === 'reasoning') {
        showAnswer();
        if (!thinkEl) {
          thinkEl = document.createElement('details');
          thinkEl.className = 'thinking';
          thinkEl.open = true;
          thinkEl.innerHTML = '<summary>思考过程</summary>';
          thinkBody = document.createElement('div');
          thinkBody.className = 'thinking-body';
          thinkEl.appendChild(thinkBody);
          assistantDiv.insertBefore(thinkEl, contentEl);
        }
        fullThink += ev.text;
        thinkBody.textContent = fullThink;
        scrollChatToBottom();
      } else if (ev.type === 'delta') {
        showAnswer();
        if (!full && thinkEl) thinkEl.open = false;
        full += ev.text;
        contentEl.innerHTML = renderMd(full);
        scrollChatToBottom();
      } else if (ev.type === 'error') {
        showAnswer();
        contentEl.classList.add('error');
        contentEl.textContent = `错误：${ev.text}`;
      }
    });
    if (full) state.messages.push({ role: 'assistant', content: full });
    else if (!revealed) showAnswer();
  } catch (err) {
    showAnswer();
    contentEl.classList.add('error');
    contentEl.textContent = `错误：${err.message}`;
  } finally {
    state.sending = false;
    $('btn-send').disabled = false;
  }
}

$('btn-send').addEventListener('click', sendChat);
$('chat-text').addEventListener('keydown', (e) => {
  // isComposing：中文输入法组词期间的 Enter 是选词，不触发发送
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); }
});

$('btn-clear-chat').addEventListener('click', () => {
  state.messages = [];
  $('chat-messages').querySelectorAll('.msg').forEach((el) => el.remove());
});

$('btn-summary').addEventListener('click', async () => {
  if (!state.videoId) return;
  $('btn-summary').disabled = true;
  const note = addMessage('system-note', '正在生成视频总结');
  note.classList.add('waiting');
  try {
    const data = await api('/api/chat/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: state.videoId }),
    });
    note.remove();
    addMessage('assistant', `【视频总结】\n${data.summary}`);
  } catch (err) {
    note.classList.remove('waiting');
    note.textContent = `总结生成失败：${err.message}`;
  } finally {
    $('btn-summary').disabled = false;
  }
});

/* ---------- 设置面板 ---------- */

/* faster-whisper 可用规格（faster_whisper 标准模型名） */
const WHISPER_SIZES = [
  'tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en',
  'medium', 'medium.en', 'large-v1', 'large-v2', 'large-v3',
  'large-v3-turbo', 'turbo',
  'distil-large-v2', 'distil-medium.en', 'distil-small.en', 'distil-large-v3',
];

/* whisper 支持的语言（whisper tokenizer 固定列表） */
const WHISPER_LANGUAGES = {
  auto: '自动检测', zh: '中文', en: '英语', yue: '粤语', ja: '日语', ko: '韩语',
  fr: '法语', de: '德语', es: '西班牙语', ru: '俄语', pt: '葡萄牙语', it: '意大利语',
  af: 'Afrikaans', am: 'Amharic', ar: 'Arabic', as: 'Assamese', az: 'Azerbaijani',
  ba: 'Bashkir', be: 'Belarusian', bg: 'Bulgarian', bn: 'Bengali', bo: 'Tibetan',
  br: 'Breton', bs: 'Bosnian', ca: 'Catalan', cs: 'Czech', cy: 'Welsh', da: 'Danish',
  el: 'Greek', et: 'Estonian', eu: 'Basque', fa: 'Persian', fi: 'Finnish', fo: 'Faroese',
  gl: 'Galician', gu: 'Gujarati', haw: 'Hawaiian', he: 'Hebrew', hi: 'Hindi',
  hr: 'Croatian', ht: 'Haitian Creole', hu: 'Hungarian', hy: 'Armenian',
  id: 'Indonesian', is: 'Icelandic', jw: 'Javanese', ka: 'Georgian', kk: 'Kazakh',
  km: 'Khmer', kn: 'Kannada', la: 'Latin', lb: 'Luxembourgish', ln: 'Lingala',
  lo: 'Lao', lt: 'Lithuanian', lv: 'Latvian', mg: 'Malagasy', mi: 'Maori',
  mk: 'Macedonian', ml: 'Malayalam', mn: 'Mongolian', mr: 'Marathi', ms: 'Malay',
  mt: 'Maltese', my: 'Burmese', ne: 'Nepali', nl: 'Dutch', nn: 'Norwegian Nynorsk',
  no: 'Norwegian', oc: 'Occitan', pa: 'Punjabi', pl: 'Polish', ps: 'Pashto',
  ro: 'Romanian', sa: 'Sanskrit', sd: 'Sindhi', si: 'Sinhala', sk: 'Slovak',
  sl: 'Slovenian', sn: 'Shona', so: 'Somali', sq: 'Albanian', sr: 'Serbian',
  su: 'Sundanese', sv: 'Swedish', sw: 'Swahili', ta: 'Tamil', te: 'Telugu',
  tg: 'Tajik', th: 'Thai', tk: 'Turkmen', tl: 'Tagalog', tr: 'Turkish', tt: 'Tatar',
  uk: 'Ukrainian', ur: 'Urdu', uz: 'Uzbek', vi: 'Vietnamese', yi: 'Yiddish', yo: 'Yoruba',
};

/* SenseVoiceSmall 支持的语言（FunASR 固定列表） */
const SENSEVOICE_LANGUAGES = {
  auto: '自动检测', zh: '中文', en: '英语', yue: '粤语', ja: '日语', ko: '韩语',
};

function fillSelect(sel, entries, current) {
  sel.innerHTML = '';
  for (const [value, label] of entries) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  // 已有值不在列表里（手动填过）时保留为选项，避免静默丢失
  if (current && !entries.some(([v]) => v === current)) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = `${current}（自定义）`;
    sel.appendChild(opt);
  }
  if (current) sel.value = current;
}

/* 按 ASR 模型刷新联动选项：whisper 规格只在 faster-whisper 下显示，语言列表随模型切换 */
function refreshAsrOptions(whisperModel, language) {
  const isWhisper = $('cfg-asr-model').value === 'faster-whisper';
  $('wrap-whisper-model').hidden = !isWhisper;
  const wm = whisperModel ?? ($('cfg-whisper-model').value || 'small');
  fillSelect($('cfg-whisper-model'), WHISPER_SIZES.map((s) => [s, s]), wm);
  const langs = isWhisper ? WHISPER_LANGUAGES : SENSEVOICE_LANGUAGES;
  const cur = language ?? $('cfg-asr-language').value;
  fillSelect($('cfg-asr-language'), Object.entries(langs), langs[cur] ? cur : 'auto');
}

$('cfg-asr-model').addEventListener('change', () => refreshAsrOptions());

async function loadConfig() {
  state.config = await api('/api/config');
  applyConfig();
}

/* 主设置页只管：当前提供商、模型、cookies、ASR；key/base_url 归提供商设置弹窗 */
function applyConfig() {
  const c = state.config;
  if (!c) return;
  const names = Object.keys(c.llm.providers);
  fillSelect($('cfg-provider'), names.map((n) => [n, n]), c.llm.provider);
  const p = c.llm.providers[c.llm.provider] || {};
  $('cfg-model').value = p.model || '';
  // 模型下拉默认收起，用手动输入框
  $('cfg-model-select').hidden = true;
  $('cfg-model').hidden = false;
  $('cookies-status').textContent = c.bilibili.cookies_uploaded ? '已上传' : '未上传（B站官方字幕不可用）';
  $('cfg-asr-model').value = c.asr.model;
  $('cfg-asr-device').value = c.asr.device;
  refreshAsrOptions(c.asr.whisper_model || 'small', c.asr.language || 'auto');
  $('asr-availability').textContent = c.asr_available
    ? 'ASR 依赖已安装'
    : '未安装 ASR 依赖组，转录功能不可用（使用 uv sync --extra asr 安装）';
  // 提供商声明不支持图片 → 禁用「发送当前视频帧」，悬浮给出原因
  $('chk-frame').disabled = !c.llm.supports_image;
  if (!c.llm.supports_image) $('chk-frame').checked = false;
  $('chk-frame').parentElement.title = c.llm.supports_image
    ? ''
    : `当前提供商（${c.llm.provider}）的模型不支持图像识别，无法发送视频帧`;
  setTip('btn-summary', state.videoId ? '' : '请先加载视频');
  updateSubtitleControls();
  updateNoSubHint();
}

function openSettings() {
  setHint('settings-status', '');
  $('settings-modal').hidden = false;
}
$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-menu').addEventListener('click', () => { closeAllMenus(); openSettings(); });
$('btn-close-settings').addEventListener('click', () => { $('settings-modal').hidden = true; });

/* 主页面切换提供商下拉只是预览该提供商的模型，保存时才生效 */
$('cfg-provider').addEventListener('change', () => {
  const p = state.config?.llm?.providers?.[$('cfg-provider').value];
  $('cfg-model').value = p?.model || '';
  $('cfg-model-select').hidden = true;
  $('cfg-model').hidden = false;
});

/* 提供商弹窗：add = 新增提供商，edit = 修改主页面当前选中的提供商 */
const pv = { mode: 'edit', origName: '' };

function openProviderModal(mode) {
  pv.mode = mode;
  const isAdd = mode === 'add';
  const name = $('cfg-provider').value;
  pv.origName = isAdd ? '' : name;
  $('provider-modal-title').textContent = isAdd ? '新增提供商' : `提供商设置：${name}`;
  // 名称在编辑时也可改（保存时走 rename 接口整体迁移配置）
  $('pv-name').value = isAdd ? '' : name;
  $('pv-name').disabled = false;
  $('pv-protocol-row').hidden = !isAdd;
  $('pv-protocol').value = 'openai';
  $('btn-pv-delete').hidden = isAdd;
  const p = isAdd ? null : state.config?.llm?.providers?.[name];
  $('pv-base-url').value = p?.base_url || '';
  $('pv-api-key').value = '';
  $('pv-api-key').placeholder = isAdd ? '必填'
    : p?.api_key_set ? `已设置 (${p.api_key_masked})，留空则不修改` : '必填';
  $('pv-supports-image').checked = !!p?.supports_image;
  $('pv-status').textContent = '';
  $('pv-status').style.color = '';
  $('provider-modal').hidden = false;
}

$('btn-add-provider').addEventListener('click', () => openProviderModal('add'));
$('btn-edit-provider').addEventListener('click', () => openProviderModal('edit'));
$('btn-pv-cancel').addEventListener('click', () => { $('provider-modal').hidden = true; });

$('btn-pv-save').addEventListener('click', async () => {
  const baseUrl = $('pv-base-url').value.trim();
  const apiKey = $('pv-api-key').value.trim();
  const supportsImage = $('pv-supports-image').checked;
  try {
    if (pv.mode === 'add') {
      const name = $('pv-name').value.trim();
      if (!name) return setHint('pv-status', '请填写提供商名称', true);
      if (!baseUrl) return setHint('pv-status', '请填写 Base URL', true);
      if (!apiKey) return setHint('pv-status', '请填写 API Key', true);
      state.config = await api('/api/config/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocol: 'openai', name, base_url: baseUrl,
          api_key: apiKey, supports_image: supportsImage,
        }),
      });
      // 创建后切换为新提供商
      state.config = await api('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm: { provider: name } }),
      });
    } else {
      const origName = pv.origName;
      const newName = $('pv-name').value.trim();
      const saved = state.config?.llm?.providers?.[origName];
      if (!newName) return setHint('pv-status', '请填写提供商名称', true);
      if (!baseUrl) return setHint('pv-status', '请填写 Base URL', true);
      // 已保存过 key 才允许留空（留空 = 不修改）
      if (!apiKey && !saved?.api_key_set) return setHint('pv-status', '请填写 API Key', true);
      // 名称变了先 rename（整体迁移配置），再按新名称保存其余字段
      if (newName !== origName) {
        state.config = await api(`/api/config/providers/${encodeURIComponent(origName)}/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        });
      }
      state.config = await api('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          llm: { providers: { [newName]: {
            base_url: baseUrl, api_key: apiKey, supports_image: supportsImage,
          } } },
        }),
      });
    }
    $('provider-modal').hidden = true;
    applyConfig();
  } catch (err) {
    setHint('pv-status', `保存失败：${err.message}`, true);
  }
});

/* 删除当前编辑的提供商（至少保留一个，由后端兜底） */
$('btn-pv-delete').addEventListener('click', async () => {
  const name = pv.origName;
  if (!name) return;
  if (!confirm(`确定删除提供商「${name}」？其 Base URL 和 API Key 将一并删除。`)) return;
  try {
    state.config = await api(`/api/config/providers/${encodeURIComponent(name)}`, { method: 'DELETE' });
    $('provider-modal').hidden = true;
    applyConfig();
    setHint('settings-status', `已删除提供商「${name}」`);
  } catch (err) {
    setHint('pv-status', `删除失败：${err.message}`, true);
  }
});

/* 拉取主页面当前选中提供商的模型列表（用该提供商已保存的 base_url/key） */
$('btn-fetch-models').addEventListener('click', async () => {
  $('btn-fetch-models').disabled = true;
  setHint('settings-status', '拉取模型列表中…');
  try {
    const { models } = await api('/api/config/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: $('cfg-provider').value }),
    });
    if (!models.length) {
      setHint('settings-status', '提供商未返回任何模型，可手动输入', true);
      return;
    }
    const entries = models.map((m) => [m, m]);
    entries.push(['__custom__', '自定义…']);
    fillSelect($('cfg-model-select'), entries, $('cfg-model').value.trim());
    $('cfg-model').hidden = true;
    $('cfg-model-select').hidden = false;
    setHint('settings-status', '');
  } catch (err) {
    setHint('settings-status', `拉取失败：${err.message}`, true);
  } finally {
    $('btn-fetch-models').disabled = false;
  }
});

$('cfg-model-select').addEventListener('change', () => {
  if ($('cfg-model-select').value === '__custom__') {
    $('cfg-model-select').hidden = true;
    $('cfg-model').hidden = false;
    $('cfg-model').focus();
  } else {
    $('cfg-model').value = $('cfg-model-select').value;
  }
});

$('btn-save-settings').addEventListener('click', async () => {
  const model = $('cfg-model-select').hidden
    ? $('cfg-model').value.trim()
    : $('cfg-model-select').value;
  const provider = $('cfg-provider').value;
  const patch = {
    llm: {
      provider,
      // 只更新当前选中提供商的模型，key/base_url 在提供商设置弹窗里改
      providers: { [provider]: { model } },
    },
    asr: {
      model: $('cfg-asr-model').value,
      whisper_model: $('cfg-whisper-model').value || 'small',
      device: $('cfg-asr-device').value,
      language: $('cfg-asr-language').value || 'auto',
    },
  };
  try {
    $('btn-save-settings').disabled = true;
    state.config = await api('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    applyConfig();
    $('settings-modal').hidden = true;
  } catch (err) {
    setHint('settings-status', `保存失败：${err.message}`, true);
  } finally {
    $('btn-save-settings').disabled = false;
  }
});

$('cfg-cookies').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  setHint('cookies-status', '上传中…');
  try {
    const resp = await fetch('/api/config/cookies', { method: 'POST', body: fd });
    if (!resp.ok) throw new Error((await resp.json()).detail || '上传失败');
    state.config = await api('/api/config');
    applyConfig();
  } catch (err) {
    setHint('cookies-status', `cookies 上传失败：${err.message}`, true);
  }
  e.target.value = '';
});

/* ---------- 菜单 / 面板 / 画面字幕 ---------- */

function closeAllMenus(except) {
  document.querySelectorAll('.menu').forEach((m) => {
    if (m !== except) m.hidden = true;
  });
  document.querySelectorAll('[aria-haspopup="true"]').forEach((b) => {
    if (except && b.parentElement?.contains(except)) return;
    b.setAttribute('aria-expanded', 'false');
  });
}

document.querySelectorAll('[aria-haspopup="true"]').forEach((btn) => {
  const menu = btn.parentElement?.querySelector('.menu');
  if (!menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    closeAllMenus(open ? menu : null);
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
});
document.addEventListener('click', () => closeAllMenus());
$('menu-app').addEventListener('click', (e) => e.stopPropagation());

function openBiliModal() {
  $('bili-modal-status').textContent = '';
  $('bili-modal-status').style.color = '';
  updateBiliModal();
  $('bili-modal').hidden = false;
  $('bili-url').focus();
  const url = $('bili-url').value.trim();
  if (url && !biliState.info) parseBiliInfo(url);
}

$('btn-upload-landing').addEventListener('click', () => $('file-video').click());
$('menu-upload-video').addEventListener('click', () => $('file-video').click());
$('menu-bili').addEventListener('click', openBiliModal);
$('menu-close-video').addEventListener('click', closeVideo);
$('menu-srt').addEventListener('click', () => {
  if (!state.videoId) return setHint('transcribe-status', '请先加载视频', true);
  $('file-srt').click();
});
$('menu-bili-sub').addEventListener('click', () => {
  if (!state.videoId) return setHint('transcribe-status', '请先加载视频', true);
  loadBilibiliSubtitle();
});
$('menu-transcribe').addEventListener('click', () => {
  if (!state.videoId) return setHint('transcribe-status', '请先加载视频', true);
  startTranscribe('realtime');
});

$('btn-caption').addEventListener('click', () => setCaptionOn(!captionPref.on));
$('menu-caption').addEventListener('click', () => setCaptionOn(!captionPref.on));
$('chk-subtitles').addEventListener('change', updateComposerCue);

$('nosub-srt').addEventListener('click', () => {
  if (!state.videoId) return setHint('transcribe-status', '请先加载视频', true);
  $('file-srt').click();
});
$('nosub-transcribe').addEventListener('click', () => {
  if (!state.videoId) return setHint('transcribe-status', '请先加载视频', true);
  startTranscribe('realtime');
});
$('nosub-dismiss').addEventListener('click', () => {
  state.nosubDismissed = true;
  updateNoSubHint();
});

function syncPanelMenu() {
  document.querySelectorAll('[data-panel-toggle]').forEach((btn) => {
    const hidden = window.vlhLayout?.isHidden(btn.dataset.panelToggle);
    btn.setAttribute('aria-checked', hidden ? 'false' : 'true');
  });
}
document.querySelectorAll('[data-panel-toggle]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.panelToggle;
    window.vlhLayout.setHidden(id, !window.vlhLayout.isHidden(id));
    syncPanelMenu();
  });
});
window.addEventListener('vlh-layout-change', syncPanelMenu);

/* ---------- 启动 ---------- */

/* Esc 关闭任意打开的弹窗和菜单 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeAllMenus();
  for (const id of ['provider-modal', 'settings-modal', 'bili-modal', 'chat-settings-modal']) $(id).hidden = true;
});

syncCaptionUI();
syncPanelMenu();
renderSubtitles();
refreshRecentVideos();
loadConfig().catch((err) => {
  setHint('video-title', `配置加载失败：${err.message}，请刷新页面重试`, true);
});
