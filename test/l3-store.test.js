'use strict';

/**
 * L3 存储测试：markdown 文件解析↔序列化往返、supersede 链、人工编辑共存。
 * 用独立的临时目录（AIMEMORY_L3_DIR），不碰任何真实数据。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-l3-'));
const tmpDb = path.join(tmpRoot, 'test.db');
process.env.AIMEMORY_DB = tmpDb;
process.env.AIMEMORY_L3_DIR = path.join(tmpRoot, 'l3');
process.env.LLM_ENABLED = '0'; // 本文件不涉及 LLM

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const db = require('../src/db');
const store = require('../src/l3/store');

before(() => {});

after(() => {
  db.close();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  try { fs.rmSync(config.l3Dir, { recursive: true, force: true }); } catch {}
});

test('append → list：字段完整、落在正确的文件里', () => {
  const id = store.appendEntry({
    kind: 'constraints', text: '生产服务部署在内网 10.10.10.x。',
    source: 'l1:zcode/s1', confidence: 0.8, validFrom: '2026-09-18',
  });
  assert.ok(/^[0-9a-f]{8}$/.test(id), 'id 应是 8 位 hex');

  const all = store.listEntries({ kind: 'constraints' });
  assert.equal(all.length, 1);
  assert.equal(all[0].id, id);
  assert.equal(all[0].text, '生产服务部署在内网 10.10.10.x。');
  assert.equal(all[0].valid_from, '2026-09-18');
  assert.equal(all[0].confidence, 0.8);
  assert.equal(all[0].superseded_by, null);
  assert.ok(fs.existsSync(path.join(config.l3Dir, 'constraints.md')), '条目应落盘为 markdown');
});

test('supersede：旧条目不删除、默认清单里不再出现、链路可追溯', () => {
  const oldId = store.appendEntry({ kind: 'profile', text: '偏好用 qwen 系列模型。' });
  const newId = store.appendEntry({ kind: 'profile', text: '偏好用 deepseek 系列模型。' });
  assert.equal(store.markSuperseded(oldId, newId), true);
  assert.equal(store.markSuperseded('不存在的id', newId), false, '幻觉 id 必须被拒绝');

  const active = store.listEntries({ kind: 'profile' });
  assert.equal(active.length, 1);
  assert.equal(active[0].id, newId);

  const all = store.listEntries({ kind: 'profile', includeSuperseded: true });
  assert.equal(all.length, 2);
  const old = all.find((e) => e.id === oldId);
  assert.equal(old.superseded_by, newId, '被取代者指向取代者');
  assert.equal(old.text, '偏好用 qwen 系列模型。', '原文保留（双时间轴可追溯）');
});

test('updateBody：人工编辑正文，created_at 不动、updated_at 刷新', () => {
  const id = store.appendEntry({ kind: 'lessons', text: 'v1' });
  const before = store.getEntry(id);
  const edited = store.updateBody(id, 'v2 · 人工修正过');
  assert.equal(edited.text, 'v2 · 人工修正过');
  assert.equal(edited.created_at, before.created_at, '入库时间轴不该被编辑改动');
  assert.notEqual(edited.updated_at, before.updated_at);
  assert.equal(store.updateBody('不存在', 'x'), null);
  assert.throws(() => store.updateBody(id, '  '), /不能为空/);
});

test('人工直接改文件 → 下一次读取立即生效（文件即事实，无缓存）', () => {
  const id = store.appendEntry({ kind: 'constraints', text: '服务端口是 18543' });
  const file = path.join(config.l3Dir, 'constraints.md');
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8').replace('服务端口是 18543', '服务端口是 18544（人工改）'),
    'utf8'
  );
  const got = store.getEntry(id);
  assert.equal(got.text, '服务端口是 18544（人工改）', '手改必须立刻可见');
});

test('人工删除条目（整块移除）→ removeEntry 等价生效', () => {
  const id = store.appendEntry({ kind: 'lessons', text: '会被删掉的条目' });
  assert.equal(store.removeEntry(id), true);
  assert.equal(store.getEntry(id), null);
  assert.equal(store.removeEntry(id), false);
});

test('l3Stats：按 kind 计数 + 最后更新时间', () => {
  store.appendEntry({ kind: 'profile', text: 'a' });
  store.appendEntry({ kind: 'constraints', text: 'b' });
  const superseded = store.appendEntry({ kind: 'constraints', text: 'b-旧' });
  store.markSuperseded(superseded, store.appendEntry({ kind: 'constraints', text: 'b-新' }));

  const s = store.l3Stats();
  assert.equal(s.active, 3);
  assert.equal(s.superseded, 1);
  assert.equal(s.byKind.constraints.active, 2);
  assert.equal(s.byKind.profile.active, 1);
  assert.ok(s.last_update, '应有最后更新时间');
});

test('非法 kind 与空正文被拒绝', () => {
  assert.throws(() => store.appendEntry({ kind: 'nope', text: 'x' }), /未知的 L3 条目类型/);
  assert.throws(() => store.appendEntry({ kind: 'profile', text: '   ' }), /不能为空/);
  assert.deepEqual(store.listEntries({ kind: 'nope' }), [], '查询未知 kind 返回空而非报错（便于前端容错）');
});

test('序列化往返稳定：读出的文件再写回，内容不变（diff 友好）', () => {
  store.appendEntry({ kind: 'profile', text: '第一行\n第二行', source: 'l1:zcode/s2' });
  const file = path.join(config.l3Dir, 'profile.md');
  const once = fs.readFileSync(file, 'utf8');
  const entries = store.readKind('profile');
  fs.writeFileSync(file, store.serializeKind('profile', entries), 'utf8');
  assert.equal(fs.readFileSync(file, 'utf8'), once, '二次序列化应逐字节一致');
});

test('置信度时效衰减：新≈原值，半衰处减半，远古趋近 0，边界安全', () => {
  const now = Date.now();
  const day = 86400000;
  const iso = (ms) => new Date(ms).toISOString();

  assert.equal(store.effectiveConfidence(null, iso(now), { now }), null, '无置信度 → null');
  assert.ok(Math.abs(store.effectiveConfidence(0.8, iso(now - 3600e3), { now }) - 0.8) < 0.001, '1 小时前 ≈ 原值');
  const half = store.effectiveConfidence(0.8, iso(now - 180 * day), { now, halfLifeDays: 180 });
  assert.ok(Math.abs(half - 0.4) < 0.001, '半衰期处恰好衰减一半');
  const ancient = store.effectiveConfidence(0.8, iso(now - 1800 * day), { now, halfLifeDays: 180 });
  assert.ok(ancient >= 0 && ancient < 0.001, '10 倍半衰期后趋近 0');
  assert.ok(Math.abs(store.effectiveConfidence(0.8, iso(now - 90 * day), { now, halfLifeDays: 90 }) - 0.4) < 0.001, '半衰期可调');
  assert.equal(store.effectiveConfidence(0.8, '2020-01-01T00:00:00Z', { now, halfLifeDays: 0 }), 0.8, 'halfLife≤0 = 关衰减');
  assert.equal(store.effectiveConfidence(0.8, 'not-a-date', { now }), 0.8, '坏时间戳不衰减也不崩');
  const future = store.effectiveConfidence(0.8, iso(now + 30 * day), { now });
  assert.equal(future, 0.8, '未来时间戳不放大（age 钳到 0）');
});

test('listEntries 携带 effective_confidence，文件原值不动', () => {
  const id = store.appendEntry({ kind: 'constraints', text: '端口固定为 18543', confidence: 0.8 });
  const got = store.listEntries({ kind: 'constraints' })[0];
  assert.equal(got.confidence, 0.8, '原值保留');
  assert.ok(Math.abs(got.effective_confidence - 0.8) < 0.001, '新建条目有效置信 ≈ 原值');
  // 手工把 updated_at 改到远古 → 有效置信应显著低于原值，且文件中的 confidence 原值不被改写
  const file = path.join(config.l3Dir, 'constraints.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/updated_at=[^ ]+/, 'updated_at=2020-01-01T00:00:00.000Z'), 'utf8');
  const old = store.listEntries({ kind: 'constraints' })[0];
  assert.ok(old.effective_confidence < 0.1, '远古条目有效置信趋近 0');
  assert.equal(old.confidence, 0.8, '文件原值不受衰减视图影响');
  assert.equal(store.getEntry(id).confidence, 0.8);
});

test('l3Stats 输出 active 条目的平均有效置信度', () => {
  store.appendEntry({ kind: 'profile', text: 'a', confidence: 0.6 });
  store.appendEntry({ kind: 'constraints', text: 'b', confidence: 0.8 });
  const s = store.l3Stats();
  assert.ok(typeof s.effective_confidence === 'number' && s.effective_confidence > 0.6, '平均有效置信应在区间内');
  assert.ok(typeof s.byKind.profile.effective_confidence === 'number');
});
