/**
 * 记忆星图入口。
 *
 * 职责：把「遥测快照 → 图形状态 → WebGL 绘制」串起来，并处理交互。
 * 每帧只做三件事：推进相机、更新数据包位置、投影标签位置；
 * 节点与线路的几何只在状态签名变化时重建（遥测 5s 一次，交互即时）。
 */

import { buildGraph, nodeSize } from './graph.js';
import { createRenderer } from './renderer.js';
import { createTelemetry } from './telemetry.js';
import { createHud } from './ui/hud.js';
import { createLabels } from './ui/labels.js';
import { createInspector } from './ui/inspector.js';
import { createTrace } from './ui/trace.js';
import { TRACES } from './topology.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 启动日志
const bootLog = $('boot-log');
const BOOT_LINES = [
  '初始化渲染管线…',
  '编译 GLSL · 星云 / 环带 / 数据包 / Bloom…',
  '装载记忆拓扑 · L0 → L1 → L2 → L3…',
  '连接遥测通道…',
];
let bootIdx = 0;
function bootStep(text) {
  if (text) bootLog.textContent = text;
  else if (bootIdx < BOOT_LINES.length) bootLog.textContent = BOOT_LINES[bootIdx++];
}

function fatal(msg) {
  $('boot').classList.add('is-done');
  $('fatal-msg').textContent = msg || '';
  $('fatal').hidden = false;
}

// ---------------------------------------------------------------- 初始化
const canvas = $('gl');
let graph = null;
let renderer = null;
let hud = null;
let labels = null;
let inspector = null;
let trace = null;
let telemetry = null;

let model = {
  live: false,
  demo: true,
  authRequired: false,
  healthLive: false,
  health: {},
  stats: {},
  l0: { devices_list: [] },
  l1: {},
  events: {},
  derived: {},
};

let hoverId = null;
let selectedId = null;
let soloRing = null;
let traceState = null;

// 重绘标记与状态签名：几何只在签名变化时重建（见 syncScene）。
// 必须声明在 start() 之前——start() 里会调用 onResize → markDirty，
// 放到文件后半段会踩 TDZ（Cannot access 'dirty' before initialization）。
let dirty = true;
let lastSig = '';
function markDirty() { dirty = true; }

window.__atlasStarted = true;

try {
  renderer = createRenderer(canvas, {
    onContextLost: () => fatal('WebGL 上下文丢失（通常是显卡驱动重置或显存不足）。刷新页面即可恢复。'),
  });
  if (!renderer) {
    fatal('当前浏览器/设备不支持 WebGL2。');
  } else {
    start();
  }
} catch (e) {
  // 顶层兜底：初始化中途抛错时，不能只留一个不动的启动遮罩
  console.error(e);
  fatal(String((e && e.stack) || e));
}

function start() {
  graph = buildGraph(model.l0?.devices_list || []);

  hud = createHud({
    graph,
    onLegendSolo: (ring) => setSolo(ring),
  });

  labels = createLabels(graph, {
    onSelect: (id) => select(id),
    onHover: (id) => setHover(id),
    onRingClick: (rid) => setSolo(soloRing === rid ? null : rid),
  });

  inspector = createInspector(graph, {
    onSelect: (id) => select(id),
    onRequestClose: () => select(null),
  });

  trace = createTrace({
    graph,
    onState: (st) => {
      traceState = st;
      markDirty();
    },
    onEnd: () => {
      document.querySelectorAll('#trace-actions button').forEach((b) => b.classList.remove('is-on'));
      log('info', '追踪结束');
    },
    log: (lv, t) => log(lv, t),
  });

  telemetry = createTelemetry(onModel);

  bindPointer();
  bindKeys();
  bindDock();

  window.addEventListener('resize', onResize);
  onResize();

  // 开场：从略微拉远处缓缓推近。
  // 兜底：后台标签页里 rAF 可能被节流到几乎不触发，若只靠缓动，用户切回来时
  // 会看到一个放大且裁切的画面——所以 2 秒后无条件落到目标缩放。
  renderer.cam.zoom = renderer.fitZoom() * 1.3;
  renderer.cam.targetZoom = renderer.fitZoom();
  renderer.applyFraming();
  setTimeout(() => {
    renderer.cam.zoom = renderer.cam.targetZoom;
    renderer.applyFraming();
    markDirty();
  }, 2000);

  const t0 = Date.now();
  bootStep();
  const bootTimer = setInterval(() => {
    bootStep();
    if (Date.now() - t0 > 1500) {
      clearInterval(bootTimer);
      $('boot').classList.add('is-done');
      log('ok', `星图就绪 · ${graph.nodes.length} 个模块 / ${graph.links.length} 条线路`);
      log('info', '按住拖拽平移 · 滚轮缩放 · 点击模块看详情');
      setTimeout(() => log('info', '试试底部「链路追踪」：把一次请求的走法演一遍'), 1600);
    }
  }, 380);

  telemetry.start();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- 遥测回调
function onModel(m) {
  const prevDevices = (model.l0?.devices_list || []).length;
  const nextDevices = (m.l0?.devices_list || []).length;
  model = m;

  // 设备增减会改变拓扑（节点数变了），需要重建整个图
  if (nextDevices !== prevDevices) {
    rebuildGraph(m.l0?.devices_list || []);
  }

  hud.renderMetrics(m);
  labels.updateMetrics(m);
  inspector.refresh(m);
  syncTint();
  markDirty();

  if (!m.live && m.authRequired && !onModel._notified) {
    onModel._notified = true;
    log('warn', '未登录：当前为演示数据 —— 访问 /auth/login?next=/ 登录后接实时');
  }
  if (m.live && !onModel._liveLogged) {
    onModel._liveLogged = true;
    log('ok', `已接入实时遥测 · 记忆 ${m.stats?.memories ?? 0} 条 / L0 ${m.l0?.records ?? 0} 条`);
  }
}

function rebuildGraph(devices) {
  // 原地替换图数据：inspector / trace / hud 都持有同一个 graph 引用，
  // 换新对象会让它们指向旧图（设备增减后表现不一致）
  Object.assign(graph, buildGraph(devices));
  $('labels').innerHTML = '';
  labels = createLabels(graph, {
    onSelect: (id) => select(id),
    onHover: (id) => setHover(id),
    onRingClick: (rid) => setSolo(soloRing === rid ? null : rid),
  });
  labels.updateMetrics(model);
  markDirty();
  log('info', `设备清单变化：重建拓扑（${devices.length} 台设备）`);
}

/** 层级聚焦：HUD 图例与环带徽标共用同一条路径，两处高亮始终一致 */
function setSolo(ring) {
  soloRing = ring || null;
  hud.setSolo(soloRing);
  log('info', soloRing ? `聚焦层级：${soloRing.toUpperCase()}` : '显示全部层级');
  markDirty();
}

function log(level, text) { hud.log(level, text); }

// ---------------------------------------------------------------- 状态与重绘

/** 把「悬停 / 选中 / 层级聚焦 / 追踪 / 健康异常」合成节点状态表 */
function computeStates() {
  const s = new Map();
  const set = (id, v) => { if (s.get(id) !== 'error') s.set(id, v); };

  if (model.healthLive) {
    if (model.health.db === false) s.set('core', 'error');
    if (model.health.llm === false) s.set('llm', 'error');
    if (model.health.embedding === false) s.set('emb', 'error');
  }

  if (soloRing) {
    for (const n of graph.nodes) {
      const inRing = soloRing === 'ext'
        ? n.ring === 'ext' || n.kind === 'actor' || n.kind === 'device'
        : n.ring === soloRing;
      if (!inRing) set(n.id, 'dim');
    }
  }

  if (traceState && traceState.active) {
    for (const n of graph.nodes) {
      const inStep = traceState.nodes.has(n.id);
      const inFlow = traceState.links.size
        ? [...traceState.links].some((k) => k.startsWith(`${n.id}→`) || k.endsWith(`→${n.id}`))
        : false;
      set(n.id, inStep ? 'active' : inFlow ? 'idle' : 'dim');
    }
  }

  if (hoverId) set(hoverId, 'active');
  if (selectedId) set(selectedId, 'active');
  return s;
}

/** 高亮 / 压暗的线路集合 */
function computeLinks() {
  const hot = new Set();
  const dim = new Set();

  if (traceState && traceState.active) {
    for (const k of traceState.links) hot.add(k);
    for (const k of traceState.dimLinks) dim.add(k);
  }

  const focus = hoverId || selectedId;
  if (focus && !(traceState && traceState.active)) {
    for (const l of graph.links) {
      if (l.from === focus || l.to === focus) hot.add(`${l.from}→${l.to}`);
    }
  }
  return { hot, dim };
}

function syncTint() {
  const h = model.health || {};
  const bad = h.llm === false || h.embedding === false || h.db === false;
  const off = h.llm === null && h.embedding === null;
  const target = bad
    ? { tint: [0.42, 0.20, 0.14], accent: [0.55, 0.14, 0.30] }
    : off
      ? { tint: [0.16, 0.20, 0.42], accent: [0.30, 0.22, 0.62] }
      : { tint: [0.15, 0.25, 0.58], accent: [0.40, 0.24, 0.74] };
  renderer.state.tintTarget = target.tint;
  renderer.state.accentTarget = target.accent;
}

function syncScene() {
  const states = computeStates();
  const { hot, dim } = computeLinks();
  const sig = JSON.stringify([
    [...states.entries()].sort(),
    [...hot].sort(),
    [...dim].sort(),
    model.live,
    model.derived?.ingest?.toFixed?.(2),
    model.derived?.l1?.toFixed?.(2),
    model.derived?.remember?.toFixed?.(2),
  ]);
  if (sig !== lastSig) {
    lastSig = sig;
    renderer.rebuildNodes(graph, states);
    renderer.rebuildLines(graph, model.derived, hot, dim);
  }
  renderer._hot = hot;
  renderer._dim = dim;
}

// ---------------------------------------------------------------- 主循环
let last = performance.now();

/**
 * 一帧的全部工作。
 * 与 requestAnimationFrame 解耦：自动化验收与调试可以直接调 __atlas.tick()，
 * 不依赖 rAF（后台标签页里 rAF 会被节流到几乎不跑）。
 */
function frame(dt) {
  // 缩放比变化（窗口拖到不同 DPI 的显示器、浏览器缩放）→ 重建画布。
  // 相机是 CSS 像素口径，所以构图不会因为 dpr 变化而跳。
  if (Math.min(window.devicePixelRatio || 1, 2) !== renderer.size.dpr) onResize();

  if (dirty) { dirty = false; syncScene(); }

  // 相机缓动
  const cam = renderer.cam;
  cam.zoom += (cam.targetZoom - cam.zoom) * Math.min(1, dt * 6);
  renderer.applyFraming();

  // 星云配色缓动到目标（健康度变化时天空变色）
  const st = renderer.state;
  if (st.tintTarget) {
    for (let i = 0; i < 3; i++) st.tint[i] += (st.tintTarget[i] - st.tint[i]) * Math.min(1, dt * 1.6);
  }
  if (st.accentTarget) {
    for (let i = 0; i < 3; i++) st.accent[i] += (st.accentTarget[i] - st.accent[i]) * Math.min(1, dt * 1.6);
  }
  const d = model.derived || {};
  const energyTarget = 0.32 + 0.55 * Math.max(d.ingest || 0, d.l1 || 0, d.remember || 0);
  st.energy += (energyTarget - st.energy) * Math.min(1, dt * 1.2);

  renderer.render(dt, graph, model.derived, renderer._hot, renderer._dim);

  labels.update(
    (x, y, rect) => renderer.project(x, y, rect),
    cam,
    window.innerWidth,
    window.innerHeight,
  );
}

function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frame(dt);
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- 交互
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.resize(w, h);

  // 安全区：扣掉顶栏、左侧图例、底部日志与操作坞占用的位置，
  // 让图形主体落在真正空着的那块区域中央
  const padTop = 92;
  const padBottom = w > 900 ? 152 : 96;
  const padLeft = w > 1180 ? 268 : 20;
  const padRight = 20;
  const aw = Math.max(240, w - padLeft - padRight);
  const ah = Math.max(240, h - padTop - padBottom);
  renderer.setSafeArea({
    cx: (padLeft + aw / 2) / w,
    cy: (padTop + ah / 2) / h,
    w: aw / w,
    h: ah / h,
  });

  if (!renderer._fitted) {
    renderer.cam.zoom = renderer.fitZoom();
    renderer._fitted = true;
  }
  renderer.cam.targetZoom = clampZoom(renderer.cam.targetZoom);
  renderer.applyFraming();
  document.body.classList.toggle('zoomed-out', renderer.cam.zoom < renderer.fitZoom() * 0.68);
  markDirty();
}

function clampZoom(z) {
  const f = renderer.fitZoom();
  return Math.max(f * 0.42, Math.min(f * 3.2, z));
}

/** 屏幕坐标（CSS 像素）→ 世界坐标 */
function toWorld(sx, sy) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return {
    x: (sx - w / 2) / renderer.cam.zoom + renderer.cam.x,
    y: -(sy - h / 2) / renderer.cam.zoom + renderer.cam.y,
  };
}

function hitTest(sx, sy) {
  const w = toWorld(sx, sy);
  const slop = 12 / renderer.cam.zoom; // 12 CSS px 的宽容度，换算成世界单位
  let best = null;
  let bestD = Infinity;
  for (const n of graph.nodes) {
    const d = Math.hypot(n.x - w.x, n.y - w.y);
    const r = nodeSize(n.kind) + slop;
    if (d < r && d < bestD) { bestD = d; best = n; }
  }
  return best;
}

function setHover(id) {
  if (hoverId === id) return;
  hoverId = id;
  labels.setHot(id);
  markDirty();
}

function select(id) {
  if (id === selectedId) return; // 同时挡住 null→null，避免与 inspector.close() 互调
  selectedId = id;
  labels.setSelected(id);
  if (id) {
    inspector.open(id);
    const n = graph.byId.get(id);
    log('info', `检视：${n ? n.label : id}`);
  } else {
    inspector.close();
  }
  markDirty();
}

function bindPointer() {
  const stage = $('stage');
  let down = false;
  let moved = 0;
  let lastX = 0;
  let lastY = 0;
  let onLabel = false; // 指针按下时落在标签上 → 交给标签自行处理，不启动平移

  if (!window.matchMedia('(hover: hover)').matches) {
    document.body.classList.add('touch');
  }

  stage.addEventListener('pointerdown', (e) => {
    // 标签与环带徽标自带交互（选中 / 层级聚焦），不能当成画布拖拽的起点
    onLabel = !!(e.target.closest && e.target.closest('.nlabel__box, .ringbadge__box'));
    if (onLabel) {
      const label = e.target.closest('.nlabel');
      if (label) {
        const id = label.dataset.id;
        select(selectedId === id ? null : id);
      }
      return;
    }
    down = true;
    moved = 0;
    lastX = e.clientX;
    lastY = e.clientY;
    stage.setPointerCapture(e.pointerId);
  });

  stage.addEventListener('pointermove', (e) => {
    if (onLabel) return;
    if (down) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX;
      lastY = e.clientY;
      if (moved > 4) {
        renderer.cam.panX -= dx / renderer.cam.zoom;
        renderer.cam.panY += dy / renderer.cam.zoom;
        renderer.applyFraming();
        markDirty();
      }
    } else {
      const lbl = e.target.closest && e.target.closest('.nlabel');
      const n = lbl ? graph.byId.get(lbl.dataset.id) : hitTest(e.clientX, e.clientY);
      setHover(n ? n.id : null);
    }
    // 星云视差
    renderer.state.mouse[0] = (e.clientX / window.innerWidth) * 2 - 1;
    renderer.state.mouse[1] = -((e.clientY / window.innerHeight) * 2 - 1);
  });

  const end = (e) => {
    if (onLabel) { onLabel = false; return; }
    if (!down) return;
    down = false;
    if (moved <= 4) {
      const n = hitTest(e.clientX, e.clientY);
      select(n ? n.id : null);
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', () => { down = false; onLabel = false; });

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const before = toWorld(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.0016);
    renderer.cam.targetZoom = clampZoom(renderer.cam.targetZoom * factor);
    renderer.cam.zoom = clampZoom(renderer.cam.zoom * factor);
    renderer.applyFraming();
    const after = toWorld(e.clientX, e.clientY);
    // 以光标为锚点缩放：把光标下的世界点拉回原处
    renderer.cam.panX += before.x - after.x;
    renderer.cam.panY += before.y - after.y;
    renderer.applyFraming();
    document.body.classList.toggle('zoomed-out', renderer.cam.zoom < renderer.fitZoom() * 0.68);
    document.body.classList.toggle('zoomed-way-out', renderer.cam.zoom < renderer.fitZoom() * 0.46);
    markDirty();
  }, { passive: false });

  stage.addEventListener('dblclick', resetView);
}

function resetView() {
  renderer.cam.panX = 0;
  renderer.cam.panY = 0;
  renderer.cam.targetZoom = renderer.fitZoom();
  renderer.applyFraming();
  document.body.classList.remove('zoomed-out', 'zoomed-way-out');
  markDirty();
  log('info', '视角已复位');
}

function bindDock() {
  document.querySelectorAll('#trace-actions button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.trace;
      document.querySelectorAll('#trace-actions button').forEach((b) => b.classList.toggle('is-on', b === btn));
      trace.start(id);
      const t = TRACES.find((x) => x.id === id);
      log('ok', `开始追踪：${t ? t.name : id}`);
    });
  });
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (e.key === 'r' || e.key === 'R') { resetView(); return; }
    if (e.key === 'p' || e.key === 'P') {
      renderer.state.paused = !renderer.state.paused;
      log('info', renderer.state.paused ? '动画已暂停' : '动画已恢复');
      return;
    }
    if (e.key === '1') trace.start('ingest');
    if (e.key === '2') trace.start('remember');
    if (e.key === '3') trace.start('recall');
    if (e.key === 'Escape' && !trace.active) select(null);
  });
}

/**
 * 调试钩子：图形/相机/遥测的内部状态。
 * 出问题时在控制台 `__atlas.camera()` 一眼看到是缩放错了还是数据没到；
 * 自动化验收脚本也靠它读状态，避免去猜 DOM。
 */
window.__atlas = {
  get graph() { return graph; },
  get renderer() { return renderer; },
  get model() { return model; },
  camera: () => ({
    zoom: renderer.cam.zoom,
    targetZoom: renderer.cam.targetZoom,
    fitZoom: renderer.fitZoom(),
    panX: renderer.cam.panX,
    panY: renderer.cam.panY,
    dpr: renderer.size.dpr,
    W: renderer.size.W,
    H: renderer.size.H,
  }),
  /** 标签布局模型 vs DOM 实测坐标对比（验收用） */
  layoutDump: () => {
    const dom = {};
    document.querySelectorAll('.nlabel__box, .ringbadge__box').forEach((e) => {
      const id = e.closest('.nlabel') ? e.closest('.nlabel').dataset.id : 'badge:' + e.closest('.ringbadge').dataset.ring;
      const r = e.getBoundingClientRect();
      dom[id] = { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return labels.dump().map((m) => ({ ...m, dom: dom[m.id] || null }));
  },
  /** 重测标签尺寸后立即重排（验收脚本用：正常运行时这笔由 rAF 触发） */
  remeasure: () => {
    labels.measure();
    markDirty();
    frame(1 / 60);
    return true;
  },
  /** 当前追踪步的高亮集合（验收用） */
  trace: () => ({
    active: !!(traceState && traceState.active),
    nodes: traceState ? [...traceState.nodes] : [],
    links: traceState ? [...traceState.links] : [],
    hot: [...(renderer._hot || [])],
  }),
  /** 手动推进 n 帧（与 rAF 无关，验收脚本用） */
  tick: (n = 1) => {
    for (let i = 0; i < n; i++) frame(1 / 60);
    last = performance.now();
    return { zoom: renderer.cam.zoom, time: renderer.state.time };
  },
  /** 标签重叠检测：返回重叠对（验收排版用） */
  labelOverlaps: () => {
    const boxes = Array.from(document.querySelectorAll('.nlabel__box, .ringbadge__box'))
      .filter((e) => {
        const host = e.closest('.nlabel');
        return !host || host.style.display !== 'none';
      })
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { t: e.textContent.trim().slice(0, 16), x: r.x, y: r.y, w: r.width, h: r.height };
      });
    const hits = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 2 && oy > 2) hits.push(`${a.t} × ${b.t} (${Math.round(ox)}×${Math.round(oy)})`);
      }
    }
    return { boxes: boxes.length, overlaps: hits };
  },
};
