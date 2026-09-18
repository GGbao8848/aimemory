'use strict';

/**
 * 上传器 —— 采集器里的"死程序"。
 *
 * 它只做一件事：把「已经是固定 schema 的记录数组」打成批次 POST 到服务端。
 * 它不知道对面是 Codex 还是 ZCode，不解析内容，不提炼，不索引。
 * 新增 agent 只加适配器，这里一行都不用改。
 *
 * 可靠性由三件事保证：
 *   1. 批次指纹（batch_id）—— 服务端按它幂等跳过，重传不会重复落盘；
 *   2. 本地队列 —— 发送失败/离线则积压，恢复后补传；
 *   3. 指数退避 —— 网络抖动不空转，也不放弃。
 */

const crypto = require('crypto');

/** 批次指纹：内容寻址。相同内容必然同 id，重传天然幂等 */
function batchIdFor({ collectorId, agent, sessionId, records }) {
  return crypto
    .createHash('sha256')
    .update(`${collectorId}|${agent}|${sessionId}|${records.map((r) => r.rid + ':' + (r.version || '')).join(',')}`)
    .digest('hex')
    .slice(0, 32);
}

class Uploader {
  constructor(config, device) {
    this.config = config;
    // 设备身份（可选：测试可只传 config）。上传时随每个批次携带，
    // 服务端据此把数据归到「哪台机器的哪个 agent」。
    this.device = device || { code: config.collectorId || 'unknown-device', label: '', info: {}, fingerprint: '' };
    this.lastError = null;
    // 服务端认回的权威设备码（指纹命中已有设备时与其对齐）
    this.authoritativeCode = null;
    this.onAdoptCode = null;
  }

  /** 组一个批次对象（入队用；bytes 为估算值，服务端会重算实际落盘字节） */
  makeBatch(agent, sessionId, records) {
    const batchId = batchIdFor({ collectorId: this.device.code, agent, sessionId, records });
    return {
      agent,
      session_id: sessionId,
      collector_id: this.device.code,
      device_code: this.device.code,
      device_label: this.device.label,
      batch_id: batchId,
      records,
      records_count: records.length,
      bytes: Buffer.byteLength(JSON.stringify(records)),
      attempts: 0,
      next_at: 0,
    };
  }

  /** 发送一个批次。返回 { ok } 或 { ok:false, retry:bool, error } */
  async send(batch) {
    const url = `${this.config.serverUrl}/api/l0/ingest`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token ${this.config.token}`,
        },
        body: JSON.stringify({
          agent: batch.agent,
          session_id: batch.session_id,
          collector_id: batch.collector_id,
          // 设备三元组 + 机器指纹：设备码用于归类，指纹用于"认出这是同一台机器"
          // （重装后设备码会变，服务端凭指纹归回原设备，避免重复建一台）
          device: {
            code: batch.device_code || this.device.code,
            label: batch.device_label || this.device.label,
            fingerprint: this.device.fingerprint || '',
            fingerprint_source: this.device.fingerprint_source || '',
            info: this.device.info,
          },
          batch_id: batch.batch_id,
          records: batch.records,
        }),
        signal: AbortSignal.timeout(60_000),
      });

      // 401/403 是配置问题，重试无用；413 说明批次过大，必须拆分（由调用方处理）
      if (res.status === 401 || res.status === 403) {
        const text = await res.text().catch(() => '');
        this.lastError = `鉴权失败 HTTP ${res.status}（检查 Token）${text.slice(0, 120)}`;
        return { ok: false, retry: false, fatal: true, error: this.lastError };
      }
      if (res.status === 413) {
        // 批次超过服务端 body 上限：重试同一批永远不会成功，必须拆分
        return {
          ok: false,
          retry: false,
          tooLarge: true,
          error: `HTTP 413 批次过大（${batch.bytes} 字节）——需拆分`,
        };
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, retry: true, error: `HTTP ${res.status} ${text.slice(0, 160)}` };
      }
      const json = await res.json().catch(() => ({}));
      this.lastError = null;
      // 服务端按机器指纹认回已有设备时，会返回权威设备码；本地跟着对齐，
      // 这样"删掉状态目录重装"也不会分裂成两台设备。
      if (json && json.device_code && json.device_code !== this.device.code) {
        const from = this.device.code;
        this.device.code = json.device_code;
        this.authoritativeCode = json.device_code;
        if (typeof this.onAdoptCode === 'function') {
          try { this.onAdoptCode(json.device_code, from); } catch { /* 持久化失败不影响上传 */ }
        }
      }
      return { ok: true, deduped: !!json.deduped };
    } catch (e) {
      // 网络错误 / 超时 → 可重试（离线容忍）
      return { ok: false, retry: true, error: e.name === 'TimeoutError' ? '请求超时' : e.message };
    }
  }

  /** 退避延迟：指数增长 + 抖动，封顶 maxDelayMs */
  backoffMs(attempts) {
    const { baseDelayMs, maxDelayMs } = this.config.retry;
    const raw = baseDelayMs * 2 ** Math.max(0, attempts - 1);
    const jitter = Math.floor(raw * 0.2 * Math.random());
    return Math.min(raw + jitter, maxDelayMs);
  }

  /**
   * 冲刷队列：按序发送。
   * 关键保障（防队头阻塞）：一个批次反复失败时不能永久堵住后面所有批次——
   *   - 413（批次过大）→ 就地一分为二重新入队，立即重试（不空等）
   *   - 单条记录仍过大 → 剥离 raw 再试；仍不行则标记 oversized 并移出主链路
   *   - 超过重试上限的批次 → 暂停本轮，但整体重试计数在下一轮重置
   * @returns {{sent:number, deduped:number, failed:number, fatal:string|null, split:number}}
   */
  async flush(state) {
    let sent = 0;
    let deduped = 0;
    let split = 0;
    let fatal = null;
    // 本轮最多处理多少个批次，避免一次性把超大积压跑太久
    const MAX_PER_ROUND = 200;
    let processed = 0;

    while (processed < MAX_PER_ROUND) {
      const entry = state.peek();
      if (!entry) break;
      const now = Date.now();
      if (entry.next_at && entry.next_at > now) break; // 退避未到，本轮不碰

      // 记录内容在 spool 文件里，发送时按需读入（state.json 只存元数据）
      const records = state.readSpool(entry);
      if (!records) {
        // 内容丢失/损坏（不应发生）→ 出队并上报，避免永久卡住队头
        state.dequeue(entry.batch_id);
        state.commit();
        fatal = fatal || `批次内容缺失，已丢弃：${entry.batch_id}`;
        continue;
      }
      const batch = { ...entry, records };

      processed += 1;
      const r = await this.send(batch);

      if (r.ok) {
        state.dequeue(batch.batch_id);
        // 刷新已送达时间戳（记录在入队时已认领，这里只是续期 TTL，便于按龄淘汰）
        state.markSentRecords(batch.records);
        state.commit();
        sent += 1;
        if (r.deduped) deduped += 1;
        continue;
      }

      // 批次过大：拆分后立刻重试（拆出来的半批更小，能过）
      if (r.tooLarge && batch.records.length > 1) {
        const halves = splitBatch(batch);
        state.dequeue(batch.batch_id);
        for (const h of halves) state.enqueue(h);
        // 拆出的两半保持原顺序插到队首
        const q = state.data.queue;
        const moved = q.splice(q.length - halves.length, halves.length);
        q.unshift(...moved);
        state.commit();
        split += 1;
        continue; // 不消耗 attempts，继续处理（新队头是拆出的前半）
      }
      // 单条记录就超限：剥离 raw（通常是大头）后再试一次
      if (r.tooLarge && batch.records.length === 1 && !entry.stripped) {
        const [rec] = batch.records;
        const slim = { ...rec };
        delete slim.raw;
        state.dequeue(batch.batch_id);
        const nb = this.makeBatch(batch.agent, batch.session_id, [slim]);
        nb.stripped = true;
        state.enqueue(nb);
        state.data.queue.unshift(state.data.queue.pop()); // 回到队首
        state.commit();
        continue;
      }

      entry.attempts = (entry.attempts || 0) + 1;
      entry.last_error = r.error;
      state.commit();

      if (r.fatal) { fatal = r.error; break; }

      if (entry.attempts >= this.config.retry.maxAttempts) {
        // 毒批保护：长期失败的批次不能在队首堵死整条链路。
        // 移到队尾（数据不丢，稍后再试），本轮继续推进后面的批次。
        entry.attempts = 0;
        entry.next_at = Date.now() + this.backoffMs(this.config.retry.maxAttempts);
        entry.poison_moves = (entry.poison_moves || 0) + 1;
        // 队列里只剩它一个时移到队尾＝原地打转 → 本轮停止，等下轮（避免空转）
        if (state.queueSize() <= 1) {
          state.commit();
          break;
        }
        state.requeue(entry.batch_id);
        state.commit();
        continue; // 继续处理新队头，而不是停下（否则等于没解决阻塞）
      }

      // 保序：队头失败且未到上限 → 本轮不再往后发
      entry.next_at = Date.now() + this.backoffMs(entry.attempts);
      state.commit();
      break;
    }
    return { sent, deduped, failed: state.queueSize(), fatal, split };
  }
}

/** 把一个批次按记录数一分为二（批次指纹随内容重算，天然是合法的新批次） */
function splitBatch(batch) {
  const mid = Math.ceil(batch.records.length / 2);
  const mk = (records) => ({
    ...batch,
    batch_id: batchIdFor({ collectorId: batch.collector_id, agent: batch.agent, sessionId: batch.session_id, records }),
    records,
    bytes: Buffer.byteLength(JSON.stringify(records)),
    attempts: 0,
    next_at: 0,
    split_from: batch.batch_id,
  });
  return [mk(batch.records.slice(0, mid)), mk(batch.records.slice(mid))];
}

module.exports = { Uploader, batchIdFor, splitBatch };
