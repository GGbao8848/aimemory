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
