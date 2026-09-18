'use strict';

/**
 * 检索质量地板测试（守护 04:30 改进不被回退）：
 * 用 test/fixtures/retrieval-cases.json 的语料与查询，在临时库（零 LLM、零 embedding）
 * 上断言 recall@5 与 MRR 不低于地板值。2026-09-19 实测改进后为 1.0/1.0，地板留有余量。
 * 语料扩充或算法再改时，地板只升不降。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'retrieval-cases.json'), 'utf8'));

process.env.AIMEMORY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eval-floor-')), 'eval.db');
process.env.EMBEDDING_ENABLED = '0';
process.env.LLM_ENABLED = '0';

const { test } = require('node:test');
const assert = require('node:assert');
const l2store = require('../src/l2/store');
const repo = require('../src/db/repo');

const FLOOR_RECALL5 = 0.9;
const FLOOR_MRR = 0.8;

test('检索质量地板：recall@5 ≥ 0.9 且 MRR ≥ 0.8（基线 0.2059，04:30 改进后 1.0）', async () => {
  const ids = {};
  for (const c of fixture.corpus) {
    ids[c.key] = l2store.insertFact({ userId: 'owner', text: c.text, metadata: { key: c.key } });
  }
  let r5sum = 0;
  let mrrSum = 0;
  for (const c of fixture.cases) {
    const relIds = c.relevant.map((k) => ids[k]);
    const hits = await repo.searchMemories({ userId: 'owner', query: c.query, limit: 10 });
    const topIds = hits.map((h) => h.id);
    r5sum += relIds.filter((id) => topIds.slice(0, 5).includes(id)).length / relIds.length;
    const rank = topIds.findIndex((id) => relIds.includes(id));
    mrrSum += rank >= 0 ? 1 / (rank + 1) : 0;
  }
  const recall5 = r5sum / fixture.cases.length;
  const mrr = mrrSum / fixture.cases.length;
  assert.ok(recall5 >= FLOOR_RECALL5, `recall@5=${recall5} 低于地板 ${FLOOR_RECALL5}——检索质量回退`);
  assert.ok(mrr >= FLOOR_MRR, `MRR=${mrr} 低于地板 ${FLOOR_MRR}——检索质量回退`);
});
