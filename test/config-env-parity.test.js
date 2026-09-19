'use strict';

// 首启体验守护：
// 1) src/config.js 读取的每个环境变量都必须在 .env.example 有文档（双向，防配置项缺漏/模板漂移）；
// 2) scripts/doctor.js 冒烟：临时库环境下 exit 0 且输出自检结论。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const configSrc = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');
const exampleSrc = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

const configKeys = new Set([...configSrc.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]));
const exampleKeys = new Set([...exampleSrc.matchAll(/^\s*#?\s*([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]));

test('src/config.js 读取的每个环境变量都在 .env.example 有文档', () => {
  const missing = [...configKeys].filter((k) => !exampleKeys.has(k));
  assert.deepEqual(missing, [], `.env.example 缺少：${missing.join(', ')}`);
});

test('.env.example 的每个键都被 src/config.js 读取（防模板漂移）', () => {
  const stale = [...exampleKeys].filter((k) => !configKeys.has(k));
  assert.deepEqual(stale, [], `.env.example 存在代码不读取的键：${stale.join(', ')}`);
});

// ===== doctor 冒烟 =====

test('doctor 冒烟：临时库环境 exit 0 且给出结论与下一步', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-smoke-'));
  try {
    const out = execFileSync('node', ['scripts/doctor.js'], {
      cwd: ROOT,
      env: { ...process.env, AIMEMORY_DB: path.join(tmp, 't.db') },
      encoding: 'utf8',
    });
    assert.ok(out.includes('首启自检'), '输出应含自检标题');
    assert.ok(out.includes('可以启动'), '临时库环境应结论「可以启动」');
    assert.ok(out.includes('/admin'), '输出应含下一步指引');
    assert.ok(!/[0-9a-f]{32}/.test(out), '输出不得包含密钥形态字符串');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
