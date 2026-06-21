const defaults = {
  apiBaseKey: 'substore.gateway.apiBase.v1',
  flowUserAgentKey: 'substore.gateway.flowUserAgent.v1',
  gatewayName: 'dynamic-gateway-v1',
  flowUserAgent: 'clash.meta/v1.19.23',
  storageKey: 'substore.dynamicGatewayName.v1',
  patches: [
    { key: 'adblock', label: '广告拦截', file: 'dg-v1-patch-adblock', note: '按旧完整模板顺序插入广告 rule-providers 和规则。' },
    { key: 'audit', label: 'Anti/CN 审计', file: 'dg-v1-patch-audit', note: '按旧 all-rule 顺序插入 Anti-Audit / Anti-Audit-CN，CN 审计默认直连。' },
    { key: 'landing', label: '落地链路', file: 'dg-v1-patch-landing', note: '给单独选择的落地节点源增加 dialer-proxy。' }
  ]
};

const state = {
  apiBase: localStorage.getItem(defaults.apiBaseKey) || '',
  gatewayName: localStorage.getItem(defaults.storageKey) || defaults.gatewayName,
  subs: [],
  collections: [],
  files: [],
  gateway: null,
  manifest: null,
  currentLink: null,
  selectedSources: [],
  selectedLandingSources: [],
  selectedFlowSub: '',
  flowUserAgent: localStorage.getItem(defaults.flowUserAgentKey) || defaults.flowUserAgent,
  activeStep: 1,
  maxUnlockedStep: 1,
  busy: false
};

// localStorage.removeItem('shouhou.apiBase');
// localStorage.removeItem('substore.apiBase');
// localStorage.removeItem('substore.dynamicApiBase');

const $ = (id) => document.getElementById(id);
const logEl = $('log');

$('apiBase').value = state.apiBase;
$('gatewayName').value = state.gatewayName;
$('flowUserAgent').value = state.flowUserAgent;
$('installBtn').disabled = true;
$('deleteBtn').disabled = true;
$('toStep2Btn').disabled = true;

function log(message, type = 'info') {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  logEl.textContent += `[${time}] ${type.toUpperCase()} ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(message, kind = '') {
  const box = $('statusBox');
  box.className = `status ${kind}`.trim();
  box.textContent = message;
}

function api(path, options = {}) {
  const base = requireApiBase();
  return fetch(base + path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  }).then(async (res) => {
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch {}
    if (!res.ok || (body && body.status === 'failed')) {
      const reason = (body && (body.message || body.error || (body.data && body.data.message))) || text || res.statusText;
      throw new Error(reason);
    }
    return body;
  });
}

function requireApiBase() {
  const value = $('apiBase').value.trim().replace(/\/+$/, '');
  if (!value) {
    throw new Error('请先填写 Sub-Store API 地址');
  }
  return value;
}

function assetUrl(filePath) {
  const relative = filePath ? '/' + String(filePath).replace(/^\/+/, '') : '';
  return './substore-gateway-v1' + relative + '?v=' + Date.now();
}

async function fetchTextAsset(filePath) {
  const res = await fetch(assetUrl(filePath), { cache: 'no-store' });
  if (!res.ok) throw new Error('读取源文件失败：' + filePath + ' (' + res.status + ')');
  return res.text();
}

async function loadManifest() {
  if (state.manifest) return state.manifest;
  const res = await fetch(assetUrl('manifest.json'), { cache: 'no-store' });
  if (!res.ok) throw new Error('读取 manifest.json 失败：' + res.status);
  state.manifest = await res.json();
  return state.manifest;
}

async function sourceFilePayloads(manifest) {
  const payloads = [];
  for (const item of manifest.files || []) {
    const content = await fetchTextAsset(item.path);
    payloads.push(baseFilePayload(item.name, item.displayName || item.name, content, item.remark || ''));
  }
  return payloads;
}

async function gatewayFilePayload(manifest) {
  const gateway = manifest.gateway || {};
  const content = await fetchTextAsset(gateway.script || 'dynamic-gateway-v1.js');
  const subInfoUrl = selectedFlowSubInfoUrl();
  const subInfoUserAgent = $('flowUserAgent').value.trim() || defaults.flowUserAgent;
  state.flowUserAgent = subInfoUserAgent;
  localStorage.setItem(defaults.flowUserAgentKey, subInfoUserAgent);
  return {
    name: state.gatewayName,
    displayName: gateway.displayName || 'Dynamic Gateway v1',
    type: 'file',
    source: 'local',
    content: '# dynamic-gateway-v1: base rule + switch builder\nproxies: []\n',
    download: false,
    subInfoUrl,
    subInfoUserAgent,
    process: [{
      type: 'Script Operator',
      args: {
        mode: 'script',
        content,
        arguments: {}
      },
      disabled: false
    }]
  };
}

function baseFilePayload(name, displayName, content, remark = '') {
  return {
    name,
    displayName,
    remark,
    icon: '',
    source: 'local',
    process: [],
    content,
    'display-name': displayName,
    mergeSources: '',
    download: false,
    sourceType: 'local',
    type: 'file',
    ignoreFailedRemoteFile: false,
    isIconColor: true,
    tag: [],
    subInfoUrl: ''
  };
}

function activeManagedFileNames() {
  const manifest = state.manifest;
  const names = [state.gatewayName || defaults.gatewayName];
  if (manifest && Array.isArray(manifest.files)) {
    manifest.files.forEach((item) => { if (item.name) names.push(item.name); });
  } else {
    names.push('dg-v1-profile-lite', 'dg-v1-patch-adblock', 'dg-v1-patch-audit', 'dg-v1-patch-landing');
  }
  return names;
}

function obsoleteManagedFileNames() {
  const manifest = state.manifest;
  if (manifest && Array.isArray(manifest.obsoleteFiles)) return manifest.obsoleteFiles;
  return ['dg-v1-profile-rule', 'dg-v1-profile-landing', 'dg-v1-profile-ali', 'dg-v1-patch-ali', 'dg-v1-patch-warp'];
}

function managedFileNames() {
  return activeManagedFileNames().concat(obsoleteManagedFileNames());
}

async function upsertFilePayload(payload) {
  const exists = state.files.some((file) => file.name === payload.name);
  const path = exists ? `/api/file/${encodeURIComponent(payload.name)}` : '/api/files';
  const method = exists ? 'PATCH' : 'POST';
  const res = await api(path, { method, body: JSON.stringify(payload) });
  const next = res.data || payload;
  const index = state.files.findIndex((file) => file.name === payload.name);
  if (index >= 0) state.files[index] = next;
  else state.files.push(next);
  return next;
}

async function deleteFileByName(name) {
  await api(`/api/file/${encodeURIComponent(name)}`, { method: 'DELETE' });
  state.files = state.files.filter((file) => file.name !== name);
  if (state.gateway && state.gateway.name === name) state.gateway = null;
}

function sourceOptionValue(type, name) {
  return `${type}:${name}`;
}

function sourceOptionName(value) {
  const text = String(value || '');
  const index = text.indexOf(':');
  return index > 0 ? text.slice(index + 1) : text;
}

function sourceOptionType(value) {
  const text = String(value || '');
  const index = text.indexOf(':');
  return index > 0 ? text.slice(0, index) : 'sub';
}

function sourceOptionLabel(type, name) {
  return `(${type === 'collection' ? 'collection' : 'sub'}) ${name}`;
}

function hasSourceValue(values, value) {
  const type = sourceOptionType(value);
  const name = sourceOptionName(value);
  return values.some((item) => sourceOptionType(item) === type && sourceOptionName(item) === name);
}

function pushSourceValue(values, value) {
  if (!hasSourceValue(values, value)) values.push(value);
}

function subscriptionLabel(sub) {
  return sub.displayName || sub['display-name'] || sub.name;
}

function findSubscription(name) {
  return state.subs.find((sub) => sub.name === name);
}

function selectedFlowSubscription() {
  const select = $('flowSubSelect');
  const name = select ? select.value : state.selectedFlowSub;
  return name ? findSubscription(name) : null;
}

function selectedFlowSubInfoUrl() {
  const sub = selectedFlowSubscription();
  return sub && sub.url ? sub.url : '';
}

function buildSourceOptions() {
  const seen = new Set();
  const options = [];
  const add = (type, name) => {
    if (!name) return;
    const value = sourceOptionValue(type, name);
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ type, name, value, label: sourceOptionLabel(type, name) });
  };
  state.subs.map((sub) => sub.name).sort().forEach((name) => add('sub', name));
  state.collections.map((collection) => collection.name).sort().forEach((name) => add('collection', name));
  return options;
}

function renderFlowSubscriptions() {
  const select = $('flowSubSelect');
  if (!select) return;
  const previous = state.selectedFlowSub || select.value || '';
  select.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '不转发流量信息';
  select.appendChild(empty);

  state.subs
    .slice()
    .sort((a, b) => subscriptionLabel(a).localeCompare(subscriptionLabel(b)))
    .forEach((sub) => {
      const option = document.createElement('option');
      option.value = sub.name;
      option.textContent = subscriptionLabel(sub);
      if (sub.url) option.title = sub.url;
      select.appendChild(option);
    });

  const fromGateway = state.gateway && state.gateway.subInfoUrl
    ? state.subs.find((sub) => sub.url && sub.url === state.gateway.subInfoUrl)
    : null;
  const next = previous && findSubscription(previous) ? previous : (fromGateway ? fromGateway.name : '');
  select.value = next;
  state.selectedFlowSub = next;
  if (state.gateway && state.gateway.subInfoUserAgent) {
    $('flowUserAgent').value = state.gateway.subInfoUserAgent;
    state.flowUserAgent = state.gateway.subInfoUserAgent;
  }
}

function selectedStateKey(id) {
  return id === 'sourceSelect' ? 'selectedSources' : 'selectedLandingSources';
}

function syncSelectedState(id) {
  state[selectedStateKey(id)] = [...$(id).selectedOptions].map((option) => option.value);
}

function updateStep2Summary() {
  const sources = state.selectedSources.length;
  const landingSources = state.selectedLandingSources.length;
  $('step2Summary').textContent = sources ? `${sources}常规 / ${landingSources}落地` : '未选择';
  renderSelectedNames();
}

function selectedDisplayName(value) {
  const type = sourceOptionType(value);
  return sourceOptionLabel(type, sourceOptionName(value));
}

function renderSelectedNameList(id, values) {
  const box = $(id);
  if (!box) return;
  box.innerHTML = '';
  if (!values.length) {
    const empty = document.createElement('span');
    empty.className = 'selected-empty';
    empty.textContent = '未选择';
    box.appendChild(empty);
    return;
  }
  values.forEach((value) => {
    const item = document.createElement('span');
    item.className = 'selected-name';
    item.title = selectedDisplayName(value);
    item.textContent = selectedDisplayName(value);
    box.appendChild(item);
  });
}

function renderSelectedNames() {
  renderSelectedNameList('selectedSourceNames', state.selectedSources);
  renderSelectedNameList('selectedLandingSourceNames', state.selectedLandingSources);
}

function fillSourceSelect(id, selectedNames) {
  const select = $(id);
  const stateKey = selectedStateKey(id);
  const selectedValues = Array.isArray(selectedNames) ? selectedNames : state[stateKey];
  select.innerHTML = '';
  const listContainer = $(id === 'sourceSelect' ? 'sourceCheckboxList' : 'landingSourceCheckboxList');
  if (listContainer) listContainer.innerHTML = '';

  const selected = new Set(selectedValues);
  const available = new Set();
  buildSourceOptions().forEach((item) => {
    available.add(item.value);
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    opt.selected = selected.has(item.value);
    select.appendChild(opt);

    if (listContainer) {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'checkbox-item' + (opt.selected ? ' active' : '');
      
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = opt.selected;
      checkbox.id = `chk-${id}-${item.value}`;
      
      const label = document.createElement('label');
      label.htmlFor = checkbox.id;
      label.textContent = item.label;
      
      const syncSelect = () => {
        opt.selected = checkbox.checked;
        syncSelectedState(id);
        updateStep2Summary();
        if (checkbox.checked) {
          itemDiv.classList.add('active');
        } else {
          itemDiv.classList.remove('active');
        }
        select.dispatchEvent(new Event('change'));
      };

      checkbox.addEventListener('change', syncSelect);
      itemDiv.addEventListener('click', (e) => {
        if (e.target !== checkbox && e.target !== label) {
          checkbox.checked = !checkbox.checked;
          syncSelect();
        }
      });

      itemDiv.appendChild(checkbox);
      itemDiv.appendChild(label);
      listContainer.appendChild(itemDiv);
    }
  });

  state[stateKey] = state[stateKey].filter((value) => available.has(value));
  updateStep2Summary();
}

function validateInputs() {
  const auditMode = $('auditMode').value === 'yes';
  const landingSelect = $('landingSourceSelect');
  const landingContainer = $('landingSourceCheckboxList');
  if (landingContainer) {
    if (auditMode && landingSelect.options.length > 0 && landingSelect.selectedOptions.length === 0) {
      landingContainer.style.borderColor = 'var(--danger)';
      landingContainer.style.background = 'rgba(239, 68, 68, 0.03)';
    } else {
      landingContainer.style.borderColor = '';
      landingContainer.style.background = '';
    }
  }
}

function renderSources() {
  fillSourceSelect('sourceSelect');
  fillSourceSelect('landingSourceSelect');
  validateInputs();
}

function renderGatewayState() {
  $('gatewayState').textContent = state.gateway ? '已安装' : (hasBackendData() ? '已连接' : '未连接');
  const connected = hasBackendData();
  $('installBtn').disabled = state.busy || !connected;
  $('deleteBtn').disabled = state.busy || !connected;
  $('toStep2Btn').disabled = state.busy || !state.gateway;
}

function renderCurrentLink() {
  const box = $('linkList');
  $('step4Summary').textContent = state.currentLink ? '已生成' : '未生成';
  if (!state.currentLink) {
    box.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '点击上方“生成订阅链接”进行输出。';
    box.appendChild(empty);
    return;
  }
  const item = state.currentLink;
  box.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'link-item';

  const title = document.createElement('div');
  title.className = 'link-title';

  const name = document.createElement('strong');
  name.textContent = item.name;
  title.appendChild(name);

  const summary = document.createElement('span');
  summary.className = 'pill';
  summary.textContent = item.summary;
  title.appendChild(summary);

  const url = document.createElement('div');
  url.className = 'link-url';
  url.textContent = item.url;

  const actions = document.createElement('div');
  actions.className = 'row tight';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.dataset.copy = '';
  copyBtn.textContent = '复制';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.dataset.open = '';
  openBtn.textContent = '打开';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.dataset.clear = '';
  clearBtn.className = 'danger';
  clearBtn.textContent = '清除';

  actions.appendChild(copyBtn);
  actions.appendChild(openBtn);
  actions.appendChild(clearBtn);
  el.appendChild(title);
  el.appendChild(url);
  el.appendChild(actions);
  box.appendChild(el);
  box.querySelector('[data-copy]').addEventListener('click', (e) => {
    copyText(item.url);
    const btn = e.target;
    const oldText = btn.textContent;
    btn.textContent = '已复制 ✓';
    btn.style.borderColor = 'var(--ok)';
    btn.style.color = 'var(--ok)';
    setTimeout(() => {
      btn.textContent = oldText;
      btn.style.borderColor = '';
      btn.style.color = '';
    }, 2000);
  });
  box.querySelector('[data-open]').addEventListener('click', () => window.open(item.url, '_blank'));
  box.querySelector('[data-clear]').addEventListener('click', () => {
    state.currentLink = null;
    renderCurrentLink();
  });
}

function clearCurrentLink() {
  if (!state.currentLink) return;
  state.currentLink = null;
  renderCurrentLink();
}

function selectedValues(id) {
  syncSelectedState(id);
  return state[selectedStateKey(id)].slice();
}

function hasBackendData() {
  return Boolean(state.subs.length || state.collections.length || state.files.length);
}

function selectedRuleOptions() {
  const patches = [];
  if ($('adblockMode').value === 'yes') patches.push('adblock');
  if ($('auditMode').value === 'yes') patches.push('audit');
  return { patches };
}

function currentLink() {
  const params = new URLSearchParams();
  const sources = selectedValues('sourceSelect');
  const landingSources = selectedValues('landingSourceSelect');
  const ruleOptions = selectedRuleOptions();
  const patches = ruleOptions.patches;
  if (!sources.length) throw new Error('至少选择一个常规节点源');
  const overlap = landingSources.filter((value) => hasSourceValue(sources, value));
  if (overlap.length) throw new Error('落地节点源不要和普通节点源重复：' + overlap.map(sourceOptionName).join(', '));
  if (patches.includes('audit') && !landingSources.length) throw new Error('Anti/CN 审计需要先选择落地节点源，例如 sub:warp 或其他落地源');
  if (landingSources.length && !patches.includes('landing')) patches.push('landing');
  params.set('sources', sources.join(','));
  if (landingSources.length) params.set('landingSources', landingSources.join(','));
  if (patches.length) params.set('patches', patches.join(','));
  const flowSubInfoUrl = selectedFlowSubInfoUrl();
  if (flowSubInfoUrl) {
    params.set('subInfoUrl', flowSubInfoUrl);
    params.set('subInfoUserAgent', $('flowUserAgent').value.trim() || defaults.flowUserAgent);
  }
  const base = requireApiBase();
  const url = `${base}/api/file/${encodeURIComponent(state.gatewayName)}?${params.toString()}`;
  const labels = patches.map((key) => (defaults.patches.find((item) => item.key === key) || { label: key }).label);
  const modeName = labels.join('+') || '基础';
  const name = [
    $('namePrefix').value.trim() || 'mihomo',
    modeName,
    sources.length + (landingSources.length ? '+' + landingSources.length + 'landing' : 'src')
  ].join('-');
  const landingText = landingSources.length ? ` / ${landingSources.length}落地` : '';
  const flowText = flowSubInfoUrl ? ' / 流量透传' : '';
  return { url, name, summary: `${modeName} / ${sources.length}源${landingText}${flowText}` };
}

async function connect() {
  state.apiBase = $('apiBase').value.trim().replace(/\/+$/, '');
  if (!state.apiBase) {
    setStatus('请先填写 Sub-Store API 地址。', 'warn');
    throw new Error('请先填写 Sub-Store API 地址');
  }
  state.gatewayName = $('gatewayName').value.trim() || defaults.gatewayName;
  localStorage.setItem(defaults.storageKey, state.gatewayName);
  localStorage.setItem(defaults.apiBaseKey, state.apiBase);
  setStatus('正在读取 Sub-Store 后端...', 'warn');
  log('连接 ' + state.apiBase);

  const [subsRes, collectionsRes, filesRes] = await Promise.all([
    api('/api/subs'),
    api('/api/collections'),
    api('/api/files')
  ]);
  state.subs = subsRes.data || [];
  state.collections = collectionsRes.data || [];
  state.files = filesRes.data || [];
  state.gateway = state.files.find((file) => file.name === state.gatewayName) || null;

  renderSources();
  renderFlowSubscriptions();
  renderGatewayState();
  setStatus(state.gateway ? '已连接，网关脚本已安装。可以继续选择节点。' : '已连接，但未检测到当前网关脚本。请先部署网关脚本。', state.gateway ? 'ok' : 'warn');
  log(`读取完成：subs=${state.subs.length}, collections=${state.collections.length}, files=${state.files.length}, gateway=${state.gateway ? 'yes' : 'no'}`);
  
  // 更新向导状态
  let urlHostname = state.apiBase;
  try {
    urlHostname = new URL(state.apiBase).hostname;
  } catch {}
  $('step1Summary').textContent = `已连接 (${urlHostname})`;
  if (state.gateway) unlockStep(2, state.busy ? { stay: true } : undefined);
}

async function installGateway() {
  if (!hasBackendData()) await connect();
  const manifest = await loadManifest();
  const payloads = [...await sourceFilePayloads(manifest), await gatewayFilePayload(manifest)];
  log('准备从本地源文件安装 v1 文件：' + payloads.length + ' 个');
  for (const payload of payloads) {
    log((state.files.some((file) => file.name === payload.name) ? '更新' : '创建') + ' file: ' + payload.name);
    const saved = await upsertFilePayload(payload);
    if (payload.name === state.gatewayName) state.gateway = saved;
  }
  renderGatewayState();
  setStatus('v1 文件已安装。规则源文件来自当前网站目录。', 'ok');
  log('v1 文件安装完成');
  unlockStep(2, state.busy ? { stay: true } : undefined);
}

async function deleteManagedFiles() {
  if (!hasBackendData()) await connect();
  await loadManifest();
  const names = managedFileNames();
  const existing = names.filter((name) => state.files.some((file) => file.name === name));
  if (!existing.length) {
    setStatus('没有找到可删除的 v1 文件。', 'warn');
    log('没有找到可删除的 v1 文件', 'warn');
    return;
  }
  const ok = window.confirm('将删除这些 v1 文件：\n\n' + existing.join('\n'));
  if (!ok) return;
  log('准备删除 v1 文件：' + existing.length + ' 个');
  for (const name of existing) {
    log('删除 file: ' + name);
    await deleteFileByName(name);
  }
  renderGatewayState();
  renderSources();
  setStatus('v1 文件已删除。旧 shouhou 文件和其他订阅未改动。', 'ok');
  log('v1 文件删除完成');
}

function generateCurrentLink() {
  try {
    state.currentLink = currentLink();
    renderCurrentLink();
    log('生成订阅链接：' + state.currentLink.summary);
  } catch (err) {
    setStatus(err.message, 'warn');
    log(err.message, 'warn');
  }
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      log('已复制到剪贴板');
      return;
    } catch (err) {
      // Fallback if clipboard API fails
    }
  }
  
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    const successful = document.execCommand('copy');
    if (successful) {
      log('已复制到剪贴板 (兼容模式)');
    } else {
      throw new Error('复制失败');
    }
  } catch (err) {
    log('复制失败，请手动选择复制：' + err.message, 'error');
  } finally {
    document.body.removeChild(textarea);
  }
}

async function withLoading(btnId, loadingText, fn) {
  const btn = $(btnId);
  const originalText = btn.textContent;
  const actionButtons = ['connectBtn', 'installBtn', 'deleteBtn', 'toStep2Btn', 'generateLinkBtn', 'toStep3Btn', 'toStep4Btn', 'selectAllBtn', 'clearAllBtn'];
  
  const previousStates = actionButtons.map(id => {
    const el = $(id);
    return el ? { el, disabled: el.disabled } : null;
  });
  
  try {
    state.busy = true;
    document.body.classList.add('is-busy');
    actionButtons.forEach(id => {
      const el = $(id);
      if (el) el.disabled = true;
    });
    btn.textContent = loadingText;
    await fn();
  } finally {
    previousStates.forEach(state => {
      if (state && state.el) state.el.disabled = state.disabled;
    });
    document.body.classList.remove('is-busy');
    state.busy = false;
    btn.textContent = originalText;
    renderGatewayState();
  }
}

function selectAllSources(selected) {
  [...$('sourceSelect').options].forEach((option) => { option.selected = selected; });
  syncSelectedState('sourceSelect');
  const checkboxes = $('sourceCheckboxList').querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach(chk => {
    chk.checked = selected;
    const itemDiv = chk.closest('.checkbox-item');
    if (itemDiv) {
      if (selected) itemDiv.classList.add('active');
      else itemDiv.classList.remove('active');
    }
  });
  updateStep2Summary();
  clearCurrentLink();
}

function clearAllSelections() {
  ['sourceSelect', 'landingSourceSelect'].forEach((id) => {
    [...$(id).options].forEach((option) => { option.selected = false; });
    syncSelectedState(id);
    const listId = id === 'sourceSelect' ? 'sourceCheckboxList' : 'landingSourceCheckboxList';
    $(listId).querySelectorAll('input[type="checkbox"]').forEach((checkbox) => { checkbox.checked = false; });
    $(listId).querySelectorAll('.checkbox-item').forEach((item) => item.classList.remove('active'));
  });
  updateStep2Summary();
  validateInputs();
  clearCurrentLink();
}

function resetBackendData() {
  state.subs = [];
  state.collections = [];
  state.files = [];
  state.gateway = null;
  state.selectedSources = [];
  state.selectedLandingSources = [];
  state.selectedFlowSub = '';
  state.currentLink = null;
  renderSources();
  renderFlowSubscriptions();
  renderCurrentLink();
  renderGatewayState();
  setStatus('配置已更改，请重新连接后端。', 'warn');
  
  // 锁定后续步骤
  state.maxUnlockedStep = 1;
  $('step1Summary').textContent = '未连接';
  $('step2Summary').textContent = '未选择';
  $('step3Summary').textContent = '默认';
  $('step4Summary').textContent = '未生成';
  setStep(1);
}

// 纵向向导逻辑
function setStep(index) {
  if (state.busy) return;
  if (index > state.maxUnlockedStep) return;
  state.activeStep = index;
  for (let i = 1; i <= 4; i++) {
    const card = $(`step${i}Card`);
    if (i === index) {
      card.classList.add('active');
    } else {
      card.classList.remove('active');
    }

    if (i <= state.maxUnlockedStep) {
      card.classList.remove('disabled');
      card.classList.add('completed');
    } else {
      card.classList.add('disabled');
      card.classList.remove('completed');
    }
  }
  // 当前激活的步骤不显示 completed 颜色标志，保留为激活状态
  $(`step${index}Card`).classList.remove('completed');
}

function unlockStep(index, options) {
  if (index > state.maxUnlockedStep) {
    state.maxUnlockedStep = index;
  }
  if (options && options.stay) return;
  setStep(index);
}

// 绑定步骤头部的点击切换事件
for (let i = 1; i <= 4; i++) {
  $(`step${i}Header`).addEventListener('click', () => {
    if (!state.busy && i <= state.maxUnlockedStep) {
      setStep(i);
    }
  });
}

$('connectBtn').addEventListener('click', () => {
  withLoading('connectBtn', '连接中...', connect).catch((err) => {
    let errMsg = err.message;
    if (errMsg.includes('Failed to fetch') || errMsg.includes('fetch')) {
      errMsg = '连接失败！请检查 Sub-Store API 地址是否正确，且后端已启动。如果依然失败，这通常是由于跨域访问限制 (CORS) 导致的。请确保开启了 Sub-Store 的允许跨域选项。';
    }
    setStatus(errMsg, 'error');
    log(errMsg, 'error');
  });
});

$('toStep2Btn').addEventListener('click', () => {
  if (state.busy || !state.gateway) return;
  setStep(2);
});

$('toStep3Btn').addEventListener('click', () => {
  if (state.busy) return;
  const sources = selectedValues('sourceSelect');
  if (!sources.length) {
    setStatus('请至少选择一个常规节点源', 'warn');
    log('请至少选择一个常规节点源', 'warn');
    return;
  }
  const landingSources = selectedValues('landingSourceSelect');
  $('step2Summary').textContent = `${sources.length}常规 / ${landingSources.length}落地`;
  unlockStep(3);
});

$('toStep4Btn').addEventListener('click', () => {
  if (state.busy) return;
  const adblock = $('adblockMode').value === 'yes' ? '广告' : '';
  const audit = $('auditMode').value === 'yes' ? '审计' : '';
  const prefix = $('namePrefix').value.trim();
  const parts = [adblock, audit, prefix].filter(Boolean);
  $('step3Summary').textContent = parts.join(' | ') || '默认';
  unlockStep(4);
});

$('installBtn').addEventListener('click', () => {
  withLoading('installBtn', '安装中...', installGateway).catch((err) => {
    setStatus(err.message, 'error');
    log(err.message, 'error');
  });
});

$('deleteBtn').addEventListener('click', () => {
  withLoading('deleteBtn', '删除中...', deleteManagedFiles).catch((err) => {
    setStatus(err.message, 'error');
    log(err.message, 'error');
  });
});

$('generateLinkBtn').addEventListener('click', generateCurrentLink);
$('selectAllBtn').addEventListener('click', () => { selectAllSources(true); });
$('clearAllBtn').addEventListener('click', clearAllSelections);
$('clearLogBtn').addEventListener('click', () => { logEl.textContent = ''; });

$('apiBase').addEventListener('change', () => {
  state.apiBase = $('apiBase').value.trim();
  resetBackendData();
});
$('gatewayName').addEventListener('change', () => {
  state.gatewayName = $('gatewayName').value.trim() || defaults.gatewayName;
  resetBackendData();
});

$('auditMode').addEventListener('change', validateInputs);
$('adblockMode').addEventListener('change', clearCurrentLink);
$('auditMode').addEventListener('change', clearCurrentLink);
$('namePrefix').addEventListener('input', clearCurrentLink);
$('flowSubSelect').addEventListener('change', () => {
  state.selectedFlowSub = $('flowSubSelect').value;
  const subInfoUrl = selectedFlowSubInfoUrl();
  if (subInfoUrl) log('查询流量信息订阅链接已选择：' + $('flowSubSelect').value);
});
$('flowUserAgent').addEventListener('change', () => {
  state.flowUserAgent = $('flowUserAgent').value.trim() || defaults.flowUserAgent;
  $('flowUserAgent').value = state.flowUserAgent;
  localStorage.setItem(defaults.flowUserAgentKey, state.flowUserAgent);
});
$('landingSourceSelect').addEventListener('change', validateInputs);
$('sourceSelect').addEventListener('change', () => {
  syncSelectedState('sourceSelect');
  updateStep2Summary();
  clearCurrentLink();
});
$('landingSourceSelect').addEventListener('change', () => {
  syncSelectedState('landingSourceSelect');
  updateStep2Summary();
  clearCurrentLink();
});

function setupFilter(inputId, listId) {
  const input = $(inputId);
  if (!input) return;
  input.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const items = $(listId).querySelectorAll('.checkbox-item');
    items.forEach(item => {
      const labelText = item.querySelector('label').textContent.toLowerCase();
      if (labelText.includes(query)) {
        item.style.display = 'flex';
      } else {
        item.style.display = 'none';
      }
    });
  });
}

// 页面初始化
renderSources();
renderFlowSubscriptions();
setupFilter('sourceSearch', 'sourceCheckboxList');
setupFilter('landingSourceSearch', 'landingSourceCheckboxList');
renderCurrentLink();
renderGatewayState();
setStep(1);
log('页面已就绪');
