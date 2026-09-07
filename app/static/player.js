/* 播放器控制、倍速、进度记忆 */
/* ---------- 播放器自定义控制条（不遮挡画面） ---------- */

function persistCuesSoon() {
  if (!state.videoId) return;
  clearTimeout(persistCuesSoon._t);
  persistCuesSoon._t = setTimeout(() => { saveCuesNow(); }, 400);
}

async function saveCuesNow() {
  if (!state.videoId) return;
  try {
    await api(`/api/subtitle/${state.videoId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cues: state.cues }),
    });
  } catch {}
}

async function persistChat() {
  if (!state.videoId) return;
  try {
    await api(`/api/chat/${state.videoId}/history`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: state.messages }),
    });
  } catch {}
}

const PLAYBACK_RATES = [0.5, 1, 1.25, 1.5, 2];
const ratePref = { value: 1 };

function applyRate() {
  $('player').playbackRate = ratePref.value;
  $('rate-select').value = String(ratePref.value);
}

function setRate(r) {
  const n = Number(r);
  ratePref.value = PLAYBACK_RATES.includes(n) ? n : 1;
  applyRate();
}

function persistPosition(immediate = false) {
  if (!state.videoId || !state.video) return;
  if (state.resumeAt != null) return;
  const t = $('player').currentTime;
  if (!Number.isFinite(t) || t < 0) return;
  const dur = videoDuration();
  let pos = t;
  if (dur > 0 && t >= Math.max(dur - 5, dur * 0.98)) pos = 0;
  if (!immediate && Math.abs((state.video.position || 0) - pos) < 2) return;
  state.video.position = pos;
  const flush = () => {
    if (!state.videoId) return;
    api(`/api/video/${state.videoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: pos }),
    }).catch(() => {});
  };
  clearTimeout(persistPosition._t);
  if (immediate) flush();
  else persistPosition._t = setTimeout(flush, 2000);
}

function applyResume() {
  applyRate();
  const v = $('player');
  if (v.readyState < 1) return;
  if (state.resumeAt != null) {
    const t = state.resumeAt;
    const dur = videoDuration();
    if (dur > 0 && t >= dur - 0.5) {
      state.resumeAt = null;
    } else if (Math.abs((v.currentTime || 0) - t) > 0.4) {
      try { v.currentTime = t; } catch { /* 片源尚未可 seek */ }
      return;
    } else {
      state.resumeAt = null;
    }
  }
  if (state.resumePlay && v.readyState >= 2) {
    state.resumePlay = false;
    v.play().catch(() => {});
  }
}

function revokeBlob() {
  if (state.blobUrl) {
    URL.revokeObjectURL(state.blobUrl);
    state.blobUrl = null;
  }
}

function togglePlay() {
  const v = $('player');
  if (!state.videoId) return;
  v.paused ? v.play() : v.pause();
}

$('btn-play').addEventListener('click', togglePlay);
$('player').addEventListener('click', togglePlay);
$('player').addEventListener('play', () => {
  $('btn-play').textContent = '⏸';
  applyRate();
});
$('player').addEventListener('pause', () => {
  $('btn-play').textContent = '▶';
  persistPosition(true);
});
$('player').addEventListener('seeked', () => persistPosition(true));
$('player').addEventListener('ratechange', () => {
  if (Math.abs($('player').playbackRate - ratePref.value) > 0.01) {
    $('player').playbackRate = ratePref.value;
  }
});
$('rate-select').value = String(ratePref.value);
$('rate-select').addEventListener('change', (e) => setRate(e.target.value));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistPosition(true);
});
window.addEventListener('pagehide', () => persistPosition(true));

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
  persistPosition(false);
});
$('player').addEventListener('loadedmetadata', () => {
  applyResume();
  $('time-display').textContent = `${fmtTime($('player').currentTime || 0)} / ${fmtTime(videoDuration())}`;
  const d = $('player').duration;
  if (state.video && Number.isFinite(d) && d > 0 && !state.video.duration) {
    state.video.duration = d;
    state.duration = d;
    api(`/api/video/${state.videoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: d }),
    }).catch(() => {});
  }
});
$('player').addEventListener('canplay', applyResume);
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

