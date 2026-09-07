/* 最近播放历史页：按标题搜索，点一项回到首页打开。 */

function biliKey(url, page) {
  const bv = (url || '').match(/BV[\w]+/i);
  return `${(bv ? bv[0] : (url || '')).toLowerCase()}#${page || 1}`;
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

let allVideos = [];

function matches(v, q) {
  if (!q) return true;
  const name = (v.name || v.id || '').toLowerCase();
  return name.includes(q);
}

function renderHistory() {
  const q = ($('history-q').value || '').trim().toLowerCase();
  const list = $('history-list');
  const status = $('history-status');
  list.innerHTML = '';
  const items = allVideos.filter((v) => matches(v, q));
  if (!allVideos.length) {
    status.textContent = '还没有播放记录';
    return;
  }
  status.textContent = q
    ? (items.length ? `找到 ${items.length} 条` : '没有匹配的标题')
    : `共 ${items.length} 条`;
  for (const v of items) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'rv-name';
    name.textContent = v.name || v.id;
    const meta = document.createElement('span');
    meta.className = 'rv-meta';
    const bits = [];
    if (v.duration) bits.push(fmtTime(v.duration));
    if (v.source === 'bilibili') bits.push('B站');
    meta.textContent = bits.join(' · ');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'rv-del';
    del.title = '从列表移除';
    del.setAttribute('aria-label', '从列表移除');
    del.textContent = '×';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`移除「${v.name || v.id}」？字幕、总结和对话会一起从本地库删掉。`)) return;
      try {
        await api(`/api/video/${v.id}`, { method: 'DELETE' });
        allVideos = allVideos.filter((x) => x.id !== v.id);
        renderHistory();
      } catch (err) {
        status.textContent = `删除失败：${err.message}`;
      }
    });
    li.append(name, meta, del);
    li.addEventListener('click', () => {
      location.href = `/?open=${encodeURIComponent(v.id)}`;
    });
    list.append(li);
  }
}

$('history-q').addEventListener('input', renderHistory);

(async () => {
  try {
    const { videos } = await api('/api/video/list');
    allVideos = dedupeVideos(videos || []);
  } catch (err) {
    $('history-status').textContent = `加载失败：${err.message}`;
    return;
  }
  renderHistory();
})();
