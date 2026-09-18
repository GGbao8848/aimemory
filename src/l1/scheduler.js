'use strict';

/**
 * L1 后台摘要调度器（sleep-time 思路：空闲时批量处理，不阻塞在线请求）。
 *
 * 触发条件：会话**静默一段时间**（默认 5 分钟没有新记录）才摘要——正在进行的
 * 会话内容还在变，提前摘要等于浪费（下一轮还要重跑）。
 *
 * 另外用指纹（l0_records 的 count/version 聚合）判断会话是否变化：
 *   - 没摘过 → 排队
 *   - 摘过且指纹相同 → 跳过（省 LLM 调用）
 *   - 摘过但指纹变了 → 重新排队
 *
 * 与 add_memory 的异步提炼队列互不干扰：那条链路是「素材 → 记忆」，这条是
 * 「归档会话 → 摘要」，共用同一个 LLM 客户端（有熔断与并发保护）。
 */

const config = require('../config');
const repo = require('../db/repo');
const { summarizeOne } = require('./summarize');
const llm = require('../llm/client');

/** 会话静默多久才认为"告一段落"（毫秒） */
const QUIET_MS = config.l1.quietMs;
/**
 * 每轮处理多少个会话。
 * 串行执行（本地 LLM 并发能力有限），单会话实测约 90-110 秒；
 * 首轮全量回填 85 个会话约需 2.5-3 小时——这是 sleep-time 后台任务，
 * 不阻塞在线请求，属于预期行为。赶时间可临时调大本值。
 */
const BATCH = config.l1.batch;
/** 单会话最大重试次数 */
const MAX_ATTEMPTS = config.l1.maxAttempts;

let ticking = false;

/**
 * pick 出来的是 DB 行（snake_case），而状态函数按 camelCase 解构。
 * 直接传 job 会因字段名不匹配被绑成 NULL——better-sqlite3 不报错，
 * `WHERE user_id = NULL` 匹配 0 行，于是**静默失效**：状态不置 running、
 * attempts 也不递增（实测：永远达不到重试上限，坏会话会被无限重试、持续烧 LLM 调用）。
 * 故统一显式映射一次。
 */
const jobRef = (job) => ({
  userId: job.user_id,
  deviceCode: job.device_code,
  agent: job.agent,
  sessionId: job.session_id,
  contentHash: job.content_hash,
});

/**
 * 扫描归档 → 为「已静默且未摘要（或已变化）」的会话排队。
 * @returns {{scanned:number, queued:number, requeued:number, skipped:number}}
 */
function enqueueStale() {
  const userId = config.userId;
  const sources = repo.l1Sources(userId);
  const existing = repo.l1Existing(userId);
  const now = Date.now();

  let queued = 0;
  let requeued = 0;
  let skipped = 0;

  for (const s of sources) {
    const key = `${s.device_code}\u0000${s.agent}\u0000${s.session_id}`;
    const prev = existing[key];

    // 静默判定：最后接收时间距现在不足 QUIET_MS → 会话可能还在进行，跳过
    const lastMs = s.last_received ? Date.parse(s.last_received) : 0;
    const quiet = lastMs && (now - lastMs >= QUIET_MS);

    if (!prev) {
      if (!quiet) { skipped += 1; continue; }
      repo.ensureL1Pending({ userId, deviceCode: s.device_code, agent: s.agent, sessionId: s.session_id });
      queued += 1;
      continue;
    }

    // 已成功摘过：指纹一致就不必重跑
    if (prev.status === 'done' && prev.content_hash === s.fp) { skipped += 1; continue; }

    // 摘过但内容变了 → 重新排队（同样要等静默）
    if (prev.status === 'done' && prev.content_hash !== s.fp) {
      if (!quiet) { skipped += 1; continue; }
      repo.requeueL1({ userId, deviceCode: s.device_code, agent: s.agent, sessionId: s.session_id, contentHash: s.fp });
      requeued += 1;
      continue;
    }

    // failed 且已达上限 → 不再排队（等人工介入或提高上限）
    if (prev.status === 'failed' && (prev.attempts || 0) >= MAX_ATTEMPTS) { skipped += 1; continue; }

    skipped += 1;
  }

  return { scanned: sources.length, queued, requeued, skipped };
}

/**
 * 处理一批待摘要会话（串行，避免打爆本地 LLM）。
 * @returns {{processed:number, done:number, failed:number, skippedLlM:boolean}}
 */
async function processBatch() {
  if (!llm.enabled()) return { processed: 0, done: 0, failed: 0, skippedLlM: true };

  const jobs = repo.pickL1Pending({ maxAttempts: MAX_ATTEMPTS, limit: BATCH });
  let done = 0;
  let failed = 0;

  for (const job of jobs) {
    repo.markL1Running(jobRef(job));
    try {
      const r = await summarizeOne({
        userId: job.user_id,
        deviceCode: job.device_code,
        agent: job.agent,
        sessionId: job.session_id,
      });
      if (r.ok) {
        done += 1;
        console.log(`[l1] 摘要完成：${job.agent}/${job.session_id.slice(0, 24)}…`);
      } else {
        // summarizeOne 内部已标记失败原因；这里只计数
        failed += 1;
        if (r.error) console.warn(`[l1] 摘要失败：${job.session_id.slice(0, 24)}… ${r.error}`);
        // LLM 熔断/不可用时不继续消耗剩余任务（等下一轮）
        if (r.error && r.error.includes('LLM')) break;
      }
    } catch (e) {
      failed += 1;
      repo.markL1Failed({ ...jobRef(job), error: `异常：${e.message}` });
      console.error(`[l1] 摘要异常：${e.message}`);
    }
  }
  return { processed: jobs.length, done, failed, skippedLlM: false };
}

/** 一轮：先补队列，再处理一批 */
async function tick() {
  if (ticking) return null; // 上一轮还没结束（LLM 慢），不叠加
  ticking = true;
  try {
    const enq = enqueueStale();
    const proc = await processBatch();
    return { ...enq, ...proc };
  } finally {
    ticking = false;
  }
}

/** 启动：复位中断残留的 running，然后处理积压（首次会较慢，串行跑） */
function start() {
  const reset = repo.resetStuckL1();
  if (reset) console.log(`[l1] 复位 ${reset} 个中断的摘要任务`);
  const interval = config.l1.intervalMs;
  // 不 await：后台跑，避免拖慢启动
  tick().then((r) => { if (r && r.processed) console.log(`[l1] 首轮：${JSON.stringify(r)}`); }).catch(() => {});
  return setInterval(() => {
    tick().then((r) => {
      if (r && (r.queued || r.requeued || r.processed)) {
        console.log(`[l1] 轮询：排队 ${r.queued} 新增 / ${r.requeued} 重排，处理 ${r.processed}（成功 ${r.done}）`);
      }
    }).catch((e) => console.error(`[l1] 轮询异常：${e.message}`));
  }, interval).unref();
}

module.exports = { start, tick, enqueueStale, processBatch, QUIET_MS, BATCH, MAX_ATTEMPTS };
