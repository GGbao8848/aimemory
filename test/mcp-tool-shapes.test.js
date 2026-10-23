'use strict';

/**
 * MCP 工具响应形状回归（agent 对接的隐性契约）：
 * - get_event_status 平铺返回且与 REST GET /v1/event/{id} 同形（result 为已解析对象，不得嵌套/字符串化）；
 * - add_memory 的 agent_id 透传到提炼产物（此前仅 REST 面支持，MCP 补齐后锁行为）。
 * 独立临时 DB + stub LLM（拦截 llm.complete，见 raw-material-delete 同款）。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-mcpshape-')), 'test.db');
process.env.AIMEMORY_DB = tmpDb;

const { test, before } = require('node:test');
const assert = require('node:assert');
const { callTool } = require('../src/mcp/tools');
const events = require('../src/db/repo/events');
const db = require('../src/db');
const llm = require('../src/llm/client');

const u = 'mcp-shape-user';

before(async () => {
  llm.enabled = () => true;
  let i = 0;
  llm.complete = async () => {
    // 调用序列：提炼（1 次）→ 标注（1 次）→ 消解（若干次，null 走 fail-open）
    i += 1;
    if (i === 1) return '内网构建机 10.10.10.254 的 Jenkins 端口是 8081，这是关键环境事实。';
    if (i === 2) return JSON.stringify([{ entities: ['jenkins'], categories: ['devops'], importance: 7 }]);
    return null;
  };
});

test('add_memory（带 agent_id）→ get_event_status 平铺返回，result.memories 可直接取用', async () => {
  const add = JSON.parse((await callTool('add_memory', { text: '素材原文', agent_id: 'shape-test' }, u)).content[0].text);
  assert.ok(add.event_id, '受理返回 event_id');
  await events.processPendingEvents();

  const out = await callTool('get_event_status', { event_id: add.event_id }, u);
  assert.ok(!out.isError, `不应报错: ${out.content?.[0]?.text?.slice(0, 120)}`);
  const ev = JSON.parse(out.content[0].text);

  // 平铺 + 与 REST /v1/event/{id} 同形
  assert.equal(ev.event_id, add.event_id, '顶层 event_id（不是嵌套在 event 下，也不是 id 字段名）');
  assert.equal(ev.status, 'done');
  assert.equal(ev.error, null);
  assert.ok(ev.result && typeof ev.result === 'object', 'result 是已解析对象（不得是字符串化 JSON）');
  assert.ok(ev.result.count >= 1 && Array.isArray(ev.result.memories), 'result 含 count 与 memories 列表');
  assert.equal(ev.result.memories[0].agent_id, 'shape-test', 'agent_id 透传到提炼产物');
  assert.equal(ev.event_type, undefined, '与 REST 形状一致：不携带 event_type');
});

test('get_memory 返回 {memory} 且带 agent_id 归属（MCP 面透传锁定）', async () => {
  const list = JSON.parse((await callTool('get_memories', { filters: {}, page: 1, page_size: 10 }, u)).content[0].text);
  const row = list.results.find((m) => m.agent_id === 'shape-test');
  assert.ok(row, '列表里能按 agent_id 找到产物');
  const one = JSON.parse((await callTool('get_memory', { memory_id: row.id }, u)).content[0].text);
  assert.equal(one.memory.id, row.id, '单条以 {memory} 包裹返回');
  assert.equal(one.memory.agent_id, 'shape-test');
});
