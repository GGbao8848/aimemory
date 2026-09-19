'use strict';

/**
 * 跨路径消解竞态测试（评估规划 G8）：
 * 同一段素材可能同时从「素材管线（events 队列）」和「L2 派生（l1 摘要自动沉淀）」到达。
 * 消解临界区（读候选 → LLM 判定 → 写入）已用进程内互斥串行化——
 * 后到者能看到先到者的产物 → 判 NOOP，同一事实只落一条。
 * LLM stub 模拟真实判定器：候选池非空且语义相同 → NOOP；空 → ADD。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-xpath-')), 'test.db');
process.env.AIMEMORY_DB = tmpDb;
process.env.LLM_ENABLED = '1';
process.env.EMBEDDING_ENABLED = '0';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const llm = require('../src/llm/client');
const reconcile = require('../src/l2/reconcile');
const store = require('../src/l2/store');

const U = 'crosspath-user';

test.after(() => {
  db.close();
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch {}
});

/** 模拟真实判定器：prompt 里带候选（已有记忆）→ NOOP；无候选 → ADD */
function installJudge() {
  const orig = llm.complete;
  let calls = 0;
  llm.complete = async (messages) => {
    calls += 1;
    const user = Array.isArray(messages) ? messages.map((m) => m.content).join('\n') : String(messages);
    const hasCandidate = /已有记忆（标注来源）：\n\[M1\]/.test(user);
    const op = hasCandidate ? { i: 0, op: 'NOOP', target: 'M1' } : { i: 0, op: 'ADD' };
    return JSON.stringify([op]);
  };
  return { orig, counter: () => calls };
}

test('并发双路提交同一事实：互斥串行化后只落一条', async () => {
  db.prepare('DELETE FROM memories WHERE user_id = ?').run(U);
  const judge = installJudge();
  const fact = { userId: U, facts: ['项目服务端口是 18543。'], source: 'add_memory', metadata: {}, mode: 'material' };

  // 两条链同时提交（derive 线用 l1 来源标签）——不 await 第一条就发起第二条
  const [a, b] = await Promise.all([
    reconcile.reconcileFacts({ ...fact }),
    reconcile.reconcileFacts({ ...fact, source: 'l1:codex/session-1', metadata: { source: 'l1' }, mode: 'derive' }),
  ]);
  try {
    assert.equal(judge.counter(), 2, '两次判定都应发生（串行执行）');
    const total = db.prepare('SELECT COUNT(*) c FROM memories WHERE user_id = ?').get(U).c;
    assert.equal(total, 1, `同一事实只应落一条（竞态时会是 2）`);
    assert.ok(a.memoryIds.length === 1 || b.memoryIds.length === 1, '恰好一条路径真实入库');
    assert.ok(a.added + b.added === 1, `add 总数应为 1（实际 ${a.added + b.added}）`);
    assert.equal(a.noop + b.noop, 1, '后到者应被判 NOOP');
  } finally {
    llm.complete = judge.orig;
  }
});

test('来源标签进入判定 prompt（l1 派生 vs 素材提炼，辅助模型识别跨来源同义）', async () => {
  db.prepare('DELETE FROM memories WHERE user_id = ?').run(U);
  store.insertFact({ userId: U, text: '部署在内网 10.10.10.214。', metadata: { source: 'l1:codex/session-9' } });
  const prompt = require('../src/l2/reconcile').buildPrompt({
    facts: ['部署在内网 10.10.10.214。'],
    candidates: [{ id: 'x', text: '部署在内网 10.10.10.214。', source: 'l1:codex/session-9' }],
    mode: 'material',
  });
  const text = prompt.map((m) => m.content).join('\n');
  assert.ok(text.includes('会话摘要派生(l1:codex/session-9)'), 'l1 来源应标注为派生');
  assert.ok(/不得因措辞差异判 ADD/.test(text), '跨来源措辞规则应在 system 侧');
});
