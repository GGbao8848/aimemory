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
`);

// 老库兼容：sessions 表早期无 username 列 → 补充（幂等）
const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
if (!sessionCols.includes('username')) {
  db.exec('ALTER TABLE sessions ADD COLUMN username TEXT');
}

module.exports = db;
