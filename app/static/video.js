/* 打开/关闭视频、B站、最近列表 */
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

/* 挂载播放源：本地 blob 优先；DASH 串流走 dash.js（失败回退 HLS）；否则走后端文件/代理 */
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
  if (state.blobUrl) {
    v.src = state.blobUrl;
  } else if (state.kind === 'dash' && state.streaming) {
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
    } else {
      attachHls(v);
    }
  } else if (state.videoId) {
    v.src = `/api/video/${state.videoId}/file?t=${Date.now()}`;
  }
  applyRate();
}

function attachHls(v) {
  const url = `/api/video/${state.videoId}/hls/index.m3u8`;
  if (window.Hls && Hls.isSupported()) {
    state.hls = new Hls();
    state.hls.loadSource(url);
    state.hls.attachMedia(v);
    state.hls.on(Hls.Events.MANIFEST_PARSED, () => applyResume());
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = url; // Safari 原生 HLS
  }
}

function stopTranscribeTask() {
  if (!state.transcribeTask) return;
  api('/api/transcribe/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: state.transcribeTask }),
  }).catch(() => {});
  state.transcribeTask = null;
  state.transcribeMode = null;
}

async function setVideo(rec, opts = {}) {
  // 换视频时停掉进行中的转录，避免旧任务的字幕串入新视频
  stopTranscribeTask();
  if (state.videoId && state.videoId !== rec.id) {
    persistPosition(true);
    await persistChat();
  }
  transcribeProgress.hide();
  landingProgress.hide();
  videoProgress.hide();
  setHint('transcribe-status', '');
  revokeBlob();

  state.video = rec;
  state.videoId = rec.id;
  state.videoUrl = rec.url || null;
  state.streaming = rec.source === 'bilibili';
  state.hasAudio = !!(rec.has_audio || rec.backendAudio);
  state.duration = rec.duration || opts.duration || 0;
  state.kind = opts.kind || rec.kind || null;
  state.qualities = opts.qualities || rec.qualities || null;
  state.height = opts.height || rec.height || 0;
  state.blobUrl = opts.blobUrl || null;
  if (state.blobUrl) state.streaming = false;
  state.resumeAt = (rec.position || 0) > 1 ? rec.position : null;
  state.resumePlay = false;
  setRate(1);

  const [sub, hist, detail] = await Promise.all([
    api(`/api/subtitle/${rec.id}`).catch(() => ({ cues: [] })),
    api(`/api/chat/${rec.id}/history`).catch(() => ({ messages: [] })),
    rec.summary != null ? Promise.resolve(rec) : api(`/api/video/${rec.id}`).catch(() => rec),
  ]);
  state.cues = sub.cues || [];
  state.messages = hist.messages || [];
  state.summary = detail.summary || rec.summary || null;
  if (detail.position != null && rec.position == null) {
    rec.position = detail.position;
    state.resumeAt = rec.position > 1 ? rec.position : null;
  }
  state.nosubDismissed = false;
  state.nosubNoted = false;

  attachSource();
  applyRate();
  $('time-display').textContent = `00:00 / ${fmtTime(state.duration)}`;
  setHint('video-title', rec.name || '');
  renderChatFromState();
  updateSubtitleControls();
  updateQualitySelect();
  renderSubtitles();
  updateVideoCaption();
  updateComposerCue();
  updateNoSubHint();
  setWorkspace(true);
  api(`/api/video/${rec.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ touch: true }),
  }).catch(() => {});
  if (opts.autoSubtitles && rec.source === 'bilibili' && !state.cues.length) {
    autoLoadBiliSubtitle();
  }
  refreshRecentVideos();
}

async function closeVideo() {
  stopTranscribeTask();
  persistPosition(true);
  await persistChat();
  state.resumeAt = null;
  state.resumePlay = false;
  const v = $('player');
  v.pause();
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  if (state.dash) { state.dash.destroy(); state.dash = null; }
  v.removeAttribute('src');
  v.load();
  revokeBlob();
  state.videoId = null;
  state.video = null;
  state.cues = [];
  state.summary = null;
  state.messages = [];
  state.nosubDismissed = false;
  state.nosubNoted = false;
  state.kind = null;
  state.streaming = false;
  state.hasAudio = false;
  renderChatFromState();
  setHint('video-title', '');
  $('btn-summary').disabled = true;
  setTip('btn-summary', '请先打开视频');
  renderSubtitles();
  updateVideoCaption();
  updateComposerCue();
  updateNoSubHint();
  setWorkspace(false);
  refreshRecentVideos();
}

/* 控制条清晰度选择：仅 B站在线串流且有解析到的档位时显示 */
function updateQualitySelect() {
  const sel = $('quality-select');
  const q = state.qualities;
  if (!state.videoId || !state.streaming || !q?.length) {
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
    if (state.video) {
      state.video.height = data.height;
      state.video.kind = data.kind;
      if (data.qualities?.length) state.video.qualities = data.qualities;
    }
    state.resumeAt = t;
    state.resumePlay = playing;
    attachSource();
    applyRate();
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

/* 上传 cookies 后重新解析当前 B站视频：刷新清晰度列表，无字幕时再拉官方字幕 */
async function reloadCurrentBiliVideo() {
  const rec = state.video;
  if (!rec || rec.source !== 'bilibili' || !state.videoId) return;
  const player = $('player');
  const t = player.currentTime || rec.position || 0;
  const playing = !player.paused;
  setHint('transcribe-status', '正在用新 cookies 重新解析…');
  try {
    const data = await api('/api/video/bilibili/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: rec.id,
        url: rec.url || state.videoUrl || '',
        max_height: rec.height || state.height || 720,
        page: rec.page || 1,
      }),
    });
    rec.kind = data.kind;
    rec.height = data.height;
    rec.qualities = data.qualities || rec.qualities;
    rec.duration = data.duration || rec.duration;
    rec.url = data.url || rec.url;
    rec.has_audio = data.has_audio || rec.has_audio;
    state.height = data.height;
    state.kind = data.kind;
    if (data.qualities?.length) state.qualities = data.qualities;
    state.duration = rec.duration || state.duration;
    state.videoUrl = rec.url;
    state.resumeAt = t;
    state.resumePlay = playing;
    attachSource();
    applyRate();
    updateQualitySelect();
    setHint('transcribe-status', '已重新解析，可在清晰度列表中选择更高档位');
    if (!state.cues.length) await autoLoadBiliSubtitle();
  } catch (err) {
    setHint('transcribe-status', `重新加载失败：${err.message}`, true);
  }
}

$('file-video').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let rec = state.pendingAttach;
  state.pendingAttach = null;
  try {
    if (!rec) {
      rec = await api('/api/video/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, source: 'local' }),
      });
    }
    rec.name = rec.name || file.name;
    rec.fileName = file.name;
    await setVideo(rec, { blobUrl: URL.createObjectURL(file) });
    const fd = new FormData();
    fd.append('file', file, file.name);
    const upload = uploadWithProgress(`/api/video/${rec.id}/media`, fd, (pct) => {
      videoProgress.update(pct, `保存到本地库 ${Math.floor(pct)}%`);
    }).then((data) => {
      videoProgress.hide();
      if (state.videoId === rec.id && state.video) {
        state.video.has_file = true;
        if (data.duration) {
          state.video.duration = data.duration;
          state.duration = data.duration;
        }
      }
    }).catch((err) => {
      videoProgress.hide();
      setHint('video-title', `视频已打开，但保存到本地库失败：${err.message}`, true);
    });
    state.mediaUpload = upload;
    await upload;
    state.mediaUpload = null;
  } catch (err) {
    setHint('video-title', `打开失败：${err.message}`, true);
  }
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

function biliKey(url, page) {
  const bv = (url || '').match(/BV[\w]+/i);
  return `${(bv ? bv[0] : (url || '')).toLowerCase()}#${page || 1}`;
}

async function findBiliRecord(url, page) {
  const key = biliKey(url, page);
  const { videos } = await api('/api/video/list');
  return (videos || []).find((v) => v.source === 'bilibili' && biliKey(v.url, v.page) === key) || null;
}

/* 秒开：只解析播放地址，直接串流播放；同一 BV+分P 复用用户库记录 */
$('btn-bili-stream').addEventListener('click', async () => {
  if (!biliState.info) return;
  $('btn-bili-stream').disabled = true;
  setHint('bili-modal-status', '获取播放地址…');
  try {
    const body = biliRequestBody();
    const info = biliState.info;
    let rec = await findBiliRecord(info.webpage_url || body.url, body.page);
    if (!rec && info.bvid) rec = await findBiliRecord(info.bvid, body.page);
    const data = await api('/api/video/bilibili/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, video_id: rec?.id }),
    });
    rec = {
      ...(rec || {}),
      id: data.video_id,
      name: data.name,
      source: 'bilibili',
      url: data.url,
      page: data.page || body.page,
      uploader: data.uploader || rec?.uploader || '',
      upload_date: data.upload_date || rec?.upload_date || '',
      duration: data.duration,
      kind: data.kind,
      height: data.height,
      qualities: data.qualities || biliState.info.qualities || [],
      has_audio: data.has_audio || rec?.has_audio,
      position: rec?.position || 0,
    };
    $('bili-modal').hidden = true;
    await setVideo(rec, {
      autoSubtitles: true,
      kind: data.kind,
      qualities: rec.qualities,
      height: rec.height,
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
  const onLanding = !document.body.classList.contains('has-video');
  if (v.source === 'bilibili') {
    if (onLanding) landingProgress.update(null, '正在打开…');
    try {
      const data = await api('/api/video/bilibili/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: v.id,
          url: v.url || '',
          max_height: v.height || 720,
          page: v.page || 1,
        }),
      });
      if (onLanding) landingProgress.hide();
      v.kind = data.kind;
      v.height = data.height;
      v.qualities = data.qualities || v.qualities;
      v.duration = data.duration || v.duration;
      v.url = data.url || v.url;
      v.has_audio = data.has_audio || v.has_audio;
      await setVideo(v, {
        autoSubtitles: true,
        kind: data.kind,
        qualities: v.qualities,
        height: data.height,
      });
    } catch (err) {
      if (onLanding) landingProgress.update(null, `加载失败：${err.message}`);
      else setHint('video-title', `加载失败：${err.message}`, true);
    }
    return;
  }
  if (v.has_file) {
    await setVideo(v, {});
    return;
  }
  state.pendingAttach = v;
  if (!confirm(`「${v.name}」的视频文件不在本地库里了。请重新选择原文件。`)) {
    state.pendingAttach = null;
    return;
  }
  $('file-video').click();
}

function dedupeVideos(videos) {
  const seen = new Set();
  const out = [];
  for (const v of videos) {
    const key = v.source === 'bilibili' && v.url ? biliKey(v.url, v.page) : v.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

async function removeFromLibrary(v, ev) {
  ev?.stopPropagation();
  ev?.preventDefault();
  if (!confirm(`移除「${v.name || v.id}」？字幕、总结和对话会一起从本地库删掉。`)) return;
  if (state.videoId === v.id) await closeVideo();
  await api(`/api/video/${v.id}`, { method: 'DELETE' });
  refreshRecentVideos();
}

function makeRemoveBtn(v) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rv-del';
  btn.title = '从列表移除';
  btn.setAttribute('aria-label', '从列表移除');
  btn.textContent = '×';
  btn.addEventListener('click', (e) => removeFromLibrary(v, e));
  return btn;
}

async function refreshRecentVideos() {
  try {
    const { videos: raw } = await api('/api/video/list');
    const videos = dedupeVideos(raw || []);
    const landing = $('landing-recent');
    const landingList = $('landing-recent-list');
    const menu = $('menu-recent');
    landingList.innerHTML = '';
    menu.innerHTML = '';
    if (!videos.length) {
      landing.hidden = true;
      const more = $('landing-more');
      if (more) more.hidden = true;
      const empty = document.createElement('div');
      empty.className = 'menu-empty';
      empty.textContent = '暂无';
      menu.append(empty);
      return;
    }
    landing.hidden = false;
    const more = $('landing-more');
    if (more) more.hidden = videos.length <= 5;
    for (const v of videos.slice(0, 5)) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'rv-name';
      name.textContent = v.name || v.id;
      const meta = document.createElement('span');
      meta.className = 'rv-meta';
      meta.textContent = v.duration ? fmtTime(v.duration) : '';
      li.append(name, meta, makeRemoveBtn(v));
      li.addEventListener('click', () => openRecent(v));
      landingList.append(li);
    }
    for (const v of videos.slice(0, 8)) {
      const row = document.createElement('div');
      row.className = 'recent-row';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = (v.name || v.id).slice(0, 36);
      btn.addEventListener('click', () => openRecent(v));
      row.append(btn, makeRemoveBtn(v));
      menu.append(row);
    }
    const all = document.createElement('a');
    all.href = '/history';
    all.className = 'menu-all-history';
    all.textContent = '全部历史';
    menu.append(all);
  } catch {}
}

