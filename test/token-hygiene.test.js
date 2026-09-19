'use strict';

/**
 * Token 明文治理测试（评估规划 G3）：
 * 1) api_keys 不再有 token_plain 列——库文件被读走不再等于 Token 全泄；
 * 2) 明文只在创建响应里出现一次；校验/吊销/列表走哈希，全部不受影响；
 * 3) 老库迁移：升级时清空并删除存量明文列，数据与 Token 可用性保留。
 * 独立临时库；迁移模拟在子进程里做（require 重载触发 db/index 迁移块）。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-tokhyg-'));
process.env.AIMEMORY_DB = path.join(workDir, 'test.db');
process.env.EMBEDDING_ENABLED = '0';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../src/db');
const repo = require('../src/db/repo');
const tokens = require('../src/auth/tokens');

const U = 'token-hygiene-user';

test.after(() => {
  db.close();
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
});

test('新库：api_keys 无 token_plain 列；明文只在创建响应出现一次', () => {
  const cols = db.prepare('PRAGMA table_info(api_keys)').all().map((c) => c.name);
  assert.ok(!cols.includes('token_plain'), 'token_plain 列应不存在');

  const created = tokens.createApiKey(U, 'hygiene');
  assert.match(created.token, /^m0-/, '创建响应返回一次性明文');

  // 库里整表检索不到该明文（数据层保证，不依赖列名）
  const all = db.prepare('SELECT * FROM api_keys').all();
  assert.ok(!JSON.stringify(all).includes(created.token), '明文不得出现在库的任何行里');

  // 列表/校验/吊销走哈希，全部可用
  const list = tokens.listApiKeys(U);
  assert.equal(list.length, 1);
  assert.ok(!('token' in list[0]) && !('token_plain' in list[0]), '列表不得携带明文字段');
  assert.equal(tokens.verify(created.token), U);
  assert.ok(tokens.revokeApiKey(created.id, U));
  assert.equal(tokens.verify(created.token), null, '吊销后失效');
});

test('老库迁移：注入 token_plain 明文 → 重载触发迁移 → 列删除、明文清零、数据保留', () => {
  const { execFileSync } = require('node:child_process');
  // 阶段 A（父进程）：造一条 Token 数据
  const created = tokens.createApiKey(U, 'legacy-keeper');
  assert.equal(tokens.verify(created.token), U);

  // 阶段 B（子进程）：模拟老库——加列、注入明文、重载模块触发迁移、断言
  const out = execFileSync('node', ['-e', `
    const db1 = require(process.cwd() + '/src/db');
    db1.exec("ALTER TABLE api_keys ADD COLUMN token_plain TEXT");
    db1.prepare("UPDATE api_keys SET token_plain = 'm0-leaked-plain-value'").run();
    // 重载 → db/index.js 的 G3 迁移块执行
    delete require.cache[require.resolve(process.cwd() + '/src/db')];
    const db2 = require(process.cwd() + '/src/db');
    const cols = db2.prepare('PRAGMA table_info(api_keys)').all().map((c) => c.name);
    const rows = db2.prepare('SELECT * FROM api_keys').all();
    console.log(JSON.stringify({
      hasCol: cols.includes('token_plain'),
      rows: rows.length,
      leak: JSON.stringify(rows).includes('m0-leaked-plain-value'),
      hashAlive: rows.every((r) => r.token_hash && r.token_hash.length === 64),
    }));
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, AIMEMORY_DB: path.join(workDir, 'test.db') }, encoding: 'utf8' });

  const r = JSON.parse(out);
  assert.equal(r.hasCol, false, '迁移后 token_plain 列应被删除');
  assert.equal(r.leak, false, '存量明文应被清空');
  assert.equal(r.rows, 2, '既有 Token 数据保留');
  assert.equal(r.hashAlive, true, 'token_hash 完整，已有 Token 继续可用');
  assert.equal(tokens.verify(created.token), U, '老 Token 校验不受迁移影响');
});
