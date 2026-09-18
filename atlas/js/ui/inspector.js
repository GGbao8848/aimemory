/**
 * 检视面板：点节点后展示「这个模块到底在做什么、跑在哪个文件、和谁说话」。
 * 内容取自 topology.js 的 info（对着真实实现写），数字取自遥测快照。
 */

import { fmtBytes } from '../graph.js';
import { fmtAge } from '../telemetry.js';

const KIND_LABEL = {
  core: '存储内核 · Core',
  store: '存储 · Store',
  process: '计算模块 · Process',
  queue: '异步队列 · Queue',
  io: '出入口 · I/O',
  external: '外部依赖 · External',
  actor: '使用方 · Actor',
  device: '采集设备 · Device',
  pending: '未建 · Planned',
};

const nf = new Intl.NumberFormat('zh-CN');
const $ = (id) => document.getElementById(id);

export function createInspector(graph, { onSelect, onRequestClose }) {
  const root = $('inspector');
  const body = $('inspector-body');
  let current = null;
  let model = null;

  // ✕ 与 Esc 都走外部回调（由 main 统一决定"取消选中"），
  // 避免面板内部直接改状态造成 select(null) ↔ close() 互调死循环
  $('inspector-close').addEventListener('click', () => onRequestClose && onRequestClose());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current && onRequestClose) onRequestClose();
  });

  /** 该节点的实时数字：能从遥测里算出来的都算出来 */
  function liveStats(node, m) {
    if (!m) return [];
    const l0 = m.l0 || {};
    const l1 = m.l1 || {};
    const ev = m.events || {};
    const out = [];
    switch (node.id) {
      case 'core':
        out.push(['记忆条目', nf.format(m.stats?.memories || 0)]);
        out.push(['生效 Token', String(m.keys?.active ?? m.stats?.keys ?? 0)]);
        break;
      case 'l2_mem': {
        out.push(['记忆条目', nf.format(m.stats?.memories || 0)]);
        out.push(['提炼队列', `${(ev.pending || 0) + (ev.processing || 0)} 待处理`]);
        const ops = m.l2?.ops || {};
        if (ops.total) {
          out.push(['近 30 天消解', `新增 ${ops.ADD || 0} · 更新 ${ops.UPDATE || 0} · 取代 ${ops.DELETE || 0} · 去重 ${ops.NOOP || 0}`]);
        }
        break;
      }
      case 'l2_events':
        out.push(['待处理', String(ev.pending || 0)]);
        out.push(['处理中', String(ev.processing || 0)]);
        out.push(['已完成', nf.format(ev.done || 0)]);
        out.push(['失败', String(ev.failed || 0)]);
        break;
      case 'l1_sched':
      case 'l1_comp':
      case 'l1_sum':
        out.push(['已摘要', `${l1.done || 0} / ${l1.total || 0}`]);
        out.push(['排队中', String((l1.pending || 0) + (l1.running || 0))]);
        out.push(['失败', String(l1.failed || 0)]);
        out.push(['最近运行', l1.last_run ? fmtAge((Date.now() - Date.parse(l1.last_run)) / 60000) || '—' : '—']);
        break;
      case 'l0_file':
        out.push(['归档记录', nf.format(l0.records || 0)]);
        out.push(['jsonl 文件', nf.format(l0.files || 0)]);
        out.push(['磁盘占用', fmtBytes(l0.disk_bytes || l0.bytes)]);
        out.push(['最近上传', l0.last_received ? fmtAge((Date.now() - Date.parse(l0.last_received)) / 60000) : '—']);
        break;
      case 'l0_rec':
        out.push(['落盘记录', nf.format(l0.records || 0)]);
        out.push(['归档会话', String(l0.sessions || 0)]);
        out.push(['接入 agent', String(l0.agents || 0)]);
        break;
      case 'l0_batch':
        out.push(['累计批次', nf.format(l0.batches || 0)]);
        out.push(['设备数', String(l0.devices || 0)]);
        break;
      case 'ingest':
        out.push(['设备数', String(l0.devices || 0)]);
        out.push(['会话数', String(l0.sessions || 0)]);
        out.push(['最近上传', l0.last_received ? fmtAge((Date.now() - Date.parse(l0.last_received)) / 60000) : '—']);
        break;
      case 'mcp':
      case 'rest':
      case 'auth':
      case 'devflow':
        out.push(['生效 Token', String(m.keys?.active ?? m.stats?.keys ?? 0)]);
        out.push(['身份', m.live ? m.identity || 'owner' : '演示']);
        break;
      case 'llm':
        out.push(['状态', m.health?.llm === null ? '未启用' : m.health?.llm ? '正常' : '不可用']);
        out.push(['提炼队列', `${(ev.pending || 0) + (ev.processing || 0)} 待处理`]);
        break;
      case 'emb':
        out.push(['状态', m.health?.embedding === null ? '未启用' : m.health?.embedding ? '正常' : '不可用']);
        out.push(['降级', m.health?.embedding === false ? '已回退关键词' : '未触发']);
        break;
      case 'l3': {
        // L3 已建（一阶段）：从遥测的 l3 字段取真实规模（/api/atlas/overview 提供）
        const l3 = m.l3 || {};
        out.push(['生效条目', nf.format(l3.active || 0)]);
        out.push(['已被取代', nf.format(l3.superseded || 0)]);
        if (l3.last_update) {
          out.push(['最近更新', fmtAge((Date.now() - Date.parse(l3.last_update)) / 60000) || '—']);
        }
        const parts = Object.entries(l3.byKind || {})
          .map(([k, v]) => `${v.label || k} ${v.active || 0}`)
          .join(' · ');
        if (parts) out.push(['分 Kind', parts]);
        break;
      }
      default:
        break;
    }
    if (node.kind === 'device' && node.device) {
      const d = node.device;
      return [
        ['采集记录', nf.format(d.records || 0)],
        ['归档会话', String(d.sessions || 0)],
        ['归档体积', fmtBytes(d.bytes)],
        ['最近上报', d.last_seen ? fmtAge((Date.now() - Date.parse(d.last_seen)) / 60000) : '—'],
      ];
    }
    if (!out.length && node.metric) {
      const path = node.metric.split('.');
      const raw = path.reduce((o, k) => (o ? o[k] : undefined), m);
      if (raw !== undefined && raw !== null) out.push([node.metricLabel || node.metric, String(raw)]);
    }
    return out;
  }

  function flowChips(node) {
    const up = graph.links.filter((l) => l.to === node.id);
    const down = graph.links.filter((l) => l.from === node.id);
    const chips = [];
    const mk = (dir, l, other) => {
      const o = graph.byId.get(other);
      chips.push({ dir, label: o ? o.label : other, id: other, kind: l.kind, name: l.label || '' });
    };
    up.forEach((l) => mk('in', l, l.from));
    down.forEach((l) => mk('out', l, l.to));
    return chips;
  }

  function render() {
    const node = graph.byId.get(current);
    if (!node) return;
    const info = node.info || {};
    const live = liveStats(node, model);
    const chips = flowChips(node);

    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const parts = [];
    parts.push(`<div class="insp__kind">${esc(KIND_LABEL[node.kind] || node.kind)}</div>`);
    parts.push(`<h2 class="insp__title">${esc(node.label)}</h2>`);
    parts.push(`<p class="insp__sub">${esc(node.sub || '')}</p>`);

    if (live.length) {
      parts.push('<div class="insp__section"><h4>实时</h4><div class="insp__live">'
        + live.slice(0, 4).map(([k, v]) => `<div class="insp__stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')
        + '</div></div>');
    }

    if (info.role) parts.push(`<div class="insp__section"><h4>职责</h4><p class="insp__role">${esc(info.role)}</p></div>`);

    if (info.files && info.files.length) {
      parts.push('<div class="insp__section"><h4>实现位置</h4><ul class="insp__list">'
        + info.files.map((f) => `<li>${esc(f)}</li>`).join('') + '</ul></div>');
    }

    if (info.endpoints && info.endpoints.length) {
      parts.push('<div class="insp__section"><h4>接口 / 命令</h4><ul class="insp__list">'
        + info.endpoints.map((f) => `<li>${esc(f)}</li>`).join('') + '</ul></div>');
    }

    if (info.params && info.params.length) {
      parts.push('<div class="insp__section"><h4>关键参数</h4><dl class="insp__kv">'
        + info.params.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')
        + '</dl></div>');
    }

    if (chips.length) {
      parts.push('<div class="insp__section"><h4>上下游</h4><div class="insp__flow">'
        + chips.map((c) => `<button class="insp__chip" data-goto="${esc(c.id)}" title="${esc(c.name)}">`
          + `<em>${c.dir === 'in' ? '←' : '→'}</em>${esc(c.label)}</button>`).join('')
        + '</div></div>');
    }

    if (info.note) parts.push(`<div class="insp__section"><h4>要点</h4><p class="insp__note">${esc(info.note)}</p></div>`);

    body.innerHTML = parts.join('');
    root.style.setProperty('--nc', node.accent || '#7dd3fc');
    body.scrollTop = 0;

    body.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => onSelect(btn.dataset.goto));
    });
  }

  function open(nodeId) {
    current = nodeId;
    render();
    root.classList.add('is-open');
  }

  function close() {
    current = null;
    root.classList.remove('is-open');
  }

  function refresh(m) {
    model = m;
    if (current) render();
  }

  return { open, close, refresh, get current() { return current; } };
}
