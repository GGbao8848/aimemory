'use strict';

/**
 * 素材原文归档回归：
 * - 受理即落档（raw_materials 与 event 同 id，可回溯原文）
 * - 保留期清理：到期删除，0 = 永久保留
 * 独立临时 DB；受理用 stub llm（只测受理/归档，不跑提炼）。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-rawarch-')), 'test.db');
process.env.AIMEMORY_DB = tmpDb;

const { test, before } = require('node:test');
const assert = require('node:assert');
const events = require('../src/db/repo/events');
const config = require('../src/config');
const db = require('../src/db');
const llm = require('../src/llm/client');

const u = 'raw-archive-user';

before(() => {
  llm.enabled = () => true; // 受理前检查 LLM 开关
});

test('受理即落档：原文随 event 存入 raw_materials（text 与 messages 两种形态）', () => {
  const r1 = events.createMemory({ userId: u, text: '这是一段会话素材原文' });
  const r2 = events.createMemory({ userId: u, messages: [{ role: 'user', content: '对话素材' }] });
  const row1 = db.prepare('SELECT kind, input FROM raw_materials WHERE id = ?').get(r1.event_id);
  assert.equal(row1.kind, 'text');
  assert.equal(JSON.parse(row1.input), '这是一段会话素材原文');
  const row2 = db.prepare('SELECT kind, input FROM raw_materials WHERE id = ?').get(r2.event_id);
  assert.equal(row2.kind, 'messages');
  assert.deepEqual(JSON.parse(row2.input), [{ role: 'user', content: '对话素材' }]);
});

test('保留期清理：到期删除，未到期保留，0 = 永久保留', () => {
  // 造一条 100 天前的归档
  const old = { id: 'evt-old', userId: u, kind: 'text', input: '老素材' };
  events.archiveMaterial(old);
  db.prepare("UPDATE raw_materials SET created_at = ? WHERE id = 'evt-old'")
    .run(new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString());

  config.rawArchiveDays = 90;
  events.cleanupRawMaterials();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM raw_materials WHERE id = 'evt-old'").get().c, 0, '到期被清理');
  assert.ok(db.prepare('SELECT COUNT(*) c FROM raw_materials WHERE user_id = ?').get(u).c >= 2, '未到期的保留');

  config.rawArchiveDays = 0; // 永久保留
  events.archiveMaterial({ id: 'evt-ancient', userId: u, kind: 'text', input: '远古素材' });
  db.prepare("UPDATE raw_materials SET created_at = '2020-01-01T00:00:00Z' WHERE id = 'evt-ancient'");
  events.cleanupRawMaterials();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM raw_materials WHERE id = 'evt-ancient'").get().c, 1, '0 天 = 不清理');
});
