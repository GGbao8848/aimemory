'use strict';
/**
 * 前端样例：Three.js 3D 星系（多框架对照用，非生产前端）。
 * 四层记忆铺成 3D 同心环，线路为贝塞尔弧线；拖拽旋转、滚轮缩放、悬停看节点；
 * 遥测来自 /api/atlas/overview + /healthz（未登录自动切演示数据）。
 * 拓扑事实源直接复用 atlas 的 /js/topology.js——同源引用，不另抄一份数据。
 */
import * as THREE from '/samples/lib/three.module.js';
import { NODES, LINKS, RINGS } from '/js/topology.js';

const RING_COLOR = { l0: 0x38bdf8, l1: 0x60a5fa, l2: 0x5eead4, l3: 0x8b9dc3, edge: 0x22d3ee };
const SCALE = 1 / 100;           // topology 的 radius(96~380) → 3D 半径 0.96~3.8
const demoMetrics = { 'stats.memories': 1284, 'l1.total': 129, 'l0.records': 53528, 'l3.active': 9 };

// ---------------------------------------------------------------- 遥测（含演示兜底）
const state = { live: false, metrics: { ...demoMetrics }, health: { llm: true, embedding: true, db: true } };

function metricOf(node) {
  if (!node.metric) return null;
  const v = node.metric.split('.').reduce((o, k) => (o == null ? o : o[k]), state.metrics);
  return v == null ? null : v;
}

async function poll() {
  try {
    const r = await fetch('/api/atlas/overview', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    state.metrics = {
      'stats.memories': d.stats?.memories,
      'stats.keys': d.keys?.active,
      'l1.total': d.l1?.total, 'l1.done': d.l1?.done, 'l1.backlog': d.l1?.backlog,
      'l0.records': d.l0?.records, 'l0.disk_bytes': d.l0?.disk_bytes, 'l0.batches': d.l0?.batches,
      'events.pending': d.events?.pending,
      'l3.active': d.l3?.active,
    };
    state.live = true;
  } catch {
    state.live = false; // 演示数据兜底
  }
  try {
    const h = await (await fetch('/healthz')).json();
    state.health = { llm: h.llm !== 'disabled' && h.llm !== false, embedding: h.embedding === 'disabled' ? null : h.embedding !== false, db: h.db !== false };
  } catch { /* 保持原值 */ }
  const badge = document.getElementById('badge');
  badge.textContent = state.live ? '实时数据' : '演示数据';
  badge.classList.toggle('demo', !state.live);
}

// ---------------------------------------------------------------- 场景
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04060c);
scene.fog = new THREE.Fog(0x04060c, 9, 18);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);

// 手动轨道相机（不引 OrbitControls，样例保持单文件依赖）
const orbit = { theta: 0.9, phi: 1.05, radius: 7.2, target: new THREE.Vector3(0, 0, 0) };
function applyCamera() {
  camera.position.set(
    orbit.target.x + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta),
    orbit.target.y + orbit.radius * Math.cos(orbit.phi),
    orbit.target.z + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
  );
  camera.lookAt(orbit.target);
}

function ringColor(id) { return new THREE.Color(RING_COLOR[id] || 0x22d3ee); }

// 环：细线圆
const ringGroup = new THREE.Group();
for (const ring of RINGS) {
  const pts = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * ring.radius * SCALE, 0, Math.sin(a) * ring.radius * SCALE));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: ringColor(ring.id), transparent: true, opacity: 0.5 }));
  line.userData.ring = ring.id;
  ringGroup.add(line);
}
scene.add(ringGroup);

// 节点：球体 + 外圈辉光（用稍大的透明壳近似）
const nodeMeshes = new Map();
const nodeGroup = new THREE.Group();
const sphereGeo = new THREE.SphereGeometry(0.055, 20, 14);
for (const n of NODES) {
  const a = (n.angle * Math.PI) / 180;
  const r = n.radius * SCALE;
  const pos = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
  const color = ringColor(n.ring);
  const mesh = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({ color }));
  mesh.position.copy(pos);
  mesh.userData.node = n;
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 16, 12),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16 }),
  );
  mesh.add(halo);
  nodeGroup.add(mesh);
  nodeMeshes.set(n.id, mesh);
}
// 记忆内核：中心八面体
const core = new THREE.Mesh(
  new THREE.OctahedronGeometry(0.16),
  new THREE.MeshBasicMaterial({ color: 0xbfe3ff, wireframe: true }),
);
core.position.set(0, 0, 0);
core.userData.node = { id: 'core', label: '记忆内核', sub: 'SQLite · data/aimemory.db', metric: 'stats.memories', metricLabel: '条' };
nodeGroup.add(core);
nodeMeshes.set('core', core);
scene.add(nodeGroup);

// 线路：贝塞尔弧线（中点抬高，避免全压在平面上）
const linkGroup = new THREE.Group();
const byId = new Map(NODES.map((n) => [n.id, n]));
function posOf(id) {
  const n = byId.get(id);
  if (!n) return null;
  const a = (n.angle * Math.PI) / 180;
  const r = n.radius * SCALE;
  return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
}
for (const l of LINKS) {
  const from = posOf(l.from);
  const to = posOf(l.to);
  if (!from || !to) continue;
  const mid = from.clone().add(to).multiplyScalar(0.5);
  mid.y += 0.12 + from.distanceTo(to) * 0.08;
  const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
  const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(24));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
    color: 0x6fb4ff, transparent: true, opacity: l.kind === 'pending' ? 0.08 : 0.16,
  }));
  linkGroup.add(line);
}
scene.add(linkGroup);

// ---------------------------------------------------------------- 交互：轨道 + 悬停
let dragging = false;
let px = 0; let py = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; px = e.clientX; py = e.clientY; });
addEventListener('pointerup', () => { dragging = false; });
addEventListener('pointermove', (e) => {
  if (dragging) {
    orbit.theta -= (e.clientX - px) * 0.005;
    orbit.phi = Math.max(0.25, Math.min(1.45, orbit.phi - (e.clientY - py) * 0.004));
    px = e.clientX; py = e.clientY;
    applyCamera();
  }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbit.radius = Math.max(2.6, Math.min(14, orbit.radius * Math.exp(e.deltaY * 0.001)));
  applyCamera();
}, { passive: false });

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const tip = document.getElementById('tip');
let hoverMesh = null;
canvas.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(nodeGroup.children, false)[0];
  hoverMesh = hit ? hit.object : null;
  if (hoverMesh && hoverMesh.userData.node) {
    const n = hoverMesh.userData.node;
    const v = metricOf(n);
    tip.hidden = false;
    tip.style.left = `${e.clientX + 14}px`;
    tip.style.top = `${e.clientY + 12}px`;
    tip.innerHTML = `<b>${n.label || n.name || n.id}</b>`
      + (n.sub ? `<div class="sub">${n.sub}</div>` : '')
      + (v != null ? `<div>${typeof v === 'number' ? v.toLocaleString('zh-CN') : v} ${n.metricLabel || ''}</div>` : '');
  } else {
    tip.hidden = true;
  }
});

// ---------------------------------------------------------------- 图例
const legend = document.getElementById('legend');
for (const ring of RINGS) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<span class="dot" style="background:#${ringColor(ring.id).getHexString()}"></span>${ring.label} ${ring.name}<span class="n">—</span>`;
  row.dataset.ring = ring.id;
  legend.appendChild(row);
}

// ---------------------------------------------------------------- 主循环
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
applyCamera();

let t0 = performance.now();
function frame(now) {
  const dt = (now - t0) / 1000;
  t0 = now;
  ringGroup.rotation.y += dt * 0.03;
  core.rotation.y += dt * 0.5;
  core.rotation.x += dt * 0.2;
  const pulse = 1 + 0.1 * Math.sin(now * 0.002);
  for (const [, m] of nodeMeshes) {
    if (m === hoverMesh) m.scale.setScalar(1.5);
    else if (m !== core) m.scale.setScalar(pulse);
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

poll();
setInterval(poll, 5000);
