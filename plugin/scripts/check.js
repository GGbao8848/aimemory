#!/usr/bin/env node
/**
 * aimemory 插件 · 会话启动检查（SessionStart hook 调用）
 *
 * 检测本机 ~/.zcode 里 aimemory MCP 是否已配置密钥；未配置时输出 JSON：
 *   {"additionalContext": "…"}  → 注入会话，让智能体知道「记忆功能未授权」，
 *                                 在用户实际要用记忆时自动运行 connect.js 完成授权
 * 已配置/无 ZCode 配置/node 不可用 → 输出空（静默，不打扰）。
 *
 * 用法: node check.js [--base http://<服务地址>:18543]   （由 hooks/hooks.json 的 SessionStart 触发）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const PLUGIN_ROOT = process.env.ZCODE_PLUGIN_ROOT || path.join(__dirname, '..');
const HOME = os.homedir();
const ZCODE_CONFIG = path.join(HOME, '.zcode', 'cli', 'config.json');
const BASE = (arg('--base', 'http://10.10.10.169:18543') || '').replace(/\/$/, '');
const MCP_SERVER = 'plugin:aimemory:aimemory';
const LABEL = 'aimemory（记忆库）';

function out(additionalContext) {
  if (additionalContext) process.stdout.write(JSON.stringify({ additionalContext }));
  process.exit(0);
}

try {
  if (!fs.existsSync(ZCODE_CONFIG)) out('');
  const cfg = JSON.parse(fs.readFileSync(ZCODE_CONFIG, 'utf8'));
  const servers = cfg?.mcp?.servers || {};
  let hasAuth = false;
  for (const [k, v] of Object.entries(servers)) {
    if ((k === MCP_SERVER || k === 'aimemory' || k.includes('aimemory')) && v?.type === 'http') {
      if (/^Token m0-/.test(v?.headers?.Authorization || '')) hasAuth = true;
    }
  }
  if (hasAuth) out('');
  const connect = path.join(PLUGIN_ROOT, 'scripts', 'connect.js');
  out(`检测到 ${LABEL} 的 MCP 尚未配置密钥（其 MCP 工具将因未授权而不可用）。` +
      `如用户需要使用记忆功能，请自动运行：\`node "${connect}" --base ${BASE}\`（会打开授权页，用户点一次确认后自动写入密钥），` +
      `完成后提示用户重载会话即可。若用户暂不需要记忆功能则无需处理。`);
} catch (e) {
  out(''); // 任何异常都静默，不让 hook 阻塞会话
}
