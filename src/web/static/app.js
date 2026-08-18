'use strict';

/* aimemory 管理平台前端逻辑（原生 JS，无构建） */

const $ = (sel) => document.querySelector(sel);

let currentUser = null;   // { userId, via }
let selectedKey = null;   // 当前 MCP JSON 里使用的密钥（默认第一个）
let keyToken = null;      // 新生成密钥的明文（仅存前端内存，刷新即失）
let page = 1;
const PAGE_SIZE = 10;
let searchQuery = '';

// ===== 工具 =====

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

// ===== 登录状态 =====

async function init() {
  // 单点登录（SSO）：始终先经 Keycloak 校验——同浏览器已在其他应用（如 BR-Agent 9005）登录 → 免密回跳；
  // 未登录 → 显示 Keycloak 登录页。这保证 aim_session 与当前 Keycloak SSO 用户一致，
  // 单点登出（SLO：在任意应用登出 → 本应用也退出）才能双向生效。
  const q = new URLSearchParams(window.location.search);
  if (q.get('logged') !== '1') {
    window.location.replace('/auth/login'); // 走 Keycloak；回调会带 /?logged=1 回来
    return;
  }
  // 刚从 Keycloak 回跳：清掉标记，避免刷新后又跳登录
  history.replaceState({}, '', '/');
  try {
    currentUser = await api('/api/me');
    if (currentUser.userId) showApp();
    else showLogin();
  } catch { showLogin(); }
}

function showLogin() {
  // 单点登录：与 BR-Agent 等应用共用 Keycloak SSO 会话，直接跳登录即可免密直达。
  // 若浏览器未登录过 Keycloak，会进入 Keycloak 登录页；已登录则自动回跳（SSO）。
  window.location.href = '/auth/login';
}

function showApp() {
  $('#view-login').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  // 优先显示 Keycloak 用户名（br0004 等）；老会话无 username 时回退到 UUID 前 8 位
  const who = currentUser.username || currentUser.userId.slice(0, 8);
  $('#user-name').textContent = who;
  loadKeys().then(() => loadMemories());
}

// ===== 视图切换（侧边栏导航）=====

const VIEW_META = {
  memories: { title: '我的记忆', sub: '管理 agent 为你沉淀的记忆，跨会话复用' },
  keys: { title: '接入密钥', sub: '生成密钥，把 aimemory 接进你的 agent' },
  guide: { title: '接入指南', sub: 'ZCode 插件安装与 MCP 工具说明' },
};

function switchView(name) {
  if (!VIEW_META[name]) return;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('view-active'));
  document.getElementById(`view-${name}`).classList.add('view-active');
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === name)
  );
  $('#view-title').textContent = VIEW_META[name].title;
  $('#view-sub').textContent = VIEW_META[name].sub;
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ===== 主题（暗/亮）=====

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('aimemory-theme', t); } catch (e) {}
}

function initThemeToggle() {
  const btn = $('#theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    applyTheme(cur === 'light' ? 'dark' : 'light');
  });
}

// ===== 记忆 =====

async function loadMemories() {
  const list = $('#memory-list');
  list.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const qs = new URLSearchParams({ page, page_size: PAGE_SIZE });
    if (searchQuery) qs.set('q', searchQuery);
    const data = await api(`/api/memories?${qs}`);
    renderMemories(data.results, data.total);
  } catch (e) { list.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

function renderMemories(items, total) {
  const list = $('#memory-list');
  if (!items.length) {
    list.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M6 3h9l4 4v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V4.5A1.5 1.5 0 0 1 6.5 3z" stroke-linejoin="round"/>
          <path d="M14 3v5h5M8.5 12h7M8.5 15.5h7M8.5 19h4" stroke-linecap="round"/>
        </svg>
        <p class="empty-title">还没有记忆</p>
        <p class="empty-hint">在上面添加一条，或让 agent 通过 MCP 写入</p>
      </div>`;
  } else {
    list.innerHTML = items.map((m) => `
      <div class="memory-item" data-id="${esc(m.id)}">
        <div class="memory-text">${esc(m.text)}</div>
        <div class="memory-meta">
          <span class="stamp">${esc(new Date(m.updated_at).toLocaleString())}</span>
          ${Object.keys(m.metadata || {}).length ? `<span class="meta-json">${esc(JSON.stringify(m.metadata))}</span>` : ''}
        </div>
        <div class="memory-actions">
          <button class="btn btn-ghost" data-act="edit">编辑</button>
          <button class="btn btn-ghost danger" data-act="del">删除</button>
        </div>
      </div>`).join('');
  }
  // 分页
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  $('#pagination').innerHTML =
    `<button class="btn btn-ghost" id="pg-prev" ${page <= 1 ? 'disabled' : ''}>‹ 上一页</button>` +
    `<span class="pg-info">第 ${page} / ${totalPages} 页 · 共 ${total} 条</span>` +
    `<button class="btn btn-ghost" id="pg-next" ${page >= totalPages ? 'disabled' : ''}>下一页 ›</button>`;
  $('#pg-prev').onclick = () => { if (page > 1) { page--; loadMemories(); } };
  $('#pg-next').onclick = () => { if (page < totalPages) { page++; loadMemories(); } };
}

// ===== 事件绑定 =====

// 明文 / 元数据 切换（一次只显示一个输入框）
function setAddMode(mode) {
  document.querySelectorAll('.seg-btn').forEach((b) => {
    const active = b.dataset.seg === mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $('#add-text').classList.toggle('hidden', mode !== 'text');
  $('#add-metadata').classList.toggle('hidden', mode !== 'metadata');
}
document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => setAddMode(btn.dataset.seg));
});

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#add-text').value.trim();
  if (!text) return toast('内容不能为空');
  let metadata = {};
  const metaStr = $('#add-metadata').value.trim();
  if (metaStr) {
    try { metadata = JSON.parse(metaStr); }
    catch { return toast('元数据不是合法 JSON'); }
  }
  try {
    await api('/api/memories', { method: 'POST', body: JSON.stringify({ text, metadata }) });
    $('#add-text').value = '';
    $('#add-metadata').value = '';
    setAddMode('text'); // 重置回明文模式
    toast('已添加');
    loadMemories();
  } catch (e2) { toast(e2.message); }
});

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  searchQuery = $('#search-input').value.trim();
  page = 1;
  $('#search-clear').hidden = !searchQuery;
  loadMemories();
});

$('#search-clear').addEventListener('click', () => {
  searchQuery = '';
  $('#search-input').value = '';
  $('#search-clear').hidden = true;
  page = 1;
  loadMemories();
});

$('#memory-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const item = btn.closest('.memory-item');
  const id = item.dataset.id;
  if (btn.dataset.act === 'del') {
    if (!confirm('确定删除这条记忆？旧值会保留在历史中。')) return;
    try {
      await api(`/api/memories/${id}`, { method: 'DELETE' });
      toast('已删除');
      loadMemories();
    } catch (e2) { toast(e2.message); }
  } else if (btn.dataset.act === 'edit') {
    const text = item.querySelector('.memory-text').textContent;
    const newText = prompt('编辑记忆内容：', text);
    if (newText === null || newText.trim() === '' || newText === text) return;
    try {
      await api(`/api/memories/${id}`, { method: 'PATCH', body: JSON.stringify({ text: newText.trim() }) });
      toast('已更新');
      loadMemories();
    } catch (e2) { toast(e2.message); }
  }
});

// ===== API Key =====

async function loadKeys() {
  try {
    const data = await api('/api/keys');
    // 刷新后明文丢失；若之前选的密钥仍在，保持选中，否则取第一个
    if (selectedKey && !data.results.some((k) => k.id === selectedKey.id)) {
      selectedKey = null;
      keyToken = null;
    }
    if (!selectedKey) selectedKey = data.results[0] || null;
    renderKeys(data.results);
    renderJson();
  } catch (e) { toast(e.message); }
}

function renderKeys(keys) {
  $('#key-list').innerHTML = keys.length
    ? keys.map((k) => `
      <li class="key-item">
        <div>
          <span class="key-name">${esc(k.name)}</span>
          <span class="muted">· ${esc(new Date(k.created_at).toLocaleDateString())}</span>
          <button class="link-btn ${selectedKey && selectedKey.id === k.id ? 'active' : ''}" data-use="${esc(k.id)}">用于配置</button>
        </div>
        <button class="btn btn-ghost danger" data-revoke="${esc(k.id)}">吊销</button>
      </li>`).join('')
    : '<li class="muted">暂无密钥，先生成一个。</li>';
  document.querySelectorAll('[data-use]').forEach((b) => {
    b.onclick = () => {
      const k = keys.find((x) => x.id === b.dataset.use);
      if (k) {
        selectedKey = k;
        keyToken = null; // 切换密钥后不再记得旧明文
        renderKeys(keys);
        renderJson();
      }
    };
  });
  document.querySelectorAll('[data-revoke]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('吊销后该密钥立即失效，确定？')) return;
      try {
        await api(`/api/keys/${b.dataset.revoke}/revoke`, { method: 'POST' });
        toast('已吊销');
        loadKeys();
      } catch (e2) { toast(e2.message); }
    };
  });
}

$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#key-name').value.trim() || 'default';
  try {
    const k = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name }) });
    keyToken = k.token;
    selectedKey = { id: k.id, name: k.name, created_at: k.created_at };
    $('#new-key').classList.remove('hidden');
    $('#new-key-value').textContent = k.token;
    $('#copy-new-key').dataset.token = k.token;
    $('#key-name').value = '';
    loadKeys(); // 刷新列表并渲染 JSON（JSON 将带上真实 Token）
  } catch (e2) { toast(e2.message); }
});

$('#copy-new-key').addEventListener('click', (e) => {
  const token = e.target.dataset.token;
  if (!token) return;
  navigator.clipboard.writeText(token).then(() => toast('密钥已复制'));
});

// ===== MCP 配置 JSON =====

function baseUrl() {
  return location.origin;
}

function renderJson() {
  const json = {
    mcpServers: {
      aimemory: {
        type: 'http',
        url: `${baseUrl()}/mcp`,
        headers: {},
      },
    },
  };
  if (keyToken) {
    // 有明文（刚生成/本会话内创建）→ 生成可直接使用的完整配置
    json.mcpServers.aimemory.headers = { Authorization: `Token ${keyToken}` };
    $('#copy-json').textContent = '复制 JSON（含密钥）';
  } else if (selectedKey) {
    // 无明文 → 占位符提示
    json.mcpServers.aimemory.headers = { Authorization: 'Token <在此粘贴你的 m0-xxx 密钥>' };
    $('#copy-json').textContent = '复制 JSON 模板';
  } else {
    // 无任何密钥 → 空 headers 模板
    $('#copy-json').textContent = '复制 JSON 模板';
  }
  $('#mcp-json').textContent = JSON.stringify(json, null, 2);
  // 手动模式字段（与通用 MCP 客户端「自定义连接器」表单一一对应）
  $('#manual-url').textContent = `${baseUrl()}/mcp`;
  $('#manual-header-name').textContent = 'Authorization';
  if (keyToken) {
    $('#manual-header-value').textContent = `Token ${keyToken}`;
  } else if (selectedKey) {
    $('#manual-header-value').textContent = 'Token <在此粘贴你的 m0-xxx 密钥>';
  } else {
    $('#manual-header-value').textContent = 'Token m0-xxx（先生成一个密钥）';
  }
}

// MCP 配置格式切换（JSON / 手动）
document.querySelectorAll('[data-mcp-seg]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('[data-mcp-seg]').forEach((x) => {
      const on = x === b;
      x.classList.toggle('active', on);
      x.setAttribute('aria-selected', String(on));
    });
    const manual = b.dataset.mcpSeg === 'manual';
    $('#json-config').classList.toggle('hidden', manual);
    $('#manual-config').classList.toggle('hidden', !manual);
  };
});

// 手动模式字段复制
document.querySelectorAll('[data-copy]').forEach((b) => {
  b.onclick = () => {
    navigator.clipboard.writeText($(`#${b.dataset.copy}`).textContent).then(() => toast('已复制'));
  };
});

$('#copy-json').addEventListener('click', async () => {
  if (!selectedKey && !keyToken) return toast('请先生成一个密钥');
  if (!keyToken) return toast('密钥明文只显示一次：请生成新密钥后复制，或在 JSON 中手动填入 Token');
  renderJson(); // 手动模式切回来时也确保复制的是最新内容
  navigator.clipboard.writeText($('#mcp-json').textContent).then(() => {
    toast('已复制完整 MCP 配置 JSON');
  });
});

initThemeToggle();
init();
