/* 问答、对话设置 */
/* ---------- AI 问答 ---------- */

function renderChatFromState() {
  $('chat-messages').querySelectorAll('.msg').forEach((el) => el.remove());
  for (const m of state.messages) {
    if (m.role === 'user') {
      if (m.ui) addUserMessage(m.ui.text, m.ui);
      else addMessage('user', m.content);
    } else if (m.role === 'assistant') {
      addMessage('assistant', m.content);
    } else if (m.role === 'divider') {
      addChatSplit(m.kind);
    }
  }
}

function addChatSplit(kind) {
  const div = document.createElement('div');
  div.className = 'msg chat-split';
  div.textContent = kind === 'compress'
    ? '------------上下文已压缩--------'
    : '---------新对话-----------';
  $('chat-messages').appendChild(div);
  scrollChatToBottom();
  return div;
}

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

function addUserMessage(text, { currentText, windowText, image } = {}) {
  const div = document.createElement('div');
  div.className = 'msg user';
  if (currentText) {
    const quote = document.createElement('div');
    quote.className = 'quote';
    const cap = document.createElement('div');
    cap.className = 'quote-cap';
    cap.textContent = '当前字幕';
    const body = document.createElement('div');
    body.textContent = currentText;
    quote.append(cap, body);
    div.append(quote);
  }
  if (windowText) {
    const box = document.createElement('details');
    box.className = 'turn-ctx';
    const sum = document.createElement('summary');
    const n = windowText.split('\n').filter(Boolean).length;
    sum.textContent = `前后文 ${n} 条`;
    const body = document.createElement('div');
    body.className = 'turn-ctx-body';
    body.textContent = windowText;
    box.append(sum, body);
    div.append(box);
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

/* 与后端 _fmt_ts / cues_to_text(with_time=True) 对齐： [HH:MM:SS,mmm] */
function fmtCueTs(sec) {
  const totalMs = Math.round(Math.max(0, Number(sec) || 0) * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  let rem = totalMs % 3_600_000;
  const m = Math.floor(rem / 60_000);
  rem %= 60_000;
  const s = Math.floor(rem / 1000);
  const ms = rem % 1000;
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

function cueToText(cue) {
  return `[${fmtCueTs(cue.start)}] ${cue.text}`;
}

function collectTurnSubtitles(t) {
  if (!$('chk-subtitles').checked || !state.cues.length) {
    return { current: null, window: null };
  }
  let idx = -1;
  for (let i = 0; i < state.cues.length; i++) {
    if (state.cues[i].start <= t) idx = i; else break;
  }
  if (idx < 0) return { current: null, window: null };
  const current = cueToText(state.cues[idx]);
  let windowText = null;
  // 已注入完整字幕时前后文不再重复写入本条
  if (!chatCtx.fullSubtitles) {
    const before = Math.max(0, chatCtx.before);
    const after = Math.max(0, chatCtx.after);
    const win = state.cues.slice(Math.max(0, idx - before), idx)
      .concat(state.cues.slice(idx + 1, idx + 1 + after));
    if (win.length) windowText = win.map(cueToText).join('\n');
  }
  return { current, window: windowText };
}

function composeUserContent(question, { current, window: windowText } = {}) {
  const parts = [];
  if (current) {
    parts.push('【当前字幕】用户当前停留在这一句；用户说“这句话”“这句”时通常指它。\n' + current);
  }
  if (windowText) {
    parts.push('【当前播放位置前后的字幕】\n' + windowText);
  }
  parts.push(question);
  return parts.join('\n\n');
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
    videoInfo: raw.videoInfo !== false,             // 默认开
    fullSubtitles: raw.fullSubtitles === true,      // 默认关
    before: clampInt(raw.before, 0, 100, 10),
    after: clampInt(raw.after, 0, 100, 0),
    autoCompress: raw.autoCompress === true,        // 默认关
    compressK: clampInt(raw.compressK, 8, 2000, 200),
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
  $('cs-video-info').checked = chatCtx.videoInfo;
  $('cs-full-subtitles').checked = chatCtx.fullSubtitles;
  $('cs-before').value = chatCtx.before;
  $('cs-after').value = chatCtx.after;
  $('cs-auto-compress').checked = chatCtx.autoCompress;
  $('cs-compress-k').value = chatCtx.compressK;
  updateCsPreview();

  $('cs-video-info').addEventListener('change', (e) => {
    chatCtx.videoInfo = e.target.checked;
    saveChatCtx();
    updateChatInjectHint();
  });
  $('cs-summary').addEventListener('change', (e) => {
    chatCtx.summary = e.target.checked;
    if (e.target.checked && !confirmBothCtx(e.target)) chatCtx.summary = false;
    saveChatCtx();
    updateChatInjectHint();
  });
  $('cs-full-subtitles').addEventListener('change', (e) => {
    chatCtx.fullSubtitles = e.target.checked;
    if (e.target.checked && !confirmBothCtx(e.target)) chatCtx.fullSubtitles = false;
    saveChatCtx();
    updateChatInjectHint();
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
  $('cs-auto-compress').addEventListener('change', (e) => {
    chatCtx.autoCompress = e.target.checked;
    saveChatCtx();
  });
  $('cs-compress-k').addEventListener('change', (e) => {
    chatCtx.compressK = clampInt(e.target.value, 8, 2000, 200);
    e.target.value = chatCtx.compressK;
    saveChatCtx();
  });

  $('btn-chat-settings').addEventListener('click', () => { $('chat-settings-modal').hidden = false; });
  $('btn-chat-settings-close').addEventListener('click', () => { $('chat-settings-modal').hidden = true; });
}
initChatSettings();

function updateChatInjectHint() {
  const el = $('chat-inject');
  if (!el) return;
  const names = [];
  if (state.videoId && chatCtx.videoInfo) names.push('视频信息');
  if (state.videoId && state.cues.length && chatCtx.summary) names.push('视频总结');
  if (state.videoId && state.cues.length && chatCtx.fullSubtitles) names.push('完整字幕');
  if (!names.length) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = `已注入${names.join('、')}`;
}

function llmMessages() {
  let start = 0;
  for (let i = 0; i < state.messages.length; i++) {
    if (state.messages[i].role === 'divider') start = i + 1;
  }
  const out = [];
  for (const m of state.messages.slice(start)) {
    if (m.role === 'compact') {
      out.push({ role: 'user', content: `【此前对话摘要】\n${m.content}` });
      out.push({ role: 'assistant', content: '已了解此前讨论，请继续。' });
    } else if (m.role === 'user' || m.role === 'assistant') {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function estimateChatTokens(extra = '') {
  let chars = (extra || '').length + 800;
  for (const m of llmMessages()) chars += String(m.content || '').length;
  if (chatCtx.fullSubtitles) {
    for (const c of state.cues) chars += (c.text || '').length + 20;
  }
  if (chatCtx.summary && state.summary) chars += state.summary.length;
  return Math.ceil(chars / 2);
}

function isOverflowText(s) {
  s = String(s || '').toLowerCase();
  return [
    'context_length', 'context length', 'context window', 'maximum context',
    'max context', 'too many tokens', 'prompt is too long', 'context overflow',
    'exceeds the context', 'exceed context', 'token limit',
    '上下文长度', '超出上下文', '最大上下文', '上下文窗口',
  ].some((m) => s.includes(m));
}

async function compressActiveHistory() {
  const toCompress = llmMessages();
  if (toCompress.length < 2) throw new Error('还没有足够的对话可以压缩');
  const data = await api('/api/chat/compress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: toCompress }),
  });
  state.messages.push({ role: 'divider', kind: 'compress' });
  state.messages.push({ role: 'compact', content: data.summary });
  persistChat();
}

async function insertNewChatSegment() {
  state.messages.push({ role: 'divider', kind: 'new' });
  persistChat();
}

function showOverflowActions(contentEl) {
  contentEl.classList.add('error');
  contentEl.textContent = '上下文已满，模型无法继续这一轮对话。';
  const box = document.createElement('div');
  box.className = 'overflow-actions';
  const hint = document.createElement('p');
  hint.className = 'overflow-hint';
  hint.textContent = '可以压缩此前问答，或开启新对话（旧消息仍留在上面）。若开着「完整字幕」，关掉也能腾出不少空间。';
  const bNew = document.createElement('button');
  bNew.type = 'button';
  bNew.className = 'btn small';
  bNew.textContent = '开启新对话';
  const bZip = document.createElement('button');
  bZip.type = 'button';
  bZip.className = 'btn small primary';
  bZip.textContent = '压缩上下文';
  const msgEl = contentEl.closest('.msg');
  bNew.addEventListener('click', () => handleOverflowChoice('new', msgEl));
  bZip.addEventListener('click', () => handleOverflowChoice('compress', msgEl));
  box.append(hint, bNew, bZip);
  contentEl.append(box);
}

async function handleOverflowChoice(kind, errMsgEl) {
  if (state.sending) return;
  const last = state.messages[state.messages.length - 1];
  const popped = last?.role === 'user' ? state.messages.pop() : null;
  const note = addMessage('system-note', kind === 'compress' ? '正在压缩上下文' : '正在开启新对话');
  note.classList.add('waiting');
  try {
    if (kind === 'compress') await compressActiveHistory();
    else insertNewChatSegment();
    if (popped) state.messages.push(popped);
    persistChat();
    errMsgEl?.remove();
    note.remove();
    renderChatFromState();
    await sendChat({ retry: true });
  } catch (err) {
    if (popped) state.messages.push(popped);
    persistChat();
    note.classList.remove('waiting');
    note.textContent = `${kind === 'compress' ? '压缩' : '新对话'}失败：${err.message}`;
  }
}

async function sendChat(opts = {}) {
  if (state.sending) return;  // 发送中（含 Enter 触发）不重复发送
  let image = null;
  const curTime = $('player').currentTime || 0;

  if (!opts.retry) {
    const text = $('chat-text').value.trim();
    if (!text) return;
    $('chat-text').value = '';

    if (state.videoId && !state.cues.length && !state.nosubNoted) {
      state.nosubNoted = true;
      addMessage('system-note', '当前视频没有字幕，这次提问不会带上视频内容。要结合讲解来问，请先转录或导入 SRT。');
    }

    if (chatCtx.autoCompress && estimateChatTokens(text) >= chatCtx.compressK * 1000
        && llmMessages().length >= 2) {
      const note = addMessage('system-note', '对话较长，正在自动压缩上下文');
      note.classList.add('waiting');
      try {
        await compressActiveHistory();
        note.remove();
        renderChatFromState();
      } catch (err) {
        note.classList.remove('waiting');
        note.textContent = `自动压缩失败：${err.message}，仍按原文发送`;
      }
    }

    const turn = collectTurnSubtitles(curTime);
    image = $('chk-frame').checked ? captureFrame() : null;
    const userContent = composeUserContent(text, turn);
    addUserMessage(text, {
      currentText: turn.current,
      windowText: turn.window,
      image,
    });
    state.messages.push({
      role: 'user',
      content: userContent,
      ui: { text, currentText: turn.current, windowText: turn.window },
    });
    persistChat();
  }

  const assistantDiv = addPendingAssistant();
  const contentEl = mdContainer(assistantDiv);
  const statusEl = assistantDiv.querySelector('.pending-status');
  let thinkEl = null;
  let thinkBody = null;
  let fullThink = '';
  let full = '';
  let revealed = false;
  let overflowed = false;
  const showAnswer = () => {
    if (revealed) return;
    revealAssistant(assistantDiv);
    revealed = true;
  };
  const showOverflow = (detail) => {
    overflowed = true;
    showAnswer();
    showOverflowActions(contentEl);
    if (detail) {
      const extra = document.createElement('div');
      extra.className = 'overflow-detail';
      extra.textContent = detail;
      contentEl.append(extra);
    }
  };
  state.sending = true;
  $('btn-send').disabled = true;
  try {
    const payload = {
      messages: llmMessages().map(({ role, content }) => ({ role, content })),
      video_id: state.videoId,
      include_subtitles: $('chk-subtitles').checked,
      current_time: curTime,
      image_b64: image,
      enable_thinking: $('chk-thinking').checked,
      include_summary: chatCtx.summary,
      include_video_info: chatCtx.videoInfo,
      include_full_subtitles: chatCtx.fullSubtitles,
      subtitle_before: chatCtx.before,
      subtitle_after: chatCtx.after,
    };
    window.lastChatPayload = payload;
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const detail = (await resp.json()).detail || '请求失败';
      if (isOverflowText(detail)) showOverflow(detail);
      else throw new Error(detail);
    } else {
      await consumeSSE(resp, (ev) => {
        if (ev.type === 'status') {
          if (statusEl) statusEl.textContent = ev.text;
        } else if (ev.type === 'messages') {
          window.lastLlmMessages = ev.messages;
        } else if (ev.type === 'summary') {
          state.summary = ev.text;
          updateNoSubHint();
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
        } else if (ev.type === 'overflow') {
          showOverflow(ev.text);
        } else if (ev.type === 'error') {
          if (isOverflowText(ev.text)) showOverflow(ev.text);
          else {
            showAnswer();
            contentEl.classList.add('error');
            contentEl.textContent = `错误：${ev.text}`;
          }
        }
      });
    }
    if (full) {
      state.messages.push({ role: 'assistant', content: full });
      persistChat();
    } else if (!revealed && !overflowed) showAnswer();
  } catch (err) {
    if (isOverflowText(err.message)) showOverflow(err.message);
    else {
      showAnswer();
      contentEl.classList.add('error');
      contentEl.textContent = `错误：${err.message}`;
    }
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
  persistChat();
  renderChatFromState();
});

$('btn-summary').addEventListener('click', async () => {
  if (!state.videoId) return;
  if (state.summary) {
    addMessage('assistant', `【视频总结】\n${state.summary}`);
    return;
  }
  $('btn-summary').disabled = true;
  const note = addMessage('system-note', '正在生成视频总结');
  note.classList.add('waiting');
  try {
    const data = await api('/api/chat/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: state.videoId }),
    });
    state.summary = data.summary;
    note.remove();
    addMessage('assistant', `【视频总结】\n${data.summary}`);
  } catch (err) {
    note.classList.remove('waiting');
    note.textContent = `总结生成失败：${err.message}`;
  } finally {
    $('btn-summary').disabled = false;
  }
});

