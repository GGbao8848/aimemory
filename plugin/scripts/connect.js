#!/usr/bin/env node
/**
 * aimemory 插件 · 自动连接脚本（授权 + 写密钥，全程零粘贴）
 *
 * 由智能体在检测到 MCP 未授权时自动调用（无需用户开口）：
 *   1. 读 ~/.zcode/cli/config.json，检查 aimemory 的 Authorization 是否已配置
 *   2. 未配置 → 向中央服务发起设备流授权请求（匿名）
 *   3. 打开浏览器到授权页（用户已在统一登录则直达确认页，点一次「确认并重置密钥」）
 *   4. 轮询拿专属 key
 *   5. 备份 config.json 并把 key 写入对应 MCP server 的 headers.Authorization
 *
 * 用法: node connect.js [--mcp-server plugin:aimemory:aimemory] [--base http://10.10.10.169:18543]
 * 退出码: 0 成功(已授权/已就绪)  2 需要用户浏览器确认(已打开授权页)
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

const HOME = os.homedir();
const ZCODE_CONFIG = path.join(HOME, '.zcode', 'cli', 'config.json');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const MCP_SERVER = arg('--mcp-server', 'plugin:aimemory:aimemory');
const BASE = (arg('--base', 'http://10.10.10.169:18543') || '').replace(/\/$/, '');

function log(msg) { console.log(`[aimemory-connect] ${msg}`); }

function findServerEntry(cfg) {
  // 支持两种位置：用户级 config.mcp.servers / 插件级命名
  const servers = cfg?.mcp?.servers || {};
  // 1) 精确名（用户级一般是 'aimemory'，插件级是 'plugin:aimemory:aimemory'）
  if (servers[MCP_SERVER]) return servers[MCP_SERVER];
  if (servers['aimemory']) return servers['aimemory'];
  // 2) 任意以 plugin:aimemory: 开头 或以 aimemory 结尾的 server
  for (const [k, v] of Object.entries(servers)) {
    if (k.includes('aimemory') && v && v.type === 'http') return v;
  }
  return null;
}

function hasKey(cfg) {
  const s = findServerEntry(cfg);
  const h = s?.headers?.Authorization || '';
  return /^Token m0-/.test(h);
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  if (platform === 'darwin') cmd = ['open', url];
  else if (platform === 'win32') cmd = ['cmd', '/c', 'start', '', url];
  else cmd = ['xdg-open', url];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false)); // 无 xdg-open/open 等命令时静默失败
      child.on('spawn', () => { child.unref(); resolve(true); });
    } catch (e) { resolve(false); }
  });
}

async function main() {
  if (!fs.existsSync(ZCODE_CONFIG)) {
    log(`未找到 ZCode 配置 ${ZCODE_CONFIG} —— 请先安装 ZCode`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(ZCODE_CONFIG, 'utf8'));
  const entry = findServerEntry(cfg);
  const existing = entry?.headers?.Authorization || '';
  // 单 key 首装固定：已有 key 先探测是否仍有效（/api/me 200 即有效）→ 有效则跳过授权、key 永不变
  if (/^Token m0-/.test(existing)) {
    try {
      const probe = await fetch(`${BASE}/api/me`, { headers: { Authorization: existing } });
      if (probe.ok) {
        log(`MCP ${MCP_SERVER} 密钥仍有效，无需重新授权`);
        process.exit(0);
      }
      log('现有密钥已失效，将重新授权…');
    } catch (e) {
      log(`无法探测密钥有效性（${e.message}），将重新授权…`);
    }
  }

  log(`MCP ${MCP_SERVER} 未配置有效密钥，发起设备流授权…`);
  // 1) 创建授权请求（带 confirm_token → /connect 自动授权闪关，用户无需点击）
  const confirmToken = crypto.randomBytes(24).toString('hex');
  const startRes = await fetch(`${BASE}/api/connect/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm_token: confirmToken }),
  });
  if (!startRes.ok) {
    log(`授权服务不可达：HTTP ${startRes.status}（${BASE}）。请确认中央服务在线。`);
    process.exit(1);
  }
  const { request_id, authorize_url } = await startRes.json();
  if (!request_id) { log('授权服务返回异常'); process.exit(1); }

  // 2) 打开浏览器到授权页（用户点一次「确认并重置密钥」）
  log('请在浏览器弹出的授权页中确认（已登录统一平台则直接到确认页）…');
  const opened = await openBrowser(authorize_url);
  if (!opened) {
    log(`无法自动打开浏览器，请手动访问：\n  ${authorize_url}`);
  }

  // 3) 轮询拿 key（最长 ~110s）
  const deadline = Date.now() + 110_000;
  let token = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const pollRes = await fetch(`${BASE}/api/connect/poll?request_id=${encodeURIComponent(request_id)}`);
      if (pollRes.status === 410) { log('授权请求已过期，请重试'); process.exit(1); }
      if (pollRes.ok) {
        const data = await pollRes.json();
        if (data.status === 'authorized' && data.token) { token = data.token; break; }
      }
    } catch (e) { /* 网络抖动重试 */ }
  }
  if (!token) { log('等待授权超时（约 110 秒）'); process.exit(2); }
  log('已获取密钥，写入配置…');

  // 4) 备份 + 写入
  const bak = `${ZCODE_CONFIG}.bak-${Date.now()}`;
  fs.copyFileSync(ZCODE_CONFIG, bak);
  const servers = cfg.mcp.servers;
  if (!findServerEntry(cfg)) {
    // 没有现成条目：新增（用 MCP_SERVER 名）
    servers[MCP_SERVER] = servers[MCP_SERVER] || { type: 'http', url: `${BASE}/mcp`, headers: {} };
  }
  const target = findServerEntry(cfg);
  target.headers = target.headers || {};
  target.headers.Authorization = `Token ${token}`;
  fs.writeFileSync(ZCODE_CONFIG, JSON.stringify(cfg, null, 2));
  log(`✓ 密钥已写入 ${MCP_SERVER}（备份：${path.basename(bak)}）`);
  log('请重载 / 重启 ZCode 会话后生效。');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
