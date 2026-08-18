/* 三栏布局：分割条缩放 + 拖标题互换/贴边重排。状态存 localStorage。 */

const LAYOUT_KEY = 'vlh-layout-v2';
const HIDDEN_KEY = 'vlh-hidden-panels';
const LAYOUT_MQ = '(max-width: 900px)';
const GUTTER_PX = 12;
const MIN_COL_PX = 280;
const MIN_ROW_PX = 160;
const PANEL_IDS = ['video', 'chat', 'subtitle'];

const DEFAULT_LAYOUT = {
  type: 'split',
  dir: 'col',
  ratio: 0.6,
  defaultRatio: 0.6,
  a: {
    type: 'split',
    dir: 'row',
    ratio: 0.535,
    defaultRatio: 0.535,
    a: { type: 'leaf', id: 'video' },
    b: { type: 'leaf', id: 'subtitle' },
  },
  b: { type: 'leaf', id: 'chat' },
};

const EDGE_PAIR = {
  top:    (dragged, other) => splitNode('row', 0.5, dragged, other),
  bottom: (dragged, other) => splitNode('row', 0.5, other, dragged),
  left:   (dragged, other) => splitNode('col', 0.5, dragged, other),
  right:  (dragged, other) => splitNode('col', 0.5, other, dragged),
};

let tree = clone(DEFAULT_LAYOUT);
let hidden = new Set();
let dragFromId = null;
let activeZone = null;

function splitNode(dir, ratio, a, b) {
  return { type: 'split', dir, ratio, defaultRatio: ratio, a, b };
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function isMobile() {
  return window.matchMedia(LAYOUT_MQ).matches;
}

function getNode(root, path) {
  let n = root;
  for (const key of path) n = n[key];
  return n;
}

function collectIds(node, out = []) {
  if (node.type === 'leaf') out.push(node.id);
  else {
    collectIds(node.a, out);
    collectIds(node.b, out);
  }
  return out;
}

function isValidTree(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'leaf') return PANEL_IDS.includes(node.id);
  if (node.type !== 'split') return false;
  if (node.dir !== 'row' && node.dir !== 'col') return false;
  if (typeof node.ratio !== 'number' || !(node.ratio > 0 && node.ratio < 1)) return false;
  if (typeof node.defaultRatio !== 'number') node.defaultRatio = node.ratio;
  return isValidTree(node.a) && isValidTree(node.b);
}

function loadTree() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isValidTree(parsed)) return null;
    const ids = collectIds(parsed);
    if (ids.length !== 3 || !PANEL_IDS.every((id) => ids.includes(id))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistTree() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(tree)); } catch { /* 隐私模式 */ }
}

function loadHidden() {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((id) => PANEL_IDS.includes(id)));
  } catch {
    return new Set();
  }
}

function persistHidden() {
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden])); } catch { /* 隐私模式 */ }
}

function anyVisible(node) {
  if (!node) return false;
  if (node.type === 'leaf') return !hidden.has(node.id);
  return anyVisible(node.a) || anyVisible(node.b);
}

function buildVisible(node, path) {
  if (node.type === 'leaf') {
    if (hidden.has(node.id)) return null;
    const pane = document.createElement('div');
    pane.className = 'split-pane';
    pane.dataset.slot = node.id;
    return pane;
  }
  const a = buildVisible(node.a, [...path, 'a']);
  const b = buildVisible(node.b, [...path, 'b']);
  if (!a) return b;
  if (!b) return a;
  const wrap = document.createElement('div');
  wrap.className = `split split-${node.dir}`;
  a.style.flex = `${node.ratio} 1 0%`;
  b.style.flex = `${1 - node.ratio} 1 0%`;
  wrap.append(a, makeGutter(node.dir, path), b);
  return wrap;
}

function setPanelHidden(id, hide) {
  if (!PANEL_IDS.includes(id)) return;
  if (hide) hidden.add(id);
  else hidden.delete(id);
  persistHidden();
  renderLayout();
  window.dispatchEvent(new Event('vlh-layout-change'));
}

function isPanelHidden(id) {
  return hidden.has(id);
}

function minSize(node, axis) {
  if (node.type === 'leaf') return axis === 'col' ? MIN_COL_PX : MIN_ROW_PX;
  if (node.dir === axis) return minSize(node.a, axis) + GUTTER_PX + minSize(node.b, axis);
  return Math.max(minSize(node.a, axis), minSize(node.b, axis));
}

function clampRatio(node, el, raw) {
  const rect = el.getBoundingClientRect();
  const total = (node.dir === 'col' ? rect.width : rect.height) - GUTTER_PX;
  if (total <= 0) return 0.5;
  const minR = minSize(node.a, node.dir) / total;
  const maxR = 1 - minSize(node.b, node.dir) / total;
  if (!(minR < maxR)) return 0.5;
  return Math.min(maxR, Math.max(minR, raw));
}

function swapIds(node, a, b) {
  if (node.type === 'leaf') {
    if (node.id === a) node.id = b;
    else if (node.id === b) node.id = a;
    return;
  }
  swapIds(node.a, a, b);
  swapIds(node.b, a, b);
}

function extractLeaf(node, id) {
  if (node.type === 'leaf') {
    return node.id === id ? { rest: null, leaf: node } : { rest: node, leaf: null };
  }
  const left = extractLeaf(node.a, id);
  if (left.leaf) {
    return { rest: left.rest === null ? node.b : { ...node, a: left.rest }, leaf: left.leaf };
  }
  const right = extractLeaf(node.b, id);
  if (right.leaf) {
    return { rest: right.rest === null ? node.a : { ...node, b: right.rest }, leaf: right.leaf };
  }
  return { rest: node, leaf: null };
}

function replaceLeaf(node, id, replacement) {
  if (node.type === 'leaf') return node.id === id ? replacement : node;
  return { ...node, a: replaceLeaf(node.a, id, replacement), b: replaceLeaf(node.b, id, replacement) };
}

function applySwap(fromId, targetId) {
  if (!fromId || !targetId || fromId === targetId) return;
  const next = clone(tree);
  swapIds(next, fromId, targetId);
  tree = next;
  persistTree();
  renderLayout();
}

function applyDockPanel(fromId, targetId, edge) {
  const make = EDGE_PAIR[edge];
  if (!make || !fromId || !targetId || fromId === targetId) return;
  const { rest, leaf } = extractLeaf(tree, fromId);
  if (!rest || !leaf) return;
  tree = replaceLeaf(rest, targetId, make(leaf, { type: 'leaf', id: targetId }));
  persistTree();
  renderLayout();
}

function applyDockWorkspace(fromId, edge) {
  const make = EDGE_PAIR[edge];
  if (!make || !fromId) return;
  const { rest, leaf } = extractLeaf(tree, fromId);
  if (!rest || !leaf) return;
  const outerDir = (edge === 'left' || edge === 'right') ? 'col' : 'row';
  let other = rest;
  // 占满左/右侧时，剩下两块改成上下堆，避免变成难用的三列
  if (rest.type === 'split' && rest.dir === outerDir) {
    const ids = collectIds(rest);
    other = splitNode(outerDir === 'col' ? 'row' : 'col', 0.5,
      { type: 'leaf', id: ids[0] }, { type: 'leaf', id: ids[1] });
  }
  tree = make(leaf, other);
  persistTree();
  renderLayout();
}

function resetLayout() {
  tree = clone(DEFAULT_LAYOUT);
  hidden = new Set();
  persistTree();
  persistHidden();
  renderLayout();
  window.dispatchEvent(new Event('vlh-layout-change'));
}

function getPanels() {
  const out = {};
  for (const id of PANEL_IDS) {
    out[id] = document.querySelector(`[data-panel="${id}"]`);
  }
  return out;
}

function makeGutter(dir, path) {
  const el = document.createElement('div');
  el.className = `gutter gutter-${dir}`;
  el.dataset.path = path.join('.');
  el.title = '拖动调整大小，双击恢复默认比例';
  el.setAttribute('role', 'separator');
  el.setAttribute('aria-orientation', dir === 'col' ? 'vertical' : 'horizontal');
  return el;
}

function buildSkeleton(node, path) {
  if (node.type === 'leaf') {
    const pane = document.createElement('div');
    pane.className = 'split-pane';
    pane.dataset.slot = node.id;
    return pane;
  }
  const wrap = document.createElement('div');
  wrap.className = `split split-${node.dir}`;
  const a = buildSkeleton(node.a, [...path, 'a']);
  a.style.flex = `${node.ratio} 1 0%`;
  const b = buildSkeleton(node.b, [...path, 'b']);
  b.style.flex = `${1 - node.ratio} 1 0%`;
  wrap.append(a, makeGutter(node.dir, path), b);
  return wrap;
}

function bindGutters(root) {
  root.querySelectorAll('.gutter').forEach((gutter) => {
    const path = gutter.dataset.path ? gutter.dataset.path.split('.') : [];
    const node = getNode(tree, path);
    if (!node || node.type !== 'split') return;
    const splitEl = gutter.parentElement;

    let dragging = false;
    let dragPointerId = null;

    const onMove = (e) => {
      if (!dragging) return;
      const rect = splitEl.getBoundingClientRect();
      const raw = node.dir === 'col'
        ? (e.clientX - rect.left - GUTTER_PX / 2) / (rect.width - GUTTER_PX)
        : (e.clientY - rect.top - GUTTER_PX / 2) / (rect.height - GUTTER_PX);
      node.ratio = clampRatio(node, splitEl, raw);
      const panes = [gutter.previousElementSibling, gutter.nextElementSibling];
      panes[0].style.flex = `${node.ratio} 1 0%`;
      panes[1].style.flex = `${1 - node.ratio} 1 0%`;
    };

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      if (dragPointerId != null) {
        try { gutter.releasePointerCapture(dragPointerId); } catch { /* 可能没有捕获 */ }
      }
      dragPointerId = null;
      gutter.classList.remove('dragging');
      document.body.classList.remove('layout-resizing', 'layout-resizing-col', 'layout-resizing-row');
      persistTree();
      window.dispatchEvent(new Event('resize'));
    };

    gutter.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || isMobile()) return;
      e.preventDefault();
      dragPointerId = e.pointerId;
      try { gutter.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
      dragging = true;
      gutter.classList.add('dragging');
      document.body.classList.add('layout-resizing', `layout-resizing-${node.dir}`);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
    });

    gutter.addEventListener('dblclick', (e) => {
      e.preventDefault();
      node.ratio = node.defaultRatio ?? 0.5;
      persistTree();
      renderLayout();
    });
  });
}

function zoneFromEvent(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  return el?.closest?.('.dz') || null;
}

function highlightZone(zone) {
  if (activeZone === zone) return;
  activeZone?.classList.remove('active');
  activeZone = zone;
  activeZone?.classList.add('active');
}

function clearOverlays() {
  document.querySelectorAll('.dock-overlay, .dock-workspace').forEach((el) => el.remove());
  document.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
  highlightZone(null);
  dragFromId = null;
}

function onLayoutDragOver(e) {
  if (!dragFromId) return;
  const zone = zoneFromEvent(e) || e.target.closest?.('.dz');
  if (!zone) {
    highlightZone(null);
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  highlightZone(zone);
}

function onLayoutDrop(e) {
  if (!dragFromId) return;
  const zone = zoneFromEvent(e) || e.target.closest?.('.dz');
  if (!zone) return;
  e.preventDefault();
  const fromId = dragFromId;
  const action = zone.dataset.action;
  const edge = zone.dataset.edge;
  const targetId = zone.closest('.dock-overlay')?.dataset.target;
  clearOverlays();
  if (action === 'swap') applySwap(fromId, targetId);
  else if (action === 'dock') applyDockPanel(fromId, targetId, edge);
  else if (action === 'workspace') applyDockWorkspace(fromId, edge);
}

function showOverlays(fromId) {
  const root = document.getElementById('layout');
  const ws = document.createElement('div');
  ws.className = 'dock-workspace';
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    const z = document.createElement('div');
    z.className = `dz dz-ws dz-ws-${edge}`;
    z.dataset.action = 'workspace';
    z.dataset.edge = edge;
    z.dataset.label = ({ top: '占满顶侧', bottom: '占满底侧', left: '占满左侧', right: '占满右侧' })[edge];
    ws.append(z);
  }
  root.append(ws);

  const labels = { top: '贴到上侧', bottom: '贴到下侧', left: '贴到左侧', right: '贴到右侧' };
  for (const id of PANEL_IDS) {
    if (id === fromId || hidden.has(id)) continue;
    const region = document.querySelector(`[data-panel="${id}"]`);
    if (!region) continue;
    const ov = document.createElement('div');
    ov.className = 'dock-overlay';
    ov.dataset.target = id;
    for (const [cls, action, edge, label] of [
      ['dz-top', 'dock', 'top', labels.top],
      ['dz-left', 'dock', 'left', labels.left],
      ['dz-center', 'swap', '', '互换'],
      ['dz-right', 'dock', 'right', labels.right],
      ['dz-bottom', 'dock', 'bottom', labels.bottom],
    ]) {
      const z = document.createElement('div');
      z.className = `dz ${cls}`;
      z.dataset.action = action;
      if (edge) z.dataset.edge = edge;
      z.dataset.label = label;
      ov.append(z);
    }
    region.append(ov);
  }
}

function onDragStart(e) {
  const handle = e.target.closest('.region-drag');
  if (!handle || isMobile()) {
    e.preventDefault();
    return;
  }
  const panel = handle.closest('[data-panel]');
  if (!panel) {
    e.preventDefault();
    return;
  }
  dragFromId = panel.dataset.panel;
  e.dataTransfer.setData('text/plain', dragFromId);
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setDragImage(handle, 12, 12); } catch { /* 部分浏览器不支持 */ }
  panel.classList.add('is-dragging');
  showOverlays(dragFromId);
}

function onDragEnd() {
  clearOverlays();
}

function renderLayout() {
  const root = document.getElementById('layout');
  if (!root) return;
  const panels = getPanels();
  if (PANEL_IDS.some((id) => !panels[id])) return;

  // 先把面板从旧树上摘到 root，再删 leftover，避免隐藏面板跟着旧树被移除
  for (const id of PANEL_IDS) {
    root.append(panels[id]);
    panels[id].classList.toggle('panel-hidden', hidden.has(id));
  }
  [...root.children]
    .filter((el) => el.classList.contains('split') || el.classList.contains('layout-stack'))
    .forEach((el) => el.remove());

  if (isMobile()) {
    const stack = document.createElement('div');
    stack.className = 'layout-stack';
    root.append(stack);
    for (const id of ['video', 'subtitle', 'chat']) {
      if (!hidden.has(id)) stack.append(panels[id]);
    }
  } else if (!anyVisible(tree)) {
    const empty = document.createElement('div');
    empty.className = 'layout-stack';
    empty.style.cssText = 'align-items:center;justify-content:center;color:#7a8494;font-size:13px;';
    empty.textContent = '所有面板已隐藏，可在右上角菜单中重新打开';
    root.append(empty);
  } else {
    const treeEl = buildVisible(tree, []);
    root.append(treeEl);
    for (const id of PANEL_IDS) {
      if (hidden.has(id)) continue;
      const slot = treeEl.dataset?.slot === id
        ? treeEl
        : treeEl.querySelector(`[data-slot="${id}"]`);
      if (slot) slot.append(panels[id]);
    }
    bindGutters(root);
  }
  window.dispatchEvent(new Event('resize'));
}

function initLayout() {
  tree = loadTree() || clone(DEFAULT_LAYOUT);
  hidden = loadHidden();

  const root = document.getElementById('layout');
  if (!root) return;

  root.addEventListener('dragstart', onDragStart);
  root.addEventListener('dragend', onDragEnd);
  root.addEventListener('dragover', onLayoutDragOver);
  root.addEventListener('drop', onLayoutDrop);

  document.getElementById('btn-reset-layout')?.addEventListener('click', resetLayout);

  const mq = window.matchMedia(LAYOUT_MQ);
  mq.addEventListener('change', renderLayout);

  renderLayout();
}

initLayout();

window.vlhLayout = {
  getTree: () => clone(tree),
  swap: applySwap,
  dockPanel: applyDockPanel,
  dockWorkspace: applyDockWorkspace,
  reset: resetLayout,
  setHidden: setPanelHidden,
  isHidden: isPanelHidden,
  getHidden: () => [...hidden],
};
