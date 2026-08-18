'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');

// 加载 .env（不存在则从 .env.example 复制）
function loadEnv() {
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(path.join(root, '.env.example'), envPath);
  }
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

loadEnv();

// 会话签名/校验密钥：缺失或为空时自动生成并写回 .env，保证 pm2 重启后会话不失效
// 注意：不能只看「SESSION_SECRET= 这行是否存在」——.env 里空值也会被 loadEnv 读进来，
// 若不回填，每次重启都会生成新 secret，已登录的 Web 会话全部失效。
function ensureSessionSecret() {
  if (process.env.SESSION_SECRET) return;
  const secret = crypto.randomBytes(32).toString('hex');
  let content = fs.readFileSync(envPath, 'utf8');
  if (/^\s*SESSION_SECRET\s*=/m.test(content)) {
    content = content.replace(/^\s*SESSION_SECRET\s*=.*$/m, `SESSION_SECRET=${secret}`);
  } else {
    content = `${content.replace(/\s*$/, '')}\nSESSION_SECRET=${secret}\n`;
  }
  fs.writeFileSync(envPath, content);
  process.env.SESSION_SECRET = secret;
}
ensureSessionSecret();

module.exports = {
  root,
  dataDir: path.join(root, 'data'),
  dbPath: path.join(root, 'data', 'aimemory.db'),
  port: parseInt(process.env.PORT || '18543', 10),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  keycloak: {
    url: (process.env.KEYCLOAK_URL || 'http://localhost:18443').replace(/\/$/, ''),
    realm: process.env.KEYCLOAK_REALM || 'aimemory',
    clientId: process.env.KEYCLOAK_CLIENT_ID || 'aimemory-web',
  },
  sessionSecret: process.env.SESSION_SECRET,
  sessionTtlMs: 7 * 24 * 3600 * 1000, // Web 会话 7 天
  mcpSessionTtlMs: 30 * 60 * 1000, // MCP session 空闲 30 分钟清理
};
