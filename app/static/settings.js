/* 设置面板、提供商 */
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
  const cookiesOn = !!c.bilibili.cookies_uploaded;
  $('btn-upload-cookies').textContent = cookiesOn ? '重新上传 cookie' : '上传 cookies.txt';
  $('cookies-status').textContent = cookiesOn ? '已上传' : '未上传（B站官方字幕不可用）';
  $('cfg-asr-model').value = c.asr.model;
  $('cfg-asr-device').value = c.asr.device;
  refreshAsrOptions(c.asr.whisper_model || 'small', c.asr.language || 'auto');
  const asrName = c.asr.model === 'faster-whisper'
    ? `faster-whisper ${c.asr.whisper_model || 'small'}`
    : 'SenseVoiceSmall';
  $('asr-availability').textContent = !c.asr_available
    ? 'ASR 依赖未安装，转录功能不可用（请重新执行 uv sync）'
    : c.asr_model_cached
      ? `ASR 已就绪（Silero VAD + ${asrName}）`
      : `ASR 已安装。首次转录需下载 ${asrName} 模型文件，可能需要几分钟`;
  // 提供商声明不支持图片 → 禁用「发送当前视频帧」，悬浮给出原因
  $('chk-frame').disabled = !c.llm.supports_image;
  if (!c.llm.supports_image) $('chk-frame').checked = false;
  $('chk-frame').parentElement.title = c.llm.supports_image
    ? ''
    : `当前提供商（${c.llm.provider}）的模型不支持图像识别，无法发送视频帧`;
  setTip('btn-summary', state.videoId ? '' : '请先打开视频');
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

let cookiesDirty = false;

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
    const shouldReload = cookiesDirty && state.video?.source === 'bilibili' && state.videoId;
    cookiesDirty = false;
    if (shouldReload) {
      const ok = confirm(
        '检测到新的 B站 cookies。是否重新加载当前视频？登录后可获取更高清晰度，并尝试拉取官方字幕。'
      );
      if (ok) await reloadCurrentBiliVideo();
    }
  } catch (err) {
    setHint('settings-status', `保存失败：${err.message}`, true);
  } finally {
    $('btn-save-settings').disabled = false;
  }
});

$('btn-upload-cookies').addEventListener('click', () => $('cfg-cookies').click());

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
    cookiesDirty = true;
    applyConfig();
  } catch (err) {
    setHint('cookies-status', `cookies 上传失败：${err.message}`, true);
  }
  e.target.value = '';
});

