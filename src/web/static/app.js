'use strict';

/* aimemory 管理平台前端逻辑（原生 JS，无构建） */

const $ = (sel) => document.querySelector(sel);

let currentUser = null;   // { userId, via }
let selectedKey = null;   // MCP JSON 配置里嵌入的 Token（默认最新一枚）
let keyToken = null;      // selectedKey 的明文（服务端提供，随时可见）
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
  keys: { title: '接入 Token', sub: '为每个 agent 客户端签发独立 Token，随时单独吊销' },
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

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#add-text').value.trim();
  if (!text) return toast('内容不能为空');
  try {
    // 异步受理：素材提交后由后台 LLM 提炼入库（不存原文），202 + event_id
    const r = await api('/api/memories', { method: 'POST', body: JSON.stringify({ text }) });
    $('#add-text').value = '';
    toast('素材已提交，AI 提炼入库中（本地模型较慢，稍后刷新可见）…');
    // 轮询等待提炼完成：done → 刷新列表；failed → 提示失败原因
    if (r && r.event_id) {
      pollAddResult(r.event_id);
    } else {
      loadMemories();
    }
  } catch (e2) { toast(e2.message); }
});

// 轮询素材提炼事件直到 done/failed，完成后刷新记忆列表
async function pollAddResult(eventId, tries = 0) {
  try {
    const st = await api(`/api/events/${eventId}`);
    if (st && st.event && st.event.status === 'done') {
      toast(`提炼完成，新增 ${st.event.result ? st.event.result.count : ''} 条记忆`);
      loadMemories();
    } else if (st && st.event && st.event.status === 'failed') {
      toast(`提炼失败：${st.event.error || '无有效产出，素材未入库'}`);
      loadMemories();
    } else if (tries < 40) { // 最多等 ~40s
      setTimeout(() => pollAddResult(eventId, tries + 1), 1000);
    } else {
      loadMemories();
    }
  } catch (e) { loadMemories(); }
}

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

// ===== 导出记忆（JSON 附件下载；数据备份 / 迁移）=====
$('#export-btn').addEventListener('click', async () => {
  const btn = $('#export-btn');
  try {
    btn.disabled = true;
    const res = await fetch('/api/memories/export', { headers: { Accept: 'application/json' } });
    if (res.status === 401) { showLogin(); throw new Error('未登录'); }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `导出失败 (${res.status})`);
    }
    const blob = await res.blob();
    // 从 Content-Disposition 取文件名，取不到则用默认
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^";]+)"?/i);
    const filename = m ? m[1] : `aimemory-memories-${new Date().toISOString().slice(0, 10)}.json`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出记忆文件');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
});

$('#memory-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const item = btn.closest('.memory-item');
  const id = item.dataset.id;
  if (btn.dataset.act === 'del') {
    if (!confirm('确定删除这条记忆？')) return;
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

// ===== API Token（一名用户可持有多条命名 Token；明文由服务端保存，列表内随时可看可复制） =====

async function loadKeys() {
  try {
    const data = await api('/api/keys');
    renderKeys(data.results);
  } catch (e) { toast(e.message); }
}

// 渲染 Token 列表（后端按创建时间倒序）：每枚都常显明文，可直接复制
function renderKeys(keys) {
  const list = $('#key-list');
  if (!keys.length) {
    list.innerHTML = '<li class="muted">暂无 Token，请在上方命名新建。</li>';
    selectedKey = null;
    keyToken = null;
    renderJson();
    return;
  }
  // MCP JSON 默认嵌入最新一枚（列表首条）；有明文才能拼出可直接用的完整配置
  selectedKey = keys[0];
  keyToken = selectedKey.token || null;
  list.innerHTML = keys.map((k) => {
    const plain = k.token || '';
    return `
    <li class="key-item">
      <div class="key-main">
        <span class="key-name">${esc(k.name)}</span>
        <span class="muted">· ${esc(new Date(k.created_at).toLocaleDateString())} 创建${k.id === selectedKey.id ? ' · 用于下方配置' : ''}</span>
        ${plain
          ? `<code class="key-plain">${esc(plain)}</code>`
          : '<span class="muted small">早期签发的 Token 未存明文，无法回显（请吊销后新建）</span>'}
      </div>
      <div class="key-ops">
        ${plain ? `<button class="btn btn-ghost" data-copy-token="${esc(plain)}">复制</button>` : ''}
        <button class="btn btn-ghost danger" data-revoke="${esc(k.id)}">吊销</button>
      </div>
    </li>`;
  }).join('');
  list.querySelectorAll('[data-copy-token]').forEach((b) => {
    b.onclick = () => copyText(b.dataset.copyToken).then(() => toast('已复制'));
  });
  list.querySelectorAll('[data-revoke]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('吊销后该 Token 立即失效（正在使用它的 agent 会 401），确定？')) return;
      try {
        await api(`/api/keys/${b.dataset.revoke}/revoke`, { method: 'POST' });
        toast('已吊销');
        loadKeys();
      } catch (e2) { toast(e2.message); }
    };
  });
  renderJson();
}

// 新建 Token（名称必填；明文持久化，列表中随时可看）
$('#key-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#key-name-input').value.trim();
  if (!name) return toast('请先填写 Token 名称');
  try {
    await api('/api/keys', { method: 'POST', body: JSON.stringify({ name }) });
    $('#key-name-input').value = '';
    toast(`Token「${name}」已创建`);
    loadKeys();
  } catch (e2) { toast(e2.message); }
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
    // 有明文 → 生成可直接使用的完整配置
    json.mcpServers.aimemory.headers = { Authorization: `Token ${keyToken}` };
    $('#copy-json').textContent = '复制 JSON（含 Token）';
  } else if (selectedKey) {
    // 早期 Token 未存明文 → 占位提示，引导新建
    json.mcpServers.aimemory.headers = { Authorization: 'Token <在此粘贴你的 m0-xxx Token>' };
    $('#copy-json').textContent = '复制 JSON 模板';
  } else {
    // 尚无 Token → 空 headers 模板
    $('#copy-json').textContent = '复制 JSON 模板';
  }
  $('#mcp-json').textContent = JSON.stringify(json, null, 2);
  // 手动模式字段（与通用 MCP 客户端「自定义连接器」表单一一对应）
  $('#manual-url').textContent = `${baseUrl()}/mcp`;
  $('#manual-header-name').textContent = 'Authorization';
  if (keyToken) {
    $('#manual-header-value').textContent = `Token ${keyToken}`;
  } else if (selectedKey) {
    $('#manual-header-value').textContent = 'Token <在此粘贴你的 m0-xxx Token>';
  } else {
    $('#manual-header-value').textContent = 'Token m0-xxx（请先在上方新建 Token）';
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
    // 明文不可得（早期 Token 未存明文，或尚无 Token）→ 引导新建一枚
    return toast('请先在上方新建一枚 Token，再复制完整配置');
  }
  renderJson(); // 确保复制的是最新内容
  copyText($('#mcp-json').textContent).then(() => {
    toast('已复制完整 MCP 配置 JSON');
  });
});

initThemeToggle();
init();
