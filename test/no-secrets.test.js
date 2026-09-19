'use strict';

// 密钥泄漏防线（回归守护）：
// 1) src/ collector/ scripts/ web/ 不得出现硬编码凭据形态的字符串（密钥一律走 .env）；
// 2) .env 不被 git 跟踪，.env.example 模板的密钥值留空。
// 背景：LLM_API_KEY 曾被硬编码进 src/config.js 且已进入推送历史（docs/复盘-2026-09-19-剪枝.md）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'collector', 'scripts'];
const WEB_DIR = 'web'; // 前端源码同样不得硬编码凭据；构建产物 dist 是打包结果，跳过

const SECRET_PATTERNS = [
  [/\b[0-9a-f]{32,}\b/, '长十六进制串（疑似 API key）'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/, 'sk- 形态密钥'],
];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      if (name !== 'node_modules' && name !== 'dist') walk(p, out);
    } else if (/\.(js|mjs|cjs|sh|ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

test('源代码不含硬编码密钥形态字符串', () => {
  const files = [...SCAN_DIRS, WEB_DIR].flatMap((d) => walk(path.join(ROOT, d)));
  assert.ok(files.length > 10, '扫描目标不应为空');
  const offenders = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      for (const [re, label] of SECRET_PATTERNS) {
        if (re.test(line)) {
          offenders.push(`${path.relative(ROOT, f)}:${i + 1} ${label}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, [], `发现疑似硬编码密钥（请改走 .env）：\n${offenders.join('\n')}`);
});

test('.env 未被 git 跟踪，.env.example 密钥值为空', () => {
  const tracked = execSync('git ls-files', { cwd: ROOT }).toString().split('\n');
  assert.ok(!tracked.includes('.env'), '.env 不得入库（含凭据）');
  const tpl = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  for (const k of ['LLM_API_KEY', 'EMBEDDING_API_KEY']) {
    const m = tpl.match(new RegExp(`^${k}=(.*)$`, 'm'));
    assert.ok(m && m[1].trim() === '', `.env.example 的 ${k} 应留空（实际："${m ? m[1] : '缺失'}"）`);
  }
});
