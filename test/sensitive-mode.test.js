'use strict';

/**
 * SENSITIVE_MODE 敏感内容策略（提炼层 prompt）：
 * - allow（默认）：凭据可按原文入库（内网自托管定位），prompt 含保留规则；
 * - redact：prompt 含脱敏规则，不含保留原文的表述。
 * node --test 每个文件独立进程，可在 require 前设环境变量分别构造两种模式。
 */

const test = require('node:test');
const assert = require('node:assert');

test('allow（默认）：prompt 明示凭据按原文保留', () => {
  process.env.SENSITIVE_MODE = 'allow';
  delete require.cache[require.resolve('../src/config')];
  const { buildExtractPrompt } = require('../src/l2/extract');
  const p = buildExtractPrompt();
  assert.match(p, /按原文保留/);
  assert.doesNotMatch(p, /已脱敏/);
});

test('redact：prompt 要求凭据脱敏、不含保留原文的表述', () => {
  process.env.SENSITIVE_MODE = 'redact';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/l2/extract')];
  const { buildExtractPrompt } = require('../src/l2/extract');
  const p = buildExtractPrompt();
  assert.match(p, /已脱敏/);
  assert.match(p, /不得写入原文/);
  assert.doesNotMatch(p, /按原文保留——本部署/);
});

test('非法取值回落 allow（fail-safe：不静默改变默认部署语义）', () => {
  process.env.SENSITIVE_MODE = 'yes-please';
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');
  assert.strictEqual(config.sensitiveMode, 'allow');
});
