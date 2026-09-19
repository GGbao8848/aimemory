#!/bin/bash
# aimemory 恢复脚本：校验备份完整性 → 恢复 db → 打开库自检
# 用法: scripts/restore.sh <备份目录> [数据目录]
#   数据目录默认 <仓库>/data。恢复前请停止 aimemory 服务。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${1:?用法: restore.sh <备份目录> [数据目录]}"
DATA_DIR="${2:-$REPO_ROOT/data}"

[ -f "$BACKUP_DIR/manifest.sha256" ] || { echo "✗ 备份目录缺少 manifest.sha256：$BACKUP_DIR"; exit 1; }
[ -f "$BACKUP_DIR/aimemory.db" ] || { echo "✗ 备份目录缺少 aimemory.db"; exit 1; }

echo "== 1/3 校验和验证 =="
cd "$BACKUP_DIR"
if command -v sha256sum >/dev/null 2>&1; then sha256sum -c manifest.sha256 --quiet; else shasum -a 256 -c manifest.sha256; fi
echo "  ✓ 校验通过"

echo "== 2/3 恢复到 $DATA_DIR =="
mkdir -p "$DATA_DIR"
cp "$BACKUP_DIR/aimemory.db" "$DATA_DIR/aimemory.db"
echo "  ✓ aimemory.db"

echo "== 3/3 恢复后自检 =="
node -e "
const Database = require('$REPO_ROOT/node_modules/better-sqlite3');
const db = new Database(process.argv[1], { readonly: true });
const integrity = db.pragma('integrity_check', { simple: true });
const tables = db.prepare(\"SELECT COUNT(*) n FROM sqlite_master WHERE type='table'\").get().n;
const memories = db.prepare('SELECT COUNT(*) n FROM memories').get().n;
console.log('  ✓ integrity_check:', integrity);
console.log('  ✓ 表数量:', tables, '| 记忆:', memories);
if (integrity !== 'ok') process.exit(1);
" "$DATA_DIR/aimemory.db"

echo "✓ 恢复完成。重启服务即可使用：pm2 restart aimemory-mcp（或 node src/index.js）"
