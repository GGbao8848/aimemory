'use strict';

/**
 * 运行时设置：LLM / Embedding 接入参数与功能开关（设置页的后端）。
 *
 * 设计：
 * - 字段注册表 FIELDS 是唯一事实源：声明每个可改项对应的 .env 键、类型与取值范围；
 *   新增设置项只需在这里登记，get/update/probe 自动跟上。
 * - update 先热生效（直接改 config 模块上的运行时对象——llm/embedding 客户端每次调用都
 *   读一遍 config，无需重启），再回写 .env（下次启动沿用），最后清掉相关熔断状态。
 * - 密钥只写不读：GET 返回 { set, preview }（首尾各 3 位遮蔽），PUT 传空串/缺省 = 保持现有值。
 * - probe 与客户端熔断无关：设置页的「测试连接」是显式动作，直连发一次最小请求并回报耗时/错误。
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const envPath = () => path.join(config.root, '.env');

// ===== 字段注册表：section → field → {env, type, min?, max?} =====
// type: bool | int | url | string | secret
const FIELDS = {
  llm: {
    enabled:   { env: 'LLM_ENABLED', type: 'bool' },
    baseUrl:   { env: 'LLM_BASE_URL', type: 'url' },
    model:     { env: 'LLM_MODEL', type: 'string' },
    apiKey:    { env: 'LLM_API_KEY', type: 'secret' },
    timeoutMs: { env: 'LLM_TIMEOUT_MS', type: 'int', min: 1000, max: 300000 },
  },
  embedding: {
    enabled:   { env: 'EMBEDDING_ENABLED', type: 'bool' },
    baseUrl:   { env: 'EMBEDDING_BASE_URL', type: 'url' },
    model:     { env: 'EMBEDDING_MODEL', type: 'string' },
    apiKey:    { env: 'EMBEDDING_API_KEY', type: 'secret' },
    timeoutMs: { env: 'EMBEDDING_TIMEOUT_MS', type: 'int', min: 1000, max: 300000 },
  },
  l2: {
    reconcile: { env: 'L2_RECONCILE', type: 'bool' },
    vec:       { env: 'L2_VEC', type: 'bool' },
  },
};

// config 模块上的运行时对象（读写目标）；函数形式避免模块加载顺序耦合
const liveSection = {
  llm: () => config.llm,
  embedding: () => config.embedding,
  l2: () => config.l2,
};

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** 校验并收敛单字段值；返回可写入 config/.env 的规范值 */
function coerce(field, value, label) {
  switch (field.type) {
    case 'bool': {
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === '1' || value === 'true') return true;
      if (value === 0 || value === '0' || value === 'false') return false;
      throw httpError(400, `${label} 必须是布尔值（true/false）`);
    }
    case 'int': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < field.min || n > field.max) {
        throw httpError(400, `${label} 必须是 ${field.min}~${field.max} 之间的整数（毫秒）`);
      }
      return n;
    }
    case 'url': {
      const s = String(value ?? '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(s)) throw httpError(400, `${label} 必须以 http:// 或 https:// 开头`);
      if (s.length > 500) throw httpError(400, `${label} 过长（上限 500 字符）`);
      return s;
    }
    case 'string': {
      const s = String(value ?? '').trim();
      if (!s) throw httpError(400, `${label} 不能为空`);
      if (s.length > 200) throw httpError(400, `${label} 过长（上限 200 字符）`);
      return s;
    }
    case 'secret': {
      const s = String(value ?? '');
      if (s.length > 500) throw httpError(400, `${label} 过长（上限 500 字符）`);
      return s;
    }
    default:
      throw httpError(500, `字段 ${label} 的类型配置非法：${field.type}`);
  }
}

/** 密钥脱敏展示：只露首尾各 3 位，短密钥全遮 */
function maskKey(v) {
  if (!v) return { set: false, preview: '' };
  return { set: true, preview: v.length > 8 ? `${v.slice(0, 3)}***${v.slice(-3)}` : '***' };
}

/** 当前生效设置（密钥脱敏）。 */
function get() {
  const out = {};
  for (const [sec, fields] of Object.entries(FIELDS)) {
    const live = liveSection[sec]();
    out[sec] = {};
    for (const [name, f] of Object.entries(fields)) {
      out[sec][name] = f.type === 'secret' ? maskKey(live[name]) : live[name];
    }
  }
  return out;
}

/**
 * 应用设置补丁：校验 → 热生效（改 config 运行时对象）→ 回写 .env → 复位相关熔断。
 * 返回更新后的完整设置（同 get()）。opts.envFile 供测试注入临时 .env（默认写真实 .env）。
 */
function update(patch = {}, { envFile } = {}) {
  if (typeof patch !== 'object' || Array.isArray(patch) || patch === null) {
    throw httpError(400, '请求体必须是对象，形如 { llm: {...}, embedding: {...}, l2: {...} }');
  }
  const unknown = Object.keys(patch).filter((k) => !FIELDS[k]);
  if (unknown.length) {
    throw httpError(400, `未知的设置分区：${unknown.join(', ')}（支持：${Object.keys(FIELDS).join(', ')}）`);
  }
  const envUpdates = {};
  const touched = [];
  for (const [sec, fields] of Object.entries(FIELDS)) {
    const p = patch[sec];
    if (p === undefined || p === null) continue;
    if (typeof p !== 'object' || Array.isArray(p)) throw httpError(400, `${sec} 必须是对象`);
    const bad = Object.keys(p).filter((k) => !fields[k]);
    if (bad.length) throw httpError(400, `${sec} 含未知字段：${bad.join(', ')}（支持：${Object.keys(fields).join(', ')}）`);

    const live = liveSection[sec]();
    for (const [name, value] of Object.entries(p)) {
      const f = fields[name];
      // 密钥传空 = 保持现有值（前端不回显明文，空输入是常态）
      if (f.type === 'secret' && (value === undefined || value === null || value === '')) continue;
      const v = coerce(f, value, `${sec}.${name}`);
      live[name] = v; // 热生效：客户端每次调用都读 config
      envUpdates[f.env] = f.type === 'bool' ? (v ? '1' : '0') : String(v);
      touched.push(sec);
    }
  }

  if (Object.keys(envUpdates).length) {
    persistEnv(envUpdates, envFile);
    // 换端点/密钥后立即以新配置探测，不让旧熔断挡路
    if (touched.includes('llm')) require('./llm/client').resetCircuit();
    if (touched.includes('embedding')) require('./embeddings/client').resetCircuit();
  }
  return get();
}

/** .env 回写：已有行就地替换，没有则追加；file 参数供测试注入临时文件 */
function persistEnv(updates, file = envPath()) {
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
    if (re.test(content)) content = content.replace(re, `${key}=${value}`);
    else content = `${content.replace(/\s*$/, '')}\n${key}=${value}\n`;
  }
  fs.writeFileSync(file, content);
}

/** 连通性测试（设置页「测试连接」按钮）。直连发最小请求，不经过客户端熔断。 */
async function probe(target) {
  const t0 = Date.now();
  const latency = () => Date.now() - t0;

  if (target === 'llm') {
    const c = config.llm;
    if (!c.enabled) return { ok: false, latencyMs: latency(), error: 'LLM 当前未启用' };
    try {
      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) },
        body: JSON.stringify({
          model: c.model,
          messages: [{ role: 'user', content: '连通性测试：只回复 ok' }],
          max_tokens: 64,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(Math.min(c.timeoutMs, 20000)),
      });
      if (!res.ok) {
        return { ok: false, latencyMs: latency(), error: `HTTP ${res.status}：${(await res.text()).slice(0, 200)}` };
      }
      const data = await res.json();
      const msg = data?.choices?.[0]?.message || {};
      // 思考模型可能把输出全放进 reasoning 而 content 为空（max_tokens 烧在思考上）——与客户端兜底同口径
      const content = typeof msg.content === 'string' && msg.content.trim() ? msg.content : msg.reasoning;
      if (typeof content !== 'string' || !content.trim()) {
        return { ok: false, latencyMs: latency(), error: '应答缺少 content 与 reasoning（模型返回异常）' };
      }
      return { ok: true, latencyMs: latency(), detail: `模型 ${c.model} 应答正常` };
    } catch (e) {
      return { ok: false, latencyMs: latency(), error: `不可达：${e.message.slice(0, 200)}` };
    }
  }

  if (target === 'embedding') {
    const c = config.embedding;
    if (!c.enabled) return { ok: false, latencyMs: latency(), error: 'Embedding 当前未启用' };
    try {
      const res = await fetch(`${c.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}) },
        body: JSON.stringify({ model: c.model, input: '连通性测试' }),
        signal: AbortSignal.timeout(Math.min(c.timeoutMs, 20000)),
      });
      if (!res.ok) {
        return { ok: false, latencyMs: latency(), error: `HTTP ${res.status}：${(await res.text()).slice(0, 200)}` };
      }
      const data = await res.json();
      const vec = data?.data?.[0]?.embedding;
      if (!Array.isArray(vec) || !vec.length) {
        return { ok: false, latencyMs: latency(), error: '应答缺少 embedding 向量' };
      }
      return { ok: true, latencyMs: latency(), detail: `模型 ${c.model} 正常，维度 ${vec.length}` };
    } catch (e) {
      return { ok: false, latencyMs: latency(), error: `不可达：${e.message.slice(0, 200)}` };
    }
  }

  throw httpError(400, `target 必须是 llm 或 embedding，收到：${target}`);
}

/** 明文查看已配置密钥（设置页「小眼睛」按需取用；GET 列表永远只给脱敏预览，不把明文常驻在响应里） */
function reveal(section) {
  const sec = FIELDS[section] ? liveSection[section] : null;
  if (!sec) throw httpError(400, `section 必须是 llm 或 embedding，收到：${section}`);
  return { apiKey: sec().apiKey || '' };
}

module.exports = { get, update, probe, reveal, persistEnv, FIELDS, _coerce: coerce, _maskKey: maskKey };
