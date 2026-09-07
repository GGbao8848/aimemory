'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  text       TEXT NOT NULL,
  metadata   TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, updated_at);

-- FTS5 trigram 分词：支持中文/英文子串检索（查询 >= 3 字符）
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- 记忆修改历史（update/delete 前快照，供 get_memory 返回时间线）
CREATE TABLE IF NOT EXISTS memories_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  event_type    TEXT NOT NULL,            -- UPDATE | DELETE
  prev_text     TEXT NOT NULL,
  prev_metadata TEXT NOT NULL,
  prev_updated_at TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_memory ON memories_history(memory_id, id);

-- API Key（只存 sha256 哈希，明文不落库）
CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT 'default',
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
-- 硬约束：同一用户未吊销的密钥名称必须唯一（重名创建直接报错；吊销后可复用）
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_name ON api_keys(user_id, name) WHERE revoked_at IS NULL;

-- 单 key 策略：每个用户同时最多一条生效密钥。旧 key 由 repo.createApiKey 自动吊销（轮换），
-- 此唯一索引兜底防并发双写，防止历史数据/旁路插入出现一人多 key。
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_active ON api_keys(user_id) WHERE revoked_at IS NULL;

-- Web 登录会话（Keycloak 登录成功后建立，HttpOnly cookie 引用 sid）
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  username   TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- 连接码（半自动连接：浏览器授权 → 生成短码 + 明文 token 暂存 → 插件兑换写配置）
CREATE TABLE IF NOT EXISTS connect_codes (
  code          TEXT PRIMARY KEY,          -- 短码 XXXX-XXXX
  user_id       TEXT NOT NULL,
  api_key_id    TEXT NOT NULL,
  token_plain   TEXT NOT NULL,             -- 明文 m0-xxx，仅 TTL 窗口内存在
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  consumed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_connect_codes_user ON connect_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_connect_codes_expiry ON connect_codes(expires_at);

-- 设备流连接请求（零粘贴：agent 发起 → 授权页确认 → 轮询拿 key）
CREATE TABLE IF NOT EXISTS connect_requests (
  request_id    TEXT PRIMARY KEY,          -- 32 位随机（agent 轮询凭据）
  user_id       TEXT,                      -- 确认授权的登录用户（pending 时为空）
  key_name      TEXT,                      -- 授权时命名（可选）
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | authorized | expired
  api_key_id    TEXT,
  token_plain   TEXT,                      -- 明文 m0-xxx，确认后生成
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  confirmed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_connect_requests_user ON connect_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_connect_requests_expiry ON connect_requests(expires_at);

-- 异步任务（add_memory(messages) 异步受理：立即返回 event_id，后台串行提炼入库）
-- 本地 LLM 并发低，messages 提炼不可阻塞 MCP 调用，故走任务队列（默认 2s 轮询处理）
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  event_type  TEXT NOT NULL DEFAULT 'add_memory',
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | done | failed
  payload     TEXT NOT NULL,            -- JSON：请求内容（后台执行用）
  result      TEXT,                     -- JSON：成功结果（记忆 id 列表）
  error       TEXT,                     -- 失败原因
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at);
`);

// 老库兼容：sessions 表早期无 username 列 → 补充（幂等）
const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
if (!sessionCols.includes('username')) {
  db.exec('ALTER TABLE sessions ADD COLUMN username TEXT');
}

// 老库兼容：memories 早期无 embedding / facts / entities 列 → 补充
// （float32 BLOB 向量 / infer 抽取的结构化事实 / LLM 抽取的实体，均为可空列）
const memCols = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
if (!memCols.includes('embedding')) {
  db.exec('ALTER TABLE memories ADD COLUMN embedding BLOB');
}
if (!memCols.includes('facts')) {
  db.exec("ALTER TABLE memories ADD COLUMN facts TEXT");
}
if (!memCols.includes('entities')) {
  db.exec("ALTER TABLE memories ADD COLUMN entities TEXT");
}

// 老库兼容：connect_requests 早期无 confirm_token 列 → 补充（设备流自动确认用：agent 侧随机令牌，
// 拼进 authorize_url，/connect 页校验匹配后免按钮自动授权；无该令牌的请求回退到手动确认页）
const crCols = db.prepare('PRAGMA table_info(connect_requests)').all().map((c) => c.name);
if (!crCols.includes('confirm_token')) {
  db.exec('ALTER TABLE connect_requests ADD COLUMN confirm_token TEXT');
}

// ===== 瘦身迁移（v0.2：对标 mem0 核心，去掉冗余机制）=====
// 删除项：connect_codes（半自动连接旧方案，已被设备流取代）、memories_history（修改时间线，非核心）、
// agent_id/run_id 作用域（只留员工维度）、archived/last_access_at/access_count（TTL 归档与活跃度加权）。
// events 表保留复用：作为 messages 异步提炼的任务队列（本地 LLM 并发低，add_memory(messages) 异步受理）。
// 老库若仍带上述列（v0.1 曾建）直接 DROP 对应列即可；数据在部署前已通过快照备份（data/backup-*.db），
// 此处幂等、可重复执行。
db.exec(`
  DROP TABLE IF EXISTS connect_codes;
  DROP TABLE IF EXISTS memories_history;
  DROP INDEX IF EXISTS idx_memories_scope;
  DROP INDEX IF EXISTS idx_memories_active;
`);

const memCols2 = db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name);
for (const col of ['agent_id', 'run_id', 'archived', 'last_access_at', 'access_count']) {
  if (memCols2.includes(col)) {
    db.exec(`ALTER TABLE memories DROP COLUMN ${col}`);
  }
}

module.exports = db;
