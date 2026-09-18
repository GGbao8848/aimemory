'use strict';

/**
 * 采集器配置。
 *
 * 优先级：环境变量 > 配置文件（默认 ~/.aimemory-collector/config.json）。
 * 配置文件由安装流程（skill / connect）写入，含服务端地址与本机 Token。
 *
 * 采集器是"死程序"：它只知道「从哪读、往哪传」，不知道对方是哪种 agent
 * （那是 adapter 的事），也不做任何提炼/embedding。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DIR = path.join(os.homedir(), '.aimemory-collector');
const DEFAULT_CONFIG = path.join(DEFAULT_DIR, 'config.json');

function loadConfigFile() {
  const p = process.env.AIMEMORY_COLLECTOR_CONFIG || DEFAULT_CONFIG;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function buildConfig() {
  const file = loadConfigFile();
  const stateDir = process.env.AIMEMORY_COLLECTOR_DIR || file.state_dir || DEFAULT_DIR;
  const agents = process.env.AIMEMORY_COLLECTOR_AGENTS
    ? process.env.AIMEMORY_COLLECTOR_AGENTS.split(',').map((s) => s.trim()).filter(Boolean)
    : file.agents || ['codex', 'claude', 'zcode'];

  return {
    stateDir,
    configPath: process.env.AIMEMORY_COLLECTOR_CONFIG || DEFAULT_CONFIG,
    // 服务端
    serverUrl: (process.env.AIMEMORY_SERVER_URL || file.server_url || 'http://10.10.10.169:18543').replace(/\/$/, ''),
    token: process.env.AIMEMORY_TOKEN || file.token || '',
    collectorId: process.env.AIMEMORY_COLLECTOR_ID || file.collector_id || os.hostname(),
    // 采集范围
    agents,
    // 节奏
    pollIntervalMs: parseInt(process.env.AIMEMORY_POLL_MS || file.poll_interval_ms || '15000', 10),
    maxRecordsPerBatch: parseInt(process.env.AIMEMORY_BATCH_RECORDS || file.max_records_per_batch || '500', 10),
    maxBatchBytes: parseInt(process.env.AIMEMORY_BATCH_BYTES || file.max_batch_bytes || String(4 * 1024 * 1024), 10),
    // 队列积压上限（批次）：超过则本轮只上传不采集（背压），避免 state.json 无限膨胀
    maxQueuedBatches: parseInt(process.env.AIMEMORY_MAX_QUEUED || file.max_queued_batches || '300', 10),
    // 保留原始行（L0 是事实源；关掉可省约一半体积，但会丢字段）
    keepRaw: process.env.AIMEMORY_KEEP_RAW ? process.env.AIMEMORY_KEEP_RAW === '1' : file.keep_raw !== false,
    // 目录覆盖（测试 / 非标准安装）
    paths: {
      codex: process.env.CODEX_HOME || file.paths?.codex || path.join(os.homedir(), '.codex'),
      claude: process.env.CLAUDE_CONFIG_DIR || file.paths?.claude || path.join(os.homedir(), '.claude'),
      zcode: process.env.ZCODE_HOME || file.paths?.zcode || path.join(os.homedir(), '.zcode'),
    },
    // 上传重试
    retry: {
      maxAttempts: parseInt(process.env.AIMEMORY_RETRY_MAX || '5', 10),
      baseDelayMs: parseInt(process.env.AIMEMORY_RETRY_BASE_MS || '1000', 10),
      maxDelayMs: parseInt(process.env.AIMEMORY_RETRY_MAX_MS || '60000', 10),
    },
  };
}

module.exports = { buildConfig, DEFAULT_DIR, DEFAULT_CONFIG };
