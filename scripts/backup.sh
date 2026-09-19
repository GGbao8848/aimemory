#!/bin/bash
# aimemory 备份脚本：SQLite 在线备份 + 校验和 + 保留策略
# 用法: scripts/backup.sh [数据目录] [备份输出目录] [保留份数]
#   数据目录默认 <仓库>/data；保留份数默认 7
# 说明：SQLite 用 better-sqlite3 的在线 backup API（一致性地包含 WAL 内容），
#       绝不直接 cp .db 文件——WAL 未合并时会拷出残缺库。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${1:-$REPO_ROOT/data}"
OUT_DIR="${2:-$REPO_ROOT/backups}"
KEEP="${3:-7}"

DB="$DATA_DIR/aimemory.db"
[ -f "$DB" ] || { echo "✗ 未找到数据库：$DB"; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$OUT_DIR/$STAMP"
mkdir -p "$DEST"

echo "== 1/3 SQLite 在线备份 =="
node -e "
const Database = require('$REPO_ROOT/node_modules/better-sqlite3');
new Database(process.argv[1]).backup(process.argv[2])
  .then(() => console.log('  ✓ aimemory.db'))
  .catch((e) => { console.error(e.message); process.exit(1); });
" "$DB" "$DEST/aimemory.db"

echo "== 2/3 校验和 =="
cd "$DEST"
if command -v sha256sum >/dev/null 2>&1; then sha256sum * > manifest.sha256; else shasum -a 256 * > manifest.sha256; fi
echo "  ✓ manifest.sha256"

echo "== 3/3 保留策略（保留最近 $KEEP 份）=="
ls -1 "$OUT_DIR" | grep -E '^[0-9]{8}-[0-9]{6}$' | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -rf "$OUT_DIR/$old"
  echo "  - 清理 $old"
done

echo "✓ 备份完成：$DEST"
