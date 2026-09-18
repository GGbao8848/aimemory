/**
 * 由拓扑数据算出世界坐标与线路几何。
 * 线路用二次贝塞尔：控制点沿「远离圆心」的法线偏移 bow，用来手工避让节点。
 */

import { NODES, LINKS, ACTORS, RINGS } from './topology.js';

const D2R = Math.PI / 180;
export const polar = (angleDeg, radius) => ({
  x: Math.cos(angleDeg * D2R) * radius,
  y: Math.sin(angleDeg * D2R) * radius,
});

/** 采集设备沿接入弧铺开（角度以 ingest 的 55° 为中心） */
function deviceNodes(devices) {
  const n = Math.max(1, devices.length);
  const step = Math.min(19, 66 / n);
  const base = 55;
  return devices.map((d, i) => {
    const angle = base + (i - (n - 1) / 2) * step;
    const radius = 690 + (i % 2) * 26; // 交错半径，密集时不重叠
    const p = polar(angle, radius);
    const short = (d.label || d.device_code || '设备').slice(0, 14);
    return {
      id: `device:${i}`,
      label: short,
      sub: `${d.agents && d.agents.length ? d.agents.join(' · ') : 'agent'} ｜ ${d.sessions || 0} 会话`,
      kind: 'device',
      accent: '#34d399',
      x: p.x,
      y: p.y,
      angle,
      radius,
      metric: null,
      // 设备卡片里的实时数字由遥测填充
      device: d,
      info: {
        role: '一台装了采集器的机器。采集器是「死程序」：只认归一化 schema，不知道对面是哪种 agent。',
        files: ['collector/index.js', 'collector/adapters/{codex,claude,zcode}.js'],
        endpoints: ['pm2 start collector/ecosystem.config.js --only aimemory-collector'],
        params: [
          ['设备码', d.device_code || '—'],
          ['机器指纹', d.fingerprint ? `${String(d.fingerprint).slice(0, 10)}…（${d.fingerprint_source || '未知来源'}）` : '⚠ 无指纹'],
          ['系统', d.info ? [d.info.platform, d.info.arch, d.info.os_release].filter(Boolean).join(' ') : '—'],
          ['采集会话', `${d.sessions || 0} 个 / ${(d.records || 0).toLocaleString('zh-CN')} 条`],
          ['归档体积', d.bytes ? fmtBytes(d.bytes) : '—'],
          ['最近上报', d.last_seen ? d.last_seen.replace('T', ' ').slice(0, 19) : '—'],
        ],
        note: '设备码不绑定密钥：设备身份属于机器，Token 属于授权，二者生命周期不同。重装后靠机器指纹认回同一台设备。',
      },
    };
  });
}

export function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** 节点绘制半径（世界单位）——渲染与命中测试共用，避免两处走样 */
export function nodeSize(kind) {
  if (kind === 'core') return 46;
  if (kind === 'device') return 15;
  if (kind === 'actor') return 17;
  if (kind === 'pending') return 16;
  return 19;
}

/**
 * 组装完整图。
 * @param {Array} devices 遥测拿到的设备清单
 * @returns {{nodes:Array, byId:Map, links:Array, rings:Array}}
 */
export function buildGraph(devices) {
  const devs = deviceNodes(devices || []);

  const nodes = [
    ...NODES.map((n) => ({ ...n, ...polar(n.angle, n.radius) })),
    ...ACTORS.map((n) => ({ ...n, ...polar(n.angle, n.radius) })),
    ...devs,
  ];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const links = [];
  for (const d of devs) {
    links.push({
      from: d.id,
      to: 'ingest',
      kind: 'data',
      label: '原始会话批次',
      speed: 0.7,
      density: 6,
      weight: 1.0,
      bow: 12,
    });
  }
  for (const l of LINKS) {
    if (byId.has(l.from) && byId.has(l.to)) links.push({ ...l });
  }

  // 计算贝塞尔控制点：默认控制点在中点，再沿「背离圆心」方向偏移 bow
  for (const l of links) {
    const a = byId.get(l.from);
    const b = byId.get(l.to);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    let nx = -my;
    let ny = mx;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    // 保证法线朝外（远离原点）
    if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny; }
    const bow = l.bow || 0;
    l.p0 = { x: a.x, y: a.y };
    l.p1 = { x: mx + nx * bow, y: my + ny * bow };
    l.p2 = { x: b.x, y: b.y };
    l._a = a;
    l._b = b;
  }

  return { nodes, byId, links, rings: RINGS, devices: devs };
}

/** 贝塞尔取点 */
export function bezier(l, t) {
  const u = 1 - t;
  const a = u * u;
  const b = 2 * u * t;
  const c = t * t;
  return {
    x: a * l.p0.x + b * l.p1.x + c * l.p2.x,
    y: a * l.p0.y + b * l.p1.y + c * l.p2.y,
  };
}

/** 贝塞尔切线（未归一化） */
export function bezierTangent(l, t) {
  const u = 1 - t;
  return {
    x: 2 * u * (l.p1.x - l.p0.x) + 2 * t * (l.p2.x - l.p1.x),
    y: 2 * u * (l.p1.y - l.p0.y) + 2 * t * (l.p2.y - l.p1.y),
  };
}

/**
 * 把线路细分成三角带顶点。
 * @returns {{pos:number[], nrm:number[], t:number[]}} 每段两个顶点（side=-1/+1 交错）
 */
export function tessellate(l, segments = 26) {
  const pos = [];
  const nrm = [];
  const ts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = bezier(l, t);
    const tg = bezierTangent(l, t);
    const len = Math.hypot(tg.x, tg.y) || 1;
    const nx = -tg.y / len;
    const ny = tg.x / len;
    for (const s of [-1, 1]) {
      pos.push(p.x, p.y);
      nrm.push(nx, ny);
      ts.push(s, t);
    }
  }
  return { pos, nrm, t: ts };
}

/** 圆/弧采样点（环带用） */
export function arcPoints(cx, cy, r, a0, a1, segments = 220) {
  const out = [];
  for (let i = 0; i <= segments; i++) {
    const a = a0 + ((a1 - a0) * i) / segments;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, a });
  }
  return out;
}
