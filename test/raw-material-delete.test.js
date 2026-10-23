'use strict';

/**
 * 素材归档删除回归（deleteRawMaterials）：删素材连同其提炼出的记忆一并删除
 * （留变更历史 source=material_delete + 清向量）；直存/无溯源记忆永不触碰；
 * events 行同步清除（不留 pending 僵尸任务）。独立临时 DB + stub LLM。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-rawdel-')), 'test.db');
process.env.AIMEMORY_DB = tmpDb;

const { test, before } = require('node:test');
const assert = require('node:assert');
const events = require('../src/db/repo/events');
const extract = require('../src/l2/extract');
const store = require('../src/l2/store');
const config = require('../src/config');
const db = require('../src/db');
const llm = require('../src/llm/client');

const u = 'rawdel-user';

/** 打桩 LLM：拦截 llm.complete（提炼/标注/消解都走它），按调用次序返回产出 */
function scriptLlm(steps) {
  let i = 0;
  llm.complete = async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return step();
  };
}

before(() => {
  llm.enabled = () => true;
  config.l2.minImportance = 4;
});

let eventId = null;

test('准备：一份素材提炼出记忆 + 一条直存记忆', async () => {
  scriptLlm([() => '临时项目 X 的构建命令是 make build-all，这是关键环境事实。', () => null]);
  const acc = events.createMemory({ userId: u, text: '临时项目素材原文' });
  eventId = acc.event_id;
  await events.processPendingEvents();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memories WHERE raw_event_id = ?').get(eventId).c, 1, '素材产物入库');
  store.insertFact({ userId: u, text: '直存的一条原文，与素材无关，删除素材后必须仍在' });
});

test('删除素材：归档行、事件、提炼记忆一并清除，直存记忆不受影响', () => {
  const r = events.deleteRawMaterials({ userId: u, ids: [eventId] });
  assert.equal(r.accepted, 1);
  assert.equal(r.deleted, 1, '同源记忆被连带删除');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM raw_materials WHERE id = ?').get(eventId).c, 0, '归档行已删');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM events WHERE id = ?').get(eventId).c, 0, '事件行已删（不留僵尸任务）');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memories WHERE raw_event_id = ?').get(eventId).c, 0, '提炼记忆已删');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories WHERE user_id = ? AND text LIKE '直存%'").get(u).c, 1, '直存记忆不受影响');
  const op = db.prepare("SELECT before_text FROM memory_ops WHERE user_id = ? AND source = 'material_delete' AND op = 'DELETE'").get(u);
  assert.ok(op && op.before_text.includes('构建命令'), '删除留痕（可追溯被删原文）');
});

test('边界：空 ids / 未知 id / 跨用户 id 均安全无副作用', () => {
  assert.deepStrictEqual(events.deleteRawMaterials({ userId: u, ids: [] }), { accepted: 0, deleted: 0 });
  assert.deepStrictEqual(events.deleteRawMaterials({ userId: u, ids: ['no-such-id'] }), { accepted: 0, deleted: 0 });
  assert.deepStrictEqual(events.deleteRawMaterials({ userId: 'other-user', ids: [eventId] }), { accepted: 0, deleted: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memories WHERE user_id = ?').get(u).c, 1, '剩余仅直存一条');
});
