/**
 * 链路追踪：把「一次请求到底走了哪些模块」逐跳演出来。
 *
 * 追踪期间，非当前步的节点与线路会被压暗，配合底部解说条，
 * 目的是让人不用读架构文档也能看懂数据怎么流。
 */

import { TRACES } from '../topology.js';

const STEP_MS = 4600;

export function createTrace({ graph, onState, onEnd, log }) {
  const bar = document.getElementById('tracebar');
  const nameEl = document.getElementById('trace-name');
  const stepEl = document.getElementById('trace-step');
  const titleEl = document.getElementById('trace-title');
  const detailEl = document.getElementById('trace-detail');
  const progressEl = document.getElementById('trace-progress');
  const toggleBtn = document.getElementById('trace-toggle');

  let trace = null;
  let idx = 0;
  let paused = false;
  let raf = 0;
  let stepElapsed = 0; // 当前步已播放时长（暂停时不增长）
  let lastNow = 0;

  /** 把 topology 里的占位 id 解析成实际存在的节点（设备是运行时生成的） */
  function resolveId(id) {
    if (graph.byId.has(id)) return id;
    if (id.startsWith('device:')) {
      const first = graph.nodes.find((n) => n.kind === 'device');
      return first ? first.id : null;
    }
    return null;
  }

  function apply() {
    const step = trace.steps[idx];
    const nodes = new Set();
    for (const raw of step.nodes || []) {
      const id = resolveId(raw);
      if (id) nodes.add(id);
    }
    const links = new Set();
    for (const raw of step.links || []) {
      const [a, b] = raw.split('→');
      const fa = resolveId(a);
      const fb = resolveId(b);
      if (fa && fb) links.add(`${fa}→${fb}`);
    }

    const dimNodes = new Set(graph.nodes.filter((n) => !nodes.has(n.id)).map((n) => n.id));
    const dimLinks = new Set(
      graph.links.filter((l) => !links.has(`${l.from}→${l.to}`)).map((l) => `${l.from}→${l.to}`)
    );

    nameEl.textContent = trace.name;
    stepEl.textContent = `${idx + 1} / ${trace.steps.length}`;
    titleEl.textContent = step.title;
    detailEl.textContent = step.detail;
    bar.style.setProperty('--tc', trace.accent);

    onState({ nodes, links, dimNodes, dimLinks, accent: trace.accent, active: true });

    if (step.log !== false) log('flow', `追踪 · ${step.title}`);
  }

  function tickProgress(now) {
    if (!trace) return;
    if (lastNow && !paused) stepElapsed += now - lastNow;
    lastNow = now;
    const p = Math.min(1, stepElapsed / STEP_MS);
    progressEl.style.width = `${p * 100}%`;
    if (p >= 1 && !paused && idx < trace.steps.length - 1) next();
    raf = requestAnimationFrame(tickProgress);
  }

  function resetStepTimer() {
    stepElapsed = 0;
    lastNow = 0;
  }

  function start(id) {
    const t = TRACES.find((x) => x.id === id);
    if (!t) return;
    stopLoop();
    trace = t;
    idx = 0;
    paused = false;
    resetStepTimer();
    toggleBtn.textContent = '暂停';
    bar.hidden = false;
    apply();
    raf = requestAnimationFrame(tickProgress);
  }

  function next() {
    if (!trace || idx >= trace.steps.length - 1) return;
    idx += 1;
    resetStepTimer();
    apply();
  }

  function prev() {
    if (!trace || idx <= 0) return;
    idx -= 1;
    resetStepTimer();
    apply();
  }

  function toggle() {
    if (!trace) return;
    paused = !paused;
    lastNow = 0; // 暂停/续播都从当前帧重新计时，避免把暂停时长补进来
    toggleBtn.textContent = paused ? '继续' : '暂停';
  }

  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function exit() {
    stopLoop();
    trace = null;
    paused = false;
    bar.hidden = true;
    onState(null);
    onEnd && onEnd();
  }

  bar.querySelector('[data-act="next"]').addEventListener('click', next);
  bar.querySelector('[data-act="prev"]').addEventListener('click', prev);
  bar.querySelector('[data-act="toggle"]').addEventListener('click', toggle);
  bar.querySelector('[data-act="exit"]').addEventListener('click', exit);

  document.addEventListener('keydown', (e) => {
    if (!trace) return;
    if (e.key === 'ArrowRight') { next(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { prev(); e.preventDefault(); }
    else if (e.key === ' ') { toggle(); e.preventDefault(); }
    else if (e.key === 'Escape') { exit(); }
  });

  return { start, next, prev, toggle, exit, get active() { return !!trace; }, get paused() { return paused; } };
}
