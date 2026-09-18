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
  const r1 = store.ingestBatch({ userId: 'u1', agent: 'codex', sessionId: 's1', collectorId: 'm1', records });
  assert.strictEqual(r1.deduped, false);
  assert.strictEqual(r1.stored, 2);

  // 同批次重传（模拟网络重试）→ 幂等跳过，不追加
  const r2 = store.ingestBatch({ userId: 'u1', agent: 'codex', sessionId: 's1', collectorId: 'm1', records });
  assert.strictEqual(r2.deduped, true);
  assert.strictEqual(r2.stored, 0);

  const lines = fs.readFileSync(store.sessionFilePath('u1', 'codex', 's1'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2, '重传不得产生重复行');
  const first = JSON.parse(lines[0]);
  assert.strictEqual(first.rid, 'codex:s1:m1');
  assert.ok(first._bid, '应带批次指纹');
});

test('L0 store：同一会话多次采集 = 追加到同一文件（append-only）', () => {
  store.ingestBatch({
    userId: 'u2', agent: 'codex', sessionId: 's-append',
    records: [{ rid: 'codex:s-append:a', ts: 't1', role: 'user', content: '第一轮' }],
  });
  store.ingestBatch({
    userId: 'u2', agent: 'codex', sessionId: 's-append',
    records: [{ rid: 'codex:s-append:b', ts: 't2', role: 'assistant', content: '第二轮' }],
  });
  const lines = fs.readFileSync(store.sessionFilePath('u2', 'codex', 's-append'), 'utf8').trim().split('\n');
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
