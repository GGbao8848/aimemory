'use strict';

/**
 * 身份与登录测试（多租户：Keycloak OIDC + 本地会话 + m0- Token）。
 *
 * 必须在 require 业务模块前设置 AIMEMORY_DB（独立临时库），
 * 否则会写进生产 data/ 下的库。
 *
 * Keycloak 的授权码换 token / JWKS 验签依赖真实 IdP，不在单测覆盖内
 * （由部署验收覆盖：setup-keycloak 注册 client → 浏览器登录）；
 * 这里覆盖纯逻辑：claims 映射、用户建档、会话/Token 归属、
 * 未配置 Keycloak 时 /auth/login 的明确报错、SLO 端点清会话。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-auth-'));
process.env.AIMEMORY_DB = path.join(workDir, 'test.db');
process.env.AIMEMORY_USER_ID = 'legacy-owner';
// 本文件不配 KEYCLOAK_URL → 测「未配置」分支；显式置空防止 config 从仓库 .env 读到真值
process.env.KEYCLOAK_URL = '';
process.env.LLM_ENABLED = '0'; // 登录测试不涉及提炼

const test = require('node:test');
const assert = require('node:assert');

const config = require('../src/config');
const repo = require('../src/db/repo');

// ===== config 形态 =====

test('config：Keycloak 配置默认指向 br 域，未配 URL 时明确不可用', () => {
  assert.strictEqual(config.keycloak.realm, 'br', '默认对接 br 域（与多租户部署共用）');
  assert.strictEqual(config.keycloak.clientId, 'aimemory-web');
  assert.strictEqual(config.keycloak.enabled, false, '本测试未配 KEYCLOAK_URL');
  assert.strictEqual(config.legacyUserId, 'legacy-owner', '存量数据身份仅迁移脚本使用');
  assert.strictEqual(config.password, undefined, '本地口令登录已移除');
});

// ===== Keycloak claims → 用户模型（纯函数，无需网络） =====

test('keycloak.toUser：sub 即 user_id，claims 缺失有兜底', () => {
  const keycloakPath = require.resolve('../src/auth/keycloak');
  delete require.cache[keycloakPath];
  const kc = require('../src/auth/keycloak');
  const u = kc.toUser({
    sub: 'abc-123',
    preferred_username: 'br0002',
    email: 'br0002@br.com',
    name: '张三',
  });
  assert.deepStrictEqual(u, { id: 'abc-123', username: 'br0002', email: 'br0002@br.com', name: '张三' });

  const minimal = kc.toUser({ sub: 's2' });
  assert.strictEqual(minimal.username, 's2', 'username 缺失回落 sub');
  assert.strictEqual(minimal.email, '');
  assert.strictEqual(minimal.name, 's2', 'name 缺失回落 sub');
});

// ===== 用户建档（登录即 upsert） =====

test('users：登录建档/刷新（upsert 幂等），可按 sub/username/email 定位', () => {
  repo.upsertUser({ id: 'sub-A', username: 'br0002', name: '张三', email: 'br0002@br.com' });
  repo.upsertUser({ id: 'sub-A', username: 'br0002', name: '张三丰', email: 'br0002@br.com' }); // 再登录刷新

  const a = repo.getUser('sub-A');
  assert.strictEqual(a.username, 'br0002');
  assert.strictEqual(a.name, '张三丰', '重复登录应以最新 claims 覆盖');
  assert.ok(a.last_login_at, '应刷新最近登录时间');

  assert.strictEqual(repo.findUserByIdentifier('br0002').id, 'sub-A', '按 username 定位');
  assert.strictEqual(repo.findUserByIdentifier('br0002@br.com').id, 'sub-A', '按 email 定位');
  assert.strictEqual(repo.findUserByIdentifier('sub-A').id, 'sub-A', '按 sub 定位');
  assert.strictEqual(repo.findUserByIdentifier('nobody'), null);
  assert.ok(repo.listUsers().length >= 1);
});

// ===== 会话与 Token 的归属（多租户隔离基础） =====

test('会话：可按 Keycloak 用户建立/读取/删除', () => {
  const sid = crypto.randomBytes(24).toString('hex');
  repo.createSession(sid, 'sub-A', config.sessionTtlMs, 'br0002');

  const s = repo.getSession(sid);
  assert.ok(s, '会话应可读出');
  assert.strictEqual(s.user_id, 'sub-A', '会话归属登录用户');
  assert.strictEqual(s.username, 'br0002');

  repo.deleteSession(sid);
  assert.ok(!repo.getSession(sid), '登出后会话应失效');
});

test('Token：签发归属其用户，跨用户不可见、不可吊销', () => {
  const tokens = require('../src/auth/tokens');
  const kA = tokens.createApiKey('sub-A', 'agent-a');
  const kB = tokens.createApiKey('sub-B', 'agent-b');
  assert.match(kA.token, /^m0-/);
  assert.strictEqual(tokens.verify(kA.token), 'sub-A', 'Token 验证应归属签发用户');

  assert.deepStrictEqual(tokens.listApiKeys('sub-B').map((k) => k.name), ['agent-b'], '列表按用户隔离');
  assert.strictEqual(tokens.revokeApiKey(kA.id, 'sub-B'), false, '跨用户吊销应被拒');
  assert.strictEqual(tokens.verify(kA.token), 'sub-A', '跨用户吊销不生效');
  assert.strictEqual(tokens.revokeApiKey(kA.id, 'sub-A'), true);
  assert.strictEqual(tokens.verify(kA.token), null);
  tokens.revokeApiKey(kB.id, 'sub-B');
});

// ===== HTTP 层（未配置 Keycloak 的行为 + SLO） =====

test('HTTP：未配 KEYCLOAK_URL 时 /auth/login 明确报错；/slo-logout 清会话；Token 面不受影响', async () => {
  const port = 18999;
  const child = require('child_process').spawn(process.execPath, ['src/index.js'], {
    cwd: config.root,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const waitUp = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`${base}/healthz`);
        if (r.ok) return true;
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  };

  try {
    assert.ok(await waitUp(), '服务应在超时内启动');

    // 未配置 Keycloak → 登录入口给明确指引（503），而非静默 404/500
    const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    assert.strictEqual(login.status, 503);
    const hint = await login.text();
    assert.ok(hint.includes('KEYCLOAK_URL'), '报错应指出缺什么配置');

    // 无凭据访问 API 面 → 401
    assert.strictEqual((await fetch(`${base}/api/me`)).status, 401);

    // Token 面不受 Keycloak 影响：签发后直连 /v1 /v2 /api
    const tokens = require('../src/auth/tokens');
    const k = tokens.createApiKey('sub-A', 'http-test');
    const me = await fetch(`${base}/api/me`, { headers: { Authorization: `Token ${k.token}` } });
    assert.strictEqual(me.status, 200);
    assert.strictEqual((await me.json()).userId, 'sub-A');

    // 建一个会话，SLO front-channel 端点应清掉它（在 BR-Agent 登出 → 本端也退出）
    const sid = crypto.randomBytes(24).toString('hex');
    repo.createSession(sid, 'sub-A', config.sessionTtlMs, 'br0002');
    const slo = await fetch(`${base}/slo-logout`, { headers: { Cookie: `aim_session=${sid}` }, redirect: 'manual' });
    assert.strictEqual(slo.status, 200, 'front-channel iframe 要求 200');
    assert.ok(!repo.getSession(sid), 'SLO 后本地会话应被清除');
  } finally {
    child.kill('SIGKILL');
  }
});

test('安全：跳转白名单——外部地址被拒（防开放重定向）', () => {
  const safeNext = (v) => (typeof v === 'string' && v.startsWith('/') && !v.includes('//') ? v : '/');
  assert.strictEqual(safeNext('/connect'), '/connect', '站内路径放行');
  assert.strictEqual(safeNext('//evil.com'), '/', '协议相对地址应被拒');
  assert.strictEqual(safeNext('https://evil.com'), '/', '绝对地址应被拒');
  assert.strictEqual(safeNext('javascript:alert(1)'), '/', '伪协议应被拒');
  assert.strictEqual(safeNext(undefined), '/', '缺失回落首页');
});
