'use strict';

/**
 * 记忆来源标记（origin）回归：
 * - 原文直存（infer=false / insertFact 默认）→ direct
 * - LLM 提炼产物（reconcile insertFact）→ llm，向量补齐成功后升级 llm+embedding
 * 用独立临时 DB 与 stub embedding，不碰生产数据、不依赖外部服务。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-origin-')), 'test.db');
process.env.AIMEMORY_DB = tmpDb;

const { test, before } = require('node:test');
const assert = require('node:assert');
const store = require('../src/l2/store');
const db = require('../src/db');
const emb = require('../src/embeddings/client');

const u = 'origin-test-user';

before(() => {
  // stub：embed 恒成功（4 字节 = 1 维 float32），可开关
  emb.embed = async (text) => (emb.__ok ? Buffer.alloc(4) : null);
  emb.__ok = true;
});

test('原文直存 → direct；向量补齐成功也不改标', async () => {
  const id = store.insertFact({ userId: u, text: '服务器 LAN IP 是 10.2.28.65' });
  await new Promise((r) => setImmediate(r));
  const row = db.prepare('SELECT origin, embedding FROM memories WHERE id = ?').get(id);
  assert.equal(row.origin, 'direct');
  assert.ok(Buffer.isBuffer(row.embedding), 'direct 也补检索向量');
});

test('LLM 提炼产物 → llm；向量补齐成功后升级 llm+embedding', async () => {
  const id = store.insertFact({ userId: u, text: 'BIP 登录接口为 POST /powerbip/login.do', origin: 'llm' });
  await new Promise((r) => setImmediate(r));
  assert.equal(db.prepare('SELECT origin FROM memories WHERE id = ?').get(id).origin, 'llm+embedding');
});

test('embedding 失败 → llm 保持不升级；direct 不受影响', async () => {
  emb.__ok = false;
  try {
    const a = store.insertFact({ userId: u, text: '这条走 LLM 提炼但没有向量', origin: 'llm' });
    const b = store.insertFact({ userId: u, text: '这条直接存且没有向量' });
    await new Promise((r) => setImmediate(r));
    assert.equal(db.prepare('SELECT origin FROM memories WHERE id = ?').get(a).origin, 'llm');
    assert.equal(db.prepare('SELECT origin FROM memories WHERE id = ?').get(b).origin, 'direct');
  } finally {
    emb.__ok = true;
  }
});
