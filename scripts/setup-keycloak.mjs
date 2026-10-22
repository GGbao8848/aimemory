#!/usr/bin/env node
/**
 * 在已有的 Keycloak br 域注册 aimemory client（aimemory-web），幂等可重跑。
 * 与 BR-Agent 多租户部署共用同一 Keycloak：本脚本**不创建 realm、不动用户**，
 * 只确保 client 存在、回调地址齐全、带 audience mapper（Keycloak 26 默认不给
 * access token 签 aud，缺 mapper 登录回调会报 missing aud）。
 *
 * 前置：KEYCLOAK_URL / KEYCLOAK_ADMIN_USER / KEYCLOAK_ADMIN_PASSWORD（.env，
 *       需 master realm 管理员凭据）；KEYCLOAK_REALM 默认 br。
 * 用法: node scripts/setup-keycloak.mjs [--create-realm]
 *   --create-realm：realm 不存在时创建（仅本地开发用；生产应对接已有 br 域）
 *
 * 也可在 Keycloak 管理台手工注册，等价配置见 docs/部署-生产机.md「Keycloak 注册」一节。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const CREATE_REALM = process.argv.includes('--create-realm');

// ---- 读取环境变量（.env / 进程环境）----
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

const localEnv = { ...readEnv(path.join(root, '.env')) };

const KEYCLOAK_URL = (process.env.KEYCLOAK_URL || localEnv.KEYCLOAK_URL || '').replace(/\/$/, '');
const ADMIN_USER = process.env.KEYCLOAK_ADMIN_USER || localEnv.KEYCLOAK_ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD || localEnv.KEYCLOAK_ADMIN_PASSWORD;
const REALM = process.env.KEYCLOAK_REALM || localEnv.KEYCLOAK_REALM || 'br';
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || localEnv.KEYCLOAK_CLIENT_ID || 'aimemory-web';
const PORT = process.env.PORT || localEnv.PORT || '18543';
// 测试用户默认不建（br 域用户由多租户统一管理）；需要时 TEST_USERS=a,b 显式指定
const TEST_USERS = (process.env.TEST_USERS ?? localEnv.TEST_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TEST_PASSWORD = process.env.TEST_USERS_PASSWORD || localEnv.TEST_USERS_PASSWORD || 'aimemory-test-2026';

if (!KEYCLOAK_URL) {
  console.error('✗ 缺少 KEYCLOAK_URL：请在 .env 配置（如 http://<keycloak-host>:8666）');
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error('✗ 缺少 KEYCLOAK_ADMIN_PASSWORD：请在 .env 配置 master realm 管理员密码');
  process.exit(1);
}

function localIp() {
  const ifaces = os.networkInterfaces();
  // 优先局域网段（10.x / 192.168.x / 172.16-31.x），避免取到虚拟网卡/桥接的异常 IPv4
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

// ---- 工具：把 fetch 网络错误转成带上下文的可读信息 ----
function netErr(url, e) {
  const cause = e.cause?.code || e.cause?.message || e.message;
  return `无法连接 ${url}（${cause}）`;
}

// ---- Keycloak Admin API 辅助 ----
let adminToken = null;

async function kc(pathname, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${KEYCLOAK_URL}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new Error(`${netErr(KEYCLOAK_URL, e)}（${method} ${pathname}）`);
  }
  if (!res.ok && res.status !== 404 && res.status !== 409) {
    const t = await res.text().catch(() => '');
    throw new Error(`Keycloak API 失败 ${res.status} ${pathname}: ${t.slice(0, 300)}`);
  }
  return { ok: res.ok, status: res.status, data: res.status === 204 ? null : await res.json().catch(() => null) };
}

async function getAdminToken() {
  let res;
  try {
    res = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: 'admin-cli',
        username: ADMIN_USER,
        password: ADMIN_PASSWORD,
        grant_type: 'password',
      }),
    });
  } catch (e) {
    throw new Error(`${netErr(KEYCLOAK_URL, e)}（换取管理员 token）`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const desc = body.match(/"error_description":"([^"]+)"/)?.[1] || body.slice(0, 200);
    throw new Error(`master realm 管理员登录失败: HTTP ${res.status} ${desc}`);
  }
  adminToken = (await res.json()).access_token;
  console.log(`  ✓ 已登录 master realm 管理员: ${ADMIN_USER}`);
}

async function ensureRealm() {
  const { status } = await kc(`/admin/realms/${REALM}`);
  if (status === 200) {
    console.log(`  ✓ realm ${REALM} 已存在，跳过`);
    return;
  }
  if (!CREATE_REALM) {
    throw new Error(`realm ${REALM} 不存在。多租户部署应对接已有 br 域（确认 KEYCLOAK_REALM 拼写）；` +
      `确需新建（本地开发）请加 --create-realm`);
  }
  await kc('/admin/realms', {
    method: 'POST',
    body: { realm: REALM, enabled: true, displayName: 'aimemory', registrationAllowed: true },
  });
  console.log(`  ✓ 已创建 realm ${REALM}`);
}

// Keycloak 26 默认不给 access token 签 aud；aimemory 验签强制要求 aud=clientId。
// 因此 client 必须有 Audience mapper，否则 Web 登录回调报「missing required aud claim」。
async function ensureAudienceMapper(clientUuid) {
  const mappers = (await kc(`/admin/realms/${REALM}/clients/${clientUuid}/protocol-mappers/models`)).data || [];
  const has = mappers.some(
    (m) => m.protocolMapper === 'oidc-audience-mapper' && (m.config?.['included.client.audience'] || '') === CLIENT_ID
  );
  if (has) {
    console.log(`  ✓ client ${CLIENT_ID} 已有 audience mapper（aud=${CLIENT_ID}），跳过`);
    return;
  }
  await kc(`/admin/realms/${REALM}/clients/${clientUuid}/protocol-mappers/models`, {
    method: 'POST',
    body: {
      name: `audience-${CLIENT_ID}`,
      protocol: 'openid-connect',
      protocolMapper: 'oidc-audience-mapper',
      config: {
        'included.client.audience': CLIENT_ID,
        'access.token.claim': 'true',
        'id.token.claim': 'false',
      },
    },
  });
  console.log(`  ✓ 已创建 audience mapper（access token 将包含 aud=${CLIENT_ID}）`);
}

async function ensureClient() {
  // front-channel 单点登出：该 realm 任一 client 登出后，Keycloak 以 iframe 加载本 URL 清本地会话
  // （KC 23+ 为顶层字段；配合服务端 /slo-logout 端点，实现「BR-Agent 登出 → aimemory 也退出」）
  const frontchannelLogoutUrl = `http://${PUBLIC_BASE_URL ? new URL(PUBLIC_BASE_URL).host : `${IP}:${PORT}`}/slo-logout`;

  const { data } = await kc(`/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}`);
  if (data?.length) {
    const existing = data[0];
    let changed = false;
    const current = existing.redirectUris || [];
    const missing = redirectUris.filter((u) => !current.includes(u));
    if (missing.length) {
      existing.redirectUris = [...current, ...missing];
      changed = true;
      console.log(`  ✓ 补齐回调地址: ${missing.join(', ')}`);
    }
    const attrs = { ...(existing.attributes || {}) };
    if (attrs['frontchannel.logout.url'] !== frontchannelLogoutUrl) {
      attrs['frontchannel.logout.url'] = frontchannelLogoutUrl;
      existing.attributes = attrs;
      changed = true;
      console.log(`  ✓ 配置 front-channel 登出: ${frontchannelLogoutUrl}`);
    }
    if (changed) {
      await kc(`/admin/realms/${REALM}/clients/${existing.id}`, { method: 'PUT', body: existing });
      console.log(`  ✓ 已更新 client ${CLIENT_ID}`);
    } else {
      console.log(`  ✓ client ${CLIENT_ID} 已存在且配置齐全，跳过`);
    }
    await ensureAudienceMapper(existing.id);
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
      directAccessGrantsEnabled: false, // 业务面只走授权码 + PKCE；不开密码直授
      redirectUris,
      webOrigins: ['+'],
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'frontchannel.logout.url': frontchannelLogoutUrl,
      },
    },
  });
  console.log(`  ✓ 已创建 client ${CLIENT_ID}`);
  console.log(`    回调地址: ${redirectUris.join(', ')}`);
  console.log(`    front-channel 登出: ${frontchannelLogoutUrl}`);
  const { data: created } = await kc(`/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}`);
  if (created?.length) await ensureAudienceMapper(created[0].id);
}

async function ensureUser(username) {
  const { data } = await kc(`/admin/realms/${REALM}/users?username=${username}&exact=true`);
  if (data?.length) {
    console.log(`  ✓ 用户 ${username} 已存在，跳过`);
    return;
  }
  const { status } = await kc(`/admin/realms/${REALM}/users`, {
    method: 'POST',
    body: { username, enabled: true, email: `${username}@aimemory.local`, emailVerified: true },
  });
  if (status !== 201) throw new Error(`创建用户 ${username} 失败（HTTP ${status}）`);
  const { data: created } = await kc(`/admin/realms/${REALM}/users?username=${username}&exact=true`);
  await kc(`/admin/realms/${REALM}/users/${created[0].id}/reset-password`, {
    method: 'PUT',
    body: { type: 'password', value: TEST_PASSWORD, temporary: false },
  });
  console.log(`  ✓ 已创建测试用户 ${username}（密码 ${TEST_PASSWORD}）`);
}

// ---- 网络预检：先确认 KEYCLOAK_URL 真的可达、realm 名正确 ----
async function checkConnectivity() {
  const discovery = `${KEYCLOAK_URL}/realms/${REALM}/.well-known/openid-configuration`;
  console.log(`  → ${discovery}`);
  let res;
  try {
    res = await fetch(discovery, { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    throw new Error(`${netErr(KEYCLOAK_URL, e)}\n  排查：1) 本机能否访问该地址（ping / 浏览器） 2) 防火墙是否放行端口 3) Docker 部署时 KEYCLOAK_URL 必须用「对外映射端口」（如 :8666→8080，填 8666 而非 8080）`);
  }
  if (res.status === 404) {
    throw new Error(`realm 不存在: GET ${discovery} → 404\n  排查：1) KEYCLOAK_REALM 填的是否为目标 realm 名（默认 br） 2) 是否用了管理接口端口（管理台/OIDC 在主端口，/health、/metrics 在另一个） 3) 该 Keycloak 的 realm 列表可在管理台左上角确认`);
  }
  if (!res.ok) {
    throw new Error(`预检失败: GET ${discovery} → HTTP ${res.status}`);
  }
  const j = await res.json().catch(() => null);
  if (!j?.issuer) {
    throw new Error(`预检失败: ${discovery} 返回的不是 OIDC 配置（确认 KEYCLOAK_URL 指向主端口而非其它服务）`);
  }
  console.log(`  ✓ Keycloak 可达，realm ${REALM} 的 issuer: ${j.issuer}`);
}

// ---- 步骤框架：失败时明确「第几步 + 原因 + 排查建议」----
const steps = [
  { name: '网络预检（Keycloak 可达性）', fn: checkConnectivity, hints: ['确认 KEYCLOAK_URL 地址、端口、realm 名是否正确'] },
  { name: '登录 master realm 管理员', fn: getAdminToken, hints: [
    'KEYCLOAK_ADMIN_USER / KEYCLOAK_ADMIN_PASSWORD 必须是该 Keycloak 的 master realm 管理员（不是业务 realm 的普通用户）',
    '若提示 invalid_grant / Invalid user credentials → 账号或密码不对；若 HTTP 4xx/5xx 网络层 → 参考上一步排查',
  ] },
  { name: `确认 realm ${REALM}`, fn: ensureRealm, hints: [`KEYCLOAK_REALM（${REALM}）应与多租户部署使用的 realm 一致；本地开发新建可加 --create-realm`] },
  { name: `注册 client ${CLIENT_ID}`, fn: ensureClient, hints: [
    `目标 realm（${REALM}）下若已有同名 client，脚本只补齐回调地址，不动其它配置`,
    '若 403/409：该 client 可能被限制，或管理员 token 权限不足',
  ] },
  { name: '创建测试用户（可选）', fn: ensureTestUsers, hints: ['TEST_USERS 留空时本步自动跳过（默认）'] },
];

async function ensureTestUsers() {
  if (!TEST_USERS.length) {
    console.log('  - TEST_USERS 未指定，不创建用户（br 域用户由多租户统一管理）');
    return;
  }
  for (const u of TEST_USERS) await ensureUser(u);
}

async function main() {
  console.log('===== aimemory Keycloak 注册 =====');
  console.log(`  目标      : ${KEYCLOAK_URL} (realm: ${REALM})`);
  console.log(`  管理员    : ${ADMIN_USER}（master realm）`);
  console.log(`  应用 client: ${CLIENT_ID}`);
  console.log(`  部署机器  : ${IP} → 回调地址 ${redirectUris.length} 个`);
  if (!/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(KEYCLOAK_URL)) {
    console.log('  ⚠ 正在对接非本机 Keycloak：SSO 会话 cookie 按 host 域存储，');
    console.log('    aimemory 的 KEYCLOAK_URL 必须与 BR-Agent 用同一 host（否则 SSO 不互通）');
  }
  console.log('  --------------------------------------');

  for (let i = 0; i < steps.length; i++) {
    const { name, fn, hints } = steps[i];
    console.log(`\n[${i + 1}/${steps.length}] ${name}`);
    try {
      await fn();
    } catch (e) {
      console.error(`\n✗ 第 ${i + 1} 步「${name}」失败`);
      console.error(`  原因: ${e.message}`);
      if (hints?.length) {
        console.error('  排查建议:');
        hints.forEach((h, j) => console.error(`    ${j + 1}) ${h}`));
      }
      console.error('\n完整配置见 .env；也可重跑本脚本（幂等，已完成的步骤会跳过）');
      process.exitCode = 1;
      return;
    }
  }

  console.log('\n✓ 全部步骤完成');
  console.log(`下一步：重启 aimemory（pm2 restart aimemory），浏览器打开 http://<本机>:${PORT}/ → 「使用 Keycloak 登录」`);
}

main().catch((e) => { console.error(`\n注册失败: ${e.message}`); process.exit(1); });
