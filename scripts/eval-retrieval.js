'use strict';

/**
 * 检索质量评测（夜间计划 04:00）：语料 + 查询集来自 test/fixtures/retrieval-cases.json，
 * 全部直写 SQLite（零 LLM、零外部服务，embedding 关闭走关键词路径）。
 *
 * 用法：
 *   node scripts/eval-retrieval.js            # 打印报告
 *   node scripts/eval-retrieval.js --save     # 同时写入 docs/检索基线-2026-09-19.md
 *
 * 指标：recall@3 / recall@5 / MRR@10（relevant = 语料 key 集合，按 case 标注）。
 * 用途：04:30 改进的对照基线——改进前后各跑一次，不回退才合入。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SAVE = process.argv.includes('--save');

// ---- 隔离环境：临时库、无 embedding、无 LLM（关键词路径）----
process.env.AIMEMORY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eval-ret-')), 'eval.db');
process.env.EMBEDDING_ENABLED = '0';
process.env.LLM_ENABLED = '0';

const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'retrieval-cases.json'), 'utf8'));
const l2store = require('../src/l2/store');
const repo = require('../src/db/repo');

async function main() {
  // 1) 灌语料（直写 SQLite）
  const ids = {};
  for (const c of fixture.corpus) {
    ids[c.key] = l2store.insertFact({ userId: 'owner', text: c.text, metadata: { tag: c.tag, key: c.key } });
  }

  // 2) 跑查询集
  const rows = [];
  for (const c of fixture.cases) {
    const relIds = c.relevant.map((k) => ids[k]);
    const hits = await repo.searchMemories({ userId: 'owner', query: c.query, limit: 10 });
    const topIds = hits.map((h) => h.id);
    const rank = topIds.findIndex((id) => relIds.includes(id));
    const r3 = relIds.filter((id) => topIds.slice(0, 3).includes(id)).length / relIds.length;
    const r5 = relIds.filter((id) => topIds.slice(0, 5).includes(id)).length / relIds.length;
    rows.push({
      id: c.id, tag: c.tag, query: c.query, hit: rank >= 0, rank: rank < 0 ? null : rank + 1,
      recall3: r3, recall5: r5, mrr: rank >= 0 ? 1 / (rank + 1) : 0,
      top1: hits[0]?.text?.slice(0, 40) || '(无结果)',
    });
  }

  // 3) 汇总（总体 + 按 tag）
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const overall = {
    recall3: +avg(rows.map((r) => r.recall3)).toFixed(4),
    recall5: +avg(rows.map((r) => r.recall5)).toFixed(4),
    mrr: +avg(rows.map((r) => r.mrr)).toFixed(4),
    hitRate: +(rows.filter((r) => r.hit).length / rows.length).toFixed(4),
  };
  const byTag = {};
  for (const r of rows) {
    (byTag[r.tag] = byTag[r.tag] || []).push(r);
  }

  const line = (k, v) => `${k}: recall@3=${v.r3} recall@5=${v.r5} MRR=${v.m} 命中率=${v.h} (${v.n} 例)`;
  const report = [];
  report.push('# 检索基线（关键词路径）');
  report.push('');
  report.push(`> 生成于 ${new Date().toISOString()} · 语料 ${fixture.corpus.length} 条 · 查询 ${fixture.cases.length} 条 · embedding 关闭`);
  report.push('');
  report.push('## 总体');
  report.push('');
  report.push(`- recall@3 = ${overall.recall3} | recall@5 = ${overall.recall5} | MRR@10 = ${overall.mrr} | 命中率 = ${overall.hitRate}`);
  report.push('');
  report.push('## 分类别');
  report.push('');
  report.push('| 分类 | n | recall@3 | recall@5 | MRR | 命中率 |');
  report.push('|---|---|---|---|---|---|');
  for (const [tag, rs] of Object.entries(byTag)) {
    report.push(`| ${tag} | ${rs.length} | ${+avg(rs.map((r) => r.recall3)).toFixed(3)} | ${+avg(rs.map((r) => r.recall5)).toFixed(3)} | ${+avg(rs.map((r) => r.mrr)).toFixed(3)} | ${+(rs.filter((r) => r.hit).length / rs.length).toFixed(3)} |`);
  }
  report.push('');
  report.push('## 未命中 / 排名靠后的用例（改进 04:30 的输入）');
  report.push('');
  for (const r of rows.filter((r) => !r.hit || r.rank > 3)) {
    report.push(`- ${r.id} [${r.tag}] "${r.query}" → ${r.hit ? `rank ${r.rank}` : '未命中'}；top1：${r.top1}`);
  }
  report.push('');
  report.push('## 明细');
  report.push('');
  report.push('| id | tag | query | rank | recall@5 | MRR |');
  report.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    report.push(`| ${r.id} | ${r.tag} | ${r.query.replace(/\|/g, '/')} | ${r.rank ?? '—'} | ${r.recall5.toFixed(2)} | ${r.mrr.toFixed(2)} |`);
  }
  const text = report.join('\n');
  console.log(text);
  if (SAVE) {
    fs.writeFileSync(path.join(ROOT, 'docs', '检索基线-2026-09-19.md'), text + '\n');
    console.log('\n✓ 已写入 docs/检索基线-2026-09-19.md');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
