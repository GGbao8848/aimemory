'use strict';

/**
 * L0 采集器单元测试。
 *
 * 覆盖采集层要达标的五条：幂等、断点续传、离线容忍、活跃会话（半行保护）、不静默失败。
 * 三家 adapter 的解析用合成样本（不依赖本机真实 agent 数据，CI 可跑）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { State } = require('../collector/lib/state');
const { Uploader, batchIdFor } = require('../collector/lib/uploader');
const { readNewLines } = require('../collector/lib/jsonl');
const { makeRid, makeRecord, ROLE } = require('../collector/lib/schema');
const { chunkRecords } = require('../collector/index');

const codex = require('../collector/adapters/codex');
const claude = require('../collector/adapters/claude');
const zcode = require('../collector/adapters/zcode');

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `l0-${tag}-`));
}

// ===== schema =====

test('归一化 schema：rid 稳定、字段裁剪', () => {
  const rid = makeRid('codex', 'sess-1', 'msg-9');
  assert.strictEqual(rid, 'codex:sess-1:msg-9');
  const rec = makeRecord({ rid, ts: '2026-01-01T00:00:00Z', role: ROLE.USER, content: 'hi' });
  assert.strictEqual(rec.rid, rid);
  assert.strictEqual(rec.role, 'user');
  assert.strictEqual(rec.content, 'hi');
  assert.ok(!('meta' in rec)); // 空 meta 不占位
});

// ===== 追加型文件增量（Codex / Claude 共用） =====

test('jsonl 增量：只读新增、offset 推进', () => {
  const d = tmpdir('jsonl');
  const f = path.join(d, 'a.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"a":2}\n');
  const r1 = readNewLines(f, 0);
  assert.deepStrictEqual(r1.lines, ['{"a":1}', '{"a":2}']);
  // 再读：无新增
  const r2 = readNewLines(f, r1.offset);
  assert.strictEqual(r2.lines.length, 0);
  // 追加后只读新行
  fs.appendFileSync(f, '{"a":3}\n');
  const r3 = readNewLines(f, r1.offset);
  assert.deepStrictEqual(r3.lines, ['{"a":3}']);
});

test('jsonl 半行保护：活跃会话写入中不解析半行', () => {
  const d = tmpdir('halfline');
  const f = path.join(d, 'b.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"partial":');
  const r = readNewLines(f, 0);
  // 只取完整行，offset 停在换行处
  assert.deepStrictEqual(r.lines, ['{"a":1}']);
  assert.strictEqual(r.offset, Buffer.byteLength('{"a":1}\n'));
  // 补齐半行后能读到
  fs.appendFileSync(f, '2}\n');
  const r2 = readNewLines(f, r.offset);
  assert.deepStrictEqual(r2.lines, ['{"partial":2}']);
});

test('jsonl 截断检测：文件变小则从头重读', () => {
  const d = tmpdir('trunc');
  const f = path.join(d, 'c.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"a":2}\n{"a":3}\n');
  const r1 = readNewLines(f, 0);
  fs.writeFileSync(f, '{"b":1}\n');
  const r2 = readNewLines(f, r1.offset);
  assert.strictEqual(r2.truncated, true);
  assert.deepStrictEqual(r2.lines, ['{"b":1}']);
});

// ===== State：断点续传 / 离线积压 =====

test('State：游标与队列原子落盘、可恢复（断点续传）', () => {
  const d = tmpdir('state');
  const s1 = new State(d);
  s1.setCursor('codex:/x/y.jsonl', { offset: 42 });
  s1.enqueue({ batch_id: 'b1', bytes: 100, records: [{ rid: 'r1' }, { rid: 'r2' }] });
  s1.commit();

  // 模拟进程重启：新实例从磁盘恢复
  const s2 = new State(d);
  assert.strictEqual(s2.getCursor('codex:/x/y.jsonl').offset, 42);
  assert.strictEqual(s2.queueSize(), 1);
  assert.strictEqual(s2.peek().batch_id, 'b1');
  assert.strictEqual(s2.queueBytes(), 100);
  // 内容在 spool 文件里，重启后仍可读回（state.json 只存元数据）
  assert.deepStrictEqual(s2.peekRecords(), [{ rid: 'r1' }, { rid: 'r2' }]);

  s2.dequeue('b1');
  s2.commit();
  assert.strictEqual(new State(d).queueSize(), 0); // 出队也已落盘
});

test('State：坏状态文件不致命（降级为空）', () => {
  const d = tmpdir('badstate');
  fs.writeFileSync(path.join(d, 'state.json'), '{ 这不是 json');
  const s = new State(d);
  assert.strictEqual(s.queueSize(), 0);
  s.setCursor('k', { offset: 1 });
  s.commit(); // 能重新写出合法状态
  assert.strictEqual(new State(d).getCursor('k').offset, 1);
});

// ===== Uploader：幂等 / 离线容忍 =====

test('批次指纹：内容相同必然同 id（幂等重传基础）', () => {
  const a = batchIdFor({ collectorId: 'm1', agent: 'codex', sessionId: 's1', records: [{ rid: 'r1', version: 1 }] });
  const b = batchIdFor({ collectorId: 'm1', agent: 'codex', sessionId: 's1', records: [{ rid: 'r1', version: 1 }] });
  const c = batchIdFor({ collectorId: 'm1', agent: 'codex', sessionId: 's1', records: [{ rid: 'r1', version: 2 }] });
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c); // 版本变了 → 新批次（原地更新的记录要重传）
});

test('Uploader：服务端 5xx → 保留队列并退避（离线容忍，不丢数据）', async () => {
  const d = tmpdir('up');
  const st = new State(d);
  const config = {
    collectorId: 'm1', token: 't', serverUrl: 'http://127.0.0.1:1',
    retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
  };
  const up = new Uploader(config);
  // 指向不可达端口 → fetch 失败 → 可重试
  const u2 = new Uploader({ ...config, serverUrl: 'http://127.0.0.1:59999' });
  st.enqueue(u2.makeBatch('codex', 's1', [{ rid: 'zcode:s1:x', ts: 'x', role: 'user', content: 'hi' }]));
  st.commit();

  const r = await u2.flush(st);
  assert.strictEqual(r.sent, 0);
  assert.ok(st.queueSize() >= 1, '失败批次必须留在队列里，不能丢');
  assert.ok(st.peek().attempts >= 1, '应记录重试次数');
  assert.ok(st.peek().next_at > Date.now() - 1000, '应设置退避时间');
});

test('chunkRecords：按条数与字节双限切分', () => {
  const recs = Array.from({ length: 7 }, (_, i) => ({ rid: `r${i}`, content: 'x'.repeat(50) }));
  const byCount = chunkRecords(recs, { maxRecords: 3, maxBytes: 1e9 });
  assert.deepStrictEqual(byCount.map((c) => c.length), [3, 3, 1]);

  const byBytes = chunkRecords(recs, { maxRecords: 999, maxBytes: 120 });
  assert.ok(byBytes.every((c) => Buffer.byteLength(JSON.stringify(c)) <= 200), '每批不应远超字节上限');
  assert.strictEqual(byBytes.reduce((n, c) => n + c.length, 0), 7, '切分不丢记录');
});

test('State：记录级去重——同 rid 同版本不重传，版本涨了要重传', () => {
  const d = tmpdir('riddedup');
  const s = new State(d);

  const r1 = { rid: 'zcode:s1:p1', ts: 't', version: 100, role: 'assistant', content: '部分' };
  // 首次：全部是新的
  assert.strictEqual(s.filterUnsent([r1]).length, 1);
  s.markSentRecords([r1]);

  // 重叠窗口重读到同一记录（版本未变）→ 过滤掉，不再上传
  assert.strictEqual(s.filterUnsent([r1]).length, 0, '版本未涨不应重传');

  // 记录被原地更新（版本上涨）→ 必须重传（否则 L1 拿不到最新内容）
  const r2 = { ...r1, version: 200, content: '完整内容' };
  const out = s.filterUnsent([r2]);
  assert.strictEqual(out.length, 1, '版本上涨必须重传');
  assert.strictEqual(out[0].content, '完整内容');

  // 混合场景：老版本 + 新记录
  const mixed = s.filterUnsent([r1, { rid: 'zcode:s1:p2', ts: 't', version: 1, role: 'user', content: 'x' }]);
  assert.deepStrictEqual(mixed.map((r) => r.rid), ['zcode:s1:p2']);
});

test('State：已送达索引按龄淘汰（不无限增长）', () => {
  const d = tmpdir('prune');
  const s = new State(d);
  // 伪造一条很旧的记录（超过 TTL）
  s.data.sent['zcode:old:p'] = { v: 1, t: Date.now() - State.SENT_TTL_MS - 10_000 };
  // 触发淘汰
  s.filterUnsent([{ rid: 'zcode:new:p', ts: 't', version: 1 }]);
  assert.ok(!s.data.sent['zcode:old:p'], '超龄条目应被淘汰');
});

test('State：已送达索引落盘并可恢复（重启后不重传）', () => {
  const d = tmpdir('sentpersist');
  const s1 = new State(d);
  const r = { rid: 'zcode:s2:p9', ts: 't', version: 5, role: 'user', content: 'x' };
  s1.markSentRecords([r]);
  s1.commit();

  const s2 = new State(d); // 模拟重启
  assert.strictEqual(s2.filterUnsent([r]).length, 0, '重启后不应重复上传已送达记录');
});

test('Collector：队列积压超限时本轮只上传不采集（背压）', () => {
  const { Collector } = require('../collector/index');
  const workDir = tmpdir('backpressure');
  const c = new Collector({
    stateDir: workDir,
    collectorId: 'm1',
    token: 't',
    serverUrl: 'http://127.0.0.1:59999',
    agents: ['zcode'],          // 无真实数据源 → 采集恒为空
    pollIntervalMs: 10,
    maxRecordsPerBatch: 10,
    maxBatchBytes: 1000,
    maxQueuedBatches: 2,
    keepRaw: false,
    paths: { zcode: '/nonexistent', codex: '/nonexistent', claude: '/nonexistent' },
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });
  // 手工灌满队列
  c.state.enqueue(c.uploader.makeBatch('zcode', 's1', [{ rid: 'r1', ts: 't', role: 'user', content: 'x' }]));
  c.state.enqueue(c.uploader.makeBatch('zcode', 's1', [{ rid: 'r2', ts: 't', role: 'user', content: 'y' }]));
  c.state.commit();

  const summary = c.collectOnce();
  assert.strictEqual(summary.throttled, true, '积压超限应触发背压');
  assert.strictEqual(summary.records, 0, '背压期间不应采集新记录');
  assert.strictEqual(c.state.queueSize(), 2, '已有队列不受影响（数据不丢）');
});

test('State：spool 设计——内容不入 state.json，出队即删文件', () => {
  const d = tmpdir('spool');
  const s = new State(d);
  const big = Array.from({ length: 200 }, (_, i) => ({ rid: `r${i}`, ts: 't', role: 'user', content: 'x'.repeat(500) }));

  s.enqueue({ batch_id: 'sp1', bytes: 1, records: big });
  s.commit();

  // state.json 只含元数据：体积远小于内容本身
  const stateSize = fs.statSync(path.join(d, 'state.json')).size;
  const contentSize = Buffer.byteLength(JSON.stringify(big));
  assert.ok(stateSize < contentSize / 10, `state.json(${stateSize}) 应远小于内容(${contentSize})`);
  assert.strictEqual(s.peek().records, undefined, 'state.json 里不得内联 records');
  assert.strictEqual(s.peek().records_count, 200);

  // 内容从 spool 读回
  assert.strictEqual(s.peekRecords().length, 200);

  // 出队后 spool 文件被清理，不留垃圾
  s.dequeue('sp1');
  s.commit();
  assert.ok(!fs.existsSync(s.spoolPath('sp1')), '出队应删除 spool 文件');
});

test('State：sweepSpool 清理孤儿文件（崩溃残留）', () => {
  const d = tmpdir('sweep');
  const s = new State(d);
  s.enqueue({ batch_id: 'keep', bytes: 1, records: [{ rid: 'r', ts: 't', role: 'user' }] });
  s.commit();
  // 伪造一个无引用的孤儿 spool（模拟"写完内容、未提交元数据"时崩溃）
  fs.writeFileSync(s.spoolPath('orphan'), JSON.stringify([{ rid: 'x' }]));

  const removed = s.sweepSpool();
  assert.strictEqual(removed, 1);
  assert.ok(!fs.existsSync(s.spoolPath('orphan')), '孤儿应被清理');
  assert.ok(fs.existsSync(s.spoolPath('keep')), '在队列中的 spool 不得被误删');
});

// ===== 设备身份 =====

test('device：机器指纹稳定、来源可辨、不外传原始标识', () => {
  const dev = require('../collector/lib/device');

  const fp1 = dev.machineFingerprint();
  const fp2 = dev.machineFingerprint();
  assert.match(fp1.hash, /^fp_[0-9a-f]{16}$/, '指纹格式应为 fp_ + 16 hex');
  assert.strictEqual(fp1.hash, fp2.hash, '同一台机器反复计算必须一致');
  assert.ok(['machine-id', 'mac', 'hostname', 'random'].includes(fp1.source), `来源应可辨，实际 ${fp1.source}`);

  // 原始硬件标识绝不外传：指纹里不得出现 machine-id 或 MAC 的任何片段
  const mid = dev.readOsMachineId();
  if (mid) assert.ok(!fp1.hash.includes(mid.slice(0, 8)), '指纹不得含 machine-id 片段');
  const mac = dev.readPhysicalMac();
  if (mac) assert.ok(!fp1.hash.includes(mac.replace(/:/g, '').slice(0, 8)), '指纹不得含 MAC 片段');
});

test('device：MAC 可用性判定——排除全零/组播/本地管理地址', () => {
  const { isUsableMac } = require('../collector/lib/device');
  assert.strictEqual(isUsableMac('00:00:00:00:00:00'), false, '全零应排除');
  assert.strictEqual(isUsableMac('01:00:5e:00:00:01'), false, '组播位应排除');
  assert.strictEqual(isUsableMac('02:11:22:33:44:55'), false, '本地管理位（随机化 MAC）应排除');
  assert.strictEqual(isUsableMac('90:16:ba:36:e1:a0'), true, '正常物理 MAC 可用');
  assert.strictEqual(isUsableMac(''), false, '空值应排除');
});

test('device：物理 MAC 取排序后第一个（不受活动网卡变化影响）', () => {
  const { readPhysicalMac } = require('../collector/lib/device');
  const mac = readPhysicalMac();
  if (mac === null) return; // 无物理网卡的容器环境跳过
  assert.match(mac, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/, '应返回规范化的 MAC');
  // 关键：不能取"当前活动网卡"（换根网线就变），必须排序后取第一个且多次调用一致
  assert.strictEqual(readPhysicalMac(), mac, '多次调用结果必须一致');
});

test('device：指纹写入 device.json 并可跨重装认回（adoptDeviceCode）', () => {
  const { loadOrCreateDevice, adoptDeviceCode } = require('../collector/lib/device');
  const d = tmpdir('device-fp');
  const a = loadOrCreateDevice(d, {});
  assert.ok(a.fingerprint, '应写入机器指纹');
  assert.ok(a.fingerprint_source, '应记录指纹来源');

  // 模拟服务端按指纹认回原设备 → 本地对齐设备码
  const changed = adoptDeviceCode(d, 'dev_original1');
  assert.strictEqual(changed, true, '设备码不同时应写入');
  const b = loadOrCreateDevice(d, {});
  assert.strictEqual(b.code, 'dev_original1', '重装后应沿用服务端认回的设备码');
  assert.strictEqual(adoptDeviceCode(d, 'dev_original1'), false, '码相同则不必写盘');
});

test('device：首次生成稳定设备码，重启后不变（同一台机器始终同一设备）', () => {
  const { loadOrCreateDevice } = require('../collector/lib/device');
  const d = tmpdir('device');

  const a = loadOrCreateDevice(d, {});
  assert.match(a.code, /^dev_[0-9a-f]{8}$/, '设备码格式应为 dev_ + 8 hex');
  assert.ok(a.info.hostname, '应采集主机名');
  assert.ok(a.info.platform && a.info.arch, '应采集系统信息');
  assert.ok(a.first_seen, '应记录首次出现时间');

  // 模拟重启：同目录再取，码必须一致（否则历史归档会被割裂成两台设备）
  const b = loadOrCreateDevice(d, {});
  assert.strictEqual(b.code, a.code, '设备码重启后必须稳定');
  assert.strictEqual(b.first_seen, a.first_seen, 'first_seen 不应被刷新');
});

test('device：可用环境配置覆盖设备码与可读名（多机部署显式指定）', () => {
  const { loadOrCreateDevice } = require('../collector/lib/device');
  const d = tmpdir('device-override');
  const dev = loadOrCreateDevice(d, { deviceCode: 'dev_deadbeef', deviceLabel: '我的笔记本' });
  assert.strictEqual(dev.code, 'dev_deadbeef');
  assert.strictEqual(dev.label, '我的笔记本');
  // 覆盖值也落盘，重启后保持
  const again = loadOrCreateDevice(d, {});
  assert.strictEqual(again.code, 'dev_deadbeef');
  assert.strictEqual(again.label, '我的笔记本');
});

test('Uploader：上传体携带设备三元组（设备码 + 设备信息 + agent）', async () => {
  const { Uploader } = require('../collector/lib/uploader');
  const device = { code: 'dev_abcdef01', label: '笔记本', info: { hostname: 'laptop', platform: 'darwin' } };
  const up = new Uploader(
    { collectorId: 'ignored', retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } },
    device
  );
  const batch = up.makeBatch('codex', 'sess-1', [{ rid: 'r', ts: 't', role: 'user', content: 'x' }]);
  assert.strictEqual(batch.device_code, 'dev_abcdef01', '批次应带设备码');
  assert.strictEqual(batch.device_label, '笔记本');

  // 抓取实际发出的请求体，确认设备信息确实上传了
  let sent = null;
  global.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, status: 201, json: async () => ({ ok: true }) };
  };
  await up.send(batch);

  assert.strictEqual(sent.agent, 'codex', '应带 agent');
  assert.strictEqual(sent.device.code, 'dev_abcdef01');
  assert.strictEqual(sent.device.label, '笔记本');
  assert.strictEqual(sent.device.info.platform, 'darwin', '应带设备信息');
  assert.strictEqual(sent.collector_id, 'dev_abcdef01', '兼容字段同步为设备码');
});

// ===== 上限阻断防护（413 拆分 / 毒批 / 进程锁） =====

test('splitBatch：批次过大时一分为二，内容不丢', () => {
  const { splitBatch } = require('../collector/lib/uploader');
  const batch = {
    agent: 'zcode', session_id: 's1', collector_id: 'm1',
    batch_id: 'orig',
    records: Array.from({ length: 5 }, (_, i) => ({ rid: `r${i}`, ts: 't', role: 'user', content: 'x' })),
  };
  const [a, b] = splitBatch(batch);
  assert.strictEqual(a.records.length, 3);
  assert.strictEqual(b.records.length, 2);
  assert.strictEqual(a.records.length + b.records.length, 5, '拆分别丢记录');
  assert.notStrictEqual(a.batch_id, batch.batch_id, '拆分后是新批次（指纹随内容重算）');
  assert.notStrictEqual(a.batch_id, b.batch_id);
  assert.strictEqual(a.attempts, 0, '拆分后重试计数归零');
});

test('Uploader：413 就地拆分并继续，不被队头堵死', async () => {
  const d = tmpdir('413');
  const st = new State(d);
  const up = new Uploader({
    collectorId: 'm1', token: 't', serverUrl: 'http://x',
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
  });
  // 假装服务端说这个批次太大
  up.send = async () => ({ ok: false, retry: false, tooLarge: true, error: 'HTTP 413' });

  const batch = up.makeBatch('zcode', 's1', [
    { rid: 'r1', ts: 't', role: 'user', content: 'a' },
    { rid: 'r2', ts: 't', role: 'user', content: 'b' },
  ]);
  st.enqueue(batch);
  st.commit();

  await up.flush(st);
  // 一批变两批（各自更小），队列不为空但总量守恒
  assert.strictEqual(st.queueSize(), 2, '应拆成两批继续尝试');
  const total = st.data.queue.reduce((n, b) => n + (b.records_count || 0), 0);
  assert.strictEqual(total, 2, '拆分不丢记录');
});

test('Uploader：毒批移到队尾，不阻塞后续批次', async () => {
  const d = tmpdir('poison');
  const st = new State(d);
  const up = new Uploader({
    collectorId: 'm1', token: 't', serverUrl: 'http://x',
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5 },
  });
  // 只有队头失败，其余成功
  let calls = [];
  up.send = async (b) => {
    calls.push(b.session_id);
    if (b.session_id === 'bad') return { ok: false, retry: true, error: 'HTTP 500' };
    return { ok: true };
  };
  st.enqueue(up.makeBatch('zcode', 'bad', [{ rid: 'r', ts: 't', role: 'user', content: 'x' }]));
  st.enqueue(up.makeBatch('zcode', 'good', [{ rid: 'r2', ts: 't', role: 'user', content: 'y' }]));
  st.commit();

  const r = await up.flush(st);
  assert.strictEqual(r.sent, 1, '好批次应成功送达（没被毒批堵住）');
  assert.ok(calls.includes('good'), '应尝试过 good 批次');
  assert.strictEqual(st.queueSize(), 1);
  assert.strictEqual(st.peek().session_id, 'bad', '毒批留在队列（数据不丢）');
});

test('State：进程锁互斥 + 陈锁自动接管', () => {
  const d = tmpdir('lock');
  const s1 = new State(d);
  assert.strictEqual(s1.acquireLock(), true, '首个实例应拿到锁');
  // 同一进程再取（模拟第二个实例）——同 pid 视为存活，拒绝
  const s2 = new State(d);
  assert.strictEqual(s2.acquireLock(), false, '并发实例必须被拒绝');

  s1.releaseLock();
  assert.strictEqual(new State(d).acquireLock(), true, '释放后可再取');

  // 陈锁（持锁进程已不存在）→ 自动接管
  fs.writeFileSync(path.join(d, 'state.lock'), JSON.stringify({ pid: 999999999, at: 'x' }));
  assert.strictEqual(new State(d).acquireLock(), true, '陈锁应被接管（崩溃后可自愈）');
});

test('State：并发写入不因临时文件撞名而失败', () => {
  const d = tmpdir('concurrent');
  const a = new State(d);
  const b = new State(d);
  a.setCursor('k', { offset: 1 });
  b.setCursor('k', { offset: 2 });
  // 两个实例交替提交——固定临时文件名会在这里 ENOENT
  for (let i = 0; i < 20; i++) {
    a.commit();
    b.commit();
  }
  assert.ok(fs.existsSync(path.join(d, 'state.json')));
  assert.deepStrictEqual(fs.readdirSync(d).filter((f) => f.endsWith('.tmp')), [], '不应残留临时文件');
});

// ===== Codex adapter =====

test('codex：解析 rollout 行为归一化记录', () => {
  const lines = [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: { cwd: '/proj', cli_version: '1.0' } }),
    JSON.stringify({
      timestamp: '2026-01-01T00:00:01Z', ordinal: 1, type: 'response_item',
      payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: '你好' }] },
    }),
    JSON.stringify({
      timestamp: '2026-01-01T00:00:02Z', ordinal: 2, type: 'response_item',
      payload: { type: 'function_call', id: 'c1', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' },
    }),
    JSON.stringify({
      timestamp: '2026-01-01T00:00:03Z', ordinal: 3, type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c1', output: 'file.txt' },
    }),
  ];
  const recs = lines.map((l) => codex.normalizeLine('codex', 'sess-1', l, { keepRaw: false })).filter(Boolean);
  assert.strictEqual(recs.length, 4);
  assert.strictEqual(recs[0].role, 'meta');       // session_meta
  assert.strictEqual(recs[1].role, 'user');
  assert.strictEqual(recs[1].content, '你好');
  assert.strictEqual(recs[2].role, 'tool');
  assert.strictEqual(recs[2].meta.tool, 'shell');
  assert.strictEqual(recs[3].meta.kind, 'output');
  // rid 稳定且可区分
  assert.strictEqual(recs[1].rid, 'codex:sess-1:m1');
  assert.strictEqual(recs[2].rid, 'codex:sess-1:c1');
});

test('codex：文件名解析会话 id 与 revert 变体', () => {
  const a = codex.parseName('/x/sessions/2026/01/01/rollout-2026-01-01T00-00-00-11111111-2222-3333-4444-555555555555.jsonl');
  assert.strictEqual(a.sessionId, '11111111-2222-3333-4444-555555555555');
  assert.strictEqual(a.rolloutSuffix, null);

  const b = codex.parseName('/x/sessions/rollout-2026-01-01T00-00-00-11111111-2222-3333-4444-555555555555_aaaa.jsonl');
  assert.strictEqual(b.rolloutSuffix, 'aaaa');
});

// ===== Claude adapter =====

test('claude：transcript 事件展平（文本/工具/结果/推理）', () => {
  const d = {
    uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', type: 'user', cwd: '/proj',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '想一下' },
        { type: 'text', text: '答案是 42' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
        { type: 'tool_result', tool_use_id: 't1', content: '文件内容' },
      ],
    },
  };
  const recs = claude.blocksToRecords('claude', 'sess-9', 'main', d, false);
  const roles = recs.map((r) => r.role);
  assert.deepStrictEqual(roles, ['reasoning', 'assistant', 'tool', 'tool']);
  assert.ok(recs[0].content.includes('想一下'));
  assert.strictEqual(recs[1].content, '答案是 42');
  assert.strictEqual(recs[2].meta.tool, 'Read');
  assert.strictEqual(recs[3].meta.kind, 'output');
});

test('claude：字符串 content（用户提示）与变体识别', () => {
  const d = { uuid: 'u2', type: 'user', message: { role: 'user', content: '帮我改个 bug' } };
  const recs = claude.blocksToRecords('claude', 's1', 'main', d, false);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].role, 'user');
  assert.strictEqual(recs[0].content, '帮我改个 bug');

  // 会话结束时会被改名 —— 同一会话、不同物理文件必须都识别为同一 session
  assert.strictEqual(claude.sessionIdOf('/p/abc-123.jsonl'), 'abc-123');
  assert.strictEqual(claude.sessionIdOf('/p/abc-123.orphaned-1750000000.jsonl'), 'abc-123');
  assert.strictEqual(claude.sessionIdOf('/p/abc-123.superseded-x.jsonl'), 'abc-123');
  assert.strictEqual(claude.variantOf('/p/abc-123.orphaned-1.jsonl'), 'orphaned');
  assert.strictEqual(claude.variantOf('/p/abc-123/subagents/x.jsonl'), 'subagent');
});

// ===== ZCode adapter =====

test('zcode：part 展平为记录，UI 噪音跳过', () => {
  const keepRaw = false;
  const textPart = zcode.partToRecord('sess-1', 'user', {
    id: 'p1', time_created: 1000, time_updated: 2000, sequence: 1,
    data: JSON.stringify({ type: 'text', text: '需要安装 podman' }),
  }, keepRaw);
  assert.strictEqual(textPart.rec.role, 'user');
  assert.strictEqual(textPart.rec.content, '需要安装 podman');
  assert.strictEqual(textPart.rec.rid, 'zcode:sess-1:part_p1');
  assert.strictEqual(textPart.rec.version, 2000); // 版本 = time_updated（原地更新语义）

  const noise = zcode.partToRecord('s', 'assistant', {
    id: 'p2', time_created: 1, time_updated: 2, data: JSON.stringify({ type: 'step-start' }),
  }, keepRaw);
  assert.strictEqual(noise.noise, true);
  assert.strictEqual(noise.rec, null);

  const tool = zcode.partToRecord('s', 'assistant', {
    id: 'p3', time_created: 1, time_updated: 2,
    data: JSON.stringify({ type: 'tool', tool: 'Bash', callID: 'c1', state: { status: 'completed', output: 'done' } }),
  }, keepRaw);
  assert.strictEqual(tool.rec.role, 'tool');
  assert.strictEqual(tool.rec.meta.tool, 'Bash');
  assert.strictEqual(tool.rec.content, 'done');
});

test('zcode：同一记录更新两次 = 同 rid 两个版本（L1 取最大版本收敛）', () => {
  const mk = (upd, text) => zcode.partToRecord('s', 'assistant', {
    id: 'pX', time_created: 1000, time_updated: upd, data: JSON.stringify({ type: 'text', text }),
  }, false).rec;
  const v1 = mk(1000, '部分');
  const v2 = mk(5000, '完整内容');
  assert.strictEqual(v1.rid, v2.rid, '同一条记录 rid 必须一致');
  assert.ok(v2.version > v1.version, '版本号递增，L1 据此取新');
});

module.exports = {};
