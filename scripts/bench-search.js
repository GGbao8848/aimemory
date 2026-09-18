'use strict';

/**
 * 检索性能压测（夜间计划 05:00）。
 *
 * 架构：本进程只是驱动器，为每个规模派生**独立子进程**（AIMEMORY_DB 指向独立临时库）——
 * 教训：在同一进程里靠改 env + 清 require 缓存切库，会因 config 已缓存而把合成数据
 * 写进仓库默认库（已踩）。子进程隔离后路径天然不串。
 *
 * 合成数据**直写 SQLite**（prepared 批插），严禁走 add_memory/events 队列（零 LLM 调用）。
 * 用法：
 *   node scripts/bench-search.js --sizes 10000,100000 --queries 50 [--save]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const SIZES = (arg('sizes', '10000,100000')).split(',').map(Number);
const NQ = Number(arg('queries', '50'));
const SAVE = process.argv.includes('--save');

// ---------------------------------------------------------------- 子进程：单规模压测
function childMain() {
  process.env.EMBEDDING_ENABLED = '0';
  process.env.LLM_ENABLED = '0';
  const n = Number(process.env.BENCH_SIZE);
  const l2store = require('../src/l2/store');
  const repo = require('../src/db/repo');

  const TOOLS = ['pm2', 'docker', 'systemd', 'supervisor'];
  const KINDS = ['网关', '队列', '缓存', '数据库', '前端'];
  const synth = (i) =>
    `项目${String.fromCharCode(65 + (i % 26))}${i % 97} 的 ${KINDS[i % KINDS.length]} 服务部署在 10.10.${i % 250}.${(i * 7) % 250} 用 ${TOOLS[i % TOOLS.length]} 管理，负责人是工程师${i % 13}，端口 ${9000 + (i % 900)}`;

  const t0 = Date.now();
  const ins = l2store.insertFact; // 直写 SQLite（内部仅 INSERT + 向量懒补，embedding 关闭零外部调用）
  for (let i = 0; i < n; i++) ins({ userId: 'owner', text: synth(i), metadata: {} });
  const seedSecs = ((Date.now() - t0) / 1000).toFixed(1);

  const queries = [];
  for (let i = 0; i < Math.ceil(NQ / 2); i++) queries.push(synth((i * 1913) % n).split(' ').slice(0, 2).join(' '));
  for (let i = 0; i < NQ - queries.length; i++) queries.push(`不存在的项目${100000 + i} 端口与负责人`);

  const lat = [];
  (async () => {
    for (const q of queries) {
      const t = Date.now();
      await repo.searchMemories({ userId: 'owner', query: q, limit: 10 });
      lat.push(Date.now() - t);
    }
    const pct = (p) => { const s = lat.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
    process.stdout.write(`###RESULT### ${JSON.stringify({
      n, seedSecs, p50: pct(50), p95: pct(95), p99: pct(99),
      mean: +(lat.reduce((s, x) => s + x, 0) / lat.length).toFixed(1),
    })}\n`);
    process.exit(0);
  })();
}

// ---------------------------------------------------------------- 驱动器
function driver() {
  const results = [];
  for (const size of SIZES) {
    process.stdout.write(`· 压测 ${size} 条…\n`);
    const tmpdb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `bench-${size}-`)), 'bench.db');
    const r = spawnSync(process.execPath, [__filename, '--sizes', String(size), '--queries', String(NQ)], {
      env: { ...process.env, BENCH_CHILD: '1', BENCH_SIZE: String(size), AIMEMORY_DB: tmpdb },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('###RESULT### '));
    if (!line) { console.error(`✗ 子进程失败（size=${size}）：\n${r.stderr || r.stdout}`); process.exit(1); }
    results.push(JSON.parse(line.slice('###RESULT### '.length)));
  }

  const lines = [];
  lines.push('# 检索性能基线（关键词路径）');
  lines.push('');
  lines.push(`> 生成于 ${new Date().toISOString()} · 查询 ${NQ} 条/规模（一半命中一半未命中）· 合成数据直写 SQLite`);
  lines.push('');
  lines.push('| 规模 | 灌库耗时 | P50 | P95 | P99 | 均值 |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of results) {
    lines.push(`| ${r.n} | ${r.seedSecs}s | ${r.p50}ms | ${r.p95}ms | ${r.p99}ms | ${r.mean}ms |`);
  }
  const worst = Math.max(...results.map((r) => r.p95));
  lines.push('');
  lines.push(`**结论**：最大 P95 = ${worst}ms。${worst < 50 ? '关键词路径在当前规模下余量充足，无需引入额外索引。' : '需要评估索引/分页策略。'}`);
  lines.push('> 向量路径（sqlite-vec + embedding）依赖外部 embedding 服务，其真实语义性能待生产接入后另测。');
  const text = lines.join('\n');
  console.log(text);
  if (SAVE) {
    fs.writeFileSync(path.join(ROOT, 'docs', '性能基线-2026-09-19.md'), text + '\n');
    console.log('\n✓ 已写入 docs/性能基线-2026-09-19.md');
  }
}

if (process.env.BENCH_CHILD === '1') childMain();
else driver();
