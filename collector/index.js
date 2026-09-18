'use strict';

/**
 * aimemory L0 采集器（监察者客户端）。
 *
 * 定位：常驻的"死程序"——只做「按固定 schema 采集原始会话 → 上传」，
 * 不参与 LLM 提炼、不做 embedding、不解析语义。原始会话是 L0 事实源，
 * 后续 L1/L2 从服务端归档重放生成。
 *
 * 用法：
 *   node collector/index.js            常驻（pm2 托管）
 *   node collector/index.js --once     只跑一轮（cron / 手动 / 测试）
 *   node collector/index.js --status   打印采集与队列状态
 *
 * 可靠性设计（"不丢不重"）：
 *   - 游标与待传队列一起落盘，崩溃重启从断点继续；
 *   - 上传幂等（批次指纹），重传不重复落盘；
 *   - 离线积压，恢复后按序补传；
 *   - 采集失败/解析异常计数上报，不静默。
 */

const os = require('os');
const { buildConfig } = require('./config');
const { State } = require('./lib/state');
const { Uploader } = require('./lib/uploader');
const { loadOrCreateDevice } = require('./lib/device');

const ADAPTERS = {
  codex: require('./adapters/codex'),
  claude: require('./adapters/claude'),
  zcode: require('./adapters/zcode'),
};

/** 把一批记录切成多个批次（受条数/字节双限） */
function chunkRecords(records, { maxRecords, maxBytes }) {
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const r of records) {
    const size = Buffer.byteLength(JSON.stringify(r));
    if (cur.length && (cur.length >= maxRecords || curBytes + size > maxBytes)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(r);
    curBytes += size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

class Collector {
  constructor(config) {
    this.config = config;
    this.state = new State(config.stateDir);
    // 设备身份：每条上传数据都带 (设备码, 设备信息, agent)，服务端据此归类，
    // 这样在任意一台机器上都能查到"另一台机器做了什么"。
    this.device = loadOrCreateDevice(config.stateDir, {
      deviceCode: config.deviceCode,
      deviceLabel: config.deviceLabel,
    });
    // collector_id 兼容字段保留，缺省即设备码
    this.config.collectorId = this.config.collectorId || this.device.code;
    // 清理孤儿 spool（崩溃在"写完内容、未提交队列元数据"之间会残留）
    const swept = this.state.sweepSpool();
    if (swept) process.stdout.write(`[collector] 清理孤儿 spool 文件 ${swept} 个\n`);
    this.uploader = new Uploader(config, this.device);
    this.stats = { rounds: 0, collected: 0, sent: 0, deduped: 0, upload_errors: 0, parse_errors: 0, skipped_noise: 0 };
    this.stopping = false;
  }

  /** 采集一轮（所有启用的 adapter），入队并落盘。返回摘要 */
  collectOnce() {
    const summary = { agents: {}, enqueued: 0, records: 0, throttled: false };
    // 背压：队列积压过多时本轮只上传、不采集。
    // 否则冷启动回填会把几万条记录一次性塞进队列，而 state.json 每轮要整体
    // 重写（实测可达数百 MB），既慢又伤盘。跳过时游标不推进，数据不会丢——
    // 下轮排空后从这里接着采。
    if (this.state.queueSize() >= this.config.maxQueuedBatches) {
      summary.throttled = true;
      return summary;
    }
    for (const agent of this.config.agents) {
      const a = ADAPTERS[agent];
      if (!a) continue;
      let out;
      try {
        out = a.collect(this.config, this.state);
      } catch (e) {
        // 采集失败不静默：记录错误，游标不动（下轮重试，不会丢数据）
        summary.agents[agent] = { error: e.message };
        this.stats.parse_errors += 1;
        continue;
      }

      let agentRecords = 0;
      let enqueued = 0;
      let skippedSent = 0;
      for (const group of out.records || []) {
        // 记录级本地去重：重叠窗口重读到的、版本未涨的记录不再入队
        const fresh = this.state.filterUnsent(group.records);
        skippedSent += group.records.length - fresh.length;
        for (const chunk of chunkRecords(fresh, {
          maxRecords: this.config.maxRecordsPerBatch,
          maxBytes: this.config.maxBatchBytes,
        })) {
          this.state.enqueue(this.uploader.makeBatch(agent, group.sessionId, chunk));
          // 入队即认领：批次已持久化在队列中，下轮采集不得再次入队。
          // （若等到上传成功才标记，重启/失败期间同一批会被反复入队。）
          this.state.markSentRecords(chunk);
          enqueued += 1;
          agentRecords += chunk.length;
        }
      }

      // 游标推进与入队一起提交（同一 write，避免中间态丢批次）
      let cursorAdvanced = false;
      for (const [key, value] of out.cursorUpdates || []) {
        if (this.state.setCursor(key, value)) cursorAdvanced = true;
      }
      if (out.seenKeys?.length) this.state.pruneCursors(`${agent}:`, out.seenKeys);
      // 仅在真有新数据入队或游标实质前进时写盘（稳态下不产生空转 IO）
      if (enqueued || cursorAdvanced) this.state.markDirty();
      this.state.commitIfDirty();

      summary.agents[agent] = { files: out.files || 0, records: agentRecords, enqueued, skipped_sent: skippedSent, noise_skipped: out.skippedNoise || 0 };
      summary.enqueued += enqueued;
      summary.records += agentRecords;
      this.stats.collected += agentRecords;
      this.stats.skipped_noise += out.skippedNoise || 0;
    }
    return summary;
  }

  /** 上传队列（保序、退避、幂等） */
  async flush() {
    const r = await this.uploader.flush(this.state);
    this.stats.sent += r.sent;
    this.stats.deduped += r.deduped;
    if (r.fatal) this.stats.last_fatal = r.fatal;
    return r;
  }

  status() {
    return {
      collector_id: this.config.collectorId,
      device: { code: this.device.code, label: this.device.label, first_seen: this.device.first_seen, info: this.device.info },
      host: os.hostname(),
      server: this.config.serverUrl,
      agents: this.config.agents,
      token_set: !!this.config.token,
      ...this.state.stats(),
      last_upload_error: this.uploader.lastError,
      stats: this.stats,
    };
  }

  /** 服务端侧对账：本机采了多少、服务端收了多少（用于发现静默失败） */
  async remoteStats() {
    try {
      const res = await fetch(`${this.config.serverUrl}/api/l0/stats`, {
        headers: { Authorization: `Token ${this.config.token}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return await res.json();
    } catch (e) {
      return { error: e.message };
    }
  }

  async run() {
    process.stdout.write(`[collector] 启动：${this.device.label}（${this.device.code}） → ${this.config.serverUrl}（agent: ${this.config.agents.join(',')}）\n`);
    if (!this.config.token) {
      process.stderr.write('[collector] 未配置 Token（AIMEMORY_TOKEN 或 config.json 的 token）——上传会 401\n');
    }
    // 首轮立刻采集，不等一个轮询周期（Claude 有 30 天清理窗口，越早采越好）
    await this.tick();
    while (!this.stopping) {
      await sleep(this.config.pollIntervalMs);
      if (this.stopping) break;
      await this.tick();
    }
    process.stdout.write('[collector] 已停止\n');
  }

  async tick() {
    this.stats.rounds += 1;
    const summary = this.collectOnce();
    const flushed = await this.flush();
    const q = this.state.queueSize();
    const parts = [`轮次 ${this.stats.rounds}`, `采集 ${summary.records} 条`, `上传 ${flushed.sent} 批`];
    if (flushed.deduped) parts.push(`服务端幂等 ${flushed.deduped}`);
    if (flushed.split) parts.push(`拆分 ${flushed.split}`);
    if (q) parts.push(`积压 ${q} 批`);
    if (flushed.fatal) parts.push(`致命错误: ${flushed.fatal}`);
    process.stdout.write(`[collector] ${parts.join(' | ')}\n`);
    return { summary, flushed };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const argv = process.argv.slice(2);
  const config = buildConfig();

  if (argv.includes('--status')) {
    const c = new Collector(config);
    const local = c.status();
    const remote = await c.remoteStats();
    process.stdout.write(JSON.stringify({ local, remote }, null, 2) + '\n');
    return;
  }

  const c = new Collector(config);

  // 进程锁：常驻进程与手动 --once 同时运行会互相覆盖游标/队列，必须互斥。
  // status 不加锁（只读）；其遇到已有实例会明确报错而不静默并发。
  if (!c.state.acquireLock()) {
    process.stderr.write('[collector] 已有采集器实例在运行（state.lock 被占用），本次退出。\n');
    process.stderr.write('[collector] 如需查看状态：node collector/index.js --status\n');
    process.exit(2);
  }

  const stop = (sig) => {
    c.stopping = true;
    c.state.commitIfDirty(); // 退出前确保状态落盘（无变化则跳过写盘）
    c.state.releaseLock();
    process.stdout.write(`[collector] 收到 ${sig}，保存状态后退出\n`);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('exit', () => { try { c.state.releaseLock(); } catch { /* 已退出 */ } });

  try {
    if (argv.includes('--once')) {
      await c.tick();
      c.state.commitIfDirty();
      return;
    }
    await c.run();
  } finally {
    c.state.releaseLock();
  }
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[collector] 致命错误: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = { Collector, chunkRecords, ADAPTERS };
