'use strict';

/**
 * L0 服务端落盘测试：批次幂等、按会话归档、路径穿越防护。
 *
 * 与 memory.test.js 同样的隔离约定：必须在 require 业务模块之前设置
 * AIMEMORY_DB（独立临时库）与 AIMEMORY_L0_DIR（独立归档目录），
 * 否则会写进生产 data/ 下的库与目录。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l0-srv-'));
process.env.AIMEMORY_DB = path.join(workDir, 'test.db');
process.env.AIMEMORY_L0_DIR = path.join(workDir, 'l0');

const test = require('node:test');
const assert = require('node:assert');

const store = require('../src/l0/store');
const config = require('../src/config');

const L0_ROOT = fs.realpathSync(fs.mkdirSync(config.l0Dir, { recursive: true }) || config.l0Dir);

test('L0 store：批次落盘 + 幂等重传不重复追加', () => {
  const records = [
    { rid: 'codex:s1:m1', ts: '2026-01-01T00:00:00Z', role: 'user', content: '你好' },
    { rid: 'codex:s1:m2', ts: '2026-01-01T00:00:01Z', role: 'assistant', content: '你好，有什么可以帮你' },
  ];
  const r1 = store.ingestBatch({ userId: 'u1', agent: 'codex', sessionId: 's1', deviceCode: 'dev-1', collectorId: 'm1', records });
  assert.strictEqual(r1.deduped, false);
  assert.strictEqual(r1.stored, 2);

  // 同批次重传（模拟网络重试）→ 幂等跳过，不追加
  const r2 = store.ingestBatch({ userId: 'u1', agent: 'codex', sessionId: 's1', deviceCode: 'dev-1', collectorId: 'm1', records });
  assert.strictEqual(r2.deduped, true);
  assert.strictEqual(r2.stored, 0);

  const lines = fs.readFileSync(store.sessionFilePath('u1', 'dev-1', 'codex', 's1'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2, '重传不得产生重复行');
  const first = JSON.parse(lines[0]);
  assert.strictEqual(first.rid, 'codex:s1:m1');
  assert.ok(first._bid, '应带批次指纹');
});

test('L0 store：同一会话多次采集 = 追加到同一文件（append-only）', () => {
  store.ingestBatch({
    userId: 'u2', agent: 'codex', sessionId: 's-append', deviceCode: 'dev-1',
    records: [{ rid: 'codex:s-append:a', ts: 't1', role: 'user', content: '第一轮' }],
  });
  store.ingestBatch({
    userId: 'u2', agent: 'codex', sessionId: 's-append', deviceCode: 'dev-1',
    records: [{ rid: 'codex:s-append:b', ts: 't2', role: 'assistant', content: '第二轮' }],
  });
  const lines = fs.readFileSync(store.sessionFilePath('u2', 'dev-1', 'codex', 's-append'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0].includes('第一轮'));
  assert.ok(lines[1].includes('第二轮'));
});

test('L0 store：路径片段白名单化（防目录穿越）', () => {
  // 产出不含任何路径分隔符，且不以 . 开头
  for (const evil of ['../../etc/passwd', 'a/b\\c', '..', '.hidden']) {
    const s = store.sanitizeSeg(evil);
    assert.ok(!s.includes('/'), `不得含 / : ${s}`);
    assert.ok(!s.includes('\\'), `不得含 \\ : ${s}`);
    assert.ok(!s.startsWith('.'), `不得以 . 开头 : ${s}`);
  }

  const r = store.ingestBatch({
    userId: '../../x', agent: '../y', sessionId: '../z',
    records: [{ rid: 'r', ts: 't', role: 'user', content: 'x' }],
  });
  // 文件必须落在归档根目录之内
  assert.ok(fs.realpathSync(r.file).startsWith(L0_ROOT), '落盘路径不得逃出归档根');
});

test('L0 store：空记录被拒（不静默接受空批次）', () => {
  assert.throws(
    () => store.ingestBatch({ userId: 'u1', agent: 'codex', sessionId: 's1', records: [] }),
    /records 不能为空/
  );
  assert.throws(
    () => store.ingestBatch({ userId: 'u1', agent: 'codex', sessionId: 's1' }),
    /records 不能为空/
  );
});

test('L0 store：归档统计与磁盘文件数对账', () => {
  const before = store.archiveStats('u3');
  store.ingestBatch({
    userId: 'u3', agent: 'codex', sessionId: 's1',
    records: [{ rid: 'r1', ts: 't', role: 'user', content: 'x'.repeat(100) }],
  });
  store.ingestBatch({
    userId: 'u3', agent: 'claude', sessionId: 's2',
    records: [{ rid: 'r2', ts: 't', role: 'user', content: 'y' }],
  });
  const st = store.archiveStats('u3');
  assert.strictEqual(st.batches, before.batches + 2);
  assert.strictEqual(st.sessions, 2);
  assert.strictEqual(st.agents, 2);
  assert.strictEqual(st.files, 2);
  assert.ok(st.disk_bytes > 0);
  assert.strictEqual(st.records, 2);
});

test('L0 store：会话清单可查（供 Web / status 展示）', () => {
  const list = store.listSessions('u3');
  assert.strictEqual(list.length, 2);
  const agents = list.map((s) => s.agent).sort();
  assert.deepStrictEqual(agents, ['claude', 'codex']);
  assert.ok(list.every((s) => s.last_received));
});

// ===== 设备维度（跨机归类） =====

test('L0 store：同一用户两台设备，归档与会话按设备区分', () => {
  // 两台机器、同一员工、各自不同 agent：必须能分开查
  store.ingestBatch({
    userId: 'u-dev', agent: 'codex', sessionId: 's-laptop',
    deviceCode: 'dev_1111', deviceLabel: '笔记本',
    deviceInfo: { hostname: 'laptop', platform: 'darwin', arch: 'arm64' },
    records: [{ rid: 'l0:dev:A', ts: 't', role: 'user', content: '笔记本上的会话' }],
  });
  store.ingestBatch({
    userId: 'u-dev', agent: 'zcode', sessionId: 's-desktop',
    deviceCode: 'dev_2222', deviceLabel: '台式机',
    deviceInfo: { hostname: 'desktop', platform: 'linux', arch: 'x64' },
    records: [{ rid: 'l0:dev:B', ts: 't', role: 'user', content: '台式机上的会话' }],
  });

  const devices = store.listDevices('u-dev');
  assert.strictEqual(devices.length, 2);
  const laptop = devices.find((d) => d.device_code === 'dev_1111');
  assert.strictEqual(laptop.label, '笔记本');
  assert.strictEqual(laptop.info.platform, 'darwin');
  assert.deepStrictEqual(laptop.agents, ['codex']);
  assert.strictEqual(laptop.sessions, 1);

  // 按设备过滤会话
  const onlyLaptop = store.listSessions('u-dev', { deviceCode: 'dev_1111' });
  assert.strictEqual(onlyLaptop.length, 1);
  assert.strictEqual(onlyLaptop[0].session_id, 's-laptop');
  assert.strictEqual(onlyLaptop[0].device_code, 'dev_1111');

  // 不筛则两台都返回
  assert.strictEqual(store.listSessions('u-dev', {}).length, 2);

  // 概况里的设备数
  assert.strictEqual(store.archiveStats('u-dev').devices, 2);
});

test('L0 store：归档路径含设备维度，且行内自述来源', () => {
  const r = store.ingestBatch({
    userId: 'u-path', agent: 'codex', sessionId: 's1',
    deviceCode: 'dev_abc', deviceLabel: 'X',
    records: [{ rid: 'r', ts: 't', role: 'user', content: 'x' }],
  });
  // 路径形如 <root>/<user>/<device>/<agent>/<session>.jsonl
  const rel = path.relative(L0_ROOT, r.file).split(path.sep);
  assert.deepStrictEqual(rel, ['u-path', 'dev_abc', 'codex', 's1.jsonl']);

  // 每一行都带 _dev / _agent，文件被单独取走也能自述来源（可审计）
  const line = JSON.parse(fs.readFileSync(r.file, 'utf8').trim().split('\n')[0]);
  assert.strictEqual(line._dev, 'dev_abc');
  assert.strictEqual(line._agent, 'codex');
});

test('L0 store：设备码缺省回退 collector_id，便于老客户端兼容', () => {
  const r = store.ingestBatch({
    userId: 'u-fallback', agent: 'codex', sessionId: 's1',
    collectorId: 'legacy-host',  // 老客户端只发 collector_id
    records: [{ rid: 'r', ts: 't', role: 'user', content: 'x' }],
  });
  assert.ok(r.file.includes(`${path.sep}legacy-host${path.sep}`), `应回退用 collector_id 作设备码：${r.file}`);
  assert.strictEqual(store.listDevices('u-fallback')[0].device_code, 'legacy-host');
});

test('L0 store：设备信息后续上报可补全（label/info 不被空值清掉）', () => {
  store.ingestBatch({
    userId: 'u-upd', agent: 'codex', sessionId: 's1', deviceCode: 'dev_upd', deviceLabel: '旧名',
    deviceInfo: { platform: 'linux' },
    records: [{ rid: 'r1', ts: 't', role: 'user', content: 'x' }],
  });
  // 第二次上报不带 label/info（模拟客户端字段缺失）→ 已有信息必须保留
  store.ingestBatch({
    userId: 'u-upd', agent: 'claude', sessionId: 's2', deviceCode: 'dev_upd',
    records: [{ rid: 'r2', ts: 't', role: 'user', content: 'y' }],
  });
  const d = store.listDevices('u-upd').find((x) => x.device_code === 'dev_upd');
  assert.strictEqual(d.label, '旧名', 'label 不应被空值覆盖');
  assert.strictEqual(d.info.platform, 'linux', 'info 不应被空值覆盖');
  assert.deepStrictEqual(d.agents.sort(), ['claude', 'codex'], 'agents 应取并集');
});

test('L0 store：读会话内容——归属校验防跨用户越权', () => {
  store.ingestBatch({
    userId: 'u-owner', agent: 'codex', sessionId: 's-secret', deviceCode: 'dev_s',
    records: [{ rid: 'r', ts: 't', role: 'user', content: '机密内容' }],
  });

  const mine = store.readSession('u-owner', { deviceCode: 'dev_s', agent: 'codex', sessionId: 's-secret' });
  assert.strictEqual(mine.records.length, 1);
  assert.strictEqual(mine.records[0].content, '机密内容');

  // 换个用户读同一会话 → 必须拒绝（不能只靠路径拼接）
  assert.strictEqual(store.readSession('u-other', { deviceCode: 'dev_s', agent: 'codex', sessionId: 's-secret' }), null);
  // 不存在的会话
  assert.strictEqual(store.readSession('u-owner', { deviceCode: 'dev_s', agent: 'codex', sessionId: 'nope' }), null);
});
