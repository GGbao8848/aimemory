'use strict';

/**
 * 更新后局部重消解测试（评估轮 Q5）：
 * update_memory 改文本 → 后台与邻居做「同一事实」检测，重复则删旧候选保留新文本。
 * 安全阀全覆盖：幻觉 id、LLM 失败、开关关闭、目标已删——任何异常路径都不许动用户的数据。
 * LLM 全部 stub，0 token；独立临时 DB。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-l2u-')), 'test.db');
process.env.AIMEMORY_DB = tmpDb;
process.env.LLM_ENABLED = '1';
process.env.EMBEDDING_ENABLED = '0';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const db = require('../src/db');
const repo = require('../src/db/repo');
const llm = require('../src/llm/client');
const l2reconcile = require('../src/l2/reconcile');
const store = require('../src/l2/store');

const U = 'update-reconcile-user';

test.after(() => {
  db.close();
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch {}
});

/** 直写一条记忆（不走 add_memory 队列，夜间红线） */
function seed(text) {
  return store.insertFact({ userId: U, text, metadata: {} });
}

function setup() {
  db.prepare('DELETE FROM memories WHERE user_id = ?').run(U);
  db.prepare('DELETE FROM memory_ops WHERE user_id = ?').run(U);
}

test('无候选可比 → checked 但 0 次 LLM 调用（0 token 快路径）', async () => {
  setup();
  let llmCalls = 0;
  const orig = llm.complete;
  llm.complete = async () => { llmCalls += 1; return null; };
  try {
    const m = seed('孤立记忆：某年某月某日的一次性备注。');
    const r = await l2reconcile.reconcileAfterUpdate({ userId: U, memoryId: m });
    assert.equal(r.checked, true);
    assert.equal(r.merged, 0);
    assert.equal(llmCalls, 0, '无邻居时不应发起 LLM 调用');
  } finally {
    llm.complete = orig;
  }
});

test('同一事实（措辞不同）→ 删旧候选、保留刚更新的这条，审计留痕', async () => {
  setup();
  const n = seed('服务监听端口 18543（内网）。');         // 旧候选
  const m = seed('项目服务端口是 8000。');
  repo.updateMemory({ id: m, userId: U, text: '项目服务端口是 18543。' });

  const orig = llm.complete;
  llm.complete = async () => JSON.stringify({ duplicate_of: n });
  try {
    const r = await l2reconcile.reconcileAfterUpdate({ userId: U, memoryId: m });
    assert.equal(r.merged, 1, '应合并（删除旧候选）');
    assert.equal(repo.getMemory(n, U), null, '旧候选应被删除');
    assert.ok(repo.getMemory(m, U), '刚更新的这条必须幸存');
    const ops = db.prepare("SELECT * FROM memory_ops WHERE user_id = ? AND source = 'update_reconcile'").all(U);
    assert.equal(ops.length, 1);
    assert.equal(ops[0].op, 'DELETE');
    assert.equal(ops[0].memory_id, n, '审计记录的是被删的候选');
    assert.ok(ops[0].before_text.includes('18543'), 'beforeText 可复原');
  } finally {
    llm.complete = orig;
  }
});

test('模型判 UNIQUE（duplicate_of=null）→ 什么都不删', async () => {
  setup();
  const n = seed('部署用 docker compose。');
  const m = seed('项目端口是 8000。');
  repo.updateMemory({ id: m, userId: U, text: '项目端口是 18543。' });
  const orig = llm.complete;
  llm.complete = async () => JSON.stringify({ duplicate_of: null });
  try {
    const r = await l2reconcile.reconcileAfterUpdate({ userId: U, memoryId: m });
    assert.equal(r.merged, 0);
    assert.ok(repo.getMemory(n, U), '候选不应被动');
  } finally {
    llm.complete = orig;
  }
});

test('幻觉 id（不在候选集）→ 一律无视', async () => {
  setup();
  seed('部署用 docker compose。');
  const m = seed('项目端口是 8000。');
  repo.updateMemory({ id: m, userId: U, text: '项目端口是 18543。' });
  const orig = llm.complete;
  llm.complete = async () => JSON.stringify({ duplicate_of: 'hallucinated-id' });
  try {
    const r = await l2reconcile.reconcileAfterUpdate({ userId: U, memoryId: m });
    assert.equal(r.merged, 0);
    const ops = db.prepare("SELECT COUNT(*) n FROM memory_ops WHERE user_id = ? AND source = 'update_reconcile'").get(U);
    assert.equal(ops.n, 0, '不应产生审计（什么都没做）');
  } finally {
    llm.complete = orig;
  }
});

test('LLM 失败/输出不可解析 → skipped，绝不误删', async () => {
  setup();
  const n = seed('服务监听端口 18543。');
  const m = seed('项目端口是 8000。');
  repo.updateMemory({ id: m, userId: U, text: '项目服务端口是 18543。' });
  const orig = llm.complete;
  for (const bad of [null, '不是JSON', '{"duplicate_of": 123}']) {
    llm.complete = async () => bad;
    const r = await l2reconcile.reconcileAfterUpdate({ userId: U, memoryId: m });
    assert.equal(r.merged, 0, `输入 ${JSON.stringify(bad)} 不应触发合并`);
    assert.ok(repo.getMemory(n, U));
  }
  llm.complete = orig;
});

test('L2_RECONCILE 关闭 → 直接跳过；记忆不存在 → 跳过', async () => {
  setup();
  const m = seed('孤立记忆。');
  const orig = llm.complete;
  let called = 0;
  llm.complete = async () => { called += 1; return null; };
  try {
    config.l2.reconcile = false;
    let r = await l2reconcile.reconcileAfterUpdate({ userId: U, memoryId: m });
    assert.equal(r.skipped, true);
    assert.equal(called, 0);
    config.l2.reconcile = true;
    r = await l2reconcile.reconcileAfterUpdate({ userId: U, memoryId: 'no-such-id' });
    assert.equal(r.skipped, true);
    assert.equal(called, 0);
  } finally {
    config.l2.reconcile = true;
    llm.complete = orig;
  }
});

test('MCP update_memory 改文本会触发后台重消解（fire-and-forget，响应不等它）', async () => {
  setup();
  const { tools, callTool } = require('../src/mcp/tools');
  seed('部署用 docker compose。');
  const m = seed('项目端口是 8000。');
  const origReconcile = l2reconcile.reconcileAfterUpdate;
  const origLlm = llm.complete;
  let calledWith = null;
  l2reconcile.reconcileAfterUpdate = async (args) => { calledWith = args; return { checked: true, merged: 0, skipped: false }; };
  try {
    const out = await callTool('update_memory', { memory_id: m, text: '项目端口是 18543。' }, U);
    assert.ok(!out.isError, '更新本身必须成功且不被重消解拖慢');
    // fire-and-forget：让出微任务队列后应已发起
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calledWith, { userId: U, memoryId: m }, '应以更新后的记忆 id 触发');
    // metadata-only 更新不触发
    calledWith = null;
    await callTool('update_memory', { memory_id: m, metadata: { tag: 'x' } }, U);
    await new Promise((r) => setImmediate(r));
    assert.equal(calledWith, null, '仅改 metadata 不应触发重消解');
  } finally {
    l2reconcile.reconcileAfterUpdate = origReconcile;
    llm.complete = origLlm;
  }
});
