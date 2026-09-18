/**
 * 全部 GLSL 源码。拆成「背景 / 线 / 节点 / 数据包 / 后处理」五组。
 * 渲染管线（单 WebGL2 上下文）：
 *   1. 背景星云   → 默认帧缓冲（LDR，自带 vignette/grain/dither）
 *   2. 图形元素   → HDR FBO（加法混合，亮部不截断）
 *   3. 亮部提取 → 分离高斯模糊（两轮，逐级降采样）
 *   4. 合成       → 加法叠回默认帧缓冲（ACES 色调映射 + 色差）
 */

// ============================================================ 全屏四边形

export const QUAD_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// ============================================================ 背景：星云 + 星场

export const BG_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;

uniform vec2  uRes;
uniform float uTime;
uniform vec3  uTint;       // 主色调：随系统健康度漂移
uniform vec3  uAccent;     // 次色调
uniform vec2  uMouse;      // -1..1 视差
uniform float uEnergy;     // 0..1 系统整体活跃度 → 星云湍流强度
// ---- 主题形态参数（见 main.js 的 THEMES）：全默认即原始星云
uniform float uNebula;     // 星云强度
uniform float uStars;      // 星场强度
uniform float uSweep;      // 雷达扫掠
uniform float uCoreGlow;   // 中心辉光
uniform float uGrid;       // 蓝图网格
uniform float uScan;       // 扫描线（磷光屏）
uniform vec3  uBase;       // 底色

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = rot * p * 2.03;
    a *= 0.5;
  }
  return v;
}

// 一层星点：1/d 核 + 独立闪烁
float starLayer(vec2 uv, float scale, float seed, float thresh, float sizeK) {
  vec2 g = uv * scale + seed;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float h = hash21(id + seed);
  float on = step(thresh, h);
  vec2 off = (vec2(hash21(id + 11.7), hash21(id + 37.3)) - 0.5) * 0.7;
  float d = length(f - off);
  float core = sizeK / (d + sizeK);
  float tw = 0.45 + 0.55 * sin(uTime * (0.6 + h * 3.1) + h * 61.0);
  return on * core * core * core * tw;
}

void main() {
  vec2 uv = vUV;
  vec2 p = (uv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float r = length(p);

  // ---- 视差：远景移动少，近景移动多
  vec2 par = uMouse * 0.02;

  vec3 col = uBase;

  // ---- 域扭曲星云（uNebula=0 时整段跳过，flat/蓝图/磷光不付这笔采样钱）
  if (uNebula > 0.001) {
    vec2 q = p * 1.9 + par * 0.5;
    float w1 = fbm(q + uTime * 0.012);
    float w2 = fbm(q + vec2(5.2, 1.3) - uTime * 0.009);
    vec2 warp = vec2(w1, w2);
    float f = fbm(q + 3.2 * warp + vec2(0.0, uTime * 0.006));

    // 星云只在中心区外沿分布（中心要留给图形），并随 uEnergy 增亮
    float shell = smoothstep(0.06, 0.62, r) * (1.0 - smoothstep(1.05, 2.35, r));
    float density = smoothstep(0.32, 0.90, f) * shell;
    vec3 neb = mix(uAccent * 0.55, uTint, smoothstep(0.3, 0.85, f));
    col += neb * density * (0.42 + 0.72 * uEnergy) * uNebula;
  }

  // ---- 星场（三层深度）
  if (uStars > 0.001) {
    col += vec3(0.72, 0.82, 1.00) * starLayer(uv + par * 0.35, 26.0, 3.1, 0.965, 0.020) * 0.75 * uStars;
    col += vec3(0.85, 0.90, 1.00) * starLayer(uv + par * 0.75, 52.0, 17.9, 0.978, 0.014) * 1.05 * uStars;
    col += vec3(1.00, 0.96, 0.90) * starLayer(uv + par * 1.20, 96.0, 71.3, 0.986, 0.010) * 1.45 * uStars;
  }

  // ---- 极坐标雷达扫掠：强化「反应堆」意象（极弱）
  if (uSweep > 0.001) {
    float ang = atan(p.y, p.x);
    float sweep = pow(max(0.0, cos(ang - uTime * 0.22)), 28.0);
    col += uAccent * sweep * exp(-r * 1.25) * 0.20 * uSweep;
  }

  // ---- 蓝图网格：主/次两级刻度线，随视差轻移（制图感）
  if (uGrid > 0.001) {
    vec2 g1p = (gl_FragCoord.xy - 0.5 * uRes) / 46.0 + par * 5.0;
    vec2 g1 = abs(fract(g1p) - 0.5) / fwidth(g1p);
    float minor = 1.0 - min(min(g1.x, g1.y), 1.0);
    vec2 g2p = (gl_FragCoord.xy - 0.5 * uRes) / 230.0 + par * 5.0;
    vec2 g2 = abs(fract(g2p) - 0.5) / fwidth(g2p);
    float major = 1.0 - min(min(g2.x, g2.y), 1.0);
    vec3 gridCol = mix(uTint, vec3(0.85, 0.92, 1.0), 0.5);
    col += gridCol * (minor * 0.035 + major * 0.085) * uGrid;
  }

  // ---- 磷光屏扫描线：横向明暗纹（CRT 气质）
  if (uScan > 0.001) {
    float scan = 0.5 + 0.5 * sin(gl_FragCoord.y * 2.35);
    col *= 1.0 - uScan * 0.24 * scan;
  }

  // ---- 内核辉光：中心一圈微亮，衬托记忆内核
  col += uTint * exp(-r * 3.0) * 0.17 * uCoreGlow;

  // ---- 暗角 + 颗粒 + 抖动（暗部渐变防色带）
  float vig = smoothstep(1.55, 0.28, r);
  col *= mix(0.42, 1.0, vig);
  float g = hash21(uv * uRes + fract(uTime) * 311.0);
  col += (g - 0.5) * 0.020;
  col += (hash21(uv * uRes * 1.7 + 13.0) - 0.5) * (1.0 / 255.0);

  outColor = vec4(col, 1.0);
}`;

// ============================================================ 线（环 / 连线）

export const LINE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2  aPos;   // 世界坐标（曲线上的点）
layout(location = 1) in vec2  aNrm;   // 法线（CPU 侧算好，避免着色器求导）
layout(location = 2) in float aSide;  // -1 / +1：加宽方向
layout(location = 3) in float aT;     // 0..1 沿线参数
layout(location = 4) in vec4  aTint;  // rgb + 强度

uniform vec2  uRes;
uniform vec2  uCam;
uniform float uZoom;
uniform float uWidth;    // 世界坐标半宽

out vec2 vUV;
out vec4 vTint;

void main() {
  vec2 world = aPos + aNrm * aSide * uWidth;
  vec2 screen = (world - uCam) * uZoom;
  gl_Position = vec4(screen.x / (uRes.x * 0.5), -screen.y / (uRes.y * 0.5), 0.0, 1.0);
  vUV = vec2(aSide, aT);
  vTint = aTint;
}`;

export const LINE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in vec4 vTint;
out vec4 outColor;

uniform float uTime;
uniform float uAlphaMul;
uniform float uSpeed;      // 能量流速（1/秒）
uniform float uDashScale;  // 沿线亮段密度
uniform float uDashAmt;    // 亮段占比（0 = 纯实线）

void main() {
  float across = abs(vUV.x);
  float body = smoothstep(1.0, 0.05, across);          // 线体（软边）
  float d = fract(vUV.y * uDashScale - uTime * uSpeed);
  float dash = pow(1.0 - d, 8.0) * uDashAmt;           // 彗尾状流动亮段
  float lit = body * 0.44 + dash * body;
  float a = vTint.a * uAlphaMul;
  outColor = vec4(vTint.rgb * lit * a, lit * a);
}`;

// ============================================================ 节点（实例化）

export const NODE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2  aCorner;   // -1..1 方片
layout(location = 1) in vec2  iCenter;
layout(location = 2) in vec4  iParams;   // size, phase, shape(0 圆/1 六边), glow
layout(location = 3) in vec3  iColor;
layout(location = 4) in float iState;    // 0 常态 / 1 高亮 / 2 待建 / 3 异常

uniform vec2  uRes;
uniform vec2  uCam;
uniform float uZoom;

out vec2  vUV;
out vec3  vColor;
out float vPhase;
out float vShape;
out float vGlow;
out float vState;

void main() {
  float size = iParams.x * (1.0 + iParams.w);
  vec2 world = iCenter + aCorner * size;
  vec2 screen = (world - uCam) * uZoom;
  gl_Position = vec4(screen.x / (uRes.x * 0.5), -screen.y / (uRes.y * 0.5), 0.0, 1.0);
  vUV = aCorner;
  vColor = iColor;
  vPhase = iParams.y;
  vShape = iParams.z;
  vGlow = iParams.w;
  vState = iState;
}`;

export const NODE_FS = `#version 300 es
precision highp float;
in vec2  vUV;
in vec3  vColor;
in float vPhase;
in float vShape;
in float vGlow;
in float vState;
out vec4 outColor;

uniform float uTime;

float hexDist(vec2 p) {
  p = abs(p);
  return max(p.x * 0.866025 + p.y * 0.5, p.y);
}

void main() {
  float d = length(vUV);
  float ang = atan(vUV.y, vUV.x);
  float t = uTime + vPhase;

  float coreShape;
  if (vShape > 0.5) {
    coreShape = hexDist(vUV);            // 内核：六边形晶体
  } else {
    coreShape = d;                        // 其余：圆
  }

  float core = smoothstep(0.52, 0.0, coreShape);
  float rim  = smoothstep(0.13, 0.0, abs(coreShape - 0.72));
  float halo = exp(-d * d * 2.6);
  float outer = exp(-d * d * 0.85);

  // 状态环：高亮节点有线速度扫描感
  float sweep = pow(max(0.0, cos(ang - t * 1.35)), 14.0);
  float ticks = step(0.90, fract(ang / 6.2831853 * 16.0 + t * 0.08)) * smoothstep(0.02, 0.06, abs(d - 1.16));

  float breathe = 0.5 + 0.5 * sin(t * 1.5);

  vec3 col = vColor;
  float intensity = 1.0;

  if (vState > 2.5) {                    // 异常：红偏、外扩脉冲
    col = mix(col, vec3(1.0, 0.35, 0.32), 0.75);
    intensity = 1.2 + 0.5 * breathe;
  } else if (vState > 1.5) {             // 待建：冷灰、虚线感、呼吸
    col = mix(col, vec3(0.46, 0.52, 0.64), 0.7);
    intensity = 0.30 + 0.32 * breathe;
  } else if (vState > 0.5) {             // 高亮：白热核心
    col = mix(col, vec3(1.0), 0.35);
    intensity = 1.9 + 0.5 * breathe;
  }

  float lum = core * 1.25 + rim * 1.35 + halo * 0.34 + outer * 0.11;
  lum += sweep * smoothstep(0.62, 1.0, d) * (1.0 - smoothstep(1.0, 1.3, d)) * 1.5;
  lum += ticks * 0.5;

  outColor = vec4(col * lum * intensity * (1.0 + vGlow), lum * intensity);
}`;

// ============================================================ 数据包（实例化）

export const PACKET_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec2 iPos;
layout(location = 2) in vec4 iParams;   // size, alpha, stretch, seed
layout(location = 3) in vec2 iDir;      // 单位方向（拉伸朝向）
layout(location = 4) in vec3 iColor;

uniform vec2  uRes;
uniform vec2  uCam;
uniform float uZoom;

out vec2  vUV;
out vec3  vColor;
out float vAlpha;

void main() {
  vec2 along = normalize(iDir + 1e-6);
  vec2 perp  = vec2(-along.y, along.x);
  vec2 local = vec2(aCorner.x * iParams.z, aCorner.y) * iParams.x;
  vec2 off = along * (local.x + iParams.x * 0.55) + perp * local.y;
  vec2 world = iPos + off;
  vec2 screen = (world - uCam) * uZoom;
  gl_Position = vec4(screen.x / (uRes.x * 0.5), -screen.y / (uRes.y * 0.5), 0.0, 1.0);
  vUV = aCorner;
  vColor = iColor;
  vAlpha = iParams.y;
}`;

export const PACKET_FS = `#version 300 es
precision highp float;
in vec2  vUV;
in vec3  vColor;
in float vAlpha;
out vec4 outColor;

void main() {
  float ax = vUV.x * 1.6 + 0.55;   // 头在 +x
  float ay = vUV.y * 2.3;
  float fade = smoothstep(-1.0, 0.55, ax);
  float body = exp(-(ax * ax * 0.40 + ay * ay * 3.0));
  float head = exp(-((ax - 0.42) * (ax - 0.42) * 7.0 + ay * ay * 9.0));
  float a = (body * 0.45 + head * 1.15) * fade * vAlpha;
  outColor = vec4(vColor * a, a);
}`;

// ============================================================ 后处理

export const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uThreshold;
uniform float uKnee;

void main() {
  vec3 c = texture(uTex, vUV).rgb;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 0.0001);
  float contrib = max(soft, br - uThreshold) / max(br, 0.0001);
  outColor = vec4(c * contrib, 1.0);
}`;

export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uDir;   // 像素步长（含方向）

void main() {
  // 9 抽头高斯（sigma≈2.0）
  float w0 = 0.227027, w1 = 0.194594, w2 = 0.121621, w3 = 0.054054, w4 = 0.016216;
  vec3 c = texture(uTex, vUV).rgb * w0;
  c += texture(uTex, vUV + uDir * 1.0).rgb * w1;
  c += texture(uTex, vUV - uDir * 1.0).rgb * w1;
  c += texture(uTex, vUV + uDir * 2.0).rgb * w2;
  c += texture(uTex, vUV - uDir * 2.0).rgb * w2;
  c += texture(uTex, vUV + uDir * 3.0).rgb * w3;
  c += texture(uTex, vUV - uDir * 3.0).rgb * w3;
  c += texture(uTex, vUV + uDir * 4.0).rgb * w4;
  c += texture(uTex, vUV - uDir * 4.0).rgb * w4;
  outColor = vec4(c, 1.0);
}`;

export const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uBloom2;
uniform float uBloomStrength;
uniform float uBloom2Strength;
uniform float uExposure;
uniform float uAberration;
uniform vec2  uRes;

// ACES 近似（Narkowicz）——把 HDR 亮部压回可显示范围，避免硬切白
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 uv = vUV;
  vec2 dir = uv - 0.5;
  float amt = uAberration * dot(dir, dir);

  vec3 scene;
  scene.r = texture(uScene, uv + dir * amt).r;
  scene.g = texture(uScene, uv).g;
  scene.b = texture(uScene, uv - dir * amt).b;

  vec3 bloom = texture(uBloom, uv).rgb * uBloomStrength
             + texture(uBloom2, uv).rgb * uBloom2Strength;
  vec3 col = aces((scene + bloom) * uExposure);

  outColor = vec4(col, 1.0);
}`;
