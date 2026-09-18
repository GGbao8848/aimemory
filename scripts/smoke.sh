#!/usr/bin/env bash
# aimemory 部署冒烟（一条命令验证主链路）：
#   scripts/smoke.sh [base_url] [password]
#   默认 http://127.0.0.1:18543；口令缺省从仓库 .env 的 AIMEMORY_PASSWORD 读取（不回显），
#   都没有则跳过鉴权类检查（只测公开端点）。
# 任一项失败退出码 1，可直接作部署卡点；Token 签发后即时吊销，不留痕迹。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${1:-http://127.0.0.1:18543}"
PW="${2:-}"

if [ -z "$PW" ] && [ -f "$ROOT/.env" ]; then
  PW=$(grep -E '^AIMEMORY_PASSWORD=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '"' || true)
fi

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
skip() { printf '  \033[33m- 跳过\033[0m %s（%s）\n' "$1" "$2"; }
HDRF="$(mktemp)"; trap 'rm -f "$HDRF"' EXIT

echo "aimemory 冒烟 → $BASE"

# 1. healthz
if curl -fsS "$BASE/healthz" | grep -q '"status"'; then ok "healthz 可达"; else bad "healthz 不可达"; fi

# 2. 管理台与契约
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin")" = "200" ] && ok "/admin 可达" || bad "/admin 不可达"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/openapi.json")" = "200" ] && ok "openapi 契约直出" || bad "openapi 不可达"

# 3. 未鉴权必须 401（安全底线）
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/stats")" = "401" ] && ok "REST 未鉴权 401" || bad "REST 未鉴权未返回 401"

# 4. 登录 + 签发 Token（含吊销，净零副作用）
COOKIE="$(mktemp)"
if [ -n "$PW" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -c "$COOKIE" --data-urlencode "password=$PW" "$BASE/auth/local-login")
  if [ "$CODE" = "302" ]; then
    ok "口令登录 302"
    KEYJSON=$(curl -s -b "$COOKIE" -H 'Content-Type: application/json' -d "{\"name\":\"smoke-$(date +%s)\"}" "$BASE/api/keys")
    TOKEN=$(printf '%s' "$KEYJSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).token||'')}catch{console.log('')}})")
    if [ -n "$TOKEN" ]; then
      ok "签发 Token"
      KEYID=$(printf '%s' "$KEYJSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id||'')}catch{console.log('')}})")
      # 5. MCP 完整握手
      AH="Authorization: Token $TOKEN"; AC='Accept: application/json, text/event-stream'
      SID=$(curl -s -D "$HDRF" -o /dev/null -H "$AH" -H "$AC" -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
        "$BASE/mcp" && grep -i '^mcp-session-id:' "$HDRF" | tr -d '\r' | cut -d' ' -f2)
      INITED=$(curl -s -H "$AH" -H "$AC" -H 'Content-Type: application/json' ${SID:+-H "mcp-session-id: $SID"} \
        -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' -o /dev/null -w '%{http_code}' "$BASE/mcp")
      if [ "$INITED" = "200" ] || [ "$INITED" = "202" ]; then ok "MCP initialize 握手"; else bad "MCP initialize（HTTP ${INITED}）"; fi
      TOOLS=$(curl -s -H "$AH" -H "$AC" -H 'Content-Type: application/json' ${SID:+-H "mcp-session-id: $SID"} \
        -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$BASE/mcp" \
        | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.indexOf('{')));console.log((j.result&&j.result.tools||[]).length)}catch{console.log(0)}})")
      if [ "${TOOLS:-0}" -ge 10 ]; then ok "MCP tools/list（$TOOLS 个工具）"; else bad "MCP tools/list（${TOOLS:-0} 个）"; fi
      SEARCH=$(curl -s -H "$AH" -H "$AC" -H 'Content-Type: application/json' ${SID:+-H "mcp-session-id: $SID"} \
        -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_memories","arguments":{"query":"冒烟"}}}' "$BASE/mcp" \
        | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.indexOf('{')));console.log(j.result&&j.result.content?'ok':'bad')}catch{console.log('bad')}})")
      [ "$SEARCH" = "ok" ] && ok "MCP search_memories" || bad "MCP search_memories"
      # 6. REST（会话 cookie）
      [ "$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" "$BASE/api/stats")" = "200" ] && ok "REST /api/stats 200" || bad "REST /api/stats"
      # 7. 吊销冒烟 Token（净零）
      curl -s -b "$COOKIE" -X POST "$BASE/api/keys/$KEYID/revoke" -o /dev/null && ok "冒烟 Token 已吊销" || bad "Token 吊销失败"
    else
      bad "签发 Token"
    fi
  else
    bad "口令登录（HTTP ${CODE}）"
  fi
else
  skip "登录/Token/MCP 链路" "未提供口令（传参或 .env 的 AIMEMORY_PASSWORD）"
fi
rm -f "$COOKIE"

echo "----"
echo "结果：$PASS 通过，$FAIL 失败"
[ "$FAIL" -eq 0 ]
