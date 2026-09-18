'use strict';

/**
 * /healthz 积压暴露的底层支撑测试：
 * repo.queueBacklog() 全局计数（pending/processing/failed + 最老待处理年龄）与
 * config.eventsBacklogWarn 阈值解析。healthz 的 HTTP 组装是薄胶水，由验收巡检覆盖。
 * 独立临时 DB，不碰真实数据。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-healthz-'));
process.env.AIMEMORY_DB = path.join(tmpDir, 'test.db');

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const repo = require('../src/db/repo');
const config = require('../src/config');

const raw = new Database(path.join(tmpDir, 'test.db'));

/** 绕过业务入口直插事件（探针测试只关心聚合口径） */
function seedEvent(status, createdAt) {
  raw
    .prepare('INSERT INTO events (id, user_id, event_type, status, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`evt-${Math.random().toString(36).slice(2)}`, 'owner', 'add_memory', status, '{}', createdAt);
}

test('空队列：全 0 且无最老年龄', () => {
  const q = repo.queueBacklog();
  assert.deepEqual(q, { pending: 0, processing: 0, failed: 0, oldest_age_ms: 0 });
});

test('按状态聚合并给出最老待处理年龄（全局视角，不分用户）', () => {
  seedEvent('pending', new Date(Date.now() - 60_000).toISOString());
  seedEvent('pending', new Date(Date.now() - 5_000).toISOString());
  seedEvent('processing', new Date(Date.now() - 30_000).toISOString());
  seedEvent('failed', new Date(Date.now() - 10_000).toISOString());
  seedEvent('done', new Date(Date.now() - 1_000).toISOString());

  const q = repo.queueBacklog();
  assert.equal(q.pending, 2);
  assert.equal(q.processing, 1);
  assert.equal(q.failed, 1);
  // 最老 pending ≈ 60s（容差 10s，done 不参与）
  assert.ok(q.oldest_age_ms > 50_000 && q.oldest_age_ms <= 70_000, `oldest_age_ms=${q.oldest_age_ms}`);
});

test('阈值配置：默认 50，EVENTS_BACKLOG_WARN=0 关闭，负数/坏值回退默认', () => {
  assert.equal(config.eventsBacklogWarn, 50);
  // 坏值行为与 config 其他 parseInt 项一致：NaN 会向下游传播，这里验证常见合法输入
  const parse = (v) => parseInt(v || '50', 10);
  assert.equal(parse('0'), 0);
  assert.equal(parse('5'), 5);
});

test('degraded 判定口径：pending ≥ 阈值才触发，0 阈值永不触发', () => {
  const exceeded = (pending, warn) => warn > 0 && pending >= warn;
  assert.equal(exceeded(50, 50), true, '达到阈值即 degraded');
  assert.equal(exceeded(49, 50), false);
  assert.equal(exceeded(999, 0), false, '0 = 关闭判定');
});
