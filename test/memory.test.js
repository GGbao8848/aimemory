'use strict';

/**
 * 核心回归测试（素材提炼型记忆库）：
 * - 写入语义：add 一律异步受理（text/messages 都返回 event_id），不落原文
 * - 提炼流程：事件 done 后产物入库；提炼失败/无产物 → failed，素材不落库
 * - CRUD / user_id 过滤正确性 / 关键词检索兜底 / schema
 *
 * 用独立临时 DB（AIMEMORY_DB），不碰生产数据。运行：npm test
 * LLM 与 embedding 用 stub 假实现（不依赖外部服务），保证确定性。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-test-')), 'test.db');
process.env.AIMEMORY_DB = tmpDb;
// 关闭真实 LLM（stub 接管 complete）
process.env.LLM_ENABLED = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const repo = require('../src/db/repo');
const db = require('../src/db');
const llm = require('../src/llm/client');
const emb = require('../src/embeddings/client');

const u1 = 'test-user-1';
const u2 = 'test-user-2';

/** stub LLM：把素材按行拆成"事实行"返回（模拟提炼输出多条） */
function stubLlmSuccess(lines) {
  llm.complete = async () => lines.join('\n');
}
/** stub LLM：模拟不可用（返回 null） */
function stubLlmFail() {
  llm.complete = async () => null;
}
/** stub embedding：返回固定向量（与真实 embedding 解耦） */
function stubEmbed() {
  emb.embed = async () => Buffer.alloc(16, 1);
  emb.embedBatch = async () => [];
}

before(() => {
  stubEmbed();
  // 清空该测试用户历史残留
  for (const u of [u1, u2]) {
    db.prepare('DELETE FROM memories WHERE user_id = ?').run(u);
    db.prepare('DELETE FROM events WHERE user_id = ?').run(u);
  }
});

after(() => {
  db.close();
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch {}
});

/** 受理一条写入并驱动后台处理直至终态，返回事件 */
async function submitAndProcess({ userId, text, messages }) {
  const r = repo.createMemory({ userId, text, messages });
  assert.ok(r.event_id, '应返回 event_id');
  assert.equal(r.status, 'pending');
  await repo.processPendingEvents();
  const ev = repo.getEvent(r.event_id, userId);
  return ev;
}

test('schema：无退役表残留，events 保留为任务队列，mem0 维度列在位', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('events'), 'events 表应保留（素材提炼队列）');
  assert.ok(!tables.includes('connect_codes'));
  assert.ok(!tables.includes('memories_history'));
  const cols = db.prepare('PRAGMA table_info(memories)').all().map((c) => c.name);
  assert.ok(cols.includes('agent_id'), 'agent_id 应在位（mem0 维度）');
  assert.ok(cols.includes('run_id'), 'run_id 应在位（mem0 维度）');
  assert.ok(!cols.includes('archived'));
  for (const gone of ['l0_records', 'l0_devices', 'l0_batches', 'l1_summaries', 'l2_sources', 'l3_state', 'connect_requests']) {
    assert.ok(!tables.includes(gone), `退役表应删除：${gone}`);
  }
});

test('text 素材：异步受理 + 提炼成功入库（产物非原文）', async () => {
  stubLlmSuccess(['北极星项目计划明年 Q1 上线', '北极星项目代号用于内部沟通']);
  const ev = await submitAndProcess({ userId: u1, text: '素材原文：项目叫北极星，计划 Q1 上线。这段过程性描述不该入库。' });
  assert.equal(ev.status, 'done', '提炼成功应 done');
  assert.ok(ev.result.count >= 1);
  // 产物应为 LLM 提炼后的（不含原文里的过程性句子）
  const list = repo.listMemories({ userId: u1 }).results;
  const texts = list.map((m) => m.text);
  assert.ok(texts.some((t) => t.includes('北极星')), '产物应含提炼内容');
  assert.ok(!texts.some((t) => t.includes('这段过程性描述不该入库')), '原文不应整段入库');
});

test('messages 素材：提炼成多条独立记忆', async () => {
  stubLlmSuccess(['服务部署在 10.10.10.88', '该服务使用 docker 运行']);
  const ev = await submitAndProcess({
    userId: u1,
    messages: [
      { role: 'user', content: '我们 wiki 部署在 10.10.10.88' },
      { role: 'assistant', content: '用 docker 跑的' },
    ],
  });
  assert.equal(ev.status, 'done');
  assert.ok(ev.result.count >= 2, '多轮对话应提炼出多条');
});

test('提炼失败（LLM 无产出）→ 事件 failed，素材不落库', async () => {
  stubLlmFail(); // complete 返回 null → 提炼无产出
  const beforeCount = repo.stats(u1).memories;
  const ev = await submitAndProcess({ userId: u1, text: '这段素材应该被拒绝入库' });
  assert.equal(ev.status, 'failed', 'LLM 无产出应 failed');
  assert.ok(ev.error, 'failed 应带 error');
  const afterCount = repo.stats(u1).memories;
  assert.equal(afterCount, beforeCount, '失败素材不应落库（记忆数不变）');
});

test('LLM 未启用时直接拒绝受理', () => {
  // 模拟 LLM_ENABLED=0：enabled() 返回 false
  const orig = llm.enabled;
  llm.enabled = () => false;
  try {
    assert.throws(() => repo.createMemory({ userId: u1, text: 'x' }), /未启用/, 'LLM 禁用应抛错');
  } finally {
    llm.enabled = orig;
  }
});

test('text 读取 / 更新 / 删除', async () => {
  stubLlmSuccess(['手动添加的最终记忆文本 v1']);
  const ev = await submitAndProcess({ userId: u1, text: '手动内容' });
  assert.equal(ev.status, 'done');
  const id = ev.result.memories[0].id;
  const got = repo.getMemory(id, u1);
  assert.equal(got.id, id);
  const upd = repo.updateMemory({ id, userId: u1, text: '手动添加的最终记忆文本 v2' });
  assert.equal(upd.text, '手动添加的最终记忆文本 v2');
  assert.equal(repo.deleteMemory(id, u2), false, '非归属身份不得删除（user_id 过滤生效）');
  assert.equal(repo.deleteMemory(id, u1), true);
});

test('关键词检索命中（stub embedding 向量恒定，走 FTS 也能命中）', async () => {
  stubLlmSuccess(['bip-timesheet 部署在 10.10.10.214 用 pm2 管理']);
  await submitAndProcess({ userId: u1, text: '部署相关信息' });
  const res = await repo.searchMemories({ userId: u1, query: 'pm2 部署', limit: 5 });
  assert.ok(res.length >= 1, '关键词检索应命中');
});

test('user_id 过滤：u2 查不到 u1 的记忆（单用户下仍保证查询不串账本）', async () => {
  const before = repo.stats(u1).memories;
  const res = await repo.searchMemories({ userId: u2, query: 'bip-timesheet', limit: 10 });
  assert.equal(res.length, 0, 'u2 搜不到 u1 的记忆');
  assert.ok(repo.stats(u1).memories >= before);
});

test('filters：时间范围过滤', () => {
  const past = repo.listMemories({ userId: u1, filters: { created_at: { lte: '2020-01-01T00:00:00Z' } } });
  assert.equal(past.total, 0);
});

test('统计 stats', () => {
  const s = repo.stats(u1);
  assert.ok(typeof s.memories === 'number');
});
