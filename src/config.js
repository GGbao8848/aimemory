'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');

// 加载 .env（不存在则从 .env.example 复制）
function loadEnv() {
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(path.join(root, '.env.example'), envPath);
  }
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

loadEnv();

// 身份常量：单用户模式下所有数据归属这一个身份，由 MCP 的 instructions / Web 展示使用
const USER_ID = process.env.AIMEMORY_USER_ID || 'owner';

/**
 * 本地登录口令：缺失或为空时自动生成强口令并写回 .env。
 * 与旧 SESSION_SECRET 的坑同理——不能只看「.env 里有没有 AIMEMORY_PASSWORD= 这行」，
 * 空值也会被 loadEnv 读进来，若不回填则每次重启都会换口令、且旧口令无从得知。
 *
 * @param {string} file 目标 .env 路径
 * @param {string|undefined} current 当前生效值（非空则直接返回 null，不生成）
 * @returns {string|null} 生成的口令，或 null（无需生成）
 */
function ensurePassword(file, current) {
  if (current) return null;
  const generated = crypto.randomBytes(16).toString('base64url');
  let content = fs.readFileSync(file, 'utf8');
  if (/^\s*AIMEMORY_PASSWORD\s*=/m.test(content)) {
    // 已有该行（可能是空值）→ 就地替换，避免重复追加
    content = content.replace(/^\s*AIMEMORY_PASSWORD\s*=.*$/m, `AIMEMORY_PASSWORD=${generated}`);
  } else {
    content = `${content.replace(/\s*$/, '')}\nAIMEMORY_PASSWORD=${generated}\n`;
  }
  fs.writeFileSync(file, content);
  return generated;
}
const generatedPassword = ensurePassword(envPath, process.env.AIMEMORY_PASSWORD);
if (generatedPassword) process.env.AIMEMORY_PASSWORD = generatedPassword;

// ===== Embedding 语义检索 =====
// 用于 search_memories 的语义召回。指向任意 OpenAI 兼容的 /v1/embeddings 服务。
// EMBEDDING_ENABLED=1 时启用语义检索；不可用/失败时自动回退关键词检索，不影响现有调用。
const embedding = {
  enabled: process.env.EMBEDDING_ENABLED === '1',
  baseUrl: (process.env.EMBEDDING_BASE_URL || 'http://10.10.10.146:8005/v1').replace(/\/$/, ''),
  model: process.env.EMBEDDING_MODEL || '/models/Qwen3-Embedding-8B',
  apiKey: process.env.EMBEDDING_API_KEY || '',
  timeoutMs: parseInt(process.env.EMBEDDING_TIMEOUT_MS || '15000', 10),
};

// ===== LLM（infer 事实抽取，P0-2）=====
// 用于 add_memory 的 infer：把自由文本提炼成结构化事实，增强语义召回。
// 对话模型端点（chat/completions），失败时不影响原样入库。
const llm = {
  enabled: process.env.LLM_ENABLED === '1',
  baseUrl: (process.env.LLM_BASE_URL || 'http://10.10.10.146:8001/v1').replace(/\/$/, ''),
  model: process.env.LLM_MODEL || 'qwen3.8-27b',
  apiKey: process.env.LLM_API_KEY || 'dc5bcb91f400e8b3b40d9156ddc9a1ef60c2ea953f46f359',
  timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10),
};

// AIMEMORY_DB 可覆盖数据库路径（测试用独立临时库，避免污染生产数据）
const dbPath = process.env.AIMEMORY_DB || path.join(root, 'data', 'aimemory.db');

module.exports = {
  root,
  dataDir: path.dirname(dbPath),
  dbPath,
  // L0 原始会话归档目录（append-only jsonl，按 用户/agent/会话 分文件；不参与提炼）
  l0Dir: process.env.AIMEMORY_L0_DIR || path.join(path.dirname(dbPath), 'l0'),
  // L0 上传批次体积上限（原始会话批次远大于普通 API 请求，单独放宽）
  l0MaxBody: process.env.AIMEMORY_L0_MAX_BODY || '64mb',
  port: parseInt(process.env.PORT || '18543', 10),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  embedding,
  llm,
  // ===== 单用户身份（个人部署） =====
  // 所有数据归属这一个身份；不存在多用户/租户概念。
  // 默认 'owner'：全新的个人部署直接用默认值即可，无需配置。
  userId: USER_ID,
  userName: process.env.AIMEMORY_USER_NAME || '我',
  // 本地登录口令（Web 管理页）；首次启动自动生成并写回 .env
  password: process.env.AIMEMORY_PASSWORD,
  passwordGenerated: generatedPassword, // 非空表示本次是自动生成，启动时提示用户
  sessionTtlMs: 7 * 24 * 3600 * 1000, // Web 会话 7 天
  mcpSessionTtlMs: 30 * 60 * 1000, // MCP session 空闲 30 分钟清理
  // 供测试直接验证口令生成逻辑（生产路径已在模块加载时调用过）
  _ensurePassword: ensurePassword,
};
