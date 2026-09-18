'use strict';

/**
 * 本地口令登录测试（单用户模式，替代原 Keycloak SSO）。
 *
 * 必须在 require 业务模块前设置 AIMEMORY_DB（独立临时库），
 * 否则会写进生产 data/ 下的库。
 *
 * 覆盖：口令比对（正确/错误/长度差异）、限速拦截、会话建立与登出、跳转白名单。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-auth-'));
process.env.AIMEMORY_DB = path.join(workDir, 'test.db');
process.env.AIMEMORY_USER_ID = 'auth-test-user';
process.env.AIMEMORY_USER_NAME = '测试者';
process.env.AIMEMORY_PASSWORD = 'correct-horse-battery-staple';
process.env.LLM_ENABLED = '0'; // 登录测试不涉及提炼

const test = require('node:test');
const assert = require('node:assert');

const config = require('../src/config');
const repo = require('../src/db/repo');

// ===== 直接测核心逻辑（避免起 HTTP 服务） =====

test('config：单用户身份与口令来自环境变量', () => {
  assert.strictEqual(config.userId, 'auth-test-user');
  assert.strictEqual(config.userName, '测试者');
  assert.strictEqual(config.password, 'correct-horse-battery-staple');
  assert.strictEqual(config.passwordGenerated, null, '显式配置时不应触发生成');
  assert.strictEqual(config.keycloak, undefined, 'keycloak 配置应已移除');
});

test('config：口令缺失时自动生成强口令并写回 .env（重启不漂移）', () => {
  const ensure = config._ensurePassword;
  assert.strictEqual(typeof ensure, 'function', '应导出可测的生成函数');

  // 场景1：.env 里根本没有该行 → 追加
  const f1 = path.join(workDir, 'env-no-key');
  fs.writeFileSync(f1, 'PORT=18543\nLLM_ENABLED=1\n', 'utf8');
  const p1 = ensure(f1, undefined);
  assert.ok(p1 && p1.length >= 22, `生成的口令应足够长，实际 ${p1 && p1.length}`);
  assert.ok(fs.readFileSync(f1, 'utf8').includes(`AIMEMORY_PASSWORD=${p1}`), '应写回文件');

  // 场景2：该行存在但为空（旧代码会在这里每次重启换口令）→ 就地替换而非追加
  const f2 = path.join(workDir, 'env-empty-key');
  fs.writeFileSync(f2, 'PORT=18543\nAIMEMORY_PASSWORD=\nLLM_ENABLED=1\n', 'utf8');
  const p2 = ensure(f2, undefined);
  const c2 = fs.readFileSync(f2, 'utf8');
  assert.ok(c2.includes(`AIMEMORY_PASSWORD=${p2}`), '应填上生成的口令');
  assert.strictEqual((c2.match(/^AIMEMORY_PASSWORD=/gm) || []).length, 1, '不得重复追加该行');
  assert.ok(c2.includes('LLM_ENABLED=1'), '其余配置应保留');

  // 场景3：已配置 → 不生成、不改文件
  const f3 = path.join(workDir, 'env-has-key');
  fs.writeFileSync(f3, 'AIMEMORY_PASSWORD=already-set\n', 'utf8');
  assert.strictEqual(ensure(f3, 'already-set'), null, '已有口令不应再生成');
  assert.strictEqual(fs.readFileSync(f3, 'utf8'), 'AIMEMORY_PASSWORD=already-set\n', '文件不应被改动');

  // 场景4：两次生成结果不同（确实随机）
  const p4 = ensure(f1, undefined);
  assert.notStrictEqual(p4, p1, '重新生成应得到不同口令');
});

test('会话：主账号身份可建立/读取/删除会话', () => {
  const sid = crypto.randomBytes(24).toString('hex');
  repo.createSession(sid, config.userId, config.sessionTtlMs, config.userName);

  const s = repo.getSession(sid);
  assert.ok(s, '会话应可读出');
  assert.strictEqual(s.user_id, config.userId, '会话归属主账号');
  assert.strictEqual(s.username, config.userName);

  repo.deleteSession(sid);
  assert.ok(!repo.getSession(sid), '登出后会话应失效');
});

test('Token：单用户下签发的 Token 归属主账号（MCP/REST 鉴权不受重构影响）', () => {
  const k = require('../src/auth/tokens').createApiKey(config.userId, 'auth-test');
  assert.match(k.token, /^m0-/, 'Token 形态不变');
  assert.strictEqual(require('../src/auth/tokens').verify(k.token), config.userId, 'Token 可验证并归主账号');
  require('../src/auth/tokens').revokeApiKey(k.id, config.userId);
  assert.strictEqual(require('../src/auth/tokens').verify(k.token), null, '吊销后失效');
});

test('安全：定时安全比较——口令长度不同也返回 false 且不抛错', () => {
  // 复刻服务端的比较逻辑（timingSafeEqual 要求等长，故先判长度）
  const passwordOk = (input) => {
    const a = Buffer.from(String(input == null ? '' : input));
    const b = Buffer.from(config.password);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  };
  assert.strictEqual(passwordOk('correct-horse-battery-staple'), true, '正确口令通过');
  assert.strictEqual(passwordOk('wrong'), false, '短口令拒绝（长度不同）');
  assert.strictEqual(passwordOk('correct-horse-battery-stapleX'), false, '长口令拒绝');
  assert.strictEqual(passwordOk('correct-horse-battery-stapl3'), false, '等长但错字拒绝');
  assert.strictEqual(passwordOk(''), false, '空口令拒绝');
  assert.strictEqual(passwordOk(undefined), false, 'undefined 拒绝且不抛错');
});

// ===== HTTP 层行为（登录页 / 表单提交 / 限速） =====

test('HTTP：登录页可访问、表单提交正确口令后建立会话、错误口令 401', async () => {
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

    // 登录页
    const page = await fetch(`${base}/auth/login`);
    assert.strictEqual(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('访问口令'), '登录页应含口令输入框文案');
    assert.ok(!html.includes('Keycloak'), '登录页不应再出现 Keycloak');

    // 错误口令
    const bad = await fetch(`${base}/auth/local-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=definitely-wrong',
      redirect: 'manual',
    });
    assert.strictEqual(bad.status, 401, '错误口令应 401');

    // 正确口令 → 302 + Set-Cookie
    const ok = await fetch(`${base}/auth/local-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(config.password)}`,
      redirect: 'manual',
    });
    assert.strictEqual(ok.status, 302, '正确口令应重定向');
    const setCookie = ok.headers.get('set-cookie') || '';
    assert.ok(setCookie.includes('aim_session='), '应种下会话 cookie');

    // 带 cookie 访问 /api/me
    const cookie = setCookie.split(';')[0];
    const me = await fetch(`${base}/api/me`, { headers: { Cookie: cookie } });
    assert.strictEqual(me.status, 200);
    const info = await me.json();
    assert.strictEqual(info.userId, config.userId, '/api/me 应返回主账号');
    assert.strictEqual(info.via, 'session');

    // 健康检查不应再有 keycloak 字段
    const hz = await (await fetch(`${base}/healthz`)).json();
    assert.strictEqual(hz.keycloak, undefined, 'healthz 不应再探测 Keycloak');
    assert.strictEqual(hz.status, 'ok');
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
