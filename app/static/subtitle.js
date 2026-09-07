/* 字幕列表、导入、转录 */
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
      : '打开视频后可在此查看和定位字幕';
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
  persistCuesSoon();
  const empty = $('subtitle-list').querySelector('li.empty');
  if (empty) empty.remove();
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
  if (!file || !state.videoId) return setHint('transcribe-status', '请先打开视频', true);
  const fd = new FormData();
  fd.append('file', file);
  try {
    const data = await api('/api/subtitle/parse', { method: 'POST', body: fd });
    state.cues = data.cues;
    invalidateSummary();
    await saveCuesNow();
    renderSubtitles();
    updateVideoCaption();
    updateComposerCue();
    setHint('transcribe-status', `已导入 ${data.cues.length} 条字幕`);
  } catch (err) {
    setHint('transcribe-status', `SRT 导入失败：${err.message}`, true);
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
  const url = state.videoUrl || state.video?.url;
  if (!url) return setHint('transcribe-status', '当前不是 B站视频', true);
  transcribeProgress.update(null, '拉取 B站官方字幕中…');
  try {
    const data = await api('/api/subtitle/bilibili', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, video_id: state.videoId }),
    });
    state.cues = data.cues;
    invalidateSummary();
    await saveCuesNow();
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
  const isBili = state.video?.source === 'bilibili';
  $('btn-transcribe-stop').hidden = !busy;
  $('menu-transcribe').disabled = busy || !state.videoId || !c?.asr_available;
  $('menu-bili-sub').disabled = !isBili || !c?.bilibili.cookies_uploaded;
  $('menu-srt').disabled = busy || !state.videoId;
  $('menu-transcribe').title = !state.videoId ? '请先打开视频'
    : !c?.asr_available ? 'ASR 依赖未安装' : '';
  $('menu-bili-sub').title = !isBili ? '仅 B站视频可拉取官方字幕'
    : !c?.bilibili.cookies_uploaded ? '需上传 B站 cookies' : '';
}

async function ensureBackendMedia() {
  const st = await api(`/api/video/${state.videoId}/status`).catch(() => null);
  if (st?.has_audio || st?.has_file) {
    state.hasAudio = !!st.has_audio;
    return;
  }
  if (state.streaming) {
    if (!confirm('转录需要先下载音频（不影响继续播放）。开始吗？')) {
      throw new Error('cancelled');
    }
    await downloadCurrentAudio();
    if (state.video) state.video.has_audio = true;
    return;
  }
  if (state.mediaUpload) {
    transcribeProgress.update(null, '等待视频保存到本地库…');
    await state.mediaUpload;
  }
  const st2 = await api(`/api/video/${state.videoId}/status`).catch(() => null);
  if (st2?.has_audio || st2?.has_file) {
    state.hasAudio = !!st2.has_audio;
    return;
  }
  throw new Error('找不到视频文件，请重新选择后再转录');
}

async function startTranscribe(mode) {
  if (!state.videoId) return;
  if (state.config && !state.config.asr_available) {
    return setHint('transcribe-status', 'ASR 依赖未安装，请重新执行 uv sync', true);
  }
  if (state.config && !state.config.asr_model_cached) {
    const name = state.config.asr?.model === 'faster-whisper'
      ? `faster-whisper ${state.config.asr?.whisper_model || 'small'}`
      : 'SenseVoiceSmall';
    if (!confirm(`首次转录需要下载 ${name} 模型文件（约几百 MB），可能较久，请保持网络畅通。是否继续？`)) {
      return;
    }
  }
  try {
    await ensureBackendMedia();
  } catch (err) {
    if (err.message === 'cancelled') return;
    setHint('transcribe-status', `转录准备失败：${err.message}`, true);
    transcribeProgress.hide();
    return;
  }
  // 实时：保留当前进度之前的字幕；整段：清空后重来，避免和旧字幕叠在一起
  if (mode === 'realtime') {
    const t = $('player').currentTime || 0;
    state.cues = state.cues.filter((c) => c.start < t);
  } else {
    state.cues = [];
  }
  invalidateSummary();
  saveCuesNow();
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
        state.cues = state.cues.filter((c) => c.start < ev.before);
        persistCuesSoon();
        renderSubtitles();
        updateVideoCaption();
        updateComposerCue();
      }
      else if (ev.type === 'cue') appendCue(ev.cue);
      else if (ev.type === 'done') {
        transcribeProgress.hide();
        saveCuesNow();
        setHint('transcribe-status', `转录完成，共 ${state.cues.length} 条`);
        if (state.config) state.config.asr_model_cached = true;
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
  $('nosub-transcribe').title = asrOk ? '' : 'ASR 依赖未安装';
  const subChip = $('chk-subtitles');
  subChip.disabled = !state.cues.length;
  if (!state.cues.length) subChip.checked = false;
  subChip.parentElement.title = state.cues.length
    ? '把当前这句字幕一并发给 AI'
    : '当前没有字幕，可先转录或导入 SRT';
  $('btn-summary').disabled = !state.videoId || !state.cues.length;
  $('btn-summary').textContent = state.summary ? '查看视频总结' : '生成视频总结';
  setTip('btn-summary',
    !state.videoId ? '请先打开视频'
      : !state.cues.length ? '需要先有字幕才能生成总结'
        : '');
  updateComposerCue();
  updateChatInjectHint();
}

function invalidateSummary() {
  state.summary = null;
  if (state.videoId) {
    api(`/api/chat/${state.videoId}/summary`, { method: 'DELETE' }).catch(() => {});
  }
}

