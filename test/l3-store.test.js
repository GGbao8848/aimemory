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
