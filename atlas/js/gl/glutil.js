/**
 * 极简 WebGL2 工具层：编译程序、建 FBO、全屏四边形、动态缓冲。
 * 刻意不引三方库——星图要能在内网离线部署，静态资源零外链。
 */

/** 编译单个 shader，失败时把带行号的源码打到控制台（否则 GLSL 报错无法定位） */
function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '';
    const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(3)} | ${l}`).join('\n');
    console.error(`[atlas] shader 编译失败 (${type === gl.VERTEX_SHADER ? 'vs' : 'fs'}):\n${log}\n${lines}`);
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/**
 * 建程序并自动反射所有 uniform / attribute 位置。
 * @returns {{program:WebGLProgram, u:Record<string,WebGLUniformLocation>, a:Record<string,number>}}
 */
export function createProgram(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[atlas] 程序链接失败:', gl.getProgramInfoLog(program));
    return null;
  }
  const u = {};
  const a = {};
  const nU = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nU; i++) {
    const info = gl.getActiveUniform(program, i);
    if (info) u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
  }
  const nA = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < nA; i++) {
    const info = gl.getActiveAttrib(program, i);
    if (info) a[info.name] = gl.getAttribLocation(program, info.name);
  }
  return { program, u, a };
}

/**
 * 建渲染目标。优先 RGBA16F（HDR，Bloom 需要亮部不被截断），
 * 浏览器不支持 float 可渲染时退 RGBA8——Bloom 仍工作，只是高光会被压到 1.0。
 */
export function createTarget(gl, w, h, { filter = gl.LINEAR, hdr = true } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const canFloat = hdr && !!gl.__floatRenderable;
  const internal = canFloat ? gl.RGBA16F : gl.RGBA8;
  const type = canFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, Math.max(1, w), Math.max(1, h), 0, gl.RGBA, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  if (!ok) {
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    // 半浮点不可渲染时退 8bit（Bloom 效果降级但不空白）
    if (canFloat) return createTarget(gl, w, h, { filter, hdr: false });
    return null;
  }
  return { fb, tex, w: Math.max(1, w), h: Math.max(1, h) };
}

export function resizeTarget(gl, target, w, h) {
  if (!target) return createTarget(gl, w, h);
  if (target.w === w && target.h === h) return target;
  gl.deleteFramebuffer(target.fb);
  gl.deleteTexture(target.tex);
  return createTarget(gl, w, h);
}

/** 全屏三角/四边形（用三角形对，避免依赖 VAO 扩展） */
export function createFullscreenQuad(gl) {
  const vao = gl.createVertexArray();
  const buf = gl.createBuffer();
  const verts = new Float32Array([-1, -1, 3, -1, -1, 3]);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, buf };
}

/** 动态 VBO 包装：按需扩容，避免每帧重建缓冲对象 */
export function createDynamicBuffer(gl, target, usage = gl.DYNAMIC_DRAW) {
  const buf = gl.createBuffer();
  let capacityBytes = 0;
  return {
    buf,
    /** @param {Float32Array} data */
    upload(data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const bytes = data.byteLength;
      if (bytes > capacityBytes) {
        // 一步到位扩到够用（下取整的翻倍会在大几何上反复 realloc）
        capacityBytes = Math.max(bytes, capacityBytes * 2, 8192);
        gl.bufferData(gl.ARRAY_BUFFER, capacityBytes, usage);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    },
    dispose() { gl.deleteBuffer(buf); },
  };
}
