'use strict';

/**
 * embedding 半熔断测试（评估规划 G4）：
 * 连续失败达阈值 → 熔断（期间零网络请求，检索自动降级关键词）；
 * 窗口到 → 放行一次探测（半开）；探测失败重新计数，服务恢复后自动闭合。
 * 参数走 config（EMBEDDING_BREAK_THRESHOLD / EMBEDDING_RETRY_MS），此处注入短窗口以便测试。
 * fetch 打桩计数，不发任何真实网络请求。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-embbrk-'));
process.env.AIMEMORY_DB = path.join(workDir, 'test.db');
process.env.EMBEDDING_ENABLED = '1';
process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:9'; // 关闭端口：连接立即被拒
process.env.EMBEDDING_MODEL = 'test-model';
process.env.EMBEDDING_TIMEOUT_MS = '500';
process.env.EMBEDDING_BREAK_THRESHOLD = '2';
process.env.EMBEDDING_RETRY_MS = '120';

const test = require('node:test');
const assert = require('node:assert');
const emb = require('../src/embeddings/client');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch 打桩：计数 + 可切换行为（默认连接拒绝） */
let calls = 0;
let behavior = 'refuse'; // refuse | ok
const realFetch = global.fetch;
global.fetch = async () => {
  calls += 1;
  if (behavior === 'refuse') throw new Error('ECONNREFUSED (test)');
  return {
    ok: true,
    json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
  };
};

test.after(() => { global.fetch = realFetch; try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {} });

test('连续失败达阈值 → 熔断：后续调用零网络请求', async () => {
  calls = 0;
  assert.equal(await emb.embed('一次失败'), null);
  assert.equal(await emb.embed('两次失败'), null);
  const afterThreshold = calls;
  assert.equal(afterThreshold, 2, '阈值内每次都真实请求');
  assert.equal(await emb.embed('熔断中'), null);
  assert.equal(await emb.embed('仍在熔断'), null);
  assert.equal(calls, afterThreshold, '熔断期间不应发起任何请求');
});

test('窗口到 → 放行探测（半开）；探测失败后计数重开', async () => {
  await sleep(150); // 等 EMBEDDING_RETRY_MS=120 窗口过
  calls = 0;
  behavior = 'refuse';
  assert.equal(await emb.embed('窗口后的探测'), null);
  assert.equal(calls, 1, '窗口后应放行一次真实请求（半开）');
  assert.equal(await emb.embed('再失败一次'), null);
  assert.equal(calls, 2, '探测失败后计数重启，再败一次重新熔断');
  const frozen = calls;
  assert.equal(await emb.embed('重新熔断中'), null);
  assert.equal(calls, frozen, '重新熔断期间零请求');
});

test('服务恢复 → 探测成功自动闭合熔断，后续正常出向量', async () => {
  await sleep(150);
  behavior = 'ok';
  calls = 0;
  const v = await emb.embed('服务回来了');
  assert.ok(Buffer.isBuffer(v) && v.length === 12, '应返回 3 维 float32 向量');
  assert.equal(calls, 1);
  const v2 = await emb.embed('熔断已闭合');
  assert.ok(Buffer.isBuffer(v2), '闭合后正常调用');
  assert.equal(calls, 2, '闭合期间每次请求正常放行');
});
