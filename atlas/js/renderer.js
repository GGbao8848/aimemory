/**
 * 星图渲染器：单 WebGL2 上下文，四段式管线。
 *   1. 星云背景 → 默认帧缓冲（LDR）
 *   2. 环 / 线路 / 节点 / 数据包 → HDR FBO（加法混合）
 *   3. 亮部提取 + 两级分离高斯模糊
 *   4. 合成（ACES 色调映射 + 色差 + Bloom）→ 加法叠回背景
 *
 * 性能取舍：几何数据不每帧重建——线路顶点只在遥测 / 高亮变化时重算，
 * 每帧只重算数据包位置（几百个实例，CPU 侧算完直接上传）。
 */

import { createProgram, createTarget, createFullscreenQuad, createDynamicBuffer } from './gl/glutil.js';
import * as S from './gl/shaders.js';
import { bezier, bezierTangent, nodeSize } from './graph.js';

const LINE_STRIDE = 10; // x,y,nx,ny,side,t,r,g,b,a
const NODE_STRIDE = 10; // cx,cy,size,phase,shape,glow,r,g,b,state
const PACKET_STRIDE = 11; // x,y,size,alpha,stretch,seed,dirx,diry,r,g,b

const TAU = Math.PI * 2;

export function createRenderer(canvas, { onContextLost } = {}) {
  let gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false, // 后处理链里不需要 MSAA，靠 Bloom 与软边抗锯齿
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;

  gl.__floatRenderable = !!gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (onContextLost) onContextLost();
  });

  // ---------- 程序 ----------
  let prog = {};
  function buildPrograms() {
    prog = {
      bg: createProgram(gl, S.QUAD_VS, S.BG_FS),
      line: createProgram(gl, S.LINE_VS, S.LINE_FS),
      node: createProgram(gl, S.NODE_VS, S.NODE_FS),
      packet: createProgram(gl, S.PACKET_VS, S.PACKET_FS),
      bright: createProgram(gl, S.QUAD_VS, S.BRIGHT_FS),
      blur: createProgram(gl, S.QUAD_VS, S.BLUR_FS),
      composite: createProgram(gl, S.QUAD_VS, S.COMPOSITE_FS),
    };
    return Object.values(prog).every(Boolean);
  }
  if (!buildPrograms()) return null;

  const quad = createFullscreenQuad(gl);

  // ---------- 几何缓冲 ----------
  // 线路：单一 VBO + 多个批次，每批次一段 TRIANGLE_STRIP
  const lineVao = gl.createVertexArray();
  const lineBuf = gl.createBuffer();
  let lineBatches = [];
  let lineVertexCount = 0;

  const nodeVao = gl.createVertexArray();
  const nodeBuf = createDynamicBuffer(gl, gl.ARRAY_BUFFER);
  let nodeCount = 0;

  const packetVao = gl.createVertexArray();
  const packetBuf = createDynamicBuffer(gl, gl.ARRAY_BUFFER);
  let packetCount = 0;

  function setupLineVao() {
    gl.bindVertexArray(lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    const b = LINE_STRIDE * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, b, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, b, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, b, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, b, 20);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, b, 24);
    gl.bindVertexArray(null);
  }

  function setupInstancedVao(vao, buf, stride, layout) {
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.buf);
    // 实例化四边形的 4 个角（TRIANGLE_STRIP）
    layout.quad.forEach(([loc, size, offset]) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
      gl.vertexAttribDivisor(loc, 1);
    });
    gl.bindVertexArray(null);
  }

  // 节点：用 aCorner 常量属性模拟非实例化四边形（无需额外 VBO）
  const CORNERS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  function setupNodeVao() {
    gl.bindVertexArray(nodeVao);
    const cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // 实例属性
    gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuf.buf);
    const b = NODE_STRIDE * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, b, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, b, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, b, 24);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, b, 36);
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
  }

  function setupPacketVao() {
    gl.bindVertexArray(packetVao);
    const cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, packetBuf.buf);
    const b = PACKET_STRIDE * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, b, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, b, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, b, 24);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 3, gl.FLOAT, false, b, 32);
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
  }

  setupLineVao();
  setupNodeVao();
  setupPacketVao();
  gl.blendFunc(gl.ONE, gl.ONE); // 全程加法混合

  // ---------- 渲染目标 ----------
  let hdr = null;
  let b1a = null;
  let b1b = null;
  let b2a = null;
  let b2b = null;
  let W = 1;
  let H = 1;
  let dpr = 1;

  function allocTargets() {
    for (const t of [hdr, b1a, b1b, b2a, b2b]) {
      if (t) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); }
    }
    hdr = createTarget(gl, W, H);
    b1a = createTarget(gl, W >> 1, H >> 1);
    b1b = createTarget(gl, W >> 1, H >> 1);
    b2a = createTarget(gl, W >> 2, H >> 2);
    b2b = createTarget(gl, W >> 2, H >> 2);
  }

  function resize(cssW, cssH) {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(cssW * dpr));
    H = Math.max(1, Math.round(cssH * dpr));
    canvas.width = W;
    canvas.height = H;
    allocTargets();
    return { W, H, dpr };
  }

  // ---------- 相机 ----------
  // 坐标一律用 CSS 像素空间：zoom = 每个世界单位多少 CSS 像素。
  // 不能把 devicePixelRatio 折进 zoom——用户把窗口拖到不同缩放比的显示器上时
  // dpr 会变，折进去的话整个构图会瞬间缩成一半（改在着色器里乘 dpr）。
  // panX/panY 是拖拽产生的世界坐标偏移，cam.x/cam.y 由 applyFraming() 合成。
  const cam = { x: 0, y: 0, zoom: 1, targetZoom: 1, panX: 0, panY: 0 };

  /**
   * 视野「安全区」：默认整屏，扣掉 HUD 面板占用的区域后得到真正可用的矩形。
   * 概念图最不能忍的就是主体被自己的仪表盘压住。
   */
  let safe = { cx: 0.5, cy: 0.5, w: 1, h: 1 };
  function setSafeArea(rect) { safe = rect; }

  /** 图形世界半径（含最外圈节点标签的余量） */
  const WORLD_EXTENT = 810;

  const cssW = () => W / dpr;
  const cssH = () => H / dpr;

  /** 把安全区中心与拖拽偏移合成到相机位置（zoom 变化时也要重算） */
  function applyFraming() {
    const dx = (safe.cx - 0.5) * cssW();
    const dy = (safe.cy - 0.5) * cssH();
    cam.x = -dx / cam.zoom + cam.panX;
    cam.y = dy / cam.zoom + cam.panY;
  }

  /** 适配缩放（CSS 像素 / 世界单位） */
  function fitZoom() {
    return Math.min(cssW() * safe.w, cssH() * safe.h) / 2 / WORLD_EXTENT;
  }

  // ---------- 几何重建 ----------
  const hex = (c) => [
    parseInt(c.slice(1, 3), 16) / 255,
    parseInt(c.slice(3, 5), 16) / 255,
    parseInt(c.slice(5, 7), 16) / 255,
  ];

  function curvePoints(l, segments) {
    const out = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const p = bezier(l, t);
      const tg = bezierTangent(l, t);
      const len = Math.hypot(tg.x, tg.y) || 1;
      out.push({ x: p.x, y: p.y, nx: -tg.y / len, ny: tg.x / len });
    }
    return out;
  }

  function circlePoints(radius, segments, a0, a1) {
    const out = [];
    for (let i = 0; i <= segments; i++) {
      const a = a0 + ((a1 - a0) * i) / segments;
      out.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius, nx: Math.cos(a), ny: Math.sin(a) });
    }
    return out;
  }

  /**
   * 重建线路缓冲。仅在「图结构 / 遥测活跃度 / 高亮集合」变化时调用。
   * @param {object} g 图
   * @param {object} activity 各链路繁忙度（0..1）
   * @param {Set<string>} highlightLinks 高亮的 "from→to"
   * @param {Set<string>} dimLinks 需要压暗的（追踪时非本步的线路）
   */
  function rebuildLines(g, activity, highlightLinks, dimLinks) {
    const data = [];
    const batches = [];

    const push = (name, verts, opts) => {
      const start = data.length / LINE_STRIDE;
      data.push(...verts);
      batches.push({ name, start, count: data.length / LINE_STRIDE - start, ...opts });
    };

    // ---- 环带（内环更亮，外环更暗；L3 单独画成虚线）
    const ringStyle = {
      l3: { width: 1.4, dash: 26, speed: 0.05, amt: 0.55, alpha: 0.30 },
      l2: { width: 2.0, dash: 34, speed: 0.055, amt: 0.60, alpha: 0.85 },
      l1: { width: 2.0, dash: 30, speed: 0.05, amt: 0.60, alpha: 0.78 },
      l0: { width: 2.4, dash: 26, speed: 0.045, amt: 0.58, alpha: 0.70 },
      edge: { width: 1.6, dash: 20, speed: 0.035, amt: 0.45, alpha: 0.34 },
    };
    for (const ring of g.rings) {
      const st = ringStyle[ring.id] || ringStyle.edge;
      const col = ring.id === 'l3' ? [0.55, 0.62, 0.78]
        : ring.id === 'l2' ? [0.37, 0.92, 0.83]
          : ring.id === 'l1' ? [0.38, 0.65, 0.98]
            : ring.id === 'l0' ? [0.22, 0.74, 0.97]
              : [0.13, 0.83, 0.93];
      const pts = circlePoints(ring.radius, 260, 0, TAU);
      push(`ring:${ring.id}`, flatLines(pts, col, st.alpha), {
        width: st.width, dashScale: st.dash, speed: st.speed, dashAmt: st.amt, alphaMul: 1,
      });
    }

    // ---- 线路
    for (const l of g.links) {
      const key = `${l.from}→${l.to}`;
      const act = linkActivity(l, activity);
      const hot = highlightLinks && highlightLinks.has(key);
      const dim = dimLinks && dimLinks.has(key);
      const pending = l.kind === 'pending';

      const [r, gg, b] = LINK_COLORS[l.kind] || LINK_COLORS.data;
      // 基础透明度压低（0.16+0.5act → 0.08+0.34act）：三十条线常亮时视觉噪音过大，
      // 让线路网退成背景；悬停/追踪的 hot 增强不变，需要看时依然醒目。
      let alpha = (pending ? 0.13 : 0.08 + 0.34 * act) * (l.weight || 1);
      if (hot) alpha = Math.min(1.5, alpha * 3.0 + 0.62);
      if (dim) alpha *= 0.42;

      push(`link:${key}`, flatLines(curvePoints(l, 30), [r, gg, b], alpha), {
        width: hot ? 2.4 : 1.5,
        dashScale: l.density || 6,
        speed: (l.speed || 0.5) * (0.4 + act),
        dashAmt: pending ? 0.75 : 0.55,
        alphaMul: 1,
      });
    }

    // 上传
    lineVertexCount = data.length / LINE_STRIDE;
    if (lineVertexCount === 0) { lineBatches = []; return; }
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    const arr = new Float32Array(data);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
    lineBatches = batches;
  }

  function flatLines(pts, [r, g, b], a) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const t = i / Math.max(1, pts.length - 1);
      out.push(p.x, p.y, p.nx, p.ny, -1, t, r, g, b, a);
      out.push(p.x, p.y, p.nx, p.ny, 1, t, r, g, b, a);
    }
    return out;
  }

  const LINK_COLORS = {
    data: [0.16, 0.72, 0.98],
    derive: [0.36, 0.62, 1.0],
    query: [0.68, 0.55, 0.99],
    external: [0.78, 0.5, 0.98],
    control: [0.96, 0.45, 0.72],
    pending: [0.5, 0.57, 0.72],
  };

  function linkActivity(l, activity) {
    if (!activity) return 0.5;
    const a = activity;
    switch (l.kind) {
      case 'external':
        if (l.to === 'emb' || l.from === 'emb') return a.emb;
        return a.llm;
      case 'pending':
        return 0.25;
      case 'control':
        return 0.45;
      case 'query':
        return a.recall;
      default:
        break;
    }
    if (l.to === 'l1_sched' || l.from === 'l1_sched' || l.from === 'l1_comp' || l.to === 'l1_comp' || l.to === 'l1_sum') {
      return Math.max(0.2, a.l1);
    }
    if (l.from.startsWith('device:') || l.to === 'l0_file' || l.to === 'l0_rec' || l.to === 'l0_batch') {
      return Math.max(0.12, a.ingest);
    }
    if (l.to === 'l2_events' || l.from === 'l2_events') return Math.max(0.2, a.remember);
    return 0.55;
  }

  /** 重建节点实例。状态：0 常态 / 1 高亮 / 2 待建 / 3 异常 */
  function rebuildNodes(g, states) {
    const arr = new Float32Array(g.nodes.length * NODE_STRIDE);
    g.nodes.forEach((n, i) => {
      let state = 0;
      let glow = 0;
      const st = states && states.get(n.id);
      if (st === 'active') { state = 1; glow = 0.35; }
      if (n.kind === 'pending') state = 2;
      if (st === 'error') { state = 3; glow = 0.5; }
      if (st === 'dim') state = 2;
      const [r, gg, b] = hex(n.accent || '#7dd3fc');
      const size = nodeSize(n.kind);
      const o = i * NODE_STRIDE;
      arr[o] = n.x;
      arr[o + 1] = n.y;
      arr[o + 2] = size;
      arr[o + 3] = (i * 2.399) % TAU; // 相位错开，避免整齐脉动
      arr[o + 4] = n.kind === 'core' ? 1 : 0;
      arr[o + 5] = glow;
      arr[o + 6] = r;
      arr[o + 7] = gg;
      arr[o + 8] = b;
      arr[o + 9] = state;
    });
    nodeCount = g.nodes.length;
    nodeBuf.upload(arr);
  }

  /** 每帧重建数据包（位置随时间推进） */
  function rebuildPackets(g, time, activity, highlightLinks, dimLinks) {
    const out = [];
    for (const l of g.links) {
      const key = `${l.from}→${l.to}`;
      const hot = highlightLinks && highlightLinks.has(key);
      const dim = dimLinks && dimLinks.has(key);
      const act = linkActivity(l, activity);
      const pending = l.kind === 'pending';

      let count = Math.round(1 + act * 5 * (l.weight || 1));
      if (pending) count = 1;
      if (hot) count = Math.max(count, 9);
      if (dim) count = Math.min(count, 1);

      const [r, gg, b] = LINK_COLORS[l.kind] || LINK_COLORS.data;
      const speed = (l.speed || 0.5) * (0.35 + 0.9 * act) * (hot ? 1.35 : 1);
      const size = hot ? 9.5 : 5.2 + act * 1.6;
      const alpha = (pending ? 0.30 : 0.42 + act * 0.5) * (hot ? 1.5 : 1) * (dim ? 0.25 : 1);

      const segments = 26;
      for (let i = 0; i < count; i++) {
        const phase = i / count + hashPhase(key);
        const t = frac(time * speed + phase);
        const tc = Math.min(0.999, Math.max(0.001, t));
        const p = bezier(l, tc);
        const tg = bezierTangent(l, tc);
        const len = Math.hypot(tg.x, tg.y) || 1;
        out.push(
          p.x, p.y,
          size, alpha, hot ? 3.2 : 2.3, phase,
          tg.x / len, tg.y / len,
          r, gg, b,
        );
      }
    }
    packetCount = out.length / PACKET_STRIDE;
    if (packetCount === 0) return;
    packetBuf.upload(new Float32Array(out));
  }

  function frac(v) { return v - Math.floor(v); }
  function hashPhase(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 1000) / 1000;
  }

  // ---------- 绘制辅助 ----------
  function bindQuad() {
    gl.bindVertexArray(quad.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function drawTo(target, w, h) {
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
    }
  }

  // ---------- 主绘制 ----------
  const state = {
    time: 0,
    mouse: [0, 0],
    tint: [0.16, 0.24, 0.55],
    accent: [0.42, 0.24, 0.72],
    energy: 0.6,
    exposure: 1.06,
    bloom: 1.15,
    threshold: 0.62,
    knee: 0.28,
    aberration: 0.0022,
    paused: false,
  };

  function render(dt, g, activity, highlightLinks, dimLinks) {
    if (!state.paused) state.time += dt;
    const t = state.time;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);

    // ---- 1) 背景
    drawTo(null, W, H);
    gl.disable(gl.BLEND);
    gl.useProgram(prog.bg.program);
    gl.uniform2f(prog.bg.u.uRes, W, H);
    gl.uniform1f(prog.bg.u.uTime, t);
    gl.uniform3fv(prog.bg.u.uTint, state.tint);
    gl.uniform3fv(prog.bg.u.uAccent, state.accent);
    gl.uniform2fv(prog.bg.u.uMouse, state.mouse);
    gl.uniform1f(prog.bg.u.uEnergy, state.energy);
    bindQuad();
    gl.enable(gl.BLEND);

    // ---- 2) 图形 → HDR
    drawTo(hdr, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 线
    if (lineBatches.length && lineVertexCount) {
      gl.useProgram(prog.line.program);
      gl.uniform2f(prog.line.u.uRes, W, H);
      gl.uniform2f(prog.line.u.uCam, cam.x, cam.y);
      gl.uniform1f(prog.line.u.uZoom, cam.zoom * dpr); // 世界 → 设备像素
      gl.uniform1f(prog.line.u.uTime, t);
      gl.bindVertexArray(lineVao);
      for (const b of lineBatches) {
        // 世界坐标半宽：反推「屏幕上约 b.width 个 CSS 像素」
        gl.uniform1f(prog.line.u.uWidth, b.width / cam.zoom);
        gl.uniform1f(prog.line.u.uDashScale, b.dashScale);
        gl.uniform1f(prog.line.u.uSpeed, b.speed);
        gl.uniform1f(prog.line.u.uDashAmt, b.dashAmt);
        gl.uniform1f(prog.line.u.uAlphaMul, b.alphaMul);
        gl.drawArrays(gl.TRIANGLE_STRIP, b.start, b.count);
      }
    }

    // 节点
    if (nodeCount) {
      gl.useProgram(prog.node.program);
      gl.uniform2f(prog.node.u.uRes, W, H);
      gl.uniform2f(prog.node.u.uCam, cam.x, cam.y);
      gl.uniform1f(prog.node.u.uZoom, cam.zoom * dpr);
      gl.uniform1f(prog.node.u.uTime, t);
      gl.bindVertexArray(nodeVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nodeCount);
    }

    // 数据包
    if (packetCount) {
      gl.useProgram(prog.packet.program);
      gl.uniform2f(prog.packet.u.uRes, W, H);
      gl.uniform2f(prog.packet.u.uCam, cam.x, cam.y);
      gl.uniform1f(prog.packet.u.uZoom, cam.zoom * dpr);
      gl.bindVertexArray(packetVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, packetCount);
    }

    // ---- 3) Bloom（写操作，关混合避免叠加反馈）
    gl.disable(gl.BLEND);
    gl.bindVertexArray(quad.vao);

    // 亮部 → 1/2
    gl.useProgram(prog.bright.program);
    drawTo(b1a, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hdr.tex);
    gl.uniform1i(prog.bright.u.uTex, 0);
    gl.uniform1f(prog.bright.u.uThreshold, state.threshold);
    gl.uniform1f(prog.bright.u.uKnee, state.knee);
    bindQuad();

    // 模糊 H → b1b
    gl.useProgram(prog.blur.program);
    drawTo(b1b, W, H);
    gl.bindTexture(gl.TEXTURE_2D, b1a.tex);
    gl.uniform1i(prog.blur.u.uTex, 0);
    gl.uniform2f(prog.blur.u.uDir, 1.0 / b1a.w, 0);
    bindQuad();

    // 模糊 V → b1a
    drawTo(b1a, W, H);
    gl.bindTexture(gl.TEXTURE_2D, b1b.tex);
    gl.uniform2f(prog.blur.u.uDir, 0, 1.0 / b1b.h);
    bindQuad();

    // 再模糊一轮（1/4 分辨率）→ 大范围柔和辉光
    drawTo(b2a, W, H);
    gl.bindTexture(gl.TEXTURE_2D, b1a.tex);
    gl.uniform2f(prog.blur.u.uDir, 0, 0); // 权重和为 1 → 等价于降采样拷贝
    bindQuad();
    drawTo(b2b, W, H);
    gl.bindTexture(gl.TEXTURE_2D, b2a.tex);
    gl.uniform2f(prog.blur.u.uDir, 1.6 / b2a.w, 0);
    bindQuad();
    drawTo(b2a, W, H);
    gl.bindTexture(gl.TEXTURE_2D, b2b.tex);
    gl.uniform2f(prog.blur.u.uDir, 0, 1.6 / b2b.h);
    bindQuad();

    // ---- 4) 合成到屏幕（对背景做加法叠加）
    gl.enable(gl.BLEND);
    drawTo(null, W, H);
    gl.useProgram(prog.composite.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, hdr.tex);
    gl.uniform1i(prog.composite.u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b1a.tex);
    gl.uniform1i(prog.composite.u.uBloom, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, b2a.tex);
    gl.uniform1i(prog.composite.u.uBloom2, 2);
    gl.uniform1f(prog.composite.u.uBloomStrength, state.bloom);
    gl.uniform1f(prog.composite.u.uBloom2Strength, state.bloom * 0.85);
    gl.uniform1f(prog.composite.u.uExposure, state.exposure);
    gl.uniform1f(prog.composite.u.uAberration, state.aberration);
    gl.uniform2f(prog.composite.u.uRes, W, H);
    bindQuad();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
  }

  /** 世界坐标 → 屏幕 CSS 像素（zoom 本身就是 CSS 像素口径，不用再除 dpr） */
  function project(x, y, rect) {
    return {
      sx: (x - cam.x) * cam.zoom + rect.width / 2,
      sy: -(y - cam.y) * cam.zoom + rect.height / 2,
    };
  }

  return {
    gl,
    state,
    cam,
    resize,
    fitZoom,
    setSafeArea,
    applyFraming,
    render,
    rebuildLines,
    rebuildNodes,
    rebuildPackets,
    project,
    get size() { return { W, H, dpr }; },
  };
}
