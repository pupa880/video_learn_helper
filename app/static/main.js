/* 菜单、启动 */
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
  if (!state.videoId) return setHint('transcribe-status', '请先打开视频', true);
  $('file-srt').click();
});
$('menu-bili-sub').addEventListener('click', () => {
  if (!state.videoId) return setHint('transcribe-status', '请先打开视频', true);
  loadBilibiliSubtitle();
});
$('menu-transcribe').addEventListener('click', () => {
  if (!state.videoId) return setHint('transcribe-status', '请先打开视频', true);
  startTranscribe('realtime');
});

$('btn-caption').addEventListener('click', () => setCaptionOn(!captionPref.on));
$('menu-caption').addEventListener('click', () => setCaptionOn(!captionPref.on));
$('chk-subtitles').addEventListener('change', updateComposerCue);

$('nosub-srt').addEventListener('click', () => {
  if (!state.videoId) return setHint('transcribe-status', '请先打开视频', true);
  $('file-srt').click();
});
$('nosub-transcribe').addEventListener('click', () => {
  if (!state.videoId) return setHint('transcribe-status', '请先打开视频', true);
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

async function migrateIdbToBackend() {
  const FLAG = 'vlh-lib-backend-v1';
  try {
    if (localStorage.getItem(FLAG)) return;
  } catch { /* 隐私模式仍尝试迁移 */ }
  if (!window.vlhLibrary) {
    try { localStorage.setItem(FLAG, '1'); } catch {}
    return;
  }
  let videos = [];
  try { videos = await vlhLibrary.listVideos(); } catch { videos = []; }
  for (const v of videos) {
    const [cues, summary, messages] = await Promise.all([
      vlhLibrary.getCues(v.id).catch(() => []),
      vlhLibrary.getSummary(v.id).catch(() => null),
      vlhLibrary.getChat(v.id).catch(() => []),
    ]);
    await api('/api/video/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: v.id,
        name: v.name,
        source: v.source,
        url: v.url || '',
        page: v.page || 1,
        uploader: v.uploader || '',
        upload_date: v.upload_date || '',
        duration: v.duration || 0,
        kind: v.kind,
        height: v.height || 0,
        qualities: v.qualities || [],
        position: v.position || 0,
        updated_at: v.updatedAt || v.updated_at,
        created_at: v.createdAt || v.created_at,
        cues,
        summary,
        messages,
      }),
    }).catch((err) => console.warn('迁入用户库失败', v.id, err));
    const file = await vlhLibrary.getLocalFile(v.id).catch(() => null);
    if (file) {
      const fd = new FormData();
      fd.append('file', file, v.fileName || v.name || 'video.mp4');
      await uploadWithProgress(`/api/video/${v.id}/media`, fd, () => {}).catch((err) => {
        console.warn('迁入本地视频失败', v.id, err);
      });
    }
  }
  try { await vlhLibrary.drop(); } catch {}
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('videos', { recursive: true });
  } catch { /* 无 OPFS */ }
  try { localStorage.setItem(FLAG, '1'); } catch {}
}

syncCaptionUI();
syncPanelMenu();
renderSubtitles();
migrateIdbToBackend()
  .catch((err) => console.warn('用户库迁移失败', err))
  .finally(async () => {
    await refreshRecentVideos();
    const openId = new URLSearchParams(location.search).get('open');
    if (!openId) return;
    history.replaceState({}, '', '/');
    try {
      const rec = await api(`/api/video/${openId}`);
      await openRecent(rec);
    } catch (err) {
      landingProgress.update(null, `打开失败：${err.message}`);
    }
  });
loadConfig().catch((err) => {
  setHint('video-title', `配置加载失败：${err.message}，请刷新页面重试`, true);
});
