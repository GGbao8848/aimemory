'use strict';

/**
 * L2 冲突消解测试（ADD / UPDATE / DELETE / NOOP）。
 *
 * 覆盖三类风险：
 * 1) 功能正确：四种操作各自生效，且审计留痕可复原；
 * 2) 安全阀：模型输出不可信——幻觉 target、缺文本、超量删除、非 JSON 输出，都不许误删/丢事实；
 * 3) 降级：LLM 不可用时必须退回纯追加（等价改动前行为），绝不阻塞写入。
 *
 * LLM 全部 stub，0 token 消耗。用独立临时 DB（AIMEMORY_DB），不碰任何真实数据。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-l2-')), 'test.db');
process.env.AIMEMORY_DB = tmpDb;
process.env.LLM_ENABLED = '1';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const db = require('../src/db');
const llm = require('../src/llm/client');
const emb = require('../src/embeddings/client');
const store = require('../src/l2/store');
const reco = require('../src/l2/reconcile');

const u1 = 'l2-user-1';
const u2 = 'l2-user-2';

/** 按顺序返回预设响应（最后一次会重复用于后续调用） */
function stubLlmSeq(responses) {
  let i = 0;
  llm.complete = async () => responses[Math.min(i++, responses.length - 1)];
}
function stubLlmNull() { llm.complete = async () => null; }

before(() => {
  emb.embed = async () => Buffer.alloc(16, 1); // 向量与真实服务解耦
  emb.embedBatch = async () => [];
});

after(() => {
  db.close();
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  for (const u of [u1, u2]) {
    db.prepare('DELETE FROM memories WHERE user_id = ?').run(u);
    db.prepare('DELETE FROM memory_ops WHERE user_id = ?').run(u);
  }
});

/** 造一条已有记忆，返回 id */
const mk = (userId, text) => store.insertFact({ userId, text, metadata: {} });

// ============ 一、applyOps（操作应用层，模型输出已给定） ============

test('ADD：新事实入库并记审计', () => {
  const facts = ['新事实甲'];
  const stats = reco.applyOps({
    userId: u1, facts, ops: [{ op: 'ADD' }], candidates: [], source: 'add_memory',
  });
  assert.equal(stats.added, 1);
  assert.equal(stats.memoryIds.length, 1);
  const ops = store.listOps(u1);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'ADD');
  assert.equal(ops[0].after_text, '新事实甲');
  assert.equal(ops[0].applied, true);
});

test('NOOP：等价事实不新增行，只留审计', () => {
  const id = mk(u1, '服务部署在 10.10.10.88');
  const stats = reco.applyOps({
    userId: u1, facts: ['服务部署在 10.10.10.88'],
    ops: [{ op: 'NOOP', targetId: id }], candidates: [{ id, text: '服务部署在 10.10.10.88' }], source: 'add_memory',
  });
  assert.equal(stats.noop, 1);
  assert.equal(stats.added, 0);
  assert.equal(store.recentFacts(u1, 10).length, 1, '不应新增记忆');
  assert.equal(store.listOps(u1)[0].op, 'NOOP');
});

test('UPDATE：覆盖文本保留 id，before/after 都进审计', () => {
  const id = mk(u1, '服务部署在 10.10.10.88');
  const stats = reco.applyOps({
    userId: u1, facts: ['服务已迁移到 10.10.10.99'],
    ops: [{ op: 'UPDATE', targetId: id, text: '服务部署在 10.10.10.99' }],
    candidates: [{ id, text: '服务部署在 10.10.10.88' }], source: 'add_memory',
  });
  assert.equal(stats.updated, 1);
  assert.deepEqual(stats.memoryIds, [id], 'id 不变（更新而非新增）');
  assert.equal(store.getFact(id, u1).text, '服务部署在 10.10.10.99');
  const op = store.listOps(u1)[0];
  assert.equal(op.op, 'UPDATE');
  assert.equal(op.before_text, '服务部署在 10.10.10.88');
  assert.equal(op.after_text, '服务部署在 10.10.10.99');
});

test('DELETE：删旧 + 存新（"取代"语义），被删文本可从审计复原', () => {
  const id = mk(u1, '服务用 pm2 管理');
  const stats = reco.applyOps({
    userId: u1, facts: ['服务改用 docker 管理'],
    ops: [{ op: 'DELETE', targetId: id }], candidates: [{ id, text: '服务用 pm2 管理' }], source: 'add_memory',
  });
  assert.equal(stats.deleted, 1);
  assert.equal(stats.added, 1, '新事实必须入库存下来——只删不存等于丢数据');
  assert.equal(store.getFact(id, u1), null, '旧行应被删除');
  const texts = store.recentFacts(u1, 10).map((r) => r.text);
  assert.ok(texts.includes('服务改用 docker 管理'), '取代后的新取值要在库里');
  const del = store.listOps(u1, 10).find((o) => o.op === 'DELETE');
  assert.equal(del.before_text, '服务用 pm2 管理', '误删可依据审计复原');
});

test('安全阀：幻觉 target 不算数（不误删，且新事实照存）', () => {
  const id = mk(u1, '真实存在的记忆');
  const stats = reco.applyOps({
    userId: u1, facts: ['全新事实'],
    ops: [{ op: 'DELETE', targetId: '本批次候选里不存在的 id' }],
    candidates: [{ id, text: '真实存在的记忆' }], source: 'add_memory',
  });
  assert.equal(stats.deleted, 0);
  assert.equal(stats.added, 1, '删除目标非法也要保住新事实');
  assert.equal(store.getFact(id, u1) !== null, true, '候选外的行不许被删');
});

test('安全阀：单批删除上限，超出只记审计不执行', () => {
  const ids = [mk(u1, '记忆A'), mk(u1, '记忆B'), mk(u1, '记忆C')];
  const orig = config.l2.maxDeletes;
  config.l2.maxDeletes = 2;
  try {
    const stats = reco.applyOps({
      userId: u1,
      facts: ['新A', '新B', '新C'],
      ops: ids.map((id) => ({ op: 'DELETE', targetId: id })),
      candidates: ids.map((id, i) => ({ id, text: `记忆${'ABC'[i]}` })),
      source: 'add_memory',
    });
    assert.equal(stats.deleted, 2, '只执行上限内的删除');
    assert.equal(stats.skipped, 1);
    assert.equal(stats.added, 3, '三条新事实都要入库（安全阀只拦删除，不拦写入）');
    assert.equal(store.recentFacts(u1, 10).length, 4, '剩 1 条未被删 + 3 条新写入');
    const skippedOp = store.listOps(u1, 10).find((o) => o.applied === false);
    assert.ok(skippedOp, '被拦下的删除要留痕（applied=0），便于观察模型倾向');
    assert.equal(skippedOp.op, 'DELETE');
  } finally {
    config.l2.maxDeletes = orig;
  }
});

test('安全阀：UPDATE 缺文本 / 目标在应用前消失 → 都降级 ADD，不丢事实', () => {
  const stats = reco.applyOps({
    userId: u1, facts: ['甲'],
    ops: [{ op: 'UPDATE', targetId: 'ghost', text: '' }], candidates: [{ id: 'ghost', text: 'x' }], source: 'add_memory',
  });
  assert.equal(stats.added, 1, '缺文本 → 保底 ADD');
  assert.equal(store.recentFacts(u1, 10)[0].text, '甲');
});

// ============ 二、判定输出解析（parseOps） ============

test('parseOps：容错 markdown 代码块与前后文字，非法条目降级 ADD', () => {
  const candidates = [{ id: 'real-1', text: 'a' }, { id: 'real-2', text: 'b' }];
  const out = reco.parseOps(
    '好的，结果如下：\n```json\n[{"i":0,"op":"NOOP","target":"M1"},{"i":1,"op":"UPDATE","target":"M2","text":"合并后"}]\n```',
    { factCount: 2, candidates }
  );
  assert.equal(out[0].op, 'NOOP');
  assert.equal(out[0].targetId, 'real-1');
  assert.equal(out[1].op, 'UPDATE');
  assert.equal(out[1].text, '合并后');

  const bad = reco.parseOps('[{"i":0,"op":"EXPLODE"}]', { factCount: 1, candidates });
  assert.equal(bad[0].op, 'ADD', '未知操作 → 保底 ADD');

  // 同一候选被两条事实同时更新 → 第二条降级 ADD，避免互相覆盖
  const dup = reco.parseOps(
    '[{"i":0,"op":"UPDATE","target":"M1","text":"x"},{"i":1,"op":"UPDATE","target":"M1","text":"y"}]',
    { factCount: 2, candidates }
  );
  assert.equal(dup[0].op, 'UPDATE');
  assert.equal(dup[1].op, 'ADD');
});

test('parseOps：非 JSON 输出返回 null（调用方据此降级）', () => {
  assert.equal(reco.parseOps('这不是 JSON', { factCount: 1, candidates: [] }), null);
});

// ============ 三、候选召回（不依赖 embedding） ============

test('extractTokens：中文长串切窗口、英文与数字词根、双字词进兜底', () => {
  const t = reco.extractTokens('bip-timesheet 服务部署在北极星集群里，用 pm2 管理');
  assert.ok(t.fts.includes('bip-timesheet'), '英文词根应召回');
  assert.ok(t.fts.includes('pm2'));
  assert.ok(t.fts.some((w) => w.includes('北极星')), '长中文串应切成窗口而非整串');
  // 真实场景里双字词由标点/空格/英文隔开（如"用 pm2 管理"→"管理"）：
  // trigram 索引不到它，必须落到 js 兜底，否则这类中文短语一条候选都召不回
  const t2 = reco.extractTokens('用 pm2 管理');
  assert.ok(t2.js.includes('管理'), '双字词应进 js 兜底集合');
  assert.ok(!t2.fts.includes('管理'), '双字词不应进 FTS 集合（会命中不到）');
});

test('findCandidates：命中相关记忆、不跨用户', () => {
  mk(u1, 'bip-timesheet 部署在 10.10.10.214 用 pm2 管理');
  mk(u1, '完全无关的天气话题');
  mk(u2, 'bip-timesheet 部署在 10.10.10.214 用 pm2 管理');

  const found = reco.findCandidates(u1, 'bip-timesheet 部署在 10.10.10.214', 5);
  assert.ok(found.length >= 1, '应命中同主题记忆');
  assert.ok(found.some((c) => c.text.includes('pm2')), '命中的应是相关那条');
  assert.ok(!found.some((c) => c.text.includes('天气')), '无关记忆不应混入');

  const cross = reco.findCandidates(u2, 'bip-timesheet 部署在 10.10.10.214', 5).map((c) => c.id);
  const u1ids = store.recentFacts(u1, 10).map((r) => r.id);
  assert.ok(!cross.some((id) => u1ids.includes(id)), 'u2 的召回不得含 u1 的记忆');
});

// ============ 四、reconcileFacts 端到端（召回 + 判定 + 应用） ============

test('端到端：UPDATE 生效（判定基于真实候选）', async () => {
  const id = mk(u1, '记忆库端口是 18543');
  const facts = ['记忆库端口改为 18544'];
  const cands = reco.gatherCandidates(u1, facts);
  const targetLabel = `M${cands.findIndex((c) => c.id === id) + 1}`;
  assert.ok(cands.some((c) => c.id === id), '前置条件：候选应召回该记忆');

  stubLlmSeq([`[{"i":0,"op":"UPDATE","target":"${targetLabel}","text":"记忆库端口是 18544"}]`]);
  const r = await reco.reconcileFacts({ userId: u1, facts, source: 'l1:zcode/sess-1' });
  assert.equal(r.updated, 1);
  assert.equal(r.degraded, false);
  assert.equal(store.getFact(id, u1).text, '记忆库端口是 18544');
  assert.equal(store.listOps(u1)[0].source, 'l1:zcode/sess-1', '来源要可溯');
});

test('端到端：判定输出非 JSON → 降级为全部 ADD，事实不丢', async () => {
  stubLlmSeq(['抱歉，我不太确定该怎么处理这些内容']);
  const r = await reco.reconcileFacts({ userId: u1, facts: ['甲', '乙'] });
  assert.equal(r.degraded, true);
  assert.equal(r.added, 2);
  assert.equal(store.recentFacts(u1, 10).length, 2);
});

test('端到端：LLM 不可用 → 纯追加（等价改动前行为）', async () => {
  stubLlmNull();
  const r = await reco.reconcileFacts({ userId: u1, facts: ['甲'] });
  assert.equal(r.degraded, true);
  assert.equal(r.added, 1);
});

test('端到端：关闭消解开关（L2_RECONCILE=0）→ 0 token 纯追加', async () => {
  const orig = config.l2.reconcile;
  config.l2.reconcile = false;
  let called = 0;
  llm.complete = async () => { called += 1; return '[]'; };
  try {
    const r = await reco.reconcileFacts({ userId: u1, facts: ['甲', '乙'] });
    assert.equal(r.added, 2);
    assert.equal(called, 0, '关闭后不应发起任何 LLM 调用');
  } finally {
    config.l2.reconcile = orig;
  }
});

test('端到端：事实条数按 maxFacts 截断（token 预算硬约束）', async () => {
  stubLlmSeq(['[]']);
  const orig = config.l2.maxFacts;
  config.l2.maxFacts = 3;
  try {
    const r = await reco.reconcileFacts({ userId: u1, facts: ['a1', 'a2', 'a3', 'a4', 'a5'] });
    assert.equal(r.added, 3, '超量事实应被截断，避免 prompt 膨胀');
  } finally {
    config.l2.maxFacts = orig;
  }
});

// ============ 五、与既有写入链路的集成 ============

test('集成：add_memory 链路经消解入库，事件回执带 ops 明细', async () => {
  const repo = require('../src/db/repo');
  // 第 1 次 complete = 素材提炼；第 2 次 = 冲突消解判定
  stubLlmSeq(['服务备份在 10.10.10.7', '[{"i":0,"op":"ADD"}]']);
  const r = repo.createMemory({ userId: u1, text: '素材原文' });
  await repo.processPendingEvents();
  const ev = repo.getEvent(r.event_id, u1);
  assert.equal(ev.status, 'done');
  assert.equal(ev.result.count, 1);
  assert.ok(ev.result.memories[0].id, '回执仍带记忆对象（形状未变）');
  assert.equal(ev.result.ops.added, 1, '新增 ops 明细');
  assert.equal(ev.result.ops.degraded, false);
});

test('集成：素材中的事实已存在 → 事件 done 且 count=0、ops.noop=1（不报"空产出"）', async () => {
  const repo = require('../src/db/repo');
  mk(u1, '服务备份在 10.10.10.7');
  const facts = ['服务备份在 10.10.10.7'];
  const cands = reco.gatherCandidates(u1, facts);
  const label = `M${cands.findIndex((c) => c.text === '服务备份在 10.10.10.7') + 1}`;
  stubLlmSeq(['服务备份在 10.10.10.7', `[{"i":0,"op":"NOOP","target":"${label}"}]`]);

  const r = repo.createMemory({ userId: u1, text: '重复素材' });
  await repo.processPendingEvents();
  const ev = repo.getEvent(r.event_id, u1);
  assert.equal(ev.status, 'done', '素材已被完整记住，不是失败');
  assert.equal(ev.result.count, 0);
  assert.equal(ev.result.ops.noop, 1);
});

// ============ 六、审计与统计 ============

test('opStats：按操作类型计数', () => {
  const id = mk(u1, '待更新');
  reco.applyOps({ userId: u1, facts: ['新'], ops: [{ op: 'ADD' }], candidates: [], source: 'add_memory' });
  reco.applyOps({ userId: u1, facts: ['改'], ops: [{ op: 'UPDATE', targetId: id, text: '改了' }], candidates: [{ id, text: '待更新' }], source: 'add_memory' });
  reco.applyOps({ userId: u1, facts: ['删'], ops: [{ op: 'DELETE', targetId: id }], candidates: [{ id, text: '改了' }], source: 'add_memory' });
  const s = store.opStats(u1);
  assert.equal(s.ADD, 2, 'DELETE 会同时记一条 ADD（删旧存新）');
  assert.equal(s.UPDATE, 1);
  assert.equal(s.DELETE, 1);
  assert.equal(s.total, 4);
});
