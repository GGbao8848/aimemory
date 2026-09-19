'use strict';

/**
 * mem0 形态 API 行为回归（/v1 /v2 面，src/api/mem0.js）：
 * - add：infer=false 原文直存（同步）；infer=true 异步受理（LLM 关时 503，单独起实例验证）
 * - search / get_all：filters（agent_id/run_id/metadata/时间范围）、分页、user_id 校验
 * - update / delete：单条 + history 留痕
 * - delete all：按作用域异步删除（事件轮询）
 * 子进程起隔离实例（临时库 + LLM/EMBEDDING 关），零真实 LLM。
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function startServer(port) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-api-test-'));
  const child = spawn('node', ['src/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AIMEMORY_DB: path.join(tmp, 'a.db'),
      AIMEMORY_PASSWORD: 'mem0-api-test-pw',
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

/** 登录拿会话 cookie → 签发 Token（明文） */
async function issueToken(port) {
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/auth/local-login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent('mem0-api-test-pw')}`,
  });
  const setCookie = login.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  const r = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'mem0-test' }),
  });
  assert.equal(r.status, 201, '签发 Token 应成功');
  return (await r.json()).token;
}

function client(base, token) {
  const call = (method, url, body) => fetch(`${base}${url}`, {
    method,
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    add: (body) => call('POST', '/v1/memories/', body),
    search: (body) => call('POST', '/v2/memories/search/', body),
    listAll: (body) => call('POST', '/v2/memories/', body),
    get: (id) => call('GET', `/v1/memories/${id}/`),
    put: (id, body) => call('PUT', `/v1/memories/${id}/`, body),
    del: (id) => call('DELETE', `/v1/memories/${id}/`),
    history: (id) => call('GET', `/v1/memories/${id}/history/`),
    delAll: (qs) => call('DELETE', `/v1/memories/?${qs}`),
    event: (id) => call('GET', `/v1/event/${id}/`),
  };
}

test('mem0 API：infer=false 直存 → get/history/search/list → update/delete 留痕 → delete all 异步', async () => {
  const port = 19300 + (process.pid % 400);
  const { child, tmp } = startServer(port);
  try {
    await waitReady(port);
    const token = await issueToken(port);
    const api = client(`http://127.0.0.1:${port}`, token);

    // ===== add（infer=false）：原文直存，同步返回 =====
    const add = await api.add({
      text: '生产服务器地址是 10.10.10.146，端口 18543',
      agent_id: 'zcode',
      run_id: 'session-1',
      metadata: { tag: 'infra' },
      infer: false,
    });
    assert.equal(add.status, 200);
    const addBody = await add.json();
    assert.equal(addBody.results.length, 1);
    assert.equal(addBody.results[0].event, 'ADD');
    const id1 = addBody.results[0].id;

    // messages 直存（infer=false）
    const add2 = await api.add({
      messages: [{ role: 'user', content: '我偏好用 better-sqlite3' }, { role: 'assistant', content: '已了解' }],
      agent_id: 'claude',
      infer: false,
    });
    const id2 = (await add2.json()).results[0].id;

    // 缺内容 → 400
    assert.equal((await api.add({})).status, 400);

    // ===== get：mem0 形状 =====
    const got = await (await api.get(id1)).json();
    assert.equal(got.memory, '生产服务器地址是 10.10.10.146，端口 18543');
    assert.equal(got.agent_id, 'zcode');
    assert.equal(got.run_id, 'session-1');
    assert.deepEqual(got.metadata, { tag: 'infra' });

    // ===== history：ADD 留痕 =====
    const hist = await (await api.history(id1)).json();
    assert.equal(hist.length, 1);
    assert.equal(hist[0].event, 'ADD');
    assert.equal(hist[0].new_memory, got.memory);

    // ===== update：文本变化 → UPDATE 历史 =====
    const put = await api.put(id1, { text: '生产服务器地址是 10.10.10.200，端口 18543' });
    assert.equal(put.status, 200);
    const hist2 = await (await api.history(id1)).json();
    assert.equal(hist2.length, 2);
    assert.equal(hist2[0].event, 'UPDATE');
    assert.equal(hist2[0].old_memory, '生产服务器地址是 10.10.10.146，端口 18543');
    assert.equal(hist2[0].new_memory, '生产服务器地址是 10.10.10.200，端口 18543');

    // ===== search：过滤 agent_id + user_id 403 =====
    const sr = await api.search({ query: '生产服务器 端口', filters: { agent_id: 'zcode' }, top_k: 5 });
    assert.equal(sr.status, 200);
    const srb = await sr.json();
    assert.ok(srb.results.length >= 1, '应命中 zcode 记忆');
    assert.ok(srb.results.every((m) => m.agent_id === 'zcode'));
    assert.ok(typeof srb.results[0].score === 'number');
    const sr403 = await api.search({ query: 'x', filters: { user_id: 'someone-else' } });
    assert.equal(sr403.status, 403);
    const sr400 = await api.search({ query: 'x', filters: { OR: [{ agent_id: 'a' }] } });
    assert.equal(sr400.status, 400, 'OR 过滤应明确报错');

    // ===== list（get_all）：过滤 + 分页形状 =====
    const list = await api.listAll({ filters: { agent_id: 'zcode' }, page: 1, page_size: 1 });
    assert.equal(list.status, 200);
    const lb = await list.json();
    assert.equal(lb.count, 1);
    assert.equal(lb.results.length, 1);
    assert.equal(lb.next, null);
    const listKw = await api.listAll({ filters: { keywords: 'better-sqlite3' } });
    assert.equal((await listKw.json()).count, 1, 'keywords 过滤应命中 messages 直存记忆');

    // ===== delete 单条 → DELETE 历史（先取 id 再删） =====
    assert.equal((await api.del(id2)).status, 200);
    assert.equal((await api.get(id2)).status, 404);

    // ===== delete all：按 agent_id 异步删除 =====
    const da = await api.delAll('agent_id=zcode');
    assert.equal(da.status, 200);
    const dab = await da.json();
    assert.ok(dab.event_id);
    let ev = await (await api.event(dab.event_id)).json();
    for (let i = 0; i < 40 && ev.status === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, 250));
      ev = await (await api.event(dab.event_id)).json();
    }
    assert.equal(ev.status, 'done', '批量删除事件应完成');
    assert.equal(ev.result.count, 1, '应删掉 1 条 zcode 记忆');
    assert.equal((await api.get(id1)).status, 404, 'zcode 记忆应已删除');

    // 无过滤条件 → 400（防误删全库）
    assert.equal((await api.delAll('')).status, 400);
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mem0 API：infer=true 且 LLM 关闭 → 503 明确拒绝（不静默吞素材）', async () => {
  const port = 19500 + (process.pid % 400);
  const { child, tmp } = startServer(port);
  try {
    await waitReady(port);
    const token = await issueToken(port);
    const api = client(`http://127.0.0.1:${port}`, token);
    const r = await api.add({ text: '需要 LLM 提炼的素材' });
    assert.equal(r.status, 503);
    const b = await r.json();
    assert.ok(b.error.includes('LLM'), '错误信息应指向 LLM 未启用');
    // 无 Token → 401
    const anon = await fetch(`http://127.0.0.1:${port}/v1/memories/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(anon.status, 401);
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
