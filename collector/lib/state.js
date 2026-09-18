'use strict';

/**
 * 采集器本地状态：游标 + 待传队列。
 *
 * 两部分都要落盘，因为采集器的核心保证是「不丢不重」：
 *   - cursors：每个数据源读到哪了（文件 offset / DB 水位线）。崩溃重启后从这里继续。
 *   - queue：上传失败/离线时积压的批次。恢复后按序补传（离线容忍）。
 *
 * 写入用「临时文件 + rename」保证原子性：进程被 kill -9 也不会写出半个 JSON。
 * 游标推进与入队必须一起提交（一次 write），否则会出现"游标前进但批次丢失"。
 */

const fs = require('fs');
const path = require('path');

/** 进程存活探测（pid 存在即可；用于陈锁接管） */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但无权限 → 视为活着
  }
}

class State {
  constructor(stateDir) {
    this.dir = stateDir;
    this.file = path.join(stateDir, 'state.json');
    this.lockFile = path.join(stateDir, 'state.lock');
    this.data = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        version: 1,
        cursors: raw.cursors || {},
        queue: Array.isArray(raw.queue) ? raw.queue : [],
        sent: raw.sent && !Array.isArray(raw.sent) && typeof raw.sent === 'object' ? raw.sent : {},
      };
    } catch {
      return { version: 1, cursors: {}, queue: [], sent: {} };
    }
  }

  _persist() {
    fs.mkdirSync(this.dir, { recursive: true });
    // 临时文件名必须唯一：常驻进程与手动 --once 可能同时运行，
    // 固定名（state.json.tmp）会互相 rename 导致 ENOENT。
    const tmp = `${this.file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
    fs.renameSync(tmp, this.file); // 原子替换
  }

  /**
   * 获取进程锁，防止两个采集器同时读写同一状态（会互相覆盖游标/队列）。
   * 陈锁（持锁进程已死）自动接管——用 pid 存活探测，避免崩溃后永久锁死。
   * @returns {boolean} 是否成功持锁
   */
  acquireLock() {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      fs.writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 已有锁：判断持锁进程是否还活着
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch { /* 坏锁当陈锁 */ }
      if (holder && holder.pid && isAlive(holder.pid)) return false;
      // 陈锁 → 接管
      this.releaseLock();
      try {
        fs.writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
        return true;
      } catch { return false; }
    }
  }

  releaseLock() {
    try { fs.unlinkSync(this.lockFile); } catch { /* 已被清理 */ }
  }

  /** 一次提交：游标与队列变更同时落盘（避免中间态丢批次） */
  commit() {
    this._persist();
  }

  /**
   * 脏标记提交：无实际变化时不写盘。
   * 常驻进程 15 秒一轮、一天近六千轮，稳态下绝大部分轮次没有任何新增
   * （采集 0 条、上传 0 批），无条件写盘纯属浪费 IO。由调用方在确有变更时调 markDirty()。
   */
  markDirty() {
    this._dirty = true;
  }

  commitIfDirty() {
    if (!this._dirty) return false;
    this._dirty = false;
    this._persist();
    return true;
  }

  // ---- 游标 ----
  getCursor(key) {
    return this.data.cursors[key] || null;
  }

  /**
   * 写入游标，返回游标是否发生了"实质"变化。
   * 忽略 updated_at / truncated_at 这类诊断时间戳——它们每轮都不同，
   * 若纳入比较会让"无变化"永远判成"有变化"，脏标记就失效了。
   */
  setCursor(key, value) {
    const prev = this.data.cursors[key];
    this.data.cursors[key] = value;
    if (!prev) return true;
    const keys = new Set([...Object.keys(prev), ...Object.keys(value)]);
    keys.delete('updated_at');
    keys.delete('truncated_at');
    for (const k of keys) {
      if (JSON.stringify(prev[k]) !== JSON.stringify(value[k])) return true;
    }
    return false;
  }
  /** 移除已消失数据源的游标（如会话文件被清理） */
  pruneCursors(prefix, keepKeys) {
    const keep = new Set(keepKeys);
    for (const k of Object.keys(this.data.cursors)) {
      if (k.startsWith(prefix) && !keep.has(k)) delete this.data.cursors[k];
    }
  }

  // ---- 待传队列（spool 设计） ----
  //
  // 为什么不把 records 内联在 state.json 里：全量回填时一台机器就有 3.5 万条记录，
  // 内联会让 state.json 涨到上百 MB（实测 144MB），而它是每轮整体重写的——既慢又伤盘。
  //
  // 改为：批次内容单独写 spool/<batch_id>.json，state.json 里只留元数据（KB 级）。
  // 队列顺序由元数据数组维持，发送时按 batch_id 去 spool 取内容。
  //
  // 原子性：先写 spool 文件，再提交元数据。若两步之间崩溃，只会留下无引用的
  // 孤儿 spool 文件（启动时由 sweepSpool 清理），不会出现"队列有条目但内容丢失"。

  spoolPath(batchId) {
    return path.join(this.dir, 'spool', `${batchId}.json`);
  }

  enqueue(batch) {
    const { records, ...meta } = batch;
    if (Array.isArray(records)) {
      const p = this.spoolPath(batch.batch_id);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(records), 'utf8');
      fs.renameSync(tmp, p);
      meta.records_count = records.length;
    }
    this.data.queue.push(meta);
  }

  peek() {
    return this.data.queue[0] || null;
  }

  /** 取出队头条目的记录内容（发送用）；内容缺失返回 null（该批次已被清理/损坏） */
  peekRecords() {
    const head = this.peek();
    if (!head) return null;
    return this.readSpool(head);
  }

  readSpool(entry) {
    if (!entry) return null;
    if (entry.spool_records) return entry.spool_records; // 兼容内存中带内容的条目
    try {
      return JSON.parse(fs.readFileSync(this.spoolPath(entry.batch_id), 'utf8'));
    } catch {
      return null;
    }
  }

  /** 上传成功/丢弃：出队（按 batch_id 匹配，防并发错位）并删除 spool 文件 */
  dequeue(batchId) {
    const i = this.data.queue.findIndex((b) => b.batch_id === batchId);
    if (i < 0) return false;
    this.data.queue.splice(i, 1);
    try { fs.unlinkSync(this.spoolPath(batchId)); } catch { /* 已被清理 */ }
    return true;
  }

  /**
   * 把队列中指定批次移到队尾（毒批保护）。
   * 注意允许移动队头（i === 0）——这正是它的用途；只有"找不到"才算失败。
   */
  requeue(batchId) {
    const i = this.data.queue.findIndex((b) => b.batch_id === batchId);
    if (i < 0) return false;
    const [entry] = this.data.queue.splice(i, 1);
    this.data.queue.push(entry);
    return true;
  }

  /** 清理孤儿 spool 文件（崩溃在"写完 spool、未提交元数据"之间会留下） */
  sweepSpool() {
    const dir = path.join(this.dir, 'spool');
    let names;
    try { names = fs.readdirSync(dir); } catch { return 0; }
    const referenced = new Set(this.data.queue.map((b) => `${b.batch_id}.json`));
    let removed = 0;
    for (const n of names) {
      if (referenced.has(n)) continue;
      try { fs.unlinkSync(path.join(dir, n)); removed += 1; } catch { /* 忽略 */ }
    }
    return removed;
  }
  queueSize() {
    return this.data.queue.length;
  }
  queueBytes() {
    return this.data.queue.reduce((n, b) => n + (b.bytes || 0), 0);
  }

  // ---- 已送达记录索引（本地去重） ----
  // 为什么按"记录"而不是"批次"去重：批次指纹对整个分块内容敏感，而 ZCode 的
  // 重叠窗口每轮返回的记录集合略有不同（水位线附近总有新记录混入），分块边界
  // 一变指纹就对不上——实测 16 批里只有 2 批能靠批次指纹命中。按 rid+version
  // 记录粒度判断才是精确的：同一记录只要版本没涨就不用再传。
  //
  // 条目带时间戳，按龄淘汰（默认 1 小时）：重叠窗口只有 5 分钟，一小时前的记录
  // 不会再被重读；冷启动回填的几万条会被逐步淘汰，稳态只留最近一小批。
  // 即使条目被误淘汰导致重传，服务端批次幂等仍会兜住，不构成正确性风险。
  static get SENT_TTL_MS() { return 3600_000; }
  static get SENT_MAX() { return 8000; }

  /** 过滤掉已送达（且版本未涨）的记录 */
  filterUnsent(records) {
    const now = Date.now();
    this._pruneSent(now);
    return records.filter((r) => {
      const seen = this.data.sent[r.rid];
      if (!seen) return true;
      return (r.version || 0) > (seen.v || 0); // 版本涨了 = 内容更新，需重传
    });
  }

  /** 标记记录已送达（上传成功后调用） */
  markSentRecords(records) {
    const now = Date.now();
    for (const r of records) {
      this.data.sent[r.rid] = { v: r.version || 0, t: now };
    }
  }

  _pruneSent(now) {
    // 节流：全量扫描最多每 60 秒一次（每轮采集都扫几万条太浪费）
    if (this._lastPruneAt && now - this._lastPruneAt < 60_000) return;
    this._lastPruneAt = now;

    const sent = this.data.sent;
    const cutoff = now - State.SENT_TTL_MS;
    for (const k of Object.keys(sent)) {
      if ((sent[k].t || 0) < cutoff) delete sent[k];
    }
    // 仍超上限（高频写入场景）→ 保留最新的 SENT_MAX 条
    const keys = Object.keys(sent);
    if (keys.length > State.SENT_MAX) {
      keys
        .sort((a, b) => (sent[a].t || 0) - (sent[b].t || 0))
        .slice(0, keys.length - State.SENT_MAX)
        .forEach((k) => delete sent[k]);
    }
  }

  stats() {
    return {
      queue_batches: this.queueSize(),
      queue_bytes: this.queueBytes(),
      cursors: Object.keys(this.data.cursors).length,
      sent_indexed: Object.keys(this.data.sent).length,
    };
  }
}

module.exports = { State };
