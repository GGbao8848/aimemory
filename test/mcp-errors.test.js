'use strict';

/**
 * MCP 工具错误语义测试（对齐官方最佳实践）：
 * 输入校验/业务类错误必须以 isError:true 的**执行错误**返回（文案带行动建议，模型可自愈），
 * 而不是抛协议错误（-32602，模型拿到后无法修正）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { tools, callTool } = require('../src/mcp/tools');

const byName = (name) => {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `工具 ${name} 应存在`);
  return t;
};

test('全部 10 个工具都带 title（人可读显示名）', () => {
  assert.equal(tools.length, 10);
  for (const t of tools) {
    assert.ok(t.title && typeof t.title === 'string' && t.title.length >= 2, `${t.name} 缺 title`);
  }
});

test('校验错误 → 经分发层转 isError 执行结果（非协议错误），文案含行动建议', async () => {
  const out = await callTool('add_memory', {}, 'owner');
  assert.equal(out.isError, true, '应以 isError:true 结果返回');
  assert.ok(out.content[0].text.includes('text'), '文案应指出缺什么');

  const out2 = await callTool('search_memories', { query: '  ' }, 'owner');
  assert.equal(out2.isError, true);
  assert.ok(out2.content[0].text.includes('关键词'), '文案应含修正建议');
});

test('业务错误（id 不存在）→ isError 结果且给下一步建议', async () => {
  const out = await callTool('get_memory', { memory_id: '不存在' }, 'owner');
  assert.equal(out.isError, true);
  assert.ok(out.content[0].text.includes('get_memories'), '应建议用 get_memories 找有效 id');
});

test('正常路径不受影响：合法调用仍返回结果（非 isError）', async () => {
  // search_memories 空库也返回正常结果
  const out = await callTool('search_memories', { query: '随便' }, 'owner');
  assert.equal(out.isError, undefined);
  assert.ok(out.content[0].text.includes('results'));
});
