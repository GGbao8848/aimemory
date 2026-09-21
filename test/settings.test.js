'use strict';

/**
 * 设置模块单元测试：字段校验 / 热生效 / .env 回写 / 密钥脱敏 / 探活分支。
 * 回写一律注入临时 .env（不碰仓库真实 .env）；运行时配置改动在测试后还原。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-settings-'));
const tmpEnv = path.join(tmpDir, '.env');
fs.writeFileSync(tmpEnv, 'LLM_ENABLED=1\nLLM_BASE_URL=http://old:1/v1\n');

const config = require('../src/config');
const settings = require('../src/settings');
const { test, after } = require('node:test');
const assert = require('node:assert');

// 保存/恢复运行时配置（update 直接改 config 对象，测试后还原避免影响同进程其他用例）
const snapshot = JSON.parse(JSON.stringify({ llm: config.llm, embedding: config.embedding, l2: config.l2 }));
after(() => {
  Object.assign(config.llm, snapshot.llm);
  Object.assign(config.embedding, snapshot.embedding);
  Object.assign(config.l2, snapshot.l2);
});

test('get()：布尔等字段原样返回，密钥脱敏为 set/preview', () => {
  const s = settings.get();
  assert.equal(typeof s.llm.enabled, 'boolean');
  assert.equal(typeof s.embedding.timeoutMs, 'number');
  assert.equal(typeof s.l2.reconcile, 'boolean');
  assert.equal(s.llm.apiKey.set, Boolean(config.llm.apiKey));
  if (s.llm.apiKey.set) {
    assert.ok(!s.llm.apiKey.preview.includes(config.llm.apiKey), '脱敏后不得包含完整密钥');
    assert.ok(s.llm.apiKey.preview.includes('***'));
  }
});

test('update()：热生效 + 回写临时 .env（URL 去尾斜杠、布尔序列化、新键追加）', () => {
  const out = settings.update(
    { llm: { baseUrl: 'http://10.0.0.9:8001/v1/', enabled: false, timeoutMs: 20000 } },
    { envFile: tmpEnv },
  );
  assert.equal(config.llm.baseUrl, 'http://10.0.0.9:8001/v1');
  assert.equal(config.llm.enabled, false);
  assert.equal(config.llm.timeoutMs, 20000);
  assert.equal(out.llm.baseUrl, 'http://10.0.0.9:8001/v1');

  const env = fs.readFileSync(tmpEnv, 'utf8');
  assert.match(env, /^LLM_BASE_URL=http:\/\/10\.0\.0\.9:8001\/v1$/m); // 已有行就地替换
  assert.match(env, /^LLM_ENABLED=0$/m);
  assert.match(env, /^LLM_TIMEOUT_MS=20000$/m); // 原文件没有的键 → 追加
});

test('update()：密钥传空 = 保持现有值（不回写）', () => {
  const keyBefore = config.llm.apiKey;
  settings.update({ llm: { apiKey: '' } }, { envFile: tmpEnv });
  assert.equal(config.llm.apiKey, keyBefore);
  assert.doesNotMatch(fs.readFileSync(tmpEnv, 'utf8'), /^LLM_API_KEY=/m);
});

test('update()：非法输入逐项拒绝且不落任何变更', () => {
  assert.throws(() => settings.update({ bad: {} }, { envFile: tmpEnv }), /设置分区/);
  assert.throws(() => settings.update({ llm: { nope: 1 } }, { envFile: tmpEnv }), /未知字段/);
  assert.throws(() => settings.update({ llm: { baseUrl: 'ftp://x/v1' } }, { envFile: tmpEnv }), /http/);
  assert.throws(() => settings.update({ llm: { timeoutMs: 5 } }, { envFile: tmpEnv }), /1000~300000/);
  assert.throws(() => settings.update({ llm: { enabled: 'yes' } }, { envFile: tmpEnv }), /布尔/);
});

test('probe()：非法 target 拒绝；未启用时直接报未启用（不发请求）', async () => {
  await assert.rejects(() => settings.probe('nope'), /llm 或 embedding/);
  const real = config.llm.enabled;
  config.llm.enabled = false;
  try {
    const r = await settings.probe('llm');
    assert.equal(r.ok, false);
    assert.match(r.error, /未启用/);
  } finally {
    config.llm.enabled = real;
  }
});

test('掩码：短密钥全遮，长密钥只露首尾 3 位', () => {
  assert.deepStrictEqual(settings._maskKey(''), { set: false, preview: '' });
  assert.deepStrictEqual(settings._maskKey('abc'), { set: true, preview: '***' });
  assert.equal(settings._maskKey('sk-1234567890').preview, 'sk-***890');
});
