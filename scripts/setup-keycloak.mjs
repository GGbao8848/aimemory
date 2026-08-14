#!/usr/bin/env node
/**
 * 幂等初始化 Keycloak：创建 realm=aimemory、client=aimemory-web、测试用户。
 * 用 master realm 的管理凭据（KEYCLOAK_ADMIN_USER / KEYCLOAK_ADMIN_PASSWORD，
 * 默认从 mykeycloak/.env 读取）。
 *
 * 用法: node scripts/setup-keycloak.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// ---- 读取环境变量（.env / mykeycloak/.env / 进程环境）----
function readEnv(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const env = {};
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return env;
  } catch { return {}; }
}

const localEnv = { ...readEnv(path.join(root, '.env')), ...readEnv(path.join(root, '..', 'mykeycloak', '.env')) };

const KEYCLOAK_URL = process.env.KEYCLOAK_URL || localEnv.KEYCLOAK_URL || 'http://localhost:18443';
const ADMIN_USER = process.env.KEYCLOAK_ADMIN_USER || localEnv.KEYCLOAK_ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD || localEnv.KEYCLOAK_ADMIN_PASSWORD;
const REALM = process.env.KEYCLOAK_REALM || localEnv.KEYCLOAK_REALM || 'aimemory';
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || localEnv.KEYCLOAK_CLIENT_ID || 'aimemory-web';
const PORT = process.env.PORT || localEnv.PORT || '18543';
// BR-Agent 单点登录：web 端口（front-channel logout 回跳页）与 server 端口（back-channel logout 回调）
const BR_AGENT_WEB_PORT = process.env.BR_AGENT_WEB_PORT || localEnv.BR_AGENT_WEB_PORT || '9005';
const BR_AGENT_SERVER_PORT = process.env.BR_AGENT_SERVER_PORT || localEnv.BR_AGENT_SERVER_PORT || '9004';
// 用 ?? 而非 ||：显式留空的 TEST_USERS=（复用现有用户、不创建测试用户）应被尊重，不回退到默认
const TEST_USERS = (process.env.TEST_USERS ?? localEnv.TEST_USERS ?? 'alice,bob,charlie').split(',').map((s) => s.trim()).filter(Boolean);
const TEST_PASSWORD = process.env.TEST_USERS_PASSWORD || localEnv.TEST_USERS_PASSWORD || 'aimemory-test-2026';

if (!ADMIN_PASSWORD) {
  console.error('缺少 KEYCLOAK_ADMIN_PASSWORD：请在 .env 或 mykeycloak/.env 中配置');
  process.exit(1);
}

function localIp() {
  const ifaces = os.networkInterfaces();
  // 优先局域网段（10.x / 192.168.x / 172.16-31.x），避免取到虚拟网卡/桥接的异常 IPv4（如 2.0.0.1）
  const all = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) all.push(i.address);
    }
  }
  const lan = all.find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
  return lan || all[0] || 'localhost';
}

const IP = localIp();
const baseHosts = [IP, 'localhost', '127.0.0.1'];
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || localEnv.PUBLIC_BASE_URL || '').replace(/\/$/, '');
if (PUBLIC_BASE_URL) {
  const u = new URL(PUBLIC_BASE_URL);
  baseHosts.push(u.hostname);
}
const redirectUris = [...new Set(baseHosts.flatMap((h) => [
  `http://${h}:${PORT}/auth/callback`, // 授权回调
  `http://${h}:${PORT}/`,              // 登出后回首页（post_logout_redirect_uri）
]))];

// ---- Keycloak Admin API 辅助 ----
let adminToken = null;

async function kc(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${KEYCLOAK_URL}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok && res.status !== 404 && res.status !== 409) {
    const t = await res.text().catch(() => '');
    throw new Error(`Keycloak API 失败 ${res.status} ${pathname}: ${t.slice(0, 300)}`);
  }
  return { ok: res.ok, status: res.status, data: res.status === 204 ? null : await res.json().catch(() => null) };
}

async function getAdminToken() {
  const res = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'admin-cli',
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
      grant_type: 'password',
    }),
  });
  if (!res.ok) throw new Error(`master realm 管理员登录失败（检查 KEYCLOAK_ADMIN_*）: ${res.status}`);
  adminToken = (await res.json()).access_token;
  console.log(`✓ 已登录 master realm 管理员: ${ADMIN_USER}`);
}

// ---- 幂等创建 ----
async function ensureRealm() {
  const { status } = await kc(`/admin/realms/${REALM}`);
  if (status === 200) {
    console.log(`✓ realm ${REALM} 已存在，跳过`);
    return;
  }
  await kc('/admin/realms', {
    method: 'POST',
    body: { realm: REALM, enabled: true, displayName: 'aimemory', registrationAllowed: true },
  });
  console.log(`✓ 已创建 realm ${REALM}`);
}

async function ensureClient() {
  const { data } = await kc(`/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}`);
  if (data?.length) {
    const existing = data[0];
    const current = existing.redirectUris || [];
    const missing = redirectUris.filter((u) => !current.includes(u));
    // 单点登出：front-channel logout URL（Keycloak end_session 后以 iframe 加载，清本端会话）
    const frontChannelLogoutUrl = `http://${IP}:${PORT}/slo-logout`;
    const currentAttrs = existing.attributes || {};
    const needFront = currentAttrs['frontchannel.logout.url'] !== frontChannelLogoutUrl;
    if (missing.length || needFront) {
      await kc(`/admin/realms/${REALM}/clients/${existing.id}`, {
        method: 'PUT',
        body: { ...existing, redirectUris: [...current, ...missing], attributes: { ...currentAttrs, 'frontchannel.logout.url': frontChannelLogoutUrl } },
      });
      console.log(`✓ 已更新 client ${CLIENT_ID}（回调地址 + front-channel logout）`);
    } else {
      console.log(`✓ client ${CLIENT_ID} 已存在，跳过`);
    }
    return;
  }
  await kc(`/admin/realms/${REALM}/clients`, {
    method: 'POST',
    body: {
      clientId: CLIENT_ID,
      name: 'aimemory-web',
      protocol: 'openid-connect',
      publicClient: true,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: true,
      redirectUris,
      webOrigins: ['+'],
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'frontchannel.logout.url': `http://${IP}:${PORT}/slo-logout`,
      },
    },
  });
  console.log(`✓ 已创建 client ${CLIENT_ID}`);
  console.log(`  回调地址: ${redirectUris.join(', ')}`);
}

// BR-Agent client（br-agent，web+桌面共用）：配置单点登出
// - front-channel logout：BR-Agent web 端清 localStorage token
// - back-channel logout：Keycloak 服务端 POST 到 BR-Agent server，由其广播给桌面客户端
// 注意：br-agent 的 redirectUris（9005 web 回调 / 127.0.0.1:30088 桌面回调）由其部署侧管理，
// 此处只追加/更新 logout 属性，绝不改动其 redirectUris 与 webOrigins。
async function ensureBrAgentClient() {
  const BR_CLIENT_ID = 'br-agent';
  const { data } = await kc(`/admin/realms/${REALM}/clients?clientId=${BR_CLIENT_ID}`);
  // CS 模式：BR-Agent 只有桌面客户端（无 web），SLO 走 back-channel（server 广播到桌面 WS）；
  // front-channel logout（指向 web 的 slo-logout 页）已随 web 移除，显式清除避免 Keycloak 加载失效 URL。
  const attributes = {
    'frontchannel.logout.url': '',
    'backchannel.logout.url': `http://localhost:${BR_AGENT_SERVER_PORT}/api/auth/kc-logout`,
    'backchannel.logout.session.required': 'true',
  };
  if (data?.length) {
    const existing = data[0];
    const current = existing.attributes || {};
    const needsUpdate =
      (current['frontchannel.logout.url'] || '') !== attributes['frontchannel.logout.url'] ||
      current['backchannel.logout.url'] !== attributes['backchannel.logout.url'] ||
      current['backchannel.logout.session.required'] !== attributes['backchannel.logout.session.required'];
    if (needsUpdate) {
      await kc(`/admin/realms/${REALM}/clients/${existing.id}`, {
        method: 'PUT',
        body: { ...existing, attributes: { ...current, ...attributes } },
      });
      console.log(`✓ 已更新 client ${BR_CLIENT_ID}（back-channel logout，front-channel 已清）`);
    } else {
      console.log(`✓ client ${BR_CLIENT_ID} 已配置单点登出，跳过`);
    }
    return;
  }
  console.log(`⚠ client ${BR_CLIENT_ID} 不存在，跳过（BR-Agent 的 client 需在其部署侧创建）`);
}

async function ensureUser(username) {
  const { data } = await kc(`/admin/realms/${REALM}/users?username=${username}&exact=true`);
  if (data?.length) {
    console.log(`✓ 用户 ${username} 已存在，跳过`);
    return;
  }
  const { status } = await kc(`/admin/realms/${REALM}/users`, {
    method: 'POST',
    body: { username, enabled: true, email: `${username}@aimemory.local`, emailVerified: true },
  });
  if (status !== 201) throw new Error(`创建用户 ${username} 失败`);
  const { data: created } = await kc(`/admin/realms/${REALM}/users?username=${username}&exact=true`);
  await kc(`/admin/realms/${REALM}/users/${created[0].id}/reset-password`, {
    method: 'PUT',
    body: { type: 'password', value: TEST_PASSWORD, temporary: false },
  });
  console.log(`✓ 已创建测试用户 ${username}（密码 ${TEST_PASSWORD}）`);
}

// ---- 执行 ----
async function main() {
  console.log(`Keycloak: ${KEYCLOAK_URL} | realm: ${REALM} | client: ${CLIENT_ID}`);
  // 非本机 Keycloak：提示确认网络可达与凭据来源（迁移场景）
  if (!/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(KEYCLOAK_URL)) {
    console.log('⚠ 正在对接非本机 Keycloak（迁移场景）。确认：');
    console.log('  1) 本机能访问 ' + KEYCLOAK_URL + '（防火墙/内网连通）');
    console.log('  2) 管理员凭据 KEYCLOAK_ADMIN_USER/PASSWORD 已提供（放本项目 .env，或已存在该 Keycloak 部署的 .env）');
    console.log('  3) 若目标 realm/client 已存在：脚本会直接复用，仅补齐新机器的回调地址');
  }
  await getAdminToken();
  await ensureRealm();
  await ensureClient();
  await ensureBrAgentClient();
  for (const u of TEST_USERS) await ensureUser(u);
  console.log('\n完成。测试登录（password 模式）:');
  for (const u of TEST_USERS) {
    console.log(`  curl -s -X POST ${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token -d "client_id=${CLIENT_ID}" -d "username=${u}" -d "password=${TEST_PASSWORD}" -d "grant_type=password"`);
  }
}

main().catch((e) => { console.error(`\n初始化失败: ${e.message}`); process.exit(1); });
