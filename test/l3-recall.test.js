'use strict';

/**
 * L3 recall_context 测试。
 *
 * 本文件 LLM_ENABLED=0 —— 故意为之：recall_context 是「零 LLM、只读」的注入工具，
 * 关闭 LLM 也必须完整可用（验收标准之一）；同时保证夜间测试零 token 消耗。
 * 覆盖：三类分组 / 相关度排序 / per_kind 截断 / facts 的 user 隔离 / 工具注册。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-l3r-'));
process.env.AIMEMORY_DB = path.join(tmpRoot, 'test.db');
process.env.AIMEMORY_L3_DIR = path.join(tmpRoot, 'l3');
process.env.LLM_ENABLED = '0'; // 关键：零 LLM 也必须可用

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const db = require('../src/db');
const llm = require('../src/llm/client');
const emb = require('../src/embeddings/client');
const l2store = require('../src/l2/store');
const l3store = require('../src/l3/store');
const { recallContext, extractTokens } = require('../src/l3/recall');
const { tools: mcpTools } = require('../src/mcp/tools');

const u1 = 'recall-user-1';
const u2 = 'recall-user-2';

before(() => {
  emb.embed = async () => null; // 无 embedding：事实召回走 FTS/关键词路径
});

after(() => {
  db.close();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  for (const t of ['memories']) for (const u of [u1, u2]) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(u);
  try { fs.rmSync(config.l3Dir, { recursive: true, force: true }); } catch {}
});

const mkEntry = (kind, text, confidence = 0.8) => l3store.appendEntry({ kind, text, confidence });
const mkFact = (userId, text) => l2store.insertFact({ userId, text, metadata: {} });

test('三类分组 + 无 query 时按置信度排前，facts 为空', async () => {
  mkEntry('profile', '偏好精简的中文回复', 0.7);
  mkEntry('constraints', '生产环境为内网部署', 0.9);
  mkEntry('lessons', '采集器必须流式 emit', 0.6);
  mkFact(u1, '端口是 18543');

  const r = await recallContext({ userId: u1 });
  assert.equal(r.profile.length, 1);
  assert.equal(r.constraints.length, 1);
  assert.equal(r.lessons.length, 1);
  assert.deepEqual(r.facts, [], '无 query 不做事实召回（没有意义）');
  assert.ok(r.constraints[0].text.includes('内网'));
  assert.equal(r.constraints[0].confidence, 0.9);
});

test('有 query：命中的条目排前，且附带相关 L2 事实', async () => {
  mkEntry('constraints', '向量检索使用 sqlite-vec 扩展');
  mkEntry('constraints', '文档统一放在 docs/ 目录', 0.95); // 置信更高但不相关
  // 注意：search_memories 是 AND 语义（每个查询词都要命中），query 用词必须落在事实文本里
  mkFact(u1, '向量检索的配置在 config.js');

  const r = await recallContext({ userId: u1, query: '向量 检索 配置' });
  assert.equal(r.constraints[0].text.includes('sqlite-vec'), true, '相关条目应排在不相关的高置信条目之前');
  assert.ok(r.facts.some((f) => f.text.includes('向量')), '相关事实应被召回');
});

test('facts 的 user 隔离：u2 召回不到 u1 的事实', async () => {
  mkFact(u1, 'u1 的服务部署在 10.10.10.88');
  mkFact(u2, 'u2 的服务部署在 10.10.10.99');

  const r = await recallContext({ userId: u2, query: '服务 部署 10.10.10.99' });
  assert.ok(r.facts.some((f) => f.text.includes('10.10.10.99')), 'u2 应命中自己的事实');
  assert.ok(!r.facts.some((f) => f.text.includes('10.10.10.88')), '绝不能召回 u1 的事实');
});

test('per_kind 截断与 LLM 关闭降级（本文件 LLM_ENABLED=0 即全路径验证）', async () => {
  for (let i = 1; i <= 5; i++) mkEntry('lessons', `教训条目${i}，内容各不相同`, 0.5 + i * 0.01);
  const r = await recallContext({ userId: u1, perKind: 2 });
  assert.equal(r.lessons.length, 2, 'per_kind 截断生效');
  assert.equal(llm.enabled(), false, '前置条件：LLM 关闭');
  assert.ok(r.lessons.length > 0, 'LLM 关闭时 recall_context 依然完整可用');
});

test('空库/无条目 → 返回空组而非报错', async () => {
  const r = await recallContext({ userId: u1, query: '随便查查' });
  assert.deepEqual(r.profile, []);
  assert.deepEqual(r.constraints, []);
  assert.deepEqual(r.lessons, []);
  assert.ok(Array.isArray(r.facts));
});

test('工具注册：recall_context 在 MCP 清单中且 handler 可直接调用', async () => {
  const names = mcpTools.map((t) => t.name);
  assert.ok(names.includes('recall_context'), '工具应注册进 MCP 清单');
  assert.equal(names.length, 10, '工具总数应为 10');
  const tool = mcpTools.find((t) => t.name === 'recall_context');
  mkEntry('constraints', '测试约束：部署在内网');
  const out = await tool.handler({ query: '内网' }, u1);
  const payload = JSON.parse(out.content[0].text);
  assert.ok(payload.constraints.some((c) => c.text.includes('内网')));
});

test('extractTokens：CJK 长串滑窗 + 拉丁词', () => {
  const t = extractTokens('检查 sqlite-vec 的向量检索配置');
  assert.ok(t.includes('sqlite-vec'));
  assert.ok(t.includes('向量'), 'CJK 应产出词根');
  const t2 = extractTokens('这是一段比较长的中文描述用来验证滑窗切分逻辑');
  assert.ok(t2.length >= 4 && t2.every((w) => w.length >= 2));
});

// ===== kinds 过滤（评估轮 Q2：agent 开场只要约束/教训时省 token） =====

test('kinds 过滤：只返回指定类别，未请求的类别不出现在输出里', async () => {
  l3store.appendEntry({ kind: 'profile', text: '画像条目：偏好简洁。' });
  l3store.appendEntry({ kind: 'constraints', text: '约束条目：端口 18543。' });

  const r = await recallContext({ userId: u1, kinds: ['constraints'] });
  assert.deepEqual(Object.keys(r).sort(), ['constraints', 'facts'], '输出只含请求类别 + facts');
  assert.equal(r.constraints.length, 1);

  const r2 = await recallContext({ userId: u1, kinds: ['constraints', 'lessons'] });
  assert.deepEqual(Object.keys(r2).sort(), ['constraints', 'facts', 'lessons']);

  // store 层宽容降级：全未知类别 → 三类全量（MCP 层负责拦截坏输入）
  const r3 = await recallContext({ userId: u1, kinds: ['nope'] });
  assert.ok('profile' in r3 && 'constraints' in r3 && 'lessons' in r3);
});

test('kinds 非法输入：MCP 层返回 isError 执行错误（含合法取值清单，模型可自愈）', async () => {
  const { tools, callTool } = require('../src/mcp/tools');
  const t = tools.find((x) => x.name === 'recall_context');
  assert.ok(t.inputSchema.properties.kinds, 'schema 应声明 kinds');
  assert.deepEqual(t.inputSchema.properties.kinds.items.enum, ['profile', 'constraints', 'lessons']);

  const out = await callTool('recall_context', { kinds: ['nope'] }, u1);
  assert.equal(out.isError, true);
  assert.ok(out.content[0].text.includes('profile'), '文案应列出合法取值');
});
