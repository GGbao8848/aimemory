'use strict';

/**
 * 向量索引重建（npm run vec:rebuild）：
 * - 首次启用 embedding 或索引落后时补齐；换 embedding 模型（维度变化）加 -- --reset 先清表。
 * - 多租户：默认操作存量单用户（owner）数据；--user <user_id> 指定其他用户，--all 全部用户。
 */

const args = process.argv.slice(2);
const reset = args.includes('--reset');

const config = require('../src/config');
const vec = require('../src/l2/vec');

function targetUserId() {
  const i = args.indexOf('--user');
  if (i !== -1 && args[i + 1]) return args[i + 1];
  if (args.includes('--all')) return null; // vec.rebuild 的 null = 全部用户
  return config.legacyUserId;
}

if (!config.embedding.enabled) {
  console.error('✗ embedding 未启用（.env 设 EMBEDDING_ENABLED=1 并重启后再重建）');
  process.exit(1);
}

const r = vec.rebuild({ userId: targetUserId(), reset });
if (!r.ok) {
  console.error(`✗ 重建失败：${r.reason || r.error || '未知原因'}`);
  process.exit(1);
}
console.log(`✓ 向量索引重建完成：scanned=${r.scanned} indexed=${r.indexed} dim=${r.dim}${reset ? '（已先清空旧索引）' : ''}`);
