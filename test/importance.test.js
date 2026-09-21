'use strict';

/**
 * 长期价值门槛（importance）回归：仿 Generative Agents 的写入时评分过滤。
 * - 标注成功：低于 L2_MIN_IMPORTANCE 的事实不入库（宁缺毋滥）
 * - 标注失败（null）：fail-open，全部入库（行为与无评分时一致）
 * - 评分随标注写入 memories.importance
 * 用独立临时 DB 与 stub LLM（按调用顺序返回：第 1 次提炼、第 2 次标注），不依赖外部服务。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-importance-')), 'test.db');
process.env.AIMEMORY_DB = tmpDb;

const { test, before } = require('node:test');
const assert = require('node:assert');
const extract = require('../src/l2/extract');
const config = require('../src/config');
const db = require('../src/db');
const llm = require('../src/llm/client');

const u = 'importance-test-user';

/** 按脚本顺序响应 llm.complete：提炼调用返回按行事实，标注调用返回 JSON */
function scriptLlm(steps) {
  let i = 0;
  llm.enabled = () => true;
  llm.complete = async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return step();
  };
}

before(() => { config.l2.minImportance = 4; });

test('评分达标的事实入库并写入 importance；低于阈值的不入库', async () => {
  scriptLlm([
    () => '服务器 A 的生产端口是 7001。\n本次会话我打开了三个终端窗口。', // 提炼
    () => JSON.stringify([
      { entities: ['服务器 A'], categories: ['devops'], importance: 8 },
      { entities: [], categories: [], importance: 1 },
    ]),
  ]);
  const r = await extract.processMemoryMaterial({ userId: u, kind: 'text', input: '素材' });
  assert.equal(r.created.length, 1, '低分事实被门槛拦下');
  assert.equal(r.created[0].text, '服务器 A 的生产端口是 7001。');
  const row = db.prepare('SELECT importance FROM memories WHERE id = ?').get(r.created[0].id);
  assert.equal(row.importance, 8);
});

test('全部低于阈值 → 抛错（素材不落库，宁缺毋滥）', async () => {
  scriptLlm([
    () => '本次会话打开了三个终端窗口。\n我中途喝了一杯水。',
    () => JSON.stringify([
      { entities: [], categories: [], importance: 2 },
      { entities: [], categories: [], importance: 3 },
    ]),
  ]);
  await assert.rejects(
    () => extract.processMemoryMaterial({ userId: u, kind: 'text', input: '素材' }),
    /长期价值门槛/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memories WHERE user_id = ?').get(u).c, 1, '库内不新增');
});

test('标注失败（null）→ fail-open 全部入库，不丢事实', async () => {
  scriptLlm([
    () => '事实甲，超过十个字。\n事实乙，也超过十个字。',
    () => null, // 标注不可用
  ]);
  const r = await extract.processMemoryMaterial({ userId: u, kind: 'text', input: '素材' });
  assert.equal(r.created.length, 2, '标注失败时不过滤');
  const rows = db.prepare("SELECT importance FROM memories WHERE user_id = ? AND importance IS NULL").all(u);
  assert.ok(rows.length >= 2, '未评分记忆 importance 为 null');
});
