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

// ===== 记录级去重（批次指纹挡不住"同内容不同分块"） =====

test('L0 store：记录级去重——同内容不同分块不得重复落盘', () => {
  // 这是真实踩过的坑：批次指纹对整个批次内容敏感，批大小一变指纹就变，
  // 服务端会把同样的记录再落一遍。记录级去重按 (rid, version) 兜底。
  const mk = (i) => ({ rid: `dedup:s:${i}`, ts: 't', version: 100, role: 'user', content: `c${i}` });

  // 第一次：3 条一起传
  const a = store.ingestBatch({
    userId: 'u-dd', agent: 'zcode', sessionId: 's', deviceCode: 'dev_dd',
    records: [mk(1), mk(2), mk(3)],
  });
  assert.strictEqual(a.stored, 3);

  // 第二次：同样的记录、不同分块（2+1）→ 应全部识别为已收，不落盘
  const b = store.ingestBatch({
    userId: 'u-dd', agent: 'zcode', sessionId: 's', deviceCode: 'dev_dd',
    records: [mk(1), mk(2)],
  });
  assert.strictEqual(b.stored, 0, '已收记录不得重复落盘');
  assert.strictEqual(b.deduped, true);
  assert.strictEqual(b.skipped, 2);

  // 部分新、部分旧 → 只落新的
  const c = store.ingestBatch({
    userId: 'u-dd', agent: 'zcode', sessionId: 's', deviceCode: 'dev_dd',
    records: [mk(2), mk(4)],
  });
  assert.strictEqual(c.stored, 1, '只应落新记录');
  assert.strictEqual(c.skipped, 1);

  const lines = fs.readFileSync(store.sessionFilePath('u-dd', 'dev_dd', 'zcode', 's'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 4, `文件应只有 4 条唯一记录，实际 ${lines.length}`);
});

test('L0 store：同一 rid 的不同 version 必须保留（ZCode 原地更新的收敛依据）', () => {
  const rec = (v, content) => ({ rid: 'ver:s:p1', ts: 't', version: v, role: 'assistant', content });

  store.ingestBatch({
    userId: 'u-ver', agent: 'zcode', sessionId: 's', deviceCode: 'dev_v',
    records: [rec(1000, '部分内容')],
  });
  const r = store.ingestBatch({
    userId: 'u-ver', agent: 'zcode', sessionId: 's', deviceCode: 'dev_v',
    records: [rec(2000, '完整内容')],
  });
  assert.strictEqual(r.stored, 1, '版本上涨的记录是合法更新，必须落盘');

  const lines = fs.readFileSync(store.sessionFilePath('u-ver', 'dev_v', 'zcode', 's'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2, '两个版本都应保留（供 L1 取最大版本）');

  // 同一版本重复 → 拦掉
  const dup = store.ingestBatch({
    userId: 'u-ver', agent: 'zcode', sessionId: 's', deviceCode: 'dev_v',
    records: [rec(2000, '完整内容')],
  });
  assert.strictEqual(dup.stored, 0);
});

test('L0 store：跨设备同名会话互不干扰（去重按设备隔离）', () => {
  const rec = { rid: 'x:same:r1', ts: 't', version: 1, role: 'user', content: 'x' };
  store.ingestBatch({ userId: 'u-x', agent: 'codex', sessionId: 'same', deviceCode: 'dev_A', records: [rec] });
  const b = store.ingestBatch({ userId: 'u-x', agent: 'codex', sessionId: 'same', deviceCode: 'dev_B', records: [rec] });
  assert.strictEqual(b.stored, 1, '不同设备的同名会话是两份独立数据，不应被去重拦掉');
});

// ===== 设备统一（机器指纹认回） =====

test('L0 store：重装后设备码变了，凭指纹归回原设备（不重复建一台）', () => {
  const fp = 'fp_aaaaaaaaaaaaaaaa';
  const rec = (i) => ({ rid: `adopt:s:${i}`, ts: 't', version: 1, role: 'user', content: `c${i}` });

  // 首次：设备码 dev_first，登记指纹
  const a = store.ingestBatch({
    userId: 'u-adopt', agent: 'codex', sessionId: 's1',
    deviceCode: 'dev_first', deviceLabel: '笔记本',
    deviceFingerprint: fp, deviceFingerprintSource: 'machine-id',
    records: [rec(1)],
  });
  assert.strictEqual(a.device_code, 'dev_first');
  assert.strictEqual(a.device_adopted, false, '首次不应触发认回');

  // 模拟重装：状态目录丢失 → 生成新设备码，但指纹相同
  const b = store.ingestBatch({
    userId: 'u-adopt', agent: 'codex', sessionId: 's2',
    deviceCode: 'dev_second', deviceLabel: '笔记本',
    deviceFingerprint: fp, deviceFingerprintSource: 'machine-id',
    records: [rec(2)],
  });
  assert.strictEqual(b.device_code, 'dev_first', '指纹命中应归回原设备码');
  assert.strictEqual(b.device_adopted, true, '应标记为认回');
  assert.ok(b.file.includes(`${path.sep}dev_first${path.sep}`), `归档应落在原设备目录：${b.file}`);

  // 设备表里只应有一台设备（指纹唯一指向）
  const devs = store.listDevices('u-adopt');
  assert.strictEqual(devs.length, 1, `不应重复建设备，实际 ${devs.map((d) => d.device_code)}`);
  assert.strictEqual(devs[0].device_code, 'dev_first');
  assert.strictEqual(devs[0].fingerprint, fp, '应记录指纹');
  assert.strictEqual(devs[0].fingerprint_source, 'machine-id');
  // 两次会话都归在同一设备下
  assert.strictEqual(devs[0].sessions, 2);
});

test('L0 store：不同指纹互不认回（两台机器各自独立）', () => {
  store.ingestBatch({
    userId: 'u-fp2', agent: 'codex', sessionId: 'a',
    deviceCode: 'dev_m1', deviceFingerprint: 'fp_1111111111111111',
    records: [{ rid: 'f:a', ts: 't', version: 1, role: 'user', content: 'x' }],
  });
  const b = store.ingestBatch({
    userId: 'u-fp2', agent: 'codex', sessionId: 'b',
    deviceCode: 'dev_m2', deviceFingerprint: 'fp_2222222222222222',
    records: [{ rid: 'f:b', ts: 't', version: 1, role: 'user', content: 'y' }],
  });
  assert.strictEqual(b.device_adopted, false, '指纹不同不应认回');
  assert.strictEqual(store.listDevices('u-fp2').length, 2, '应是两台独立设备');
});

test('L0 store：跨用户指纹不互相认回（指纹查找限定在用户内）', () => {
  const fp = 'fp_cccccccccccccccc';
  store.ingestBatch({
    userId: 'u-owner-a', agent: 'codex', sessionId: 's', deviceCode: 'dev_oa',
    deviceFingerprint: fp, records: [{ rid: 'o:1', ts: 't', version: 1, role: 'user', content: 'x' }],
  });
  const b = store.ingestBatch({
    userId: 'u-owner-b', agent: 'codex', sessionId: 's', deviceCode: 'dev_ob',
    deviceFingerprint: fp, records: [{ rid: 'o:2', ts: 't', version: 1, role: 'user', content: 'y' }],
  });
  assert.strictEqual(b.device_code, 'dev_ob', '别人的设备码不得被借用');
  assert.strictEqual(b.device_adopted, false);
});

test('L0 store：不提供指纹的老客户端照常工作（回退 collector_id）', () => {
  const b = store.ingestBatch({
    userId: 'u-nofp', agent: 'codex', sessionId: 's', collectorId: 'legacy-host',
    records: [{ rid: 'n:1', ts: 't', version: 1, role: 'user', content: 'x' }],
  });
  assert.strictEqual(b.device_code, 'legacy-host');
  assert.strictEqual(b.device_adopted, false);
  assert.strictEqual(store.listDevices('u-nofp')[0].fingerprint, null, '无指纹时该列为空');
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

test('L0 store：重装时默认主机名不得打回用户自定义的设备名', () => {
  // 首次：用户显式命名（与主机名不同 → 视为自定义名）
  store.ingestBatch({
    userId: 'u-lbl', agent: 'codex', sessionId: 's1', deviceCode: 'dev_lbl',
    deviceLabel: '张三的笔记本', deviceInfo: { hostname: 'DESKTOP-ABC' },
    records: [{ rid: 'l:1', ts: 't', version: 1, role: 'user', content: 'x' }],
  });
  // 重装：没带 AIMEMORY_DEVICE_LABEL → label 回落主机名（默认值）
  store.ingestBatch({
    userId: 'u-lbl', agent: 'codex', sessionId: 's2', deviceCode: 'dev_lbl',
    deviceLabel: 'DESKTOP-ABC', deviceInfo: { hostname: 'DESKTOP-ABC' },
    records: [{ rid: 'l:2', ts: 't', version: 1, role: 'user', content: 'y' }],
  });
  const d = store.listDevices('u-lbl').find((x) => x.device_code === 'dev_lbl');
  assert.strictEqual(d.label, '张三的笔记本', '默认主机名不应覆盖自定义名');

  // 反过来：用户显式改了名（非主机名）→ 应当生效
  store.ingestBatch({
    userId: 'u-lbl', agent: 'codex', sessionId: 's3', deviceCode: 'dev_lbl',
    deviceLabel: '换了个名字', deviceInfo: { hostname: 'DESKTOP-ABC' },
    records: [{ rid: 'l:3', ts: 't', version: 1, role: 'user', content: 'z' }],
  });
  const d2 = store.listDevices('u-lbl').find((x) => x.device_code === 'dev_lbl');
  assert.strictEqual(d2.label, '换了个名字', '显式改名应生效');
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
