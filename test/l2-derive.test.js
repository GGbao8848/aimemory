'use strict';

/**
 * L2 派生链测试（L1 摘要 → L2 事实）。
 *
 * 重点覆盖：
 * 1) 幂等：摘要没变不重复派生（省 LLM 调用，token 是硬成本）；
 * 2) 重跑：摘要变了自动重新派生（"可从 L0 重放"的兑现）；
 * 3) 降级：判定不可用时不写入（摘要段落不是事实，硬塞会污染记忆）；
 * 4) 重试预算：失败到上限后必须停止（否则坏会话会无限烧 token——L1 曾有此 bug）。
 *
 * LLM 全部 stub，0 token。用独立临时 DB。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-l2d-')), 'test.db');
process.env.AIMEMORY_DB = tmpDb;
process.env.LLM_ENABLED = '1';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const db = require('../src/db');
const llm = require('../src/llm/client');
const emb = require('../src/embeddings/client');
const store = require('../src/l2/store');
const derive = require('../src/l2/derive');
const scheduler = require('../src/l2/scheduler');

const u = config.userId; // 调度器按 config.userId 扫描，测试沿用同一身份

function stubLlmSeq(responses) {
  let i = 0;
  llm.complete = async () => responses[Math.min(i++, responses.length - 1)];
}
const stubLlmNull = () => { llm.complete = async () => null; };

const past = () => new Date(Date.now() - 3600_000).toISOString(); // 已静默 1 小时
const nowIso = () => new Date().toISOString();

let seq = 0;
/** 造一条 L1 摘要（默认已静默 + done） */
function mkSummary({
  sessionId = `s${++seq}`, agent = 'zcode', overview = '会话目标与结果',
  decisions = ['决定 A'], artifacts = ['产出 B'], updatedAt = past(), status = 'done',
} = {}) {
  db.prepare(
    `INSERT INTO l1_summaries (user_id, device_code, agent, session_id, status, overview, decisions, pending, artifacts, created_at, updated_at)
     VALUES (?, 'dev1', ?, ?, ?, ?, ?, '["未决事项"]', ?, ?, ?)`
  ).run(u, agent, sessionId, status, overview, JSON.stringify(decisions), JSON.stringify(artifacts), updatedAt, updatedAt);
  return { device_code: 'dev1', agent, session_id: sessionId };
}

before(() => {
  emb.embed = async () => Buffer.alloc(16, 1);
});

after(() => {
  db.close();
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  for (const t of ['l1_summaries', 'l2_sources', 'memories', 'memory_ops']) {
    db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(u);
  }
});

// ============ 一、摘要 → 事实的转换 ============

test('summaryHash：内容不变则同指纹，decisions 变了则变', () => {
  const a = { overview: '目标', decisions: '["A"]', pending: '[]', artifacts: '["B"]' };
  assert.equal(derive.summaryHash(a), derive.summaryHash({ ...a }));
  assert.notEqual(derive.summaryHash(a), derive.summaryHash({ ...a, decisions: '["A","C"]' }));
});

test('factsFromSummary：取 overview/decisions/artifacts，不取 pending', () => {
  const facts = derive.factsFromSummary({
    overview: '概述', decisions: '["决定1"]', artifacts: '["产出1"]', pending: '["等待测试"]',
  });
  assert.deepEqual(facts, ['概述', '决定1', '产出1']);
  assert.ok(!facts.some((f) => f.includes('等待测试')), '未决事项易过期，不进事实库');
});

// ============ 二、单会话派生 ============

test('deriveOne：事实入库，来源可溯到具体会话', async () => {
  stubLlmSeq(['[{"i":0,"op":"ADD"},{"i":1,"op":"ADD"},{"i":2,"op":"ADD"}]']);
  const summary = { overview: '概述', decisions: '["决定1"]', artifacts: '["产出1"]' };
  const r = await derive.deriveOne({ userId: u, deviceCode: 'dev1', agent: 'zcode', sessionId: 'sess-x', summary });
  assert.equal(r.ok, true);
  assert.equal(r.stats.added, 3);

  const texts = store.recentFacts(u, 10).map((f) => f.text);
  assert.ok(texts.includes('概述') && texts.includes('决定1') && texts.includes('产出1'));
  const op = store.listOps(u, 10)[0];
  assert.equal(op.source, 'l1:zcode/sess-x', '来源必须能回溯到会话');
});

test('deriveOne：判定不可用 → 不写入任何记忆（不把摘要段落硬塞成事实）', async () => {
  stubLlmNull();
  const r = await derive.deriveOne({
    userId: u, deviceCode: 'dev1', agent: 'zcode', sessionId: 'sess-y',
    summary: { overview: '一大段概述', decisions: '[]', artifacts: '[]' },
  });
  assert.equal(r.ok, false);
  assert.equal(store.recentFacts(u, 10).length, 0, '降级路径不得写入');
  assert.equal(store.listOps(u, 10).length, 0);
});

// ============ 三、排队与幂等 ============

test('enqueueStale：已静默的登记排队；刚更新的等它稳定', () => {
  mkSummary({ sessionId: 'quiet-1', updatedAt: past() });
  mkSummary({ sessionId: 'fresh-1', updatedAt: nowIso() }); // 刚被摘要 → 可能还会续上

  const r = scheduler.enqueueStale();
  assert.equal(r.scanned, 2);
  assert.equal(r.queued, 1, '只登记已静默的那个');
  const pending = store.pickL2Pending({ maxAttempts: 3, limit: 10 }).map((j) => j.session_id);
  assert.deepEqual(pending, ['quiet-1']);
});

test('enqueueStale：已派生且摘要未变 → 不重复排队（省 LLM 调用）', async () => {
  mkSummary({ sessionId: 'done-1' });
  stubLlmSeq(['[{"i":0,"op":"ADD"},{"i":1,"op":"ADD"},{"i":2,"op":"ADD"}]']);
  await scheduler.tick();

  let called = 0;
  llm.complete = async () => { called += 1; return '[]'; };
  const r = scheduler.enqueueStale();
  assert.equal(r.requeued, 0);
  assert.equal(r.skipped, 1);
  assert.equal(called, 0, '指纹一致不应发起任何调用');
  assert.equal(store.recentFacts(u, 10).length, 3, '不应重复入库');
});

test('摘要变化 → 自动重新派生（"可从 L0 重放"的兑现）', async () => {
  const s = mkSummary({ sessionId: 'chg-1', overview: '旧概述', decisions: ['旧决定'], artifacts: [] });
  stubLlmSeq(['[{"i":0,"op":"ADD"},{"i":1,"op":"ADD"}]']);
  await scheduler.tick();
  assert.ok(store.recentFacts(u, 10).some((f) => f.text === '旧概述'));

  // L1 重跑后摘要变了（模拟换了摘要算法/会话续写）
  db.prepare("UPDATE l1_summaries SET overview='新概述', decisions='[\"新决定\"]', updated_at=? WHERE session_id='chg-1'").run(past());
  const r = scheduler.enqueueStale();
  assert.equal(r.requeued, 1, '摘要变了要重排队');

  stubLlmSeq(['[{"i":0,"op":"ADD"},{"i":1,"op":"ADD"}]']);
  await scheduler.tick();
  const texts = store.recentFacts(u, 10).map((f) => f.text);
  assert.ok(texts.includes('新概述'), '新摘要内容应派生出来');
});

// ============ 四、状态机与重试预算 ============

test('tick：跑完落 done 并记录操作计数', async () => {
  mkSummary({ sessionId: 'run-1' });
  stubLlmSeq(['[{"i":0,"op":"NOOP"}]']); // 全部判为已存在
  const r = await scheduler.tick();
  assert.equal(r.processed, 1);
  assert.equal(r.done, 1);

  const row = db.prepare("SELECT status, attempts, noop FROM l2_sources WHERE session_id='run-1'").get();
  assert.equal(row.status, 'done');
  assert.equal(row.attempts, 1, 'markL2Running 必须真的生效（字段名映射错误会静默失效）');
  assert.equal(row.noop, 1);
});

test('回归：失败到重试上限后不再被捞回（否则坏会话无限烧 token）', async () => {
  mkSummary({ sessionId: 'poison-1' });
  stubLlmNull(); // 判定始终不可用

  // 每轮 tick 只处理 1 个就 break（LLM 不可用），故循环 3 次打满重试预算
  for (let i = 1; i <= 3; i++) {
    const r = await scheduler.tick();
    assert.equal(r.processed, 1, `第 ${i} 轮应仍被捞回`);
    const attempts = db.prepare("SELECT attempts FROM l2_sources WHERE session_id='poison-1'").get().attempts;
    assert.equal(attempts, i, 'attempts 必须逐轮递增');
  }

  const r4 = await scheduler.tick();
  assert.equal(r4.processed, 0, '达上限后必须停止重试');
  let called = 0;
  llm.complete = async () => { called += 1; return '[]'; };
  await scheduler.tick();
  assert.equal(called, 0, '不再产生任何 LLM 调用');
});

test('tick：无 L1 摘要时不做任何事', async () => {
  stubLlmSeq(['[]']);
  const r = await scheduler.tick();
  assert.equal(r.scanned, 0);
  assert.equal(r.processed, 0);
});
