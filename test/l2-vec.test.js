'use strict';

/**
 * L2 向量层测试（sqlite-vec）。
 *
 * 这里验证的是** SQL 管道**（建表 / 写入 / KNN / 删除 / 降级 / 重建），
 * 用**手工构造的向量**而非 embedding 服务——本机没有 embedding 服务，
 * 真实语义检索效果待生产环境接上后另行验证（见 docs/L2-事实记忆与冲突消解.md P3 说明）。
 *
 * 顺带固化两个踩过的坑：rowid 必须 BigInt 绑定、距离度量必须是 cosine。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-l2v-')), 'test.db');
process.env.AIMEMORY_DB = tmpDb;
process.env.LLM_ENABLED = '1';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const db = require('../src/db');
const emb = require('../src/embeddings/client');
const store = require('../src/l2/store');
const vec = require('../src/l2/vec');

const u1 = 'vec-user-1';
const u2 = 'vec-user-2';

const buf = (arr) => Buffer.from(new Float32Array(arr).buffer);

/** 写入一条记忆并**手工设定**向量（绕开 embedding 服务，保证确定性） */
function mkWithVec(userId, text, arr) {
  const id = store.insertFact({ userId, text, metadata: {} });
  db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(buf(arr), id);
  vec.upsert(id, buf(arr));
  return id;
}

before(() => {
  // 本文件不依赖 embedding 服务：关掉自动补向量，向量全部手工设定
  emb.embed = async () => null;
});

after(() => {
  db.close();
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  for (const t of ['memories', 'memory_ops']) for (const u of [u1, u2]) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(u);
  try { db.exec('DELETE FROM memories_vec'); } catch { /* 表可能还没建 */ }
});

test('status：扩展可用（本机已装 sqlite-vec）', () => {
  const s = vec.status();
  assert.equal(s.available, true, `扩展应可用：${s.reason || ''}`);
});

test('upsert + search：按余弦相似度排序，语义与旧的 JS 全扫一致', () => {
  const a = mkWithVec(u1, '完全同向', [1, 0, 0, 0]);
  const b = mkWithVec(u1, '四十五度', [0.7071, 0.7071, 0, 0]);
  const c = mkWithVec(u1, '正交', [0, 1, 0, 0]);

  const hits = vec.search(u1, buf([1, 0, 0, 0]), 10, 0);
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((h) => h.id), [a, b, c], '相似度应从高到低');
  assert.ok(Math.abs(hits[0].similarity - 1) < 1e-4, '同向向量相似度应为 1（cosine 度量，不是 L2）');
  assert.ok(Math.abs(hits[2].similarity - 0) < 1e-4, '正交向量相似度应为 0');
});

test('search：threshold 过滤生效（与 searchMemories 的阈值语义一致）', () => {
  mkWithVec(u1, '同向', [1, 0, 0, 0]);
  mkWithVec(u1, '正交', [0, 1, 0, 0]);
  const hits = vec.search(u1, buf([1, 0, 0, 0]), 10, 0.5);
  assert.equal(hits.length, 1, '只应留下相似度 ≥ 0.5 的');
  assert.ok(hits[0].similarity > 0.5);
});

test('search：按 user 隔离（不返回他人记忆）', () => {
  mkWithVec(u1, 'u1 的记忆', [1, 0, 0, 0]);
  const other = mkWithVec(u2, 'u2 的记忆', [1, 0, 0, 0]);
  const hits = vec.search(u1, buf([1, 0, 0, 0]), 10, 0);
  assert.equal(hits.length, 1);
  assert.ok(!hits.some((h) => h.id === other), '不得跨 user 召回');
});

test('remove：记忆删除后向量同步清掉', () => {
  const id = mkWithVec(u1, '待删除', [1, 0, 0, 0]);
  assert.equal(vec.search(u1, buf([1, 0, 0, 0]), 10, 0).length, 1);
  store.deleteFact({ userId: u1, id });
  assert.equal(vec.search(u1, buf([1, 0, 0, 0]), 10, 0).length, 0, '删除记忆必须同时清掉索引条目');
});

test('维度不匹配 → 明确降级（不返回错结果）', () => {
  mkWithVec(u1, '四维', [1, 0, 0, 0]);
  assert.equal(vec.search(u1, buf([1, 0, 0, 0, 0, 0, 0, 0]), 10, 0), null, '查询维度不符应返回 null 让调用方降级');
  const id = store.insertFact({ userId: u1, text: '八维', metadata: {} });
  assert.equal(vec.upsert(id, buf([1, 0, 0, 0, 0, 0, 0, 0])), false, '写入维度不符应返回 false');
});

test('rebuild：索引清空后可用已存 embedding 重建', () => {
  const id = mkWithVec(u1, '有向量的记忆', [1, 0, 0, 0]);
  db.exec('DELETE FROM memories_vec');
  assert.equal(vec.search(u1, buf([1, 0, 0, 0]), 10, 0).length, 0);
  const r = vec.rebuild({ userId: u1 });
  assert.equal(r.ok, true);
  assert.ok(r.indexed >= 1, '应把有向量的记忆补进索引');
  const hits = vec.search(u1, buf([1, 0, 0, 0]), 10, 0);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, id);
});

test('降级：L2_VEC=0 时所有函数安全返回、不抛错', () => {
  config.l2.vec = false;
  delete require.cache[require.resolve('../src/l2/vec')];
  const vecOff = require('../src/l2/vec');
  try {
    const s = vecOff.status();
    assert.equal(s.available, false);
    assert.equal(vecOff.search(u1, buf([1, 0, 0, 0]), 10, 0), null, '不可用时应返回 null');
    assert.equal(vecOff.upsert('whatever', buf([1, 0, 0, 0])), false);
    assert.equal(vecOff.remove(1), false);
    assert.equal(vecOff.rebuild().ok, false);
  } finally {
    config.l2.vec = true;
    delete require.cache[require.resolve('../src/l2/vec')];
  }
});

// ===== G4：语义检索上线准备——rebuild 幂等 / 增量 / 维度变更 =====

test('rebuild 幂等：重复执行不产生重复命中，indexed 数稳定', () => {
  const a = mkWithVec(u1, 'rebuild 幂等一', [1, 0, 0, 0]);
  const b = mkWithVec(u1, 'rebuild 幂等二', [0.9, 0.1, 0, 0]);
  const r1 = vec.rebuild({ userId: u1 });
  const r2 = vec.rebuild({ userId: u1 });
  assert.equal(r2.indexed, r1.indexed, '第二次 rebuild 不应新增（upsert 按 rowid 幂等）');
  const hits = vec.search(u1, buf([1, 0, 0, 0]), 50, 0);
  const ids = hits.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length, '命中不得重复');
  assert.ok(ids.includes(a) && ids.includes(b), '既有向量应全部可召回');
});

test('rebuild 增量：补上向量后再 rebuild 能收进索引', () => {
  const plain = store.insertFact({ userId: u1, text: '先没有向量的记忆', metadata: {} });
  db.prepare('UPDATE memories SET embedding = NULL WHERE id = ?').run(plain);
  const seeded = mkWithVec(u1, '已有向量的记忆', [1, 0, 0, 0]);
  let r = vec.rebuild({ userId: u1 });
  assert.ok(!vec.search(u1, buf([1, 0, 0, 0]), 50, 0).map((h) => h.id).includes(plain),
    '无向量者不进索引');
  db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(buf([1, 0, 0, 0]), plain);
  r = vec.rebuild({ userId: u1 });
  assert.ok(r.indexed >= 2);
  const ids = vec.search(u1, buf([1, 0, 0, 0]), 50, 0).map((h) => h.id);
  assert.ok(ids.includes(plain) && ids.includes(seeded), '补向量后 rebuild 应收进索引');
});

test('维度变更：reset=true 后以新维度重建，旧维度查询不返回错结果', () => {
  const c = mkWithVec(u1, '八维新世界', [1, 0, 0, 0, 0, 0, 0, 0]);
  const r = vec.rebuild({ userId: u1, reset: true });
  assert.equal(r.ok, true);
  assert.equal(r.dim, 8, '维度随新数据重置');
  const hits = vec.search(u1, buf([1, 0, 0, 0, 0, 0, 0, 0]), 10, 0);
  assert.ok(hits.some((h) => h.id === c), '新维度正常召回');
  const stale = vec.search(u1, buf([1, 0, 0, 0]), 10, 0);
  assert.ok(stale === null || stale.length === 0, '旧维度查询宁可不返回，也不返回错结果');
});
