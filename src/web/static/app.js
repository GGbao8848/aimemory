'use strict';

/* aimemory 管理平台前端逻辑（原生 JS，无构建） */

const $ = (sel) => document.querySelector(sel);

let currentUser = null;   // { userId, via }
let selectedKey = null;   // MCP JSON 配置里嵌入的 Token（默认最新一枚）
// G3：服务端不再存明文——只有本次会话里新建的 Token 拿得到一次性明文，用于拼 MCP 配置 JSON
let freshToken = null;
let freshTokenKeyId = null;
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

// ===== 登录状态（本地口令）=====

async function init() {
  // 单用户部署：无 SSO。直接探测会话——已登录进入应用，未登录显示口令表单。
  try {
    currentUser = await api('/api/me');
    if (currentUser && currentUser.userId) showApp();
    else showLogin();
  } catch { showLogin(); }
}

function showLogin() {
  $('#view-app').classList.add('hidden');
  $('#view-login').classList.remove('hidden');
  const input = $('#login-password');
  if (input) input.focus();
}

function showApp() {
  $('#view-login').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  $('#user-name').textContent = currentUser.username || '我';
  loadKeys().then(() => loadMemories());
}

// ===== 视图切换（侧边栏导航）=====

const VIEW_META = {
  memories: { title: '我的记忆', sub: '管理 agent 为你沉淀的记忆，跨会话复用' },
  sessions: { title: '会话归档', sub: '各设备 agent 的原始会话备份（只归档，不做 AI 加工）' },
  keys: { title: '接入 Token', sub: '为每个 agent 客户端签发独立 Token，随时单独吊销' },
  guide: { title: '接入指南', sub: 'MCP 接入步骤与工具说明' },
  ops: { title: '记忆操作审计', sub: '冲突消解的每一次判定，被删原文可追溯' },
  l3: { title: 'L3 画像/知识', sub: '长期成立的条目（data/l3 markdown），可直接编辑' },
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
  if (name === 'sessions') loadArchive();
  if (name === 'ops') loadOps();
  if (name === 'l3') loadL3();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});


// ===== 记忆操作审计（L2 冲突消解留痕）=====
async function loadOps() {
  const { results } = await api('/api/l2/ops?limit=50');
  const tb = $('#ops-tbody');
  tb.innerHTML = results.length ? results.map((r) => `
    <tr>
      <td><span class="op-badge op-${r.op}">${r.op}${r.applied === false ? '·拦截' : ''}</span></td>
      <td class="mono">${esc((r.before_text ? `「${r.before_text.slice(0, 30)}…」→ ` : '') + (r.after_text ? `「${r.after_text.slice(0, 40)}」` : '')) || '—'}</td>
      <td class="mono">${esc(r.source || '')}</td>
      <td class="mono">${(r.created_at || '').slice(5, 16).replace('T', ' ')}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="muted">暂无记录</td></tr>';
}

// ===== L3 画像/知识（列表 + 正文编辑 + 变更历史链）=====
async function loadL3() {
  const [{ results }, stats, history] = await Promise.all([
    api('/api/l3/entries?include_superseded=1'),
    api('/api/l3/stats'),
    api('/api/l3/history').catch(() => ({ chains: [], orphans: [] })),
  ]);
  $('#l3-stats').textContent = `active ${stats.active} · 已取代 ${stats.superseded} · 平均有效置信 ${stats.effective_confidence ?? '—'}`;
  const list = $('#l3-list');
  list.innerHTML = results.length ? results.map((e) => `
    <li class="l3-item ${e.superseded_by ? 'superseded' : ''}">
      <div class="l3-body">
        <span class="op-badge">${esc(e.kind_label || e.kind)}</span>
        <span class="l3-text">${esc(e.text)}</span>
        ${e.superseded_by ? `<span class="muted">（已被 ${e.superseded_by.slice(0, 8)} 取代）</span>` : ''}
        <div class="muted mono l3-meta">置信 ${e.confidence ?? '—'} → 有效 ${e.effective_confidence ?? '—'} · ${esc(e.source || '')}</div>
      </div>
      ${e.superseded_by ? '' : `<button class="btn btn-ghost" data-l3-edit="${e.id}" type="button">编辑</button>`}
    </li>`).join('') : '<li class="muted">暂无条目——后台凝练会自动生成，也可直接在 data/l3/ 写 markdown。</li>';

  // 变更历史链：现行条目 + 被其取代的旧版（新→旧）；孤儿链单独警示（人工改坏链的可视信号）
  const hist = $('#l3-history');
  const chains = history.chains || [];
  const orphans = history.orphans || [];
  hist.innerHTML = (chains.length || orphans.length) ? `
    <h3 class="l3-hist-title">变更历史（现行 ← 被取代的旧版）</h3>
    ${chains.map((c) => `
      <div class="l3-chain">
        <div class="l3-chain-head"><span class="op-badge">${esc(c.active.kind_label || c.active.kind)}</span><span>${esc(c.active.text)}</span></div>
        ${c.history.map((h) => `<div class="l3-chain-old muted mono">← ${esc(h.text)}（更新于 ${esc((h.updated_at || '').slice(0, 10))}）</div>`).join('')}
      </div>`).join('')}
    ${orphans.length ? `<div class="l3-chain"><div class="muted">⚠ ${orphans.length} 条孤儿链（取代者不存在，疑似人工改坏，请检查 data/l3/）：${orphans.map((o) => o.id.slice(0, 8)).join('、')}</div></div>` : ''}
  ` : '';

  list.querySelectorAll('[data-l3-edit]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.l3Edit;
      const entry = results.find((e) => e.id === id);
      const next = prompt('修改 L3 条目正文：', entry?.text || '');
      if (next == null || next === entry?.text) return;
      await api(`/api/l3/entries/${id}`, { method: 'PUT', body: JSON.stringify({ text: next }) });
      loadL3();
    });
  });
}

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

// ===== API Token（一名用户可持有多条命名 Token；明文不落库，仅创建响应返回一次） =====

async function loadKeys() {
  try {
    const data = await api('/api/keys');
    renderKeys(data.results);
  } catch (e) { toast(e.message); }
}

// 渲染 Token 列表（后端按创建时间倒序）。明文不回显：仅本次会话新建的那枚显示一次性明文。
function renderKeys(keys) {
  const list = $('#key-list');
  if (!keys.length) {
    list.innerHTML = '<li class="muted">暂无 Token，请在上方命名新建。</li>';
    selectedKey = null;
    keyToken = null;
    renderJson();
    return;
  }
  // MCP JSON 默认嵌入最新一枚（列表首条）；仅当它就是本次会话新建的 Token 时有明文可拼
  selectedKey = keys[0];
  keyToken = freshTokenKeyId && selectedKey && freshTokenKeyId === selectedKey.id ? freshToken : null;
  list.innerHTML = keys.map((k) => {
    const isFresh = k.id === freshTokenKeyId;
    return `
    <li class="key-item">
      <div class="key-main">
        <span class="key-name">${esc(k.name)}</span>
        <span class="muted">· ${esc(new Date(k.created_at).toLocaleDateString())} 创建${k.id === selectedKey.id ? ' · 用于下方配置' : ''}</span>
        ${isFresh && freshToken
          ? `<div class="muted small">明文仅此一次，请立即保存：</div><code class="key-plain">${esc(freshToken)}</code>`
          : '<span class="muted small">明文不回显（仅创建时展示一次）；丢失请吊销后重建，或走设备流自动签发</span>'}
      </div>
      <div class="key-ops">
        ${isFresh && freshToken ? `<button class="btn btn-ghost" data-copy-token="${esc(freshToken)}">复制明文</button>` : ''}
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
        if (b.dataset.revoke === freshTokenKeyId) { freshToken = null; freshTokenKeyId = null; }
        toast('已吊销');
        loadKeys();
      } catch (e2) { toast(e2.message); }
    };
  });
  renderJson();
}

// 新建 Token（名称必填；响应含一次性明文——立即可见可复制，刷新后不再有）
$('#key-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#key-name-input').value.trim();
  if (!name) return toast('请先填写 Token 名称');
  try {
    const data = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name }) });
    $('#key-name-input').value = '';
    freshToken = data.token || null;
    freshTokenKeyId = data.id || null;
    toast(`Token「${name}」已创建——明文仅显示这一次`);
    loadKeys();
  } catch (e2) { toast(e2.message); }
});

// ===== 会话归档（L0：设备 → agent → 会话 三级下钻 → 详情）=====

let archiveFilter = { device: null, agent: null };

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

function agentLabel(a) {
  return { codex: 'Codex', claude: 'Claude Code', zcode: 'ZCode' }[a] || a;
}

/**
 * 加载归档并按层级渲染。
 * 数据获取只随「设备」变化——选中设备后一次性取回该设备的全部会话，
 * agent 层级与其会话列表都在本地派生（避免每次点 agent 都再打一次接口）。
 */
async function loadArchive() {
  try {
    const q = archiveFilter.device ? `?device=${encodeURIComponent(archiveFilter.device)}` : '';
    const data = await api(`/api/l0/stats${q}`);
    const sessions = data.sessions_list || [];
    const devices = data.devices_list || [];
    renderDevices(devices);
    renderAgents(devices, sessions);
    renderArchiveSessions(sessions);
  } catch (e) { toast(e.message); }
}

// ---- 一级：设备 ----
function renderDevices(devices) {
  const host = $('#l0-devices');
  if (!devices.length) {
    host.innerHTML = `<p class="muted">暂无设备上报。在目标机器上部署采集器后（见「接入指南」的 aimemory-collector skill），这里会出现该设备。</p>`;
    return;
  }
  host.innerHTML = devices.map((d) => {
    const info = d.info || {};
    const os = [info.platform, info.os_release, info.arch].filter(Boolean).join(' ');
    const active = archiveFilter.device === d.device_code;
    // 指纹：机器固有标识的哈希，用于"重装后仍认回同一台设备"
    const fpLabel = { 'machine-id': '系统安装标识', mac: '物理网卡', hostname: '主机名', random: '随机' };
    const fp = d.fingerprint
      ? `<span class="muted small" title="机器指纹（${esc(fpLabel[d.fingerprint_source] || d.fingerprint_source || '未知来源')}）——重装采集器后仍能认回同一台设备">🔗 ${esc(d.fingerprint)}</span>`
      : '<span class="muted small" title="未上报机器指纹：该设备无法在重装后自动认回">⚠ 无指纹</span>';
    return `
    <div class="device-item${active ? ' device-active' : ''}" data-device="${esc(d.device_code)}">
      <div class="device-main">
        <span class="device-name">${esc(d.label || d.device_code)}</span>
        <span class="muted small"><code>${esc(d.device_code)}</code>${os ? ' · ' + esc(os) : ''} · ${(d.agents || []).map(agentLabel).map(esc).join(' / ')}</span>
        ${fp}
      </div>
      <div class="device-stats">
        <span>${d.sessions} 会话</span>
        <span>${d.records} 条</span>
        <span>${fmtBytes(d.bytes)}</span>
        <span class="muted small">最近 ${fmtTime(d.last_seen)}</span>
      </div>
    </div>`;
  }).join('');
  host.querySelectorAll('[data-device]').forEach((el) => {
    el.onclick = () => {
      const code = el.dataset.device;
      // 切换设备时清空下级选择（agent 与设备强绑定，换了设备就必须重选）
      archiveFilter.device = archiveFilter.device === code ? null : code;
      archiveFilter.agent = null;
      $('#l0-sessions-card').classList.add('hidden');
      $('#l0-detail-card').classList.add('hidden');
      loadArchive();
    };
  });
}

// ---- 二级：agent（从该设备的会话中聚合）----
function aggregateAgents(sessions) {
  const m = new Map();
  for (const s of sessions) {
    const a = m.get(s.agent) || { agent: s.agent, sessions: 0, records: 0, bytes: 0, last: null };
    a.sessions += 1;
    a.records += s.records || 0;
    a.bytes += s.bytes || 0;
    if (!a.last || (s.last_received || '') > a.last) a.last = s.last_received;
    m.set(s.agent, a);
  }
  return [...m.values()].sort((x, y) => (y.last || '').localeCompare(x.last || ''));
}

function renderAgents(devices, sessions) {
  const card = $('#l0-agents-card');
  if (!archiveFilter.device) { card.classList.add('hidden'); return; }

  const dev = devices.find((d) => d.device_code === archiveFilter.device);
  const devName = (dev && (dev.label || dev.device_code)) || archiveFilter.device;
  $('#l0-agents-title').textContent = `Agent · ${devName}`;

  const agents = aggregateAgents(sessions);
  const host = $('#l0-agents');
  $('#l0-agents-sub').textContent = agents.length ? `${agents.length} 个 agent` : '';

  if (!agents.length) {
    card.classList.remove('hidden');
    host.innerHTML = '<p class="muted">该设备暂无归档会话。</p>';
    return;
  }
  card.classList.remove('hidden');
  host.innerHTML = agents.map((a) => {
    const active = archiveFilter.agent === a.agent;
    return `
    <div class="agent-item${active ? ' agent-active' : ''}" data-agent="${esc(a.agent)}">
      <div class="agent-main">
        <span class="agent-name">${esc(agentLabel(a.agent))}</span>
        <span class="muted small">${a.sessions} 会话 · ${a.records} 条 · ${fmtBytes(a.bytes)}</span>
      </div>
      <span class="muted small">最近 ${fmtTime(a.last)}</span>
    </div>`;
  }).join('');
  host.querySelectorAll('[data-agent]').forEach((el) => {
    el.onclick = () => {
      const a = el.dataset.agent;
      archiveFilter.agent = archiveFilter.agent === a ? null : a;
      $('#l0-detail-card').classList.add('hidden');
      loadArchive();
    };
  });
}

// ---- 三级：会话列表（须先选定 agent）----
function renderArchiveSessions(sessions) {
  const card = $('#l0-sessions-card');
  // 未选 agent 时不展示会话列表——层级下钻到这一步才出现
  if (!archiveFilter.device || !archiveFilter.agent) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  const filtered = sessions.filter((s) => s.agent === archiveFilter.agent);
  $('#l0-sessions-title').textContent = `会话 · ${agentLabel(archiveFilter.agent)}`;
  $('#l0-sessions-sub').textContent = `${filtered.length} 个会话 · ${fmtBytes(filtered.reduce((n, s) => n + (s.bytes || 0), 0))}`;

  const host = $('#l0-sessions');
  if (!filtered.length) {
    host.innerHTML = '<p class="muted">该 agent 下暂无归档会话。</p>';
    return;
  }
  host.innerHTML = filtered.map((s) => `
    <div class="session-item" data-session="${esc(s.session_id)}" data-agent="${esc(s.agent)}" data-device="${esc(s.device_code || '')}">
      <div class="session-main">
        <code class="session-id">${esc(s.session_id)}</code>
        <span class="muted small">${s.records} 条 · ${fmtBytes(s.bytes)} · 首次 ${fmtTime(s.first_received)}</span>
      </div>
      <span class="muted small">${fmtTime(s.last_received)}</span>
    </div>`).join('');
  host.querySelectorAll('[data-session]').forEach((el) => {
    el.onclick = () => openSession(el.dataset.agent, el.dataset.device, el.dataset.session);
  });
}

const ROLE_LABEL = {
  user: '用户', assistant: '助手', system: '系统', tool: '工具', reasoning: '推理', meta: '元信息',
};

async function openSession(agent, device, sessionId) {
  const card = $('#l0-detail-card');
  const host = $('#l0-detail');
  card.classList.remove('hidden');
  $('#l0-detail-title').textContent = sessionId;
  $('#l0-detail-meta').textContent = '加载中…';
  host.innerHTML = '';
  try {
    const q = new URLSearchParams({ agent, session_id: sessionId });
    if (device) q.set('device', device);
    const d = await api(`/api/l0/session?${q}`);
    const recs = d.records || [];
    $('#l0-detail-meta').textContent =
      `${agentLabel(agent)} · ${device || '未标注设备'} · 共 ${d.total || recs.length} 条` +
      (d.truncated ? `（仅显示前 ${recs.length} 条）` : '');

    // L1 摘要（若已生成）：放在逐条原文之前——看会话先看"做了什么"，需要细节再往下翻
    const sm = d.summary;
    let summaryHtml = '';
    if (sm && sm.status === 'done' && sm.overview) {
      const list = (title, arr) => (arr && arr.length)
        ? `<div class="sd-sum-block"><span class="sd-sum-label">${title}</span><ul>${
            arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
      summaryHtml = `
      <div class="session-summary">
        <div class="sd-head"><span class="sd-role">📋 会话摘要</span>
          <span class="muted small">${esc(sm.model || '')} · ${sm.records || 0} 条记录收敛</span></div>
        <p class="sd-sum-overview">${esc(sm.overview)}</p>
        ${list('关键决定', sm.decisions)}
        ${list('未决事项', sm.pending)}
        ${list('产出物', sm.artifacts)}
      </div>`;
    } else if (sm && sm.status && sm.status !== 'done') {
      const label = { pending: '排队中', running: '生成中', failed: `失败${sm.error ? '：' + sm.error : ''}` }[sm.status] || sm.status;
      summaryHtml = `<div class="session-summary muted small">📋 会话摘要：${esc(label)}（后台自动生成，稍后刷新可见）</div>`;
    }

    if (!recs.length) {
      host.innerHTML = summaryHtml + '<p class="muted">该会话暂无归档内容（文件可能已被清理）。</p>';
      return;
    }
    host.innerHTML = summaryHtml + recs.map((r) => {
      const role = r.role || 'meta';
      const content = r.content ? esc(r.content) : '<span class="muted">（无正文）</span>';
      const meta = r.meta && Object.keys(r.meta).length
        ? `<div class="sd-meta muted small">${esc(JSON.stringify(r.meta))}</div>` : '';
      const hasRaw = r.raw !== undefined;
      return `
      <div class="sd-item sd-${esc(role)}">
        <div class="sd-head">
          <span class="sd-role">${esc(ROLE_LABEL[role] || role)}</span>
          <span class="muted small">${fmtTime(r.ts)}</span>
          ${hasRaw ? '<button class="btn btn-ghost sd-raw-btn" type="button">原始</button>' : ''}
        </div>
        <pre class="sd-content">${content}</pre>
        ${meta}
        ${hasRaw ? `<pre class="sd-raw hidden">${esc(JSON.stringify(r.raw, null, 2))}</pre>` : ''}
      </div>`;
    }).join('');
    host.querySelectorAll('.sd-raw-btn').forEach((b) => {
      b.onclick = () => {
        const raw = b.closest('.sd-item').querySelector('.sd-raw');
        raw.classList.toggle('hidden');
      };
    });
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    $('#l0-detail-meta').textContent = '';
    host.innerHTML = `<p class="muted">加载失败：${esc(e.message)}</p>`;
  }
}

$('#l0-detail-close').addEventListener('click', () => $('#l0-detail-card').classList.add('hidden'));
$('#l0-refresh').addEventListener('click', () => loadArchive());

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
