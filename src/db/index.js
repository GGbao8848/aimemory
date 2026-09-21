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
  agent_id   TEXT,
  run_id     TEXT,
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

-- API Token：只存 token_hash（sha256）用于鉴权校验。
-- 明文仅在创建响应里返回一次（G3，2026-09-19）：库文件被读走也不再等于 Token 全泄。
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
-- 硬约束：同一用户未吊销的密钥名称必须唯一（重名创建直接报错；吊销后可复用）
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_name ON api_keys(user_id, name) WHERE revoked_at IS NULL;

-- 迁移：旧版「一人最多一条生效密钥」的硬约束已随多 Token 策略移除（幂等 DROP 兼容存量库）
DROP INDEX IF EXISTS idx_api_keys_user_active;

-- Web 登录会话（本地口令登录成功后建立，HttpOnly cookie 引用 sid）
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  username   TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- 异步任务（add 收到 messages/素材后异步受理：立即返回 event_id，后台串行提炼入库）
-- 本地 LLM 并发低，提炼不可阻塞调用方，故走任务队列（默认 2s 轮询处理）
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

-- 记忆变更历史（mem0 语义的 history：ADD/UPDATE/DELETE 每次都留痕）。
-- old/new_memory 对应变更前后文本；input 是触发变更的素材（仅 ADD 有，UPDATE/DELETE 为空）。
CREATE TABLE IF NOT EXISTS memory_ops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  memory_id   TEXT,                        -- 目标记忆（ADD=新建；UPDATE/DELETE/NOOP=命中的已有）
  op          TEXT NOT NULL,               -- ADD | UPDATE | DELETE | NOOP
  before_text TEXT,                        -- UPDATE/DELETE 的旧文本（复原依据）
  after_text  TEXT,                        -- ADD/UPDATE 的新文本
  candidates  TEXT,                        -- JSON：本次判定可见的候选记忆 id（复盘判定依据）
  source      TEXT NOT NULL,               -- add_memory | reconcile | manual
  applied     INTEGER NOT NULL DEFAULT 1,  -- 0=判定为 DELETE 但被安全阀拦下（便于观察模型倾向）
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_ops_user ON memory_ops(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_memory_ops_memory ON memory_ops(memory_id);

-- 内部元数据（键值）：目前存向量索引维度。
-- vec0 表的维度不可变更，换 embedding 模型（维度变了）必须重建索引——
-- 记在这里就能在启动时发现不匹配并明确降级，而不是静默返回错结果。
CREATE TABLE IF NOT EXISTS l2_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

// 老库兼容：sessions 表早期无 username 列 → 补充（幂等）
const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
if (!sessionCols.includes('username')) {
  db.exec('ALTER TABLE sessions ADD COLUMN username TEXT');
}

// G3 迁移（2026-09-19）：api_keys 不再存明文——老库清空并删除 token_plain 列。
// 校验只走 token_hash，已有 Token 全部继续可用；「随时回看」由「创建时一次性展示」替代。
const apiKeyCols = db.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name);
if (apiKeyCols.includes('token_plain')) {
  db.exec('UPDATE api_keys SET token_plain = NULL');
  db.exec('ALTER TABLE api_keys DROP COLUMN token_plain');
}

// 老库兼容：memories 早期无 embedding / facts / entities 列 → 补充
// （float32 BLOB 向量 / infer 抽取的结构化事实 / LLM 抽取的实体，均为可空列）
const memCols = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
for (const col of ['embedding', 'facts', 'entities', 'agent_id', 'run_id']) {
  if (!memCols.includes(col)) {
    db.exec(col === 'embedding'
      ? 'ALTER TABLE memories ADD COLUMN embedding BLOB'
      : `ALTER TABLE memories ADD COLUMN ${col} TEXT`);
  }
}

// 记忆来源标记（2026-09-20）：direct=文本直接存储（不经 LLM）；llm=LLM 提炼（向量未建）；
// llm+embedding=LLM 提炼且向量已建。向量补齐成功后由写入层把 llm 升级为 llm+embedding。
if (!memCols.includes('origin')) {
  db.exec('ALTER TABLE memories ADD COLUMN origin TEXT');
}
// 存量回填：本库的记忆全部来自旧素材提炼管线（LLM 产物），按有无向量定级；新写入都会显式带 origin
db.exec("UPDATE memories SET origin = CASE WHEN embedding IS NOT NULL THEN 'llm+embedding' ELSE 'llm' END WHERE origin IS NULL");

// ===== 实体与分类（对齐 mem0 平台，2026-09-20）=====
// categories：memories 上的 JSON 数组列（1-2 个小写类别词，如 tech/devops）。
// entities：归一化聚合表（供实体列表/过滤/计数），memories.entities 仍存每条记忆的实体快照。
if (!memCols.includes('categories')) {
  db.exec('ALTER TABLE memories ADD COLUMN categories TEXT');
}
// 长期价值评分（1-10，写入时由标注 LLM 打分；低于 L2_MIN_IMPORTANCE 的不入库）
if (!memCols.includes('importance')) {
  db.exec('ALTER TABLE memories ADD COLUMN importance INTEGER');
}
// 溯源：这条记忆提炼自哪份素材（raw_materials/events 的 id）。重提 = 删同源记忆 + 按原文重跑。
// 直存（infer=false）与手工添加的记忆无溯源，重提永不触碰。
if (!memCols.includes('raw_event_id')) {
  db.exec('ALTER TABLE memories ADD COLUMN raw_event_id TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_memories_raw_event ON memories(raw_event_id)');
db.exec(`
CREATE TABLE IF NOT EXISTS entities (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,              -- 展示名（首见写法）
  norm       TEXT NOT NULL,              -- 归一化键（小写去空白），查重/过滤用
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_user_norm ON entities(user_id, norm);
CREATE INDEX IF NOT EXISTS idx_entities_user ON entities(user_id);

CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id);

-- Webhooks（对齐 mem0 平台）：记忆变更（ADD/UPDATE/DELETE）实时通知外部系统。
-- secret 用于 HMAC-SHA256 签名（X-Aimemory-Signature 头）；投递日志留在 webhook_deliveries。
CREATE TABLE IF NOT EXISTS webhooks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  url         TEXT NOT NULL,
  description TEXT,
  secret      TEXT NOT NULL,
  events      TEXT NOT NULL DEFAULT '["ADD","UPDATE","DELETE"]', -- JSON 数组，订阅的操作类型
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id);

-- 素材原文归档（提炼是单向有损过程；原文短期落档供回溯/重提，按 RAW_ARCHIVE_DAYS 到期清理）。
-- 与 memories 分离：不参与检索与消解，不会"弄脏"记忆库。
CREATE TABLE IF NOT EXISTS raw_materials (
  id         TEXT PRIMARY KEY,            -- 与 events.id 一致（受理即归档）
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,               -- text | messages
  input      TEXT NOT NULL,               -- 原文（text 为字符串；messages 为 JSON 数组）
  metadata   TEXT,                        -- 受理时的 metadata（重提时还原）
  agent_id   TEXT,
  run_id     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_materials_user ON raw_materials(user_id, created_at);


CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  op         TEXT NOT NULL,
  memory_id  TEXT,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL,               -- ok | failed
  status_code INTEGER,
  attempts   INTEGER NOT NULL DEFAULT 1,
  error      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries(webhook_id, id DESC);
`);

// ===== 瘦身迁移（mem0 形态收敛，2026-09-19）=====
// 裁掉 L0 采集 / L1 摘要 / L3 画像 / 设备流授权整条链（详见 docs/项目规划.md 转向定论）：
// memories 主表 + 提炼队列 + 冲突消解历史 + 向量索引 即 mem0 核心，其余层全部退役。
// 相关表 DROP 幂等可重复执行；data/l0、data/l3 目录文件留盘不删（用户可自行归档）。
db.exec(`
  DROP TABLE IF EXISTS l0_records;
  DROP TABLE IF EXISTS l0_devices;
  DROP TABLE IF EXISTS l0_batches;
  DROP TABLE IF EXISTS l1_summaries;
  DROP TABLE IF EXISTS l2_sources;
  DROP TABLE IF EXISTS l3_state;
  DROP TABLE IF EXISTS connect_codes;
  DROP TABLE IF EXISTS connect_requests;
  DROP TABLE IF EXISTS memories_history;
`);

module.exports = db;

// 老库兼容：raw_materials 早期无 metadata/agent_id/run_id 列 → 补充（幂等）
const rawCols = db.prepare("PRAGMA table_info(raw_materials)").all().map((c) => c.name);
for (const col of ['metadata', 'agent_id', 'run_id']) {
  if (!rawCols.includes(col)) {
    db.exec(`ALTER TABLE raw_materials ADD COLUMN ${col} TEXT`);
  }
}
