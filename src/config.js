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
  // 密钥只从 .env 读取，绝不硬编码默认值（历史教训见 docs/复盘-2026-09-19-剪枝.md）
  apiKey: process.env.LLM_API_KEY || '',
  timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10),
};

// ===== L2 事实记忆：冲突消解与派生（详见 docs/L2-事实记忆与冲突消解.md）=====
// reconcile：写入时与已有记忆比对（ADD/UPDATE/DELETE/NOOP），避免同一事实反复入库、新旧取值并存。
// derive：从 L1 会话摘要派生事实，补齐「上层可从 L0 重放」的派生链。
// 两者都可单独关闭（=0）→ 行为等价于改动前（纯追加），便于回滚。
// 下面的上限同时是 token 预算的硬约束：单批只发 1 次 LLM 调用，输入裁剪到千级 token。
const l2 = {
  reconcile: process.env.L2_RECONCILE !== '0',
  derive: process.env.L2_DERIVE !== '0',
  maxFacts: parseInt(process.env.L2_MAX_FACTS || '20', 10),              // 单批最多事实条数
  maxCandidates: parseInt(process.env.L2_MAX_CANDIDATES || '6', 10),     // 每条事实召回候选数
  maxCandidatesTotal: parseInt(process.env.L2_MAX_CANDIDATES_TOTAL || '30', 10), // 候选池总量上限
  maxDeletes: parseInt(process.env.L2_MAX_DELETES || '5', 10),           // 单批删除上限（防批量误删）
  clip: parseInt(process.env.L2_CLIP || '200', 10),                      // 单条文本进 prompt 的裁剪长度
  maxTokens: parseInt(process.env.L2_MAX_TOKENS || '800', 10),           // 判定输出上限
  vec: process.env.L2_VEC !== '0',                                       // 向量索引（sqlite-vec），不可用时自动降级
  quietMs: parseInt(process.env.L2_QUIET_MS || String(5 * 60 * 1000), 10), // 派生：L1 摘要再静默多久才处理
  batch: parseInt(process.env.L2_BATCH || '6', 10),                      // 派生：每轮处理几个会话
  maxAttempts: parseInt(process.env.L2_MAX_ATTEMPTS || '3', 10),         // 派生：单会话重试上限
  intervalMs: parseInt(process.env.L2_INTERVAL_MS || '60000', 10),       // 派生：轮询间隔
};

// ===== L3 画像／知识（第一阶段，见 docs/L3-画像与知识层.md）=====
// 低频是硬要求：攒够 batchNew 个新消化会话才凝练一轮（摊到每会话 <1K token）。
// 条目本体存 data/l3/ 的 markdown（人工可编辑），SQLite 只存游标（l3_state）。
const l3 = {
  derive: process.env.L3_DERIVE !== '0',
  batchNew: parseInt(process.env.L3_BATCH_NEW || '5', 10),               // 攒够几个新会话才跑一轮
  maxSummaries: parseInt(process.env.L3_MAX_SUMMARIES || '8', 10),       // 单轮最多带几个摘要
  maxEntries: parseInt(process.env.L3_MAX_ENTRIES || '20', 10),          // 单轮最多带几条现有条目
  maxFactsSample: parseInt(process.env.L3_MAX_FACTS_SAMPLE || '10', 10), // L2 事实采样条数（仅作凝练背景）
  factClip: parseInt(process.env.L3_FACT_CLIP || '80', 10),              // 采样事实单条裁剪
  clip: parseInt(process.env.L3_CLIP || '300', 10),                      // 摘要单条裁剪
  entryClip: parseInt(process.env.L3_ENTRY_CLIP || '120', 10),           // 现有条目单条裁剪
  maxTokens: parseInt(process.env.L3_MAX_TOKENS || '600', 10),           // 凝练输出上限
  halfLifeDays: parseInt(process.env.L3_HALF_LIFE_DAYS || '180', 10),    // 置信度半衰期（天），≤0 = 关衰减
  intervalMs: parseInt(process.env.L3_INTERVAL_MS || String(10 * 60 * 1000), 10), // 轮询间隔
};

// AIMEMORY_DB 可覆盖数据库路径（测试用独立临时库，避免污染生产数据）
const dbPath = process.env.AIMEMORY_DB || path.join(root, 'data', 'aimemory.db');

module.exports = {
  root,
  dataDir: path.dirname(dbPath),
  dbPath,
  // L0 原始会话归档目录（append-only jsonl，按 用户/agent/会话 分文件；不参与提炼）
  l0Dir: process.env.AIMEMORY_L0_DIR || path.join(path.dirname(dbPath), 'l0'),
  // L3 画像／知识目录（markdown，人工可编辑；AIMEMORY_DB 覆盖时测试自动隔离）
  l3Dir: process.env.AIMEMORY_L3_DIR || path.join(path.dirname(dbPath), 'l3'),
  // L0 上传批次体积上限（原始会话批次远大于普通 API 请求，单独放宽）
  l0MaxBody: process.env.AIMEMORY_L0_MAX_BODY || '64mb',
  port: parseInt(process.env.PORT || '18543', 10),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  embedding,
  llm,
  l2,
  l3,
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
  // /healthz 积压告警阈值：pending 达到该值判定 degraded（提炼链停摆信号）；0 = 关闭
  eventsBacklogWarn: parseInt(process.env.EVENTS_BACKLOG_WARN || '50', 10),
  // 供测试直接验证口令生成逻辑（生产路径已在模块加载时调用过）
  _ensurePassword: ensurePassword,
};
