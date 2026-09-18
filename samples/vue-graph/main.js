'use strict';
/**
 * 前端样例：Vue 3 响应式图谱（多框架对照用，非生产前端）。
 * 与 atlas 同一份拓扑事实源（/js/topology.js），用 Vue 的响应式模型驱动 SVG 渲染：
 * 遥测轮询 → reactive model → 计算属性过滤/映射 → 模板渲染，交互（悬停/聚焦/检视）全走声明式绑定。
 */
import { createApp, reactive, computed } from '/samples/lib/vue.esm-browser.prod.js';
import { NODES, LINKS, RINGS } from '/js/topology.js';

const RING_COLOR = { l0: '#38bdf8', l1: '#60a5fa', l2: '#5eead4', l3: '#8b9dc3', edge: '#22d3ee' };

// ---------------------------------------------------------------- 遥测（含演示兜底）
const demo = {
  stats: { memories: 1284 }, keys: { active: 3 },
  l1: { total: 129, done: 118, backlog: 7 }, events: { pending: 2 },
  l0: { records: 53528, disk_bytes: 231735296, batches: 742 },
  l3: { active: 9 },
};

const state = reactive({
  model: demo,
  live: false,
  hover: null,
  focus: null,      // null = 全部层级
  selected: null,   // 检视面板的节点
});

async function poll() {
  try {
    const r = await fetch('/api/atlas/overview', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(r.status);
    Object.assign(state.model, await r.json());
    state.live = true;
  } catch { state.live = false; }
}

function metricOf(node) {
  if (!node.metric) return null;
  const v = node.metric.split('.').reduce((o, k) => (o == null ? o : o[k]), state.model);
  return v == null ? null : v;
}
const fmt = (v) => typeof v === 'number' ? v.toLocaleString('zh-CN') : v;

// ---------------------------------------------------------------- 极坐标 → SVG 坐标
const C = 500; // viewBox 中心
const pos = (n) => {
  const a = (n.angle - 90) * Math.PI / 180; // 90° 朝上
  return { x: C + Math.cos(a) * n.radius, y: C + Math.sin(a) * n.radius };
};
const nodes = NODES.map((n) => ({ ...n, ...pos(n), ringColor: RING_COLOR[n.ring] || '#22d3ee' }));
const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
const links = LINKS
  .map((l) => {
    const a = byId[l.from]; const b = byId[l.to];
    if (!a || !b) return null;
    const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
    const dx = mx - C; const dy = my - C;
    const len = Math.hypot(dx, dy) || 1;
    const bow = (l.bow || 0) * 1.2;
    const cx = mx + (-dy / len) * bow; const cy = my + (dx / len) * bow;
    return { ...l, x1: a.x, y1: a.y, x2: b.x, y2: b.y, cx, cy };
  })
  .filter(Boolean);

// ---------------------------------------------------------------- 应用
const app = {
  setup() {
    const visibleNodes = computed(() => (state.focus ? nodes.filter((n) => n.ring === state.focus) : nodes));
    const isDim = (n) => state.focus && n.ring !== state.focus;
    const linkHot = (l) => state.hover && (l.from === state.hover || l.to === state.hover);
    const detail = computed(() => (state.selected ? byId[state.selected] : null));
    const detailMetric = computed(() => (detail.value ? metricOf(detail.value) : null));
    return {
      state, RINGS, RING_COLOR, links, fmt,
      visibleNodes, isDim, linkHot, detail, detailMetric, metricOf,
      setFocus: (id) => { state.focus = state.focus === id ? null : id; },
      pick: (id) => { state.selected = id; },
    };
  },
  template: `
  <header>
    <b>aimemory · 图谱</b>
    <span class="badge" :class="{ demo: !state.live }">{{ state.live ? '实时数据' : '演示数据' }}</span>
    <span style="color:#7d8fb0;font-size:12px">Vue 3 · 样例（对比用）</span>
    <a href="/">← 返回星图</a>
  </header>
  <div style="position:relative">
    <svg viewBox="0 0 1000 1000">
      <circle v-for="r in RINGS" :key="r.id" class="ring"
        :cx="500" :cy="500" :r="r.radius"
        :stroke="RING_COLOR[r.id]" :stroke-opacity="state.focus && state.focus !== r.id ? .12 : .45"
        :stroke-dasharray="r.dash ? '10 8' : 'none'" />
      <path v-for="l in links" :key="l.from + l.to" class="link" :class="{ hot: linkHot(l) }"
        :d="'M ' + l.x1 + ' ' + l.y1 + ' Q ' + l.cx + ' ' + l.cy + ' ' + l.x2 + ' ' + l.y2" />
      <g v-for="n in visibleNodes" :key="n.id" class="node" :class="{ dim: isDim(n) }"
        @mouseenter="state.hover = n.id" @mouseleave="state.hover = null" @click="pick(n.id)">
        <circle :cx="n.x" :cy="n.y" :r="state.hover === n.id ? 9 : 6" :fill="n.ringColor" fill-opacity=".9" />
        <text :x="n.x + 12" :y="n.y + 4">{{ n.label }}</text>
        <text v-if="metricOf(n) !== null" :x="n.x + 12" :y="n.y + 18"
          style="fill:#7dd3fc;font-size:10px;font-family:monospace">{{ fmt(metricOf(n)) }} {{ n.metricLabel || '' }}</text>
      </g>
    </svg>
  </div>
  <aside class="panel">
    <h4>层级聚焦</h4>
    <div class="layers">
      <button v-for="r in RINGS" :key="r.id" :class="{ on: state.focus === r.id }" @click="setFocus(r.id)">
        {{ r.label }} {{ r.name }}
      </button>
    </div>
    <template v-if="detail">
      <h2>{{ detail.label }}</h2>
      <div class="sub">{{ detail.sub || detail.id }}</div>
      <div class="metric" v-if="detailMetric !== null">{{ fmt(detailMetric) }} <small style="font-size:12px">{{ detail.metricLabel || '' }}</small></div>
      <template v-if="detail.info">
        <h4>职责</h4><div class="kv">{{ detail.info.role }}</div>
        <h4>关键参数</h4>
        <div class="kv" v-for="kv in detail.info.params || []" :key="kv[0]">· {{ kv[0] }}：{{ kv[1] }}</div>
        <h4>接口</h4>
        <li v-for="e in detail.info.endpoints || []" :key="e">{{ e }}</li>
        <div class="kv" v-if="!(detail.info.endpoints || []).length" style="color:#66799a">（无）</div>
      </template>
    </template>
    <div v-else class="kv" style="color:#66799a">点击任意节点查看职责 / 参数 / 接口。</div>
  </aside>`,
};

createApp(app).mount('#app');
poll();
setInterval(poll, 5000);
