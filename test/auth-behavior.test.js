'use strict';

/**
 * 鉴权行为回归（评估轮 Q1，Keycloak 多租户版）：
 * 无凭证/假 Token/假 cookie → 401；MCP 端点同样鉴权。
 * 本地口令与限速已随单用户登录移除——登录防爆破由 Keycloak 负责。
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
      // 显式置空 KEYCLOAK_URL：Web 登录应 503 拒绝，401 族不受影响
      KEYCLOAK_URL: '',
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

test('鉴权行为：401 族（REST / MCP / 假凭证）+ 未配 Keycloak 时登录入口 503', async () => {
  const port = 19100 + (process.pid % 400);
  const b = `http://127.0.0.1:${port}`;
  const { child, tmp } = startServer(port);
  try {
    await waitReady(port);
    let r;

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

    // mem0 对外面同样 401
    r = await fetch(`${b}/v1/memories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401, '/v1 无 Token 应 401');

    // Web 登录入口：未配置 Keycloak → 503 明确指引（不静默 404）
    r = await fetch(`${b}/auth/login`, { redirect: 'manual' });
    assert.equal(r.status, 503, '未配 KEYCLOAK_URL 应 503');
    assert.ok((await r.text()).includes('KEYCLOAK_URL'));
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
