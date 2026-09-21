'use strict';

/**
 * 素材重提回归：溯源打标 → 单条重提（删同源旧记忆、原文重新入队）→ 全库重提。
 * 直存/无溯源的记忆永不触碰。独立临时 DB + stub LLM。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-reextract-')), 'test.db');
process.env.AIMEMORY_DB = tmpDb;

const { test, before } = require('node:test');
const assert = require('node:assert');
const events = require('../src/db/repo/events');
const extract = require('../src/l2/extract');
const store = require('../src/l2/store');
const config = require('../src/config');
const db = require('../src/db');
const llm = require('../src/llm/client');

const u = 'reextract-user';

before(() => {
  llm.enabled = () => true;
  config.l2.minImportance = 4;
});

test('提炼产物带溯源（raw_event_id），直存记忆没有', async () => {
  scriptLlm([() => '服务器 A 的生产端口是 7001，这是一个关键环境事实。', () => null]);
  const acc = events.createMemory({ userId: u, text: '素材原文' });
  await events.processPendingEvents();
  const mem = db.prepare('SELECT id, raw_event_id FROM memories WHERE raw_event_id = ?').get(acc.event_id);
  assert.ok(mem, '提炼产物应带溯源');
  const direct = store.insertFact({ userId: u, text: '直存的一条原文，与素材无关' });
  assert.equal(db.prepare('SELECT raw_event_id FROM memories WHERE id = ?').get(direct).raw_event_id, null);
});

test('单条重提：删同源旧记忆、原文重新入队，无溯源记忆不受影响', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM memories WHERE user_id = ?').get(u).c;
  const r = events.reextractRawMaterials({ userId: u, ids: [firstEventId()] });
  assert.equal(r.accepted, 1);
  assert.equal(r.deleted, 1, '同源旧记忆被删除');
  const ev = db.prepare('SELECT status, payload FROM events WHERE id = ?').get(firstEventId());
  assert.equal(ev.status, 'pending', '原文重新入队');
  const payload = JSON.parse(ev.payload);
  assert.equal(payload.input, '素材原文');
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM memories WHERE user_id = ?').get(u).c,
    before - 1, '只删了同源那一条',
  );
  // 清队：让重提任务跑完，避免影响后续用例
  scriptLlm([() => '服务器 A 的生产端口是 7001，重提后的事实陈述。', () => null]);
  await events.processPendingEvents();
});

test('全库重提（all=true）：所有素材重新入队', async () => {
  const rawCount = db.prepare('SELECT COUNT(*) c FROM raw_materials WHERE user_id = ?').get(u).c;
  const r = events.reextractRawMaterials({ userId: u, all: true });
  assert.equal(r.accepted, rawCount);
  const pendings = db.prepare("SELECT COUNT(*) c FROM events WHERE user_id = ? AND status = 'pending'").get(u).c;
  assert.equal(pendings, rawCount);
  // 清空队列
  scriptLlm([() => '重提产物事实陈述，超过十个字符。', () => null]);
  while ((await events.processPendingEvents()) > 0) { /* 串行清完 */ }
});

function scriptLlm(steps) {
  let i = 0;
  llm.complete = async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return step();
  };
}

function firstEventId() {
  return db.prepare('SELECT id FROM events WHERE user_id = ? ORDER BY created_at LIMIT 1').get(u).id;
}
