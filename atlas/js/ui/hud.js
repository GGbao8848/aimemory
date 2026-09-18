/**
 * HUD：顶部状态灯与指标、左侧层级图例、底部通讯日志。
 * 全部数值来自遥测快照，未登录时角标会明确标出「演示数据」。
 */

import { fmtBytes } from '../graph.js';

const $ = (id) => document.getElementById(id);

const HEALTH_TEXT = { ok: '正常', bad: '不可用', off: '未启用', unknown: '——' };

export function createHud({ graph, onLegendSolo }) {
  const healthEl = $('health');
  const metricsEl = $('metrics');
  const legendList = $('legend-list');
  const streamList = $('stream-list');
  const streamCount = $('stream-count');
  const modeBadge = $('mode-badge');

  let logCount = 0;
  const tweened = new Map();

  // ---------------------------------------------------------------- 状态灯
  const healthItems = {};
  healthEl.querySelectorAll('.health__item').forEach((el) => {
    healthItems[el.dataset.k] = el;
  });

  function setHealth(key, state, text) {
    const el = healthItems[key];
    if (!el) return;
    el.dataset.s = state;
    el.querySelector('b').textContent = text || HEALTH_TEXT[state] || '——';
  }

  // ---------------------------------------------------------------- 指标
  const METRICS = [
    {
      key: 'memories',
      k: 'L2 事实记忆',
      get: (m) => m.stats && m.stats.memories,
      unit: '条',
    },
    {
      key: 'records',
      k: 'L0 归档记录',
      get: (m) => m.l0 && m.l0.records,
      unit: '条',
      extra: (m) => (m.l0 ? fmtBytes(m.l0.disk_bytes || m.l0.bytes) : ''),
    },
    {
      key: 'sessions',
      k: '归档会话',
      get: (m) => m.l0 && m.l0.sessions,
      unit: '个',
      optional: true,
    },
    {
      key: 'devices',
      k: '采集设备',
      get: (m) => m.l0 && m.l0.devices,
      unit: '台',
      optional: true,
    },
    {
      key: 'l1',
      k: 'L1 会话摘要',
      get: (m) => m.l1 && m.l1.done,
      unit: '',
      extra: (m) => (m.l1 && m.l1.total ? `/ ${m.l1.total}` : ''),
      bar: (m) => (m.l1 && m.l1.total ? (m.l1.done || 0) / m.l1.total : 0),
      barColor: 'linear-gradient(90deg,#60a5fa,#7dd3fc)',
    },
    {
      key: 'backlog',
      k: '待处理',
      get: (m) => ((m.events && (m.events.pending || 0) + (m.events.processing || 0)) || 0)
        + ((m.l1 && ((m.l1.pending || 0) + (m.l1.running || 0))) || 0),
      unit: '项',
    },
  ];

  for (const def of METRICS) {
    const wrap = document.createElement('div');
    wrap.className = 'metric';
    wrap.dataset.key = def.key;
    if (def.optional) wrap.dataset.optional = '1';
    wrap.innerHTML = `<span class="metric__k">${def.k}</span>`
      + `<span class="metric__v"><span class="num">0</span><em>${def.unit}</em></span>`
      + (def.bar ? '<span class="metric__bar"><i style="width:0"></i></span>' : '');
    metricsEl.appendChild(wrap);
  }

  /** 数字滚动：直接跳变会显得"死"，滚动才有活体感 */
  function tween(key, el, to, unitSuffix) {
    const from = tweened.get(key) || 0;
    tweened.set(key, to);
    if (from === to) {
      el.textContent = to.toLocaleString('zh-CN') + (unitSuffix || '');
      return;
    }
    const t0 = performance.now();
    const dur = 620;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      const v = Math.round(from + (to - from) * e);
      el.textContent = v.toLocaleString('zh-CN') + (unitSuffix || '');
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function renderMetrics(m) {
    for (const def of METRICS) {
      const wrap = metricsEl.querySelector(`.metric[data-key="${def.key}"]`);
      if (!wrap) continue;
      const raw = def.get(m);
      const val = Number.isFinite(raw) ? raw : 0;
      tween(def.key, wrap.querySelector('.num'), val);
      const em = wrap.querySelector('em');
      const extra = def.extra ? def.extra(m) : '';
      em.textContent = def.unit ? (extra ? `${def.unit} · ${extra}` : def.unit) : extra;
      if (def.bar) {
        const bar = wrap.querySelector('.metric__bar i');
        bar.style.width = `${Math.round(def.bar(m) * 100)}%`;
        if (def.barColor) bar.style.background = def.barColor;
      }
    }

    // 模式角标
    if (m.live) {
      modeBadge.className = 'badge badge--live';
      modeBadge.textContent = '实时数据';
      modeBadge.title = `服务端实时状态 · ${new Date(m.at).toLocaleTimeString('zh-CN')}`;
    } else if (m.authRequired) {
      modeBadge.className = 'badge badge--demo';
      modeBadge.textContent = '未登录 · 演示数据';
      modeBadge.title = '登录后可看实时数据';
    } else {
      modeBadge.className = 'badge badge--off';
      modeBadge.textContent = '离线 · 演示数据';
      modeBadge.title = '服务端不可达';
    }

    // 状态灯
    const h = m.health || {};
    if (!m.healthLive) {
      setHealth('db', 'unknown', '——');
      setHealth('llm', 'unknown', '——');
      setHealth('embedding', 'unknown', '——');
      return;
    }
    setHealth('db', h.db ? 'ok' : 'bad');
    setHealth('llm', h.llm === null ? 'off' : h.llm ? 'ok' : 'bad');
    setHealth('embedding', h.embedding === null ? 'off' : h.embedding ? 'ok' : 'bad');
  }

  // ---------------------------------------------------------------- 图例
  const RING_COLOR = { l0: 'var(--l0)', l1: 'var(--l1)', l2: 'var(--l2)', l3: 'var(--l3)', edge: 'var(--edge)' };
  let solo = null;

  graph.rings.slice().reverse().forEach((ring) => {
    const count = graph.nodes.filter((n) => n.ring === ring.id).length;
    const li = document.createElement('li');
    li.className = 'legend__item';
    li.dataset.ring = ring.id;
    li.innerHTML = `
      <span class="legend__badge" style="--c:${RING_COLOR[ring.id] || 'var(--edge)'}">${ring.label}</span>
      <span class="legend__name"><i class="legend__dot" style="color:${RING_COLOR[ring.id] || 'var(--edge)'}"></i>${ring.name}
        <small>${ring.note}</small>
      </span>
      <span class="legend__n">${count}</span>`;
    li.addEventListener('click', () => {
      solo = solo === ring.id ? null : ring.id;
      legendList.querySelectorAll('.legend__item').forEach((x) => {
        x.classList.toggle('is-solo', x.dataset.ring === solo);
        x.classList.toggle('is-off', !!solo && x.dataset.ring !== solo);
      });
      onLegendSolo(solo);
    });
    legendList.appendChild(li);
  });

  // 外部依赖 / 实体单列一项
  const extCount = graph.nodes.filter((n) => n.ring === 'ext' && n.kind !== 'actor').length
    + graph.nodes.filter((n) => n.kind === 'actor').length
    + graph.nodes.filter((n) => n.kind === 'device').length;
  const extLi = document.createElement('li');
  extLi.className = 'legend__item';
  extLi.dataset.ring = 'ext';
  extLi.innerHTML = `
    <span class="legend__badge" style="--c:var(--ext)">EXT</span>
    <span class="legend__name"><i class="legend__dot" style="color:var(--ext)"></i>外部依赖 / 实体
      <small>LLM · Embedding · 采集设备 · MCP 客户端</small>
    </span>
    <span class="legend__n">${extCount}</span>`;
  extLi.addEventListener('click', () => {
    solo = solo === 'ext' ? null : 'ext';
    legendList.querySelectorAll('.legend__item').forEach((x) => {
      x.classList.toggle('is-solo', x.dataset.ring === solo);
      x.classList.toggle('is-off', !!solo && x.dataset.ring !== solo);
    });
    onLegendSolo(solo);
  });
  legendList.appendChild(extLi);

  function setSolo(v) {
    solo = v;
    legendList.querySelectorAll('.legend__item').forEach((x) => {
      x.classList.toggle('is-solo', x.dataset.ring === solo);
      x.classList.toggle('is-off', !!solo && x.dataset.ring !== solo);
    });
  }

  // ---------------------------------------------------------------- 日志
  const MAX_LOG = 26;
  function log(level, text) {
    const li = document.createElement('li');
    li.className = `log log--${level || 'info'}`;
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    li.innerHTML = `<time>${hh}:${mm}:${ss}</time><i></i><span></span>`;
    li.querySelector('span').textContent = text;
    streamList.prepend(li);
    while (streamList.children.length > MAX_LOG) streamList.lastElementChild.remove();
    logCount += 1;
    streamCount.textContent = String(logCount);
  }

  return { renderMetrics, log, setSolo };
}
