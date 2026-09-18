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

-- 注：早期版本的 memories_history（记忆修改时间线）已废弃——此处不再建表，
-- 由下方 v0.2 瘦身迁移 DROP 掉。曾出现「同一文件里先 CREATE 又 DROP」的自相矛盾写法。

-- API Token：token_hash 用于鉴权校验，token_plain 供 Web 端随时回看明文
-- （明文需长期可查，故与哈希一并存储；名称由调用方强制提供，不设默认值）
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  token_plain TEXT,
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

-- L1 会话摘要（情景记忆）：每个归档会话一条，由后台 LLM 从 L0 归档生成。
-- 与 L0 的关系：L0 是事实源、只追加；L1 是可再生的派生视图——清掉某行的
-- content_hash 即会重新生成（想换摘要算法就从 L0 重跑）。故这里不存原文。
CREATE TABLE IF NOT EXISTS l1_summaries (
  user_id      TEXT NOT NULL,
  device_code  TEXT NOT NULL,
  agent        TEXT NOT NULL,            -- codex / claude / zcode
  session_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
  content_hash TEXT,                     -- 收敛后内容的指纹：变了才需重跑
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  overview     TEXT,                     -- 摘要正文
  decisions    TEXT,                     -- JSON 数组：关键决定
  pending      TEXT,                     -- JSON 数组：未决事项
  artifacts    TEXT,                     -- JSON 数组：产出物
  records      INTEGER,                  -- 参与摘要的收敛后记录数
  first_ts     TEXT,                     -- 会话时间跨度
  last_ts      TEXT,
  model        TEXT,                     -- 生成所用模型
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, device_code, agent, session_id)
);
CREATE INDEX IF NOT EXISTS idx_l1_user_time ON l1_summaries(user_id, last_ts DESC);
CREATE INDEX IF NOT EXISTS idx_l1_status ON l1_summaries(status, updated_at);

-- L0 已收记录索引：按 (会话, rid, version) 去重。
-- 为什么不能只靠批次指纹：指纹对整个批次内容敏感，同一批记录若因分块方式不同
-- （批大小调整、记录顺序变化）算出不同指纹，服务端就会重复落盘同样的记录。
-- L0 允许同一 rid 的多个**版本**（ZCode 会原地更新，靠版本号收敛），
-- 但完全相同的 (rid, version) 是纯冗余，在此拦掉。
CREATE TABLE IF NOT EXISTS l0_records (
  user_id     TEXT NOT NULL,
  device_code TEXT NOT NULL,
  agent       TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  rid         TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, device_code, agent, session_id, rid, version)
) WITHOUT ROWID;

-- L0 设备注册表：每台采集机器一条，承载设备信息（归类与跨机查询的依据）
CREATE TABLE IF NOT EXISTS l0_devices (
  user_id      TEXT NOT NULL,
  device_code  TEXT NOT NULL,             -- 稳定设备码（dev_xxxxxxxx；可由指纹认回）
  fingerprint  TEXT,                      -- 机器指纹（加盐哈希，机器固有属性推导）——认回同一台设备
  fingerprint_source TEXT,                -- 指纹来源：machine-id / mac / hostname / random
  label        TEXT,                      -- 人类可读名（默认主机名，可自定义）
  info         TEXT,                      -- JSON：hostname/platform/arch/os/node/cpus/mem/user…
  agents       TEXT,                      -- JSON 数组：该设备上报过的 agent
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  PRIMARY KEY (user_id, device_code)
);
CREATE INDEX IF NOT EXISTS idx_l0_devices_user ON l0_devices(user_id, last_seen);
-- 指纹索引在下方老库迁移补列之后再建（老库无 fingerprint 列时在此建索引会失败）

-- L0 原始会话归档：批次去重表（幂等重传用）。
-- 原始记录本体不落 SQLite（体量大且 append-only），存 data/l0/ 下的 jsonl 文件；
-- 本表只记批次指纹，重复上传同一批次直接跳过。
CREATE TABLE IF NOT EXISTS l0_batches (
  batch_id     TEXT PRIMARY KEY,          -- sha256(设备|agent|会话|记录集)
  user_id      TEXT NOT NULL,
  agent        TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  device_code  TEXT,
  collector_id TEXT,
  records      INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  received_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_l0_batches_user ON l0_batches(user_id, received_at);
CREATE INDEX IF NOT EXISTS idx_l0_batches_session ON l0_batches(session_id);
-- 注意：设备维度索引在下方老库迁移补列之后再建（老库无 device_code 时建索引会失败）

-- L2 冲突消解审计：每次「新事实 vs 已有记忆」的判定都留痕；DELETE 另记被删文本（误删可复原）。
-- 为什么不加列到 memories 上：memories 是可从 L1/L0 重派生的视图，审计是过程记录，
-- 生命周期与用途都不同；且加列需要迁移存量库。详见 docs/L2-事实记忆与冲突消解.md。
CREATE TABLE IF NOT EXISTS memory_ops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  memory_id   TEXT,                        -- 目标记忆（ADD=新建；UPDATE/DELETE/NOOP=命中的已有）
  op          TEXT NOT NULL,               -- ADD | UPDATE | DELETE | NOOP
  before_text TEXT,                        -- UPDATE/DELETE 的旧文本（复原依据）
  after_text  TEXT,                        -- ADD/UPDATE 的新文本
  candidates  TEXT,                        -- JSON：本次判定可见的候选记忆 id（复盘判定依据）
  source      TEXT NOT NULL,               -- add_memory | l1:<agent>/<session> | manual
  applied     INTEGER NOT NULL DEFAULT 1,  -- 0=判定为 DELETE 但被安全阀拦下（便于观察模型倾向）
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_ops_user ON memory_ops(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_memory_ops_memory ON memory_ops(memory_id);

-- L2 派生状态（L1 摘要 → 事实）：与 l1_summaries 同构的物化状态 + content_hash 幂等，
-- 摘要没变就不重复派生（省 LLM 调用），变了才重跑。可整表清空后从 L1 重放。
CREATE TABLE IF NOT EXISTS l2_sources (
  user_id      TEXT NOT NULL,
  device_code  TEXT NOT NULL,
  agent        TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
  content_hash TEXT,                             -- L1 摘要内容指纹
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  added        INTEGER NOT NULL DEFAULT 0,
  updated      INTEGER NOT NULL DEFAULT 0,
  deleted      INTEGER NOT NULL DEFAULT 0,
  noop         INTEGER NOT NULL DEFAULT 0,
  model        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, device_code, agent, session_id)
);
CREATE INDEX IF NOT EXISTS idx_l2_sources_status ON l2_sources(status, updated_at);

-- L2 内部元数据（键值）：目前存向量索引维度。
-- vec0 表的维度不可变更，换 embedding 模型（维度变了）必须重建索引——
-- 记在这里就能在启动时发现不匹配并明确降级，而不是静默返回错结果。
CREATE TABLE IF NOT EXISTS l2_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- L3 凝练游标：记「消化到哪个 L2 派生了」（last_consumed = l2_sources 的最大 updated_at）。
-- L3 的条目本体在 data/l3/ 的 markdown 文件里（人工可编辑），SQLite 只存游标与运行时间。
CREATE TABLE IF NOT EXISTS l3_state (
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

// 老库兼容：api_keys 早期只存哈希 → 补 token_plain 列。
// 历史 Token 的明文无法从哈希逆推，该列留空，前端会提示吊销后重建。
const apiKeyCols = db.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name);
if (!apiKeyCols.includes('token_plain')) {
  db.exec('ALTER TABLE api_keys ADD COLUMN token_plain TEXT');
}

// 老库兼容：l0_batches 早期无 device_code 列 → 补充（历史行留空，列表里显示为"未标注"）
const l0Cols = db.prepare("PRAGMA table_info(l0_batches)").all().map((c) => c.name);
if (!l0Cols.includes('device_code')) {
  db.exec('ALTER TABLE l0_batches ADD COLUMN device_code TEXT');
}
// 设备维度索引须在补列之后创建（见上）
db.exec('CREATE INDEX IF NOT EXISTS idx_l0_batches_device ON l0_batches(user_id, device_code, agent)');

// 老库兼容：l0_devices 早期无指纹列 → 补充（历史设备无指纹，无法自动认回，
// 采集器下次上报时会带上并回填）
const devCols = db.prepare('PRAGMA table_info(l0_devices)').all().map((c) => c.name);
if (!devCols.includes('fingerprint')) {
  db.exec('ALTER TABLE l0_devices ADD COLUMN fingerprint TEXT');
}
if (!devCols.includes('fingerprint_source')) {
  db.exec('ALTER TABLE l0_devices ADD COLUMN fingerprint_source TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_l0_devices_fp ON l0_devices(user_id, fingerprint)');

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
