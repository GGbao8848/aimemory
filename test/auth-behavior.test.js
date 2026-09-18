'use strict';

/**
 * 鉴权行为回归（评估轮 Q1）：
 * 无凭证/假 Token/假 cookie → 401；MCP 端点同样鉴权；
 * 登录限速：连续错口令达上限后 429，且窗口内正确口令同样被拒（按 IP 而非按口令）。
 * 子进程起隔离实例（临时库 + LLM/EMBEDDING 关），真实数据零接触。
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function startServer(port) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
  const child = spawn('node', ['src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AIMEMORY_DB: path.join(tmp, 'a.db'),
      AIMEMORY_L3_DIR: path.join(tmp, 'l3'),
      AIMEMORY_L0_DIR: path.join(tmp, 'l0'),
      AIMEMORY_PASSWORD: 'auth-test-pw-0919',
      LLM_ENABLED: '0',
      EMBEDDING_ENABLED: '0',
      PORT: String(port),
    },
    stdio: 'ignore',
  });
  return { child, tmp };
}

async function waitReady(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok || r.status === 503) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server not ready');
}

test('鉴权行为：401 族 + 登录限速 429（按 IP）+ 成功登录 302', async () => {
  const port = 19100 + (process.pid % 400);
  const b = `http://127.0.0.1:${port}`;
  const { child, tmp } = startServer(port);
  try {
    await waitReady(port);
    const form = (password) => ({
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(password)}`,
    });

    // 成功登录 → 302 建会话（先做，避免被限速窗口挡住）
    let r = await fetch(`${b}/auth/local-login`, form('auth-test-pw-0919'));
    assert.equal(r.status, 302, '正确口令应 302');
    assert.ok((r.headers.get('set-cookie') || '').includes('aim_session='), '应下发会话 cookie');
    await r.arrayBuffer().catch(() => {});

    // 401 族：REST 无凭证 / 假 Token / 假 cookie
    r = await fetch(`${b}/api/stats`);
    assert.equal(r.status, 401, '无凭证应 401');
    r = await fetch(`${b}/api/stats`, { headers: { Authorization: 'Token m0-faketoken' } });
    assert.equal(r.status, 401, '假 Token 应 401');
    r = await fetch(`${b}/api/stats`, { headers: { Cookie: 'aim_session=deadbeef' } });
    assert.equal(r.status, 401, '假 cookie 应 401');

    // MCP 端点同受鉴权保护
    r = await fetch(`${b}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(r.status, 401, 'MCP 无 Token 应 401');

    // 连续错口令：前 10 次 401，第 11 次起 429（15 分钟窗口内同 IP 上限 10 次）
    let last = 0;
    for (let i = 0; i < 11; i++) {
      r = await fetch(`${b}/auth/local-login`, form('wrong-password'));
      last = r.status;
      await r.arrayBuffer().catch(() => {});
    }
    assert.equal(last, 429, '连续失败应触发限速');
    // 限速是按 IP 而非按口令：窗口内正确口令同样被拒
    r = await fetch(`${b}/auth/local-login`, form('auth-test-pw-0919'));
    assert.equal(r.status, 429, '限速窗口内正确口令同样 429');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
