'use strict';

/**
 * 存量记忆实体/分类回填（对齐 mem0 平台的 entities/categories）：
 * 对缺失 categories 标注的记忆分批调用 classifyFacts（复用写入链路同一 prompt），
 * 结果经 applyClassification 写入 memories 快照与 entities 聚合表。
 * 用法：node scripts/classify-backfill.js [--all]   # --all 连已有标注的一起重跑
 * 幂等可重复跑；LLM 不可用时直接失败退出（标注是本脚本的全部目的）。
 */

const config = require('../src/config');
const db = require('../src/db');
const events = require('../src/db/repo/events');
const entityStore = require('../src/l2/entities');
const llm = require('../src/llm/client');

const all = process.argv.includes('--all');
const BATCH = 8;

async function main() {
  if (!config.llm.enabled) {
    console.error('✗ LLM 未启用（模型设置里开启后再回填）');
    process.exit(1);
  }
  const where = all ? 'user_id = ?' : "user_id = ? AND (categories IS NULL OR categories = '[]')";
  const rows = db.prepare(`SELECT id, text FROM memories WHERE ${where} ORDER BY created_at ASC`).all(config.userId);
  console.log(`待标注记忆：${rows.length} 条（批大小 ${BATCH}）`);
  if (!rows.length) {
    console.log('✓ 全部已有标注，无需回填');
    return;
  }

  let done = 0;
  let failed = 0;

  /** 标注一批：失败则对半拆分重试（思考模型偶发超时/截断，小批成功率显著更高）；单条仍失败则跳过 */
  async function classifySafe(batch) {
    if (!batch.length) return;
    const cls = await events.classifyFacts(batch.map((r) => r.text));
    if (!cls) {
      if (batch.length === 1) {
        failed += 1;
        console.warn(`  ✗ 单条标注失败，跳过（重跑可补）：${batch[0].text.slice(0, 40)}…`);
        return;
      }
      const mid = Math.ceil(batch.length / 2);
      await classifySafe(batch.slice(0, mid));
      await classifySafe(batch.slice(mid));
      return;
    }
    for (let j = 0; j < batch.length; j++) {
      const c = cls[j] || { entities: [], categories: [] };
      entityStore.applyClassification({
        userId: config.userId,
        memoryId: batch[j].id,
        entities: c.entities || [],
        categories: c.categories || [],
      });
      done += 1;
    }
    console.log(`  已标注 ${done}/${rows.length}`);
  }

  for (let i = 0; i < rows.length; i += BATCH) {
    await classifySafe(rows.slice(i, i + BATCH));
  }

  const ents = entityStore.listEntities(config.userId);
  const cats = entityStore.listCategories(config.userId);
  console.log(`✓ 回填完成：成功 ${done} 条，失败 ${failed} 条（重跑本脚本只补失败项）；实体 ${ents.length} 个，分类 ${cats.length} 个`);
  if (failed) process.exit(2);
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
