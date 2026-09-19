'use strict';

/**
 * 前端对接包守护（评估规划 G2）：
 * 1) docs/api/aimemory-api.ts 与 openapi.json 同步——重新生成必须逐字节一致（防手改漂移）；
 * 2) openapi 的每条路径都出现在生成物里（防生成器漏路径）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs/api/aimemory-api.ts');
const OPENAPI = path.join(ROOT, 'docs/api/openapi.json');

test('生成物与 openapi 同步（npm run types 幂等，无手改漂移）', () => {
  const committed = fs.readFileSync(OUT, 'utf8');
  const regenerated = execFileSync('node', ['scripts/gen-api-types.js'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(fs.readFileSync(OUT, 'utf8'), committed, '重新生成应与已提交内容逐字节一致');
  assert.ok(regenerated.includes('已生成'), '生成器应输出结果行');
});

test('openapi 的每条路径与方法都出现在生成物里', () => {
  const spec = JSON.parse(fs.readFileSync(OPENAPI, 'utf8'));
  const ts = fs.readFileSync(OUT, 'utf8');
  const missing = [];
  for (const [p, methods] of Object.entries(spec.paths)) {
    if (!ts.includes(`'${p}'`)) missing.push(p);
    for (const m of Object.keys(methods)) {
      if (!ts.includes(`'${m.toUpperCase()}'`)) missing.push(`${p}:${m.toUpperCase()}`);
    }
  }
  assert.deepEqual(missing, [], `生成物缺少：${missing.join(', ')}`);
});

test('核心实体接口存在（外部前端依赖的形状不静默消失）', () => {
  const ts = fs.readFileSync(OUT, 'utf8');
  for (const name of ['Memory', 'MemoryListResult', 'EventStatus', 'L1Summary', 'L3Entry', 'L3History', 'Stats', 'KeyInfo']) {
    assert.ok(ts.includes(`export interface ${name}`), `缺 interface ${name}`);
  }
});
