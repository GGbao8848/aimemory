'use strict';

/**
 * L2 后台派生调度器（sleep-time 思路，与 src/l1/scheduler.js 同构）。
 *
 * 触发条件：
 *   - L1 摘要已 done（摘要只在会话静默后才生成，故 L1 done 本身就意味着会话告一段落）；
 *   - 且该摘要又静默了 QUIET_MS（防止会话刚被摘要就续上、L1 马上重跑导致 L2 白跑一次）。
 *
 * 幂等靠指纹：摘要内容（overview/decisions/pending/artifacts）的 hash 存进 l2_sources，
 * 没变就跳过（省 LLM 调用），变了才重排队。
 *
 * 成本：每会话 1 次 LLM 调用；串行执行（本地/远端模型并发能力有限），不阻塞在线请求。
 */

const config = require('../config');
const llm = require('../llm/client');
const store = require('./store');
const { deriveOne, summaryHash } = require('./derive');

const QUIET_MS = config.l2.quietMs;
const BATCH = config.l2.batch;
const MAX_ATTEMPTS = config.l2.maxAttempts;

let ticking = false;

/**
 * pick 出来的是 DB 行（snake_case），状态函数按 camelCase 解构。
 * 直接传 job 会因字段名不匹配被绑成 NULL（better-sqlite3 不报错，`WHERE user_id = NULL`
 * 匹配 0 行）→ 状态静默不变、attempts 不递增、坏会话被无限重试。
 * 同一个坑在 src/l1/scheduler.js 里也踩过（已修），此处从一开始就显式映射。
 */
const jobRef = (job) => ({
  userId: job.user_id,
  deviceCode: job.device_code,
  agent: job.agent,
  sessionId: job.session_id,
  contentHash: job.content_hash,
});

/**
 * 扫描 L1 完成的摘要 → 为「未派生（或摘要已变）」的会话排队。
 * @returns {{scanned:number, queued:number, requeued:number, skipped:number}}
 */
function enqueueStale() {
  const userId = config.userId;
  const summaries = store.l1DoneSummaries(userId);
  const existing = store.l2Existing(userId);
  const now = Date.now();

  let queued = 0;
  let requeued = 0;
  let skipped = 0;

  for (const s of summaries) {
    const key = `${s.device_code}\u0000${s.agent}\u0000${s.session_id}`;
    const prev = existing[key];
    const hash = summaryHash(s);

    // 静默判定：L1 摘要在 QUIET_MS 内更新过 → 会话可能又续上了，等它稳定
    const lastMs = s.updated_at ? Date.parse(s.updated_at) : 0;
    const quiet = lastMs && (now - lastMs >= QUIET_MS);

    if (!prev) {
      if (!quiet) { skipped += 1; continue; }
      store.ensureL2Pending({
        userId, deviceCode: s.device_code, agent: s.agent, sessionId: s.session_id, contentHash: hash,
      });
      queued += 1;
      continue;
    }

    // 已派生：指纹一致就不必重跑
    if (prev.status === 'done' && prev.content_hash === hash) { skipped += 1; continue; }

    // 摘要变了 → 重新排队（同样要等静默）
    if (prev.status === 'done' && prev.content_hash !== hash) {
      if (!quiet) { skipped += 1; continue; }
      store.requeueL2({
        userId, deviceCode: s.device_code, agent: s.agent, sessionId: s.session_id, contentHash: hash,
      });
      requeued += 1;
      continue;
    }

    // failed 且达上限 → 不再排队（等人工介入或提高上限）；未达上限的由 pickL2Pending 捞回
    if (prev.status === 'failed' && (prev.attempts || 0) >= MAX_ATTEMPTS) { skipped += 1; continue; }

    skipped += 1;
  }

  return { scanned: summaries.length, queued, requeued, skipped };
}

/**
 * 处理一批待派生会话（串行）。
 * @returns {{processed:number, done:number, failed:number, skippedLlM:boolean}}
 */
async function processBatch() {
  if (!llm.enabled()) return { processed: 0, done: 0, failed: 0, skippedLlM: true };

  const jobs = store.pickL2Pending({ maxAttempts: MAX_ATTEMPTS, limit: BATCH });
  let done = 0;
  let failed = 0;

  for (const job of jobs) {
    store.markL2Running(jobRef(job));
    try {
      // 取摘要正文（pick 只带状态字段，正文按需单独读）
      const summary = store.getL1DoneSummary(job.user_id, {
        deviceCode: job.device_code, agent: job.agent, sessionId: job.session_id,
      });
      if (!summary) {
        store.markL2Failed({ ...jobRef(job), error: 'L1 摘要不存在或已不是 done', permanent: true });
        failed += 1;
        continue;
      }

      const r = await deriveOne({
        userId: job.user_id,
        deviceCode: job.device_code,
        agent: job.agent,
        sessionId: job.session_id,
        summary,
      });

      if (!r.ok) {
        store.markL2Failed({ ...jobRef(job), error: r.error });
        failed += 1;
        console.warn(`[l2] 派生失败：${job.agent}/${job.session_id.slice(0, 24)}… ${r.error}`);
        if (r.error && r.error.includes('判定不可用')) break; // LLM 熔断 → 不继续消耗剩余任务
        continue;
      }

      const st = r.stats || { added: 0, updated: 0, deleted: 0, noop: 0 };
      store.saveL2Done({
        ...jobRef(job),
        contentHash: job.content_hash || summaryHash(summary),
        added: st.added, updated: st.updated, deleted: st.deleted, noop: st.noop,
        model: config.llm.model,
      });
      done += 1;
      console.log(
        `[l2] 派生完成：${job.agent}/${job.session_id.slice(0, 24)}… `
        + `新增 ${st.added} / 更新 ${st.updated} / 取代 ${st.deleted} / 跳过 ${st.noop}`
        + (r.skipped ? `（${r.skipped}）` : '')
      );
    } catch (e) {
      failed += 1;
      store.markL2Failed({ ...job, error: `异常：${e.message}` });
      console.error(`[l2] 派生异常：${e.message}`);
    }
  }

  return { processed: jobs.length, done, failed, skippedLlM: false };
}

/** 一轮：先补队列，再处理一批 */
async function tick() {
  if (ticking) return null; // 上一轮未结束（LLM 慢）→ 不叠加
  ticking = true;
  try {
    const enq = enqueueStale();
    const proc = await processBatch();
    return { ...enq, ...proc };
  } finally {
    ticking = false;
  }
}

/** 启动：复位中断残留的 running，后台跑首轮，然后按间隔轮询 */
function start() {
  if (!config.l2.derive) {
    console.log('[l2] 派生已关闭（L2_DERIVE=0）');
    return null;
  }
  const reset = store.resetStuckL2();
  if (reset) console.log(`[l2] 复位 ${reset} 个中断的派生任务`);
  tick()
    .then((r) => { if (r && r.processed) console.log(`[l2] 首轮：${JSON.stringify(r)}`); })
    .catch(() => {});
  return setInterval(() => {
    tick()
      .then((r) => {
        if (r && (r.queued || r.requeued || r.processed)) {
          console.log(`[l2] 轮询：排队 ${r.queued} 新增 / ${r.requeued} 重排，处理 ${r.processed}（成功 ${r.done}）`);
        }
      })
      .catch((e) => console.error(`[l2] 轮询异常：${e.message}`));
  }, config.l2.intervalMs).unref();
}

module.exports = { start, tick, enqueueStale, processBatch, QUIET_MS, BATCH, MAX_ATTEMPTS };
