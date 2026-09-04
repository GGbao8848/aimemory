'use strict';

/* aimemory 管理平台前端逻辑（原生 JS，无构建） */

const $ = (sel) => document.querySelector(sel);

let currentUser = null;   // { userId, via }
let selectedKey = null;   // 当前 MCP JSON 里使用的密钥（单 key 策略下即唯一生效密钥）
let keyToken = null;      // 密钥明文（本会话内展示，sessionStorage 持久）
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

// 兼容复制：安全上下文（HTTPS/localhost）用 navigator.clipboard；
// 内网 HTTP（http://IP:端口）下 clipboard API 不可用 → 降级为隐藏 textarea + execCommand
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok ? Promise.resolve() : Promise.reject(new Error('复制失败（浏览器限制）'));
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
  guide: { title: '接入指南', sub: 'MCP 接入步骤与工具说明' },
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
        <div class="memory-body">
          <div class="memory-text">${esc(m.text)}</div>
          <div class="memory-meta">
            <span class="stamp">${esc(new Date(m.updated_at).toLocaleString())}</span>
            ${Object.keys(m.metadata || {}).length ? `<span class="meta-json">${esc(JSON.stringify(m.metadata))}</span>` : ''}
          </div>
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

// ===== API Key（单 key：一个用户只有一条生效密钥；页面常显，明文在本浏览器会话内可重复查看） =====

// 明文只存前端 sessionStorage（仅本标签页会话）：刷新/切页不丢；关浏览器即清（下次重新签发查看）
function persistToken(token) {
  try { sessionStorage.setItem('aimemory_key_plain', token); } catch (e) {}
}
function restoreToken() {
  try { return sessionStorage.getItem('aimemory_key_plain') || null; } catch (e) { return null; }
}
function clearToken() {
  try { sessionStorage.removeItem('aimemory_key_plain'); } catch (e) {}
}

async function loadKeys() {
  try {
    const data = await api('/api/keys');
    let keys = data.results;
    // 兜底：完全没有生效密钥（异常态）→ 自动签发一条并展示明文
    if (keys.length === 0) {
      const k = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'default' }) });
      selectedKey = { id: k.id, name: k.name, created_at: k.created_at };
      keyToken = k.token;
      persistToken(k.token);
      renderActiveKey(selectedKey, keyToken);
      renderJson();
      return;
    }
    // 单 key 下生效密钥至多一条
    if (selectedKey && !keys.some((k) => k.id === selectedKey.id)) { selectedKey = null; keyToken = null; }
    if (!selectedKey) selectedKey = keys[0];
    keyToken = restoreToken(); // 本会话内已看过明文 → 恢复常显；否则只显示元信息
    renderActiveKey(selectedKey, keyToken);
    renderJson();
  } catch (e) { toast(e.message); }
}

// 渲染当前生效密钥卡片：始终显示；明文可得时直接展示，否则给「显示密钥」按钮（重新签发）
function renderActiveKey(k, plain) {
  const list = $('#key-list');
  if (!k) { list.innerHTML = '<li class="muted">暂无生效密钥。</li>'; return; }
  list.innerHTML = `
    <li class="key-item">
      <div class="key-main">
        <span class="key-name">${esc(k.name)}</span>
        <span class="muted">· 生效中 · ${esc(new Date(k.created_at).toLocaleDateString())} 生成</span>
        ${plain
          ? `<code class="key-plain">${esc(plain)}</code>`
          : '<button class="btn btn-ghost" id="btn-show-key" type="button">显示密钥</button>'}
      </div>
      <button class="btn btn-ghost danger" data-revoke="${esc(k.id)}">吊销</button>
    </li>`;
  const copyBtn = $('#copy-visible-key');
  if (copyBtn) copyBtn.dataset.token = plain || '';
  const showBtn = $('#btn-show-key');
  if (showBtn) {
    showBtn.onclick = async () => {
      try {
        const k2 = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name: k.name }) });
        keyToken = k2.token;
        selectedKey = { id: k2.id, name: k2.name, created_at: k2.created_at };
        persistToken(k2.token);
        renderActiveKey(selectedKey, keyToken); // 显示新明文；旧 key 已被吊销
        renderJson();
        toast('已生成并显示新密钥（旧密钥已自动吊销）');
      } catch (e2) { toast(e2.message); }
    };
  }
  const revokeBtn = list.querySelector('[data-revoke]');
  if (revokeBtn) {
    revokeBtn.onclick = async () => {
      if (!confirm('吊销后该密钥立即失效，确定？')) return;
      try {
        await api(`/api/keys/${revokeBtn.dataset.revoke}/revoke`, { method: 'POST' });
        clearToken(); keyToken = null; selectedKey = null;
        toast('已吊销'); loadKeys();
      } catch (e2) { toast(e2.message); }
    };
  }
}

$('#copy-visible-key').addEventListener('click', (e) => {
  const token = e.target.dataset.token;
  if (!token) return;
  copyText(token).then(() => toast('密钥已复制'));
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
    // 无明文 → 占位符提示（生成密钥后明文只显示一次，刷新需重新生成）
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
    $('#manual-header-value').textContent = 'Token m0-xxx（密钥已自动生成，刷新页面查看）';
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
    copyText($(`#${b.dataset.copy}`).textContent).then(() => toast('已复制'));
  };
});

$('#copy-json').addEventListener('click', async () => {
  if (!keyToken) {
    // 明文不可得（换了浏览器/清了缓存）→ 需先「显示密钥」重新签发
    return toast('请先点击「显示密钥」生成并查看密钥，再复制完整配置');
  }
  renderJson(); // 确保复制的是最新内容
  copyText($('#mcp-json').textContent).then(() => {
    toast('已复制完整 MCP 配置 JSON');
  });
});

initThemeToggle();
init();
