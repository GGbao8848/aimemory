#!/usr/bin/env bash
# aimemory 部署冒烟（一条命令验证主链路）：
#   scripts/smoke.sh [base_url] [token]
#   默认 http://127.0.0.1:18543；Token 缺省从环境变量 AIMEMORY_SMOKE_TOKEN 读取，
#   都没有则用库里任意用户的身份临时签发一条（跑完即吊销，净零副作用）。
# 任一项失败退出码 1，可直接作部署卡点。
# 说明：Web 登录已走 Keycloak（浏览器面），冒烟不覆盖 OIDC 跳转，只验 Token 面。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${1:-http://127.0.0.1:18543}"
TOKEN="${2:-${AIMEMORY_SMOKE_TOKEN:-}}"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
skip() { printf '  \033[33m- 跳过\033[0m %s（%s）\n' "$1" "$2"; }
HDRF="$(mktemp)"; COOKIE="$(mktemp)"; trap 'rm -f "$HDRF" "$COOKIE"' EXIT

echo "aimemory 冒烟 → $BASE"

# 1. healthz
if curl -fsS "$BASE/healthz" | grep -q '"status"'; then ok "healthz 可达"; else bad "healthz 不可达"; fi

# 2. 管理台与契约
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin")" = "200" ] && ok "/admin 可达" || bad "/admin 不可达"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/openapi.json")" = "200" ] && ok "openapi 契约直出" || bad "openapi 不可达"

# 3. 未鉴权必须 401（安全底线）
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/stats")" = "401" ] && ok "REST 未鉴权 401" || bad "REST 未鉴权未返回 401"

# 4. Token 面：临时签发（无 Token 传入时直写库，与 Web 签发同构）→ 用完吊销
if [ -z "$TOKEN" ]; then
  TOKEN=$(AIMEMORY_DB="$ROOT/data/aimemory.db" node -e "
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const db = new Database(process.env.AIMEMORY_DB, { timeout: 5000 });
const uid = (db.prepare('SELECT user_id FROM api_keys WHERE revoked_at IS NULL LIMIT 1').get()
  || db.prepare('SELECT id user_id FROM users LIMIT 1').get()
  || { user_id: 'owner' }).user_id;
const token = 'm0-' + crypto.randomBytes(32).toString('base64url');
db.prepare('INSERT INTO api_keys (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
  .run(crypto.randomUUID(), uid, 'smoke-' + Date.now(), crypto.createHash('sha256').update(token).digest('hex'), new Date().toISOString());
db.close();
console.log(token);" 2>/dev/null)
fi

if [ -n "$TOKEN" ]; then
  AH="Authorization: Token $TOKEN"; AC='Accept: application/json, text/event-stream'
  # Token 鉴权可用（/api/me 回显身份）
  ME=$(curl -s -H "$AH" "$BASE/api/me")
  echo "$ME" | grep -q '"userId"' && ok "Token 鉴权（/api/me）" || bad "Token 鉴权失败：$ME"

  # 5. MCP 完整握手
  SID=$(curl -s -D "$HDRF" -o /dev/null -H "$AH" -H "$AC" -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
    "$BASE/mcp" && grep -i '^mcp-session-id:' "$HDRF" | tr -d '\r' | cut -d' ' -f2)
  INITED=$(curl -s -H "$AH" -H "$AC" -H 'Content-Type: application/json' ${SID:+-H "mcp-session-id: $SID"} \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' -o /dev/null -w '%{http_code}' "$BASE/mcp")
  if [ "$INITED" = "200" ] || [ "$INITED" = "202" ]; then ok "MCP initialize 握手"; else bad "MCP initialize（HTTP ${INITED}）"; fi
  TOOLS=$(curl -s -H "$AH" -H "$AC" -H 'Content-Type: application/json' ${SID:+-H "mcp-session-id: $SID"} \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$BASE/mcp" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.indexOf('{')));console.log((j.result&&j.result.tools||[]).length)}catch{console.log(0)}})")
  if [ "${TOOLS:-0}" -ge 7 ]; then ok "MCP tools/list（$TOOLS 个工具）"; else bad "MCP tools/list（${TOOLS:-0} 个）"; fi
  SEARCH=$(curl -s -H "$AH" -H "$AC" -H 'Content-Type: application/json' ${SID:+-H "mcp-session-id: $SID"} \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_memories","arguments":{"query":"冒烟"}}}' "$BASE/mcp" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.indexOf('{')));console.log(j.result&&j.result.content?'ok':'bad')}catch{console.log('bad')}})")
  [ "$SEARCH" = "ok" ] && ok "MCP search_memories" || bad "MCP search_memories"

  # 6. Web 登录入口（Keycloak 面只验配置形态：配了→302 跳 IdP；没配→503 指引）
  LOGIN=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/auth/login")
  if [ "$LOGIN" = "302" ] || [ "$LOGIN" = "503" ]; then ok "/auth/login（HTTP $LOGIN）"; else bad "/auth/login（HTTP $LOGIN，应为 302 或 503）"; fi

  # 7. 吊销冒烟 Token（净零；外部传入的 Token 吊销不了——非本库签发，跳过）
  if [ -z "${2:-${AIMEMORY_SMOKE_TOKEN:-}}" ]; then
    KEYID=$(AIMEMORY_DB="$ROOT/data/aimemory.db" node -e "
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const db = new Database(process.env.AIMEMORY_DB, { readonly: true });
const row = db.prepare('SELECT id FROM api_keys WHERE token_hash = ?').get(crypto.createHash('sha256').update('$TOKEN').digest('hex'));
db.close(); console.log(row ? row.id : '');" 2>/dev/null)
    if [ -n "$KEYID" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Token $TOKEN" "$BASE/api/keys/$KEYID/revoke")" = "200" ]; then
      ok "冒烟 Token 已吊销"
    else
      bad "Token 吊销失败（残留 name=smoke-* 的 Token 请手动清理）"
    fi
  fi
else
  skip "Token/MCP 链路" "无法签发 Token（库不可写？）"
fi

echo "----"
echo "结果：$PASS 通过，$FAIL 失败"
[ "$FAIL" -eq 0 ]
