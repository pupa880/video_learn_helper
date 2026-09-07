/* 全屏悬浮 AI 问答：快捷键唤起、拖动、缩放。几何与快捷键存 localStorage。 */

const FS_CHAT_KEY = 'vlh-fs-chat';
const FS_CHAT_MIN_W = 300;
const FS_CHAT_MIN_H = 220;
const FS_CHAT_MARGIN = 8;
const DEFAULT_FS_SHORTCUT = { ctrl: false, alt: true, shift: false, meta: false, code: 'KeyA' };

const fsChat = {
  open: false,
  capturing: false,
  geom: null,
  shortcut: { ...DEFAULT_FS_SHORTCUT },
  dragTitle: '',
};

function loadFsChatPrefs() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(FS_CHAT_KEY) || '{}'); } catch { raw = {}; }
  fsChat.shortcut = normalizeShortcut(raw.shortcut) || { ...DEFAULT_FS_SHORTCUT };
  fsChat.geom = isGeom(raw.geom) ? raw.geom : null;
}

function saveFsChatPrefs() {
  try {
    localStorage.setItem(FS_CHAT_KEY, JSON.stringify({
      shortcut: fsChat.shortcut,
      geom: fsChat.geom,
    }));
  } catch { /* 隐私模式 */ }
}

function isGeom(g) {
  return g && ['left', 'top', 'width', 'height'].every((k) => Number.isFinite(g[k]));
}

function normalizeShortcut(s) {
  if (!s || typeof s.code !== 'string' || !s.code) return null;
  const spec = {
    ctrl: !!s.ctrl,
    alt: !!s.alt,
    shift: !!s.shift,
    meta: !!s.meta,
    code: s.code,
  };
  return isValidShortcut(spec) ? spec : null;
}

function isValidShortcut(spec) {
  if (!spec?.code) return false;
  if (['Escape', 'Tab', 'F11', 'F12', 'ContextMenu'].includes(spec.code)) return false;
  const hasMod = spec.ctrl || spec.alt || spec.meta;
  const isFn = /^F([1-9]|1[0-2])$/.test(spec.code);
  return hasMod || isFn;
}

function codeLabel(code) {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = {
    Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'",
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Space: 'Space', ArrowUp: '↑', ArrowDown: '↓',
    ArrowLeft: '←', ArrowRight: '→',
  };
  return map[code] || code;
}

function formatShortcut(spec) {
  const parts = [];
  if (spec.ctrl) parts.push('Ctrl');
  if (spec.alt) parts.push('Alt');
  if (spec.shift) parts.push('Shift');
  if (spec.meta) parts.push('Meta');
  parts.push(codeLabel(spec.code));
  return parts.join(' + ');
}

function shortcutFromEvent(e) {
  return {
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    meta: e.metaKey,
    code: e.code,
  };
}

function matchShortcut(e, spec) {
  if (!spec || e.repeat) return false;
  return !!e.ctrlKey === !!spec.ctrl
    && !!e.altKey === !!spec.alt
    && !!e.shiftKey === !!spec.shift
    && !!e.metaKey === !!spec.meta
    && e.code === spec.code;
}

function isPlayerFullscreen() {
  return document.fullscreenElement === $('player-box');
}

function parkModals(into) {
  document.querySelectorAll('.modal').forEach((m) => into.appendChild(m));
}

function restoreModals() {
  document.querySelectorAll('.modal').forEach((m) => document.body.appendChild(m));
}

function defaultFsGeom() {
  const box = $('player-box');
  const W = box.clientWidth;
  const H = box.clientHeight;
  const w = Math.min(400, Math.max(FS_CHAT_MIN_W, Math.round(W * 0.36)));
  const h = Math.min(Math.max(FS_CHAT_MIN_H, Math.round(H * 0.72)), Math.max(FS_CHAT_MIN_H, H - FS_CHAT_MARGIN * 2));
  return {
    left: Math.max(FS_CHAT_MARGIN, W - w - 16),
    top: FS_CHAT_MARGIN + 8,
    width: w,
    height: h,
  };
}

function clampFsGeom(g) {
  const box = $('player-box');
  const W = box.clientWidth;
  const H = box.clientHeight;
  const maxW = Math.max(FS_CHAT_MIN_W, W - FS_CHAT_MARGIN * 2);
  const maxH = Math.max(FS_CHAT_MIN_H, H - FS_CHAT_MARGIN * 2);
  const width = Math.min(Math.max(g.width, FS_CHAT_MIN_W), maxW);
  const height = Math.min(Math.max(g.height, FS_CHAT_MIN_H), maxH);
  const left = Math.min(Math.max(g.left, FS_CHAT_MARGIN), Math.max(FS_CHAT_MARGIN, W - width - FS_CHAT_MARGIN));
  const top = Math.min(Math.max(g.top, FS_CHAT_MARGIN), Math.max(FS_CHAT_MARGIN, H - height - FS_CHAT_MARGIN));
  return { left, top, width, height };
}

function applyFsGeom(g) {
  const el = $('fs-chat');
  const next = clampFsGeom(g);
  el.style.left = `${next.left}px`;
  el.style.top = `${next.top}px`;
  el.style.width = `${next.width}px`;
  el.style.height = `${next.height}px`;
  return next;
}

function persistFsGeom(g) {
  fsChat.geom = clampFsGeom(g);
  saveFsChatPrefs();
}

function chatRegion() {
  return document.querySelector('.region-chat');
}

function setChatDragEnabled(on) {
  const handle = chatRegion()?.querySelector('.region-drag');
  if (!handle) return;
  if (on) {
    handle.setAttribute('draggable', 'true');
    handle.title = fsChat.dragTitle || '拖动标题可调整布局';
  } else {
    if (!fsChat.dragTitle) fsChat.dragTitle = handle.title || '拖动标题可调整布局';
    handle.setAttribute('draggable', 'false');
    handle.title = '拖动移动窗口';
  }
}

function syncFsChatUi() {
  const label = formatShortcut(fsChat.shortcut);
  const btn = $('btn-fs-chat');
  if (btn) {
    btn.title = `问答（${label}）`;
    btn.classList.toggle('is-on', fsChat.open);
    btn.setAttribute('aria-pressed', fsChat.open ? 'true' : 'false');
  }
  const close = $('btn-fs-chat-close');
  if (close) {
    close.hidden = !fsChat.open;
    close.title = `关闭悬浮问答（${label}）`;
  }
  const rec = $('cfg-fs-chat-shortcut');
  if (rec && !fsChat.capturing) rec.textContent = label;
}

function openFsChat() {
  if (fsChat.open || !isPlayerFullscreen()) return;
  const overlay = $('fs-chat');
  const body = $('fs-chat-body');
  const region = chatRegion();
  if (!overlay || !body || !region) return;

  fsChat.open = true;
  document.body.classList.add('fs-chat-open');
  parkModals($('player-box'));
  body.appendChild(region);
  setChatDragEnabled(false);
  overlay.hidden = false;
  applyFsGeom(fsChat.geom || defaultFsGeom());
  syncFsChatUi();
  window.dispatchEvent(new Event('vlh-layout-change'));
  requestAnimationFrame(() => {
    const ta = $('chat-text');
    if (ta) { ta.focus(); ta.scrollIntoView({ block: 'nearest' }); }
    scrollChatToBottom?.();
  });
}

function closeFsChat() {
  if (!fsChat.open) return;
  fsChat.open = false;
  document.body.classList.remove('fs-chat-open', 'fs-chat-moving');
  $('fs-chat').hidden = true;
  setChatDragEnabled(true);
  syncFsChatUi();
  if (!isPlayerFullscreen()) restoreModals();
  window.vlhLayout?.refresh?.();
}

function toggleFsChat() {
  if (!isPlayerFullscreen()) return;
  if (fsChat.open) closeFsChat();
  else openFsChat();
}

function onFullscreenChange() {
  if (isPlayerFullscreen()) {
    parkModals($('player-box'));
    return;
  }
  closeFsChat();
  restoreModals();
}

/* ---------- 拖动 / 缩放 ---------- */

function bindFsChatMove() {
  const overlay = $('fs-chat');
  let mode = null; // 'move' | edge string
  let startX = 0;
  let startY = 0;
  let startG = null;
  let captureEl = null;

  const currentGeom = () => ({
    left: parseFloat(overlay.style.left) || 0,
    top: parseFloat(overlay.style.top) || 0,
    width: overlay.offsetWidth,
    height: overlay.offsetHeight,
  });

  const onMove = (e) => {
    if (!mode) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    let { left, top, width, height } = startG;
    if (mode === 'move') {
      left += dx;
      top += dy;
    } else {
      if (mode.includes('e')) width += dx;
      if (mode.includes('s')) height += dy;
      if (mode.includes('w')) { left += dx; width -= dx; }
      if (mode.includes('n')) { top += dy; height -= dy; }
    }
    applyFsGeom({ left, top, width, height });
  };

  const end = (e) => {
    if (!mode) return;
    mode = null;
    document.body.classList.remove('fs-chat-moving');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    persistFsGeom(currentGeom());
    try { captureEl?.releasePointerCapture?.(e.pointerId); } catch { /* */ }
    captureEl = null;
  };

  const begin = (edge, e) => {
    if (e.button !== 0 || !fsChat.open) return;
    e.preventDefault();
    e.stopPropagation();
    mode = edge;
    startX = e.clientX;
    startY = e.clientY;
    startG = currentGeom();
    captureEl = overlay;
    document.body.classList.add('fs-chat-moving');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    try { overlay.setPointerCapture(e.pointerId); } catch { /* */ }
  };

  overlay.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.fs-chat-handle');
    if (handle) return begin(handle.dataset.edge, e);
    const bar = e.target.closest('.region-bar');
    if (!bar) return;
    if (e.target.closest('button, .menu, a, input, textarea, select')) return;
    begin('move', e);
  });
}

/* ---------- 快捷键设置 ---------- */

function renderShortcutBtn() {
  const btn = $('cfg-fs-chat-shortcut');
  if (!btn) return;
  btn.classList.toggle('is-recording', fsChat.capturing);
  btn.textContent = fsChat.capturing ? '按下组合键…' : formatShortcut(fsChat.shortcut);
}

function setShortcut(spec) {
  fsChat.shortcut = spec;
  saveFsChatPrefs();
  fsChat.capturing = false;
  renderShortcutBtn();
  syncFsChatUi();
}

function initFsChatShortcutUi() {
  const btn = $('cfg-fs-chat-shortcut');
  const reset = $('cfg-fs-chat-shortcut-reset');
  if (!btn) return;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    fsChat.capturing = !fsChat.capturing;
    renderShortcutBtn();
  });
  reset?.addEventListener('click', () => setShortcut({ ...DEFAULT_FS_SHORTCUT }));

  document.addEventListener('mousedown', (e) => {
    if (!fsChat.capturing) return;
    if (e.target === btn || e.target === reset) return;
    fsChat.capturing = false;
    renderShortcutBtn();
  });
}

function onGlobalKeydown(e) {
  if (fsChat.capturing) {
    if (e.key === 'Escape') {
      e.preventDefault();
      fsChat.capturing = false;
      renderShortcutBtn();
      return;
    }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const spec = shortcutFromEvent(e);
    if (!isValidShortcut(spec)) {
      const btn = $('cfg-fs-chat-shortcut');
      if (btn) btn.textContent = '请加上 Ctrl / Alt / Meta';
      return;
    }
    setShortcut(spec);
    return;
  }

  if (!matchShortcut(e, fsChat.shortcut)) return;
  if (!isPlayerFullscreen()) return;
  e.preventDefault();
  e.stopPropagation();
  toggleFsChat();
}

function initFsChat() {
  loadFsChatPrefs();
  bindFsChatMove();
  initFsChatShortcutUi();
  syncFsChatUi();

  $('btn-fs-chat')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFsChat();
  });
  $('btn-fs-chat-close')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeFsChat();
  });

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('keydown', onGlobalKeydown, true);

  if (typeof ResizeObserver !== 'undefined') {
    const box = $('player-box');
    if (box) {
      new ResizeObserver(() => {
        if (!fsChat.open) return;
        applyFsGeom({
          left: parseFloat($('fs-chat').style.left) || 0,
          top: parseFloat($('fs-chat').style.top) || 0,
          width: $('fs-chat').offsetWidth,
          height: $('fs-chat').offsetHeight,
        });
      }).observe(box);
    }
  }
}

initFsChat();

window.vlhFsChat = {
  isOpen: () => fsChat.open,
  toggle: toggleFsChat,
  open: openFsChat,
  close: closeFsChat,
};
