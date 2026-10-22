'use strict';

const fs = require('fs');
const path = require('path');

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

// 存量单用户数据的归属 ID（v0.2 单用户时代的常量身份）。
// 多租户（Keycloak）模式下不再用于鉴权，仅供 scripts/migrate-owner-data.mjs 等运维脚本
// 定位旧数据；迁移完成后库中不再出现该 user_id。
const LEGACY_USER_ID = process.env.AIMEMORY_USER_ID || 'owner';

// ===== Keycloak 登录（多租户）=====
// Web 管理台经 Keycloak OIDC（授权码 + PKCE）登录，会话仍为本地 aim_session cookie；
// 机器到机器（MCP / /v1 /v2 API）继续用 m0- Token（Web 登录后在 Token 页签发）。
// KEYCLOAK_URL 缺失时 Web 登录不可用（/auth/login 明确报错），Token 鉴权不受影响。
const keycloak = {
  url: (process.env.KEYCLOAK_URL || '').replace(/\/$/, ''),
  // 默认对接 br 域（与 BR-Agent 多租户部署共用同一 realm，SSO 会话按 host 域共享）
  realm: process.env.KEYCLOAK_REALM || 'br',
  clientId: process.env.KEYCLOAK_CLIENT_ID || 'aimemory-web',
};
keycloak.enabled = Boolean(keycloak.url);
keycloak.issuer = keycloak.enabled ? `${keycloak.url}/realms/${keycloak.realm}` : null;

// ===== Embedding 语义检索 =====
// 用于 search_memories 的语义召回。指向任意 OpenAI 兼容的 /v1/embeddings 服务。
// EMBEDDING_ENABLED=1 时启用语义检索；不可用/失败时自动回退关键词检索，不影响现有调用。
const embedding = {
  enabled: process.env.EMBEDDING_ENABLED === '1',
  baseUrl: (process.env.EMBEDDING_BASE_URL || 'http://10.10.10.146:8005/v1').replace(/\/$/, ''),
  model: process.env.EMBEDDING_MODEL || '/models/Qwen3-Embedding-8B',
  apiKey: process.env.EMBEDDING_API_KEY || '',
  timeoutMs: parseInt(process.env.EMBEDDING_TIMEOUT_MS || '15000', 10),
  // 半熔断：连续失败 breakThreshold 次 → 熔断 retryMs 毫秒（期间零请求），窗口到后放行一次探测自动恢复
  breakThreshold: parseInt(process.env.EMBEDDING_BREAK_THRESHOLD || '3', 10),
  retryMs: parseInt(process.env.EMBEDDING_RETRY_MS || '60000', 10),
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

// ===== 敏感内容策略（提炼层执行，2026-10-22）=====
// 本项目定位内网自托管（LLM/Embedding 本地部署），凭据类事实默认允许按原文入库：
//   allow （默认）：密码/密钥/token 可作为事实陈述入库——部署方显式选择；
//   redact        ：提炼时把凭据脱敏为「<类型>已脱敏（存放位置: …）」，公网/多人共享部署建议启用。
// 只影响 LLM 提炼产物（infer=true）；infer=false 直存不经此策略（写入方自担）。
const SENSITIVE_MODE = (process.env.SENSITIVE_MODE || 'allow') === 'redact' ? 'redact' : 'allow';

// ===== 记忆写入：冲突消解（mem0 的 ADD/UPDATE/DELETE/NOOP 语义）=====
// 写入时与已有记忆比对（ADD/UPDATE/DELETE/NOOP），避免同一事实反复入库、新旧取值并存。
// 关闭（=0）→ 行为等价于纯追加，便于回滚。
// 上限同时是 token 预算的硬约束：单批只发 1 次 LLM 调用，输入裁剪到千级 token。
const l2 = {
  reconcile: process.env.L2_RECONCILE !== '0',
  maxFacts: parseInt(process.env.L2_MAX_FACTS || '20', 10),              // 单批最多事实条数
  maxCandidates: parseInt(process.env.L2_MAX_CANDIDATES || '6', 10),     // 每条事实召回候选数
  maxCandidatesTotal: parseInt(process.env.L2_MAX_CANDIDATES_TOTAL || '30', 10), // 候选池总量上限
  maxDeletes: parseInt(process.env.L2_MAX_DELETES || '5', 10),           // 单批删除上限（防批量误删）
  clip: parseInt(process.env.L2_CLIP || '200', 10),                      // 单条文本进 prompt 的裁剪长度
  maxTokens: parseInt(process.env.L2_MAX_TOKENS || '800', 10),           // 判定输出上限
  // 长期价值门槛（仿 Generative Agents 的 importance 1-10 评分，写入时过滤）：
  // 标注 LLM 给每条事实打分，低于阈值的不入库（宁缺毋滥，防记忆库被低价值信息污染）。
  // 4 = 明显有跨会话价值；标注失败时不过滤（fail-open，行为与旧版一致）。
  minImportance: parseInt(process.env.L2_MIN_IMPORTANCE || '4', 10),
  vec: process.env.L2_VEC !== '0',                                       // 向量索引（sqlite-vec），不可用时自动降级
};

// AIMEMORY_DB 可覆盖数据库路径（测试用独立临时库，避免污染生产数据）
const dbPath = process.env.AIMEMORY_DB || path.join(root, 'data', 'aimemory.db');

module.exports = {
  root,
  dataDir: path.dirname(dbPath),
  dbPath,
  port: parseInt(process.env.PORT || '18543', 10),
  embedding,
  llm,
  l2,
  // ===== Keycloak 登录（多租户，Web 面必配）=====
  keycloak,
  // 对外可达地址（可选）：反向代理/容器部署时 Host 头不可信，用它拼 OIDC 回调地址
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  sessionTtlMs: 7 * 24 * 3600 * 1000, // Web 会话 7 天
  mcpSessionTtlMs: 30 * 60 * 1000, // MCP session 空闲 30 分钟清理
  // /healthz 积压告警阈值：pending 达到该值判定 degraded（提炼链停摆信号）；0 = 关闭
  eventsBacklogWarn: parseInt(process.env.EVENTS_BACKLOG_WARN || '50', 10),
  // 素材原文归档保留天数（raw_materials 表；提炼是单向有损过程，原文短期可回溯）。
  // 0 = 永久保留。归档与记忆库分离：不参与检索，仅供回溯/重提，到期自动清理。
  rawArchiveDays: parseInt(process.env.RAW_ARCHIVE_DAYS || '90', 10),
  // 存量单用户数据归属（迁移脚本定位旧数据用，见 LEGACY_USER_ID 注释）
  legacyUserId: LEGACY_USER_ID,
  legacyUserName: process.env.AIMEMORY_USER_NAME || '我',
  // 敏感内容策略：allow=凭据可按原文入库（内网自托管默认）；redact=提炼时脱敏（公网/共享部署用）
  sensitiveMode: SENSITIVE_MODE,
};
