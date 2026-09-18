/**
 * 标签层：节点标签 + 环带徽标。
 *
 * 文字用 DOM 渲染（比 canvas 清晰、可选中），每帧只写 transform。
 * 两个要点：
 *  1) 标签会互相压住（24 个节点里必然有几对角度接近）——用一个只沿纵向推挤的
 *     松弛过程做去重叠，保持标签仍在各自节点旁边。
 *  2) 标签尺寸不每帧测量（会触发同步布局），只在建好后与遥测刷新后量一次。
 */

import { fmtBytes, nodeSize } from '../graph.js';
import { fmtAge } from '../telemetry.js';

const nf = new Intl.NumberFormat('zh-CN');

/** 环带徽标配色（与 legend 保持一致） */
const RING_COLOR = {
  l0: '#38bdf8', l1: '#60a5fa', l2: '#5eead4', l3: '#8b9dc3', edge: '#22d3ee',
};

/** 个别节点的标签方位需要手工指定：内核往下让开六边形圆盘 */
const SIDE_OVERRIDE = { core: 'below' };
const GAP_OVERRIDE = { core: 56 };

/**
 * 环带徽标的落点角度：逐环挑没有节点占用的方位，避免压住模块标签。
 * L3 不给徽标——它那一环上就有 L3 节点本身在标注（且是"待建"的呼吸态）。
 */
const RING_BADGE_ANGLE = { l2: 20, l1: 42, l0: 128, edge: 172 };

/** 标签再沿径向外推的距离（px）：把各环标签错开到各自的外侧环带里 */
const RADIAL_PUSH = 16;

export function createLabels(graph, { onSelect, onHover, onRingClick }) {
  const host = document.getElementById('labels');
  const els = new Map();
  const sizes = new Map(); // id -> {w,h}
  const ringEls = [];
  let lastDump = []; // 上一帧的布局结果（调试/验收用）

  // ---------------------------------------------------------------- 节点标签
  for (const n of graph.nodes) {
    const el = document.createElement('div');
    el.className = 'nlabel';
    el.dataset.id = n.id;

    // 方位：一律朝圆心外侧排。各环标签因此落在各自的外侧环带里，
    // 不会像「外环标签朝内」那样全挤到中间那圈去。
    const r = Math.hypot(n.x, n.y);
    const ux = r > 1 ? n.x / r : 0;
    const uy = r > 1 ? n.y / r : 0;
    let side = SIDE_OVERRIDE[n.id];
    if (!side) {
      if (r < 70) side = 'below';
      else if (Math.abs(ux) >= 0.30) side = ux > 0 ? 'right' : 'left';
      else side = uy > 0 ? 'above' : 'below';
    }
    el.classList.add(`nlabel--${side}`);
    el.dataset.radial = `${ux.toFixed(4)},${uy.toFixed(4)}`;

    const box = document.createElement('div');
    box.className = 'nlabel__box';
    box.style.setProperty('--nc', n.accent || '#7dd3fc');
    const gap = GAP_OVERRIDE[n.id];
    if (gap) box.style.setProperty('--gap', `${gap}px`);
    box.innerHTML = '<span class="nlabel__name"></span><span class="nlabel__sub"></span><span class="nlabel__metric"></span>';
    box.querySelector('.nlabel__name').textContent = n.label;
    box.querySelector('.nlabel__sub').textContent = n.sub || '';
    el.appendChild(box);

    // 命中判定统一由舞台层处理（见 main.js 的 pointerdown 分流），这里不挂事件
    host.appendChild(el);
    els.set(n.id, el);
  }

  // ---------------------------------------------------------------- 环带徽标
  for (const ring of graph.rings) {
    const angle = RING_BADGE_ANGLE[ring.id];
    if (angle === undefined) continue;
    const a = (angle * Math.PI) / 180;
    const el = document.createElement('div');
    el.className = 'ringbadge';
    el.dataset.ring = ring.id;
    el.style.setProperty('--rc', RING_COLOR[ring.id] || '#22d3ee');
    el.innerHTML = `<span class="ringbadge__box"><b>${ring.label}</b><span>${ring.name}</span></span>`;
    if (onRingClick) {
      el.querySelector('.ringbadge__box').addEventListener('click', (e) => {
        e.stopPropagation();
        onRingClick(ring.id);
      });
    }
    host.appendChild(el);
    ringEls.push({ el, box: el.firstElementChild, x: Math.cos(a) * ring.radius, y: Math.sin(a) * ring.radius, ring, size: { w: 90, h: 23 } });
  }

  /** 量一次标签尺寸（读 offsetWidth 会触发同步布局，故只在必要时调用） */
  function measure() {
    for (const [id, el] of els) {
      const box = el.firstElementChild;
      sizes.set(id, { w: box.offsetWidth || 120, h: box.offsetHeight || 34 });
    }
    for (const rb of ringEls) {
      rb.size = { w: rb.box.offsetWidth || 90, h: rb.box.offsetHeight || 23 };
    }
  }
  requestAnimationFrame(measure);

  /**
   * 去重叠：单向叠放扫描，上下各扫一遍取总位移小的那个。
   *
   * 为什么不用成对松弛：同一侧（比如都在节点西边）会同时挂好几个标签，
   * 成对推挤会互相打架、收敛到仍有重叠的局部解。单向扫描是确定性的——
   * 沿一个方向依次放置，后来的让开已放好的，一遍必然无重叠。
   * 环带徽标是固定障碍（fixed），只让节点标签让开它们。
   */
  function relax(items) {
    const PAD = 4;
    const fixeds = items.filter((it) => it.fixed);
    const movables = items.filter((it) => !it.fixed);

    /** 沿 dir（+1 自上而下 / -1 自下而上）放置，返回 {总位移, dy 表} */
    function sweep(dir) {
      const order = movables.slice().sort((a, b) => dir * (a.y - b.y));
      const placed = fixeds.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h }));
      const out = new Map();
      let total = 0;
      for (const it of order) {
        let y = it.y;
        for (const p of placed) {
          const ox = Math.min(it.x + it.w / 2, p.x + p.w / 2) - Math.max(it.x - it.w / 2, p.x - p.w / 2);
          if (ox <= 0) continue;
          const minGap = (it.h + p.h) / 2 + PAD;
          if (Math.abs(y - p.y) < minGap) y = p.y + dir * minGap;
        }
        out.set(it, y - it.y);
        total += Math.abs(y - it.y);
        placed.push({ x: it.x, y, w: it.w, h: it.h });
      }
      return { total, out };
    }

    const down = sweep(1);
    const up = sweep(-1);
    const best = down.total <= up.total ? down : up;
    for (const it of movables) it.dy = best.out.get(it) || 0;
  }

  /** 每帧：世界坐标 → 屏幕，再去重叠，最后写回 transform */
  function update(project, cam, cssW, cssH) {
    const rect = { width: cssW, height: cssH };
    const items = [];
    const visible = [];

    for (const n of graph.nodes) {
      const el = els.get(n.id);
      if (!el) continue;
      const { sx, sy } = project(n.x, n.y, rect);
      const vis = sx > -200 && sx < cssW + 200 && sy > -110 && sy < cssH + 110;
      if (!vis) { el.style.display = 'none'; continue; }
      el.style.display = '';
      const s = sizes.get(n.id) || { w: 130, h: 36 };

      // 先把锚点沿径向外推，再按方位把标签盒摆到锚点旁边
      const [ux, uy] = el.dataset.radial.split(',').map(Number);
      const ax = sx + ux * RADIAL_PUSH;
      const ay = sy - uy * RADIAL_PUSH; // 世界 y 向上，屏幕 y 向下，故取负

      const cls = el.classList;
      const side = cls.contains('nlabel--left') ? -1 : cls.contains('nlabel--right') ? 1 : 0;
      const isBelow = cls.contains('nlabel--below');
      const gap = Number((el.firstElementChild.style.getPropertyValue('--gap') || '').replace('px', '')) || 16;
      const cx = side === 0 ? ax : ax + side * (gap + s.w / 2);
      const cy = isBelow ? ay + gap + s.h / 2 : cls.contains('nlabel--above') ? ay - gap - s.h / 2 : ay;
      items.push({ el, x: cx, y: cy, w: s.w, h: s.h, anchorX: ax, anchorY: ay, side, isBelow, gap });
    }

    // 环带徽标投影到屏幕，并作为固定障碍参与去重叠
    const badges = [];
    for (const rb of ringEls) {
      const { sx, sy } = project(rb.x, rb.y, rect);
      const vis = sx > -260 && sx < cssW + 260 && sy > -80 && sy < cssH + 80;
      rb.el.style.display = vis ? '' : 'none';
      if (!vis) continue;
      rb.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
      const item = { el: rb.el, x: sx, y: sy, w: rb.size.w, h: rb.size.h, fixed: true };
      items.push(item);
      badges.push(item);
    }

    relax(items);

    for (const it of items) {
      if (it.fixed) continue;
      // CSS 里四种方位自带的盒子中心偏移（.nlabel--right/left/above/below）
      const offX = it.side !== 0 ? it.side * (it.gap + it.w / 2) : 0;
      const isAbove = it.el.classList.contains('nlabel--above');
      const offY = it.isBelow ? it.gap + it.h / 2 : isAbove ? -(it.gap + it.h / 2) : 0;
      // 容器的 transform 定位的是「零尺寸容器原点」，所以要由目标盒子中心反推；
      // 直接写 anchorX+偏移会把 CSS 的偏移算两遍（实测会偏半个标签宽）
      it.el.style.transform =
        `translate3d(${(it.x - offX).toFixed(1)}px, ${(it.y + it.dy - offY).toFixed(1)}px, 0)`;
      visible.push(it);
    }
    lastDump = items.map((it) => ({
      id: it.el.dataset.id || ('badge:' + (it.el.dataset.ring || '')),
      fixed: !!it.fixed,
      cx: Math.round(it.x),
      cy: Math.round(it.y + (it.dy || 0)),
      w: Math.round(it.w),
      h: Math.round(it.h),
      dy: Math.round(it.dy || 0),
    }));
    return visible.length + badges.length;
  }

  function setHot(id) {
    for (const [nid, el] of els) el.classList.toggle('is-hot', nid === id);
  }

  function setSelected(id) {
    for (const [nid, el] of els) el.classList.toggle('is-sel', nid === id);
  }

  /** dim: Set<string> | null，null 表示全部正常 */
  function setDim(set) {
    for (const [nid, el] of els) el.classList.toggle('is-dim', !!set && !set.has(nid));
  }

  function metricText(node, m) {
    if (!node.metric || !m) return '';
    const v = node.metric;
    if (v === 'l1.backlog') {
      const b = (m.l1?.pending || 0) + (m.l1?.running || 0);
      return `${b} 排队`;
    }
    const raw = v.split('.').reduce((o, k) => (o ? o[k] : undefined), m);
    if (raw === undefined || raw === null) return '';
    if (v === 'l0.disk_bytes' || v === 'l0.bytes') return fmtBytes(raw);
    if (v === 'l0.last_received') return fmtAge((Date.now() - Date.parse(raw)) / 60000) || '—';
    if (v === 'health.llm' || v === 'health.embedding') {
      if (raw === null) return '未启用';
      return raw ? '正常' : '不可用';
    }
    if (typeof raw === 'number') return `${nf.format(raw)} ${node.metricLabel || ''}`.trim();
    return String(raw);
  }

  function updateMetrics(m) {
    for (const n of graph.nodes) {
      const el = els.get(n.id);
      if (!el) continue;
      const text = n.kind === 'device' && n.device
        ? `${nf.format(n.device.records || 0)} 条 · ${n.device.sessions || 0} 会话`
        : metricText(n, m);
      const box = el.querySelector('.nlabel__metric');
      if (text) {
        box.textContent = text;
        el.classList.add('has-metric');
      } else {
        el.classList.remove('has-metric');
      }
    }
    // 文案变了 → 尺寸也变了，下一帧重量一次
    requestAnimationFrame(measure);
  }

  return { update, setHot, setSelected, setDim, updateMetrics, measure, els, dump: () => lastDump };
}
