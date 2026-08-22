'use strict';

/**
 * 向量回填脚本：为升级前写入的、无 embedding 列的老记忆批量补齐语义向量。
 *
 * 用途：memories.embedding 列是本次升级新增的，历史记忆的 embedding 为 NULL，
 *       不补的话这些老记忆在语义检索里只能靠关键词命中。本脚本一次性补齐。
 *
 * 特性：
 * - 幂等：只处理 embedding IS NULL 的记忆，可重复执行
 * - 批量：复用 src/embeddings/client.js 的 embedBatch，一次多文本减少请求数
 * - 降级：embedding 服务不可用/失败时自动停止并提示，不影响已有数据
 * - dry-run：--dry-run 只统计不清写
 *
 * 用法：node scripts/backfill-embeddings.js [--dry-run] [--batch=16]
 */

const db = require('../src/db/index');
const config = require('../src/config');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const batchArg = args.find((a) => a.startsWith('--batch='));
const BATCH = batchArg ? Math.min(Math.max(parseInt(batchArg.split('=')[1], 10) || 16, 1), 64) : 16;

async function main() {
  if (!config.embedding.enabled) {
    console.error('✘ EMBEDDING_ENABLED=0，未启用 embedding。请在 .env 中设 EMBEDDING_ENABLED=1 后重试。');
    process.exit(1);
  }

  const { embedBatch } = require('../src/embeddings/client');

  const total = db.prepare('SELECT COUNT(*) c FROM memories WHERE embedding IS NULL').get().c;
  if (total === 0) {
    console.log('✔ 没有需要回填的记忆（全部已有向量）。');
    process.exit(0);
  }
  console.log(`待回填记忆: ${total} 条，批量 ${BATCH}，${DRY_RUN ? 'DRY-RUN（只统计不写入）' : '正常写入'}`);

  const rows = db.prepare('SELECT id, text FROM memories WHERE embedding IS NULL ORDER BY created_at').all();
  let ok = 0, fail = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    process.stdout.write(`  [${Math.min(i + BATCH, rows.length)}/${rows.length}] 向量化 ${chunk.length} 条... `);
    const vecs = await embedBatch(chunk.map((r) => r.text));
    if (!vecs) {
      fail += chunk.length;
      console.log('✘ 失败（embedding 不可用），已中止。');
      break;
    }
    if (DRY_RUN) {
      ok += chunk.length;
      console.log(`✔ (dry-run) ${chunk.length} 条将写入`);
    } else {
      const tx = db.transaction((items) => {
        for (let j = 0; j < items.length; j++) {
          db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(vecs[j], items[j].id);
        }
      });
      tx(chunk);
      ok += chunk.length;
      console.log('✔');
    }
  }

  const remain = db.prepare('SELECT COUNT(*) c FROM memories WHERE embedding IS NULL').get().c;
  console.log(`\n完成：成功 ${ok} 条，失败 ${fail} 条${DRY_RUN ? '（未实际写入）' : ''}，仍有 ${remain} 条待回填。`);
}

main().catch((e) => {
  console.error('✘ 回填失败:', e.message);
  process.exit(1);
});
