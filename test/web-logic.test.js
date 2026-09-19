'use strict';

/**
 * 管理台前端（web/）的纯逻辑守护：Node 原生类型擦除直接 require .ts 模块。
 * 锁住三块：记忆视图的作用域过滤/事件映射、展示格式、MCP 配置生成的三种 Token 状态。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'web', 'src', 'lib');
const format = require(path.join(LIB, 'format.ts'));
const mcp = require(path.join(LIB, 'mcp-config.ts'));
const memories = require(path.join(LIB, 'memories.ts'));

const MEM = [
  { id: '1', text: 'a', agent_id: 'zcode', run_id: 's1', metadata: {}, updated_at: '2026-09-18T07:00:00Z' },
  { id: '2', text: 'b', agent_id: 'claude', run_id: null, metadata: {}, updated_at: '2026-09-18T08:00:00Z' },
  { id: '3', text: 'c', agent_id: 'zcode', run_id: 's2', metadata: {}, updated_at: '2026-09-18T09:00:00Z' },
  { id: '4', text: 'd', agent_id: null, run_id: null, metadata: {}, updated_at: '2026-09-18T10:00:00Z' },
];

test('作用域聚合：提取出现过的 agent/run，去重且保持出现顺序', () => {
  const s = memories.scopeOptions(MEM);
  assert.deepStrictEqual(s.agents, ['zcode', 'claude']);
  assert.deepStrictEqual(s.runs, ['s1', 's2']);
  assert.deepStrictEqual(memories.scopeOptions([]), { agents: [], runs: [] });
});

test('作用域过滤：null 维度不限制，双维度取交集', () => {
  assert.strictEqual(memories.filterByScope(MEM, memories.ALL_SCOPE).length, 4);
  assert.deepStrictEqual(
    memories.filterByScope(MEM, { agentId: 'zcode', runId: null }).map((m) => m.id),
    ['1', '3'],
  );
  assert.deepStrictEqual(
    memories.filterByScope(MEM, { agentId: 'zcode', runId: 's2' }).map((m) => m.id),
    ['3'],
  );
  assert.deepStrictEqual(
    memories.filterByScope(MEM, { agentId: null, runId: 's1' }).map((m) => m.id),
    ['1'],
  );
});

test('历史事件映射：三类操作有标签与配色，未知事件原样兜底', () => {
  assert.deepStrictEqual(memories.historyMeta('ADD'), { label: '新增', variant: 'default' });
  assert.deepStrictEqual(memories.historyMeta('UPDATE'), { label: '更新', variant: 'secondary' });
  assert.deepStrictEqual(memories.historyMeta('DELETE'), { label: '删除', variant: 'destructive' });
  assert.strictEqual(memories.historyMeta('WEIRD').label, 'WEIRD');
});

test('事件状态文案：异步提炼的四种状态 + 未知兜底', () => {
  assert.strictEqual(memories.eventStatusLabel('pending'), '排队中');
  assert.strictEqual(memories.eventStatusLabel('processing'), '提炼中');
  assert.strictEqual(memories.eventStatusLabel('done'), '已入库');
  assert.strictEqual(memories.eventStatusLabel('failed'), '提炼失败');
  assert.strictEqual(memories.eventStatusLabel(null), '—');
  assert.strictEqual(memories.eventStatusLabel('other'), 'other');
});

test('展示格式：时间', () => {
  assert.strictEqual(format.fmtTime(null), '—');
  assert.strictEqual(format.fmtTime('not-a-date'), 'not-a-date', '无法解析的时间原样返回，不显示 Invalid Date');
  assert.strictEqual(format.fmtCompactTime('2026-09-19T04:12:33Z'), '09-19 04:12');
  assert.strictEqual(format.fmtCompactTime(null), '—');
});

test('MCP 配置：有明文→完整可用；有 Token 无明文→占位；无 Token→不带 headers', () => {
  const withToken = mcp.buildMcpConfig({ origin: 'http://10.0.0.5:18543', plaintext: 'm0-abc', hasKey: true });
  assert.deepStrictEqual(JSON.parse(withToken.json), {
    mcpServers: { aimemory: { type: 'http', url: 'http://10.0.0.5:18543/mcp', headers: { Authorization: 'Token m0-abc' } } },
  });
  assert.strictEqual(withToken.copyLabel, '复制 JSON（含 Token）');
  assert.strictEqual(withToken.copyable, true);

  const template = mcp.buildMcpConfig({ origin: 'http://h:18543', plaintext: null, hasKey: true });
  assert.ok(template.json.includes(mcp.TOKEN_PLACEHOLDER), '无明文时给出占位符');
  assert.strictEqual(template.copyLabel, '复制 JSON 模板');
  assert.strictEqual(template.copyable, false, '无明文不得复制成「完整配置」');
  assert.strictEqual(mcp.authorizationHeader({ origin: 'http://h:18543', plaintext: null, hasKey: true }), `Token ${mcp.TOKEN_PLACEHOLDER}`);

  const noKeys = mcp.buildMcpConfig({ origin: 'http://h:18543', plaintext: null, hasKey: false });
  assert.ok(!noKeys.json.includes('headers'), '尚无 Token 时不输出 headers 键');
  assert.strictEqual(mcp.authorizationHeader({ origin: 'http://h:18543', plaintext: null, hasKey: false }), 'Token m0-xxx（请先在上方新建 Token）');
});

// 镜像内构建前端时，契约类型（仓库根 docs/api/）必须在 web 阶段可见——
// 首轮 docker build 就是因为只 COPY 了 web/ 而整阶段 tsc 失败，这里钉死目录形状。
test('Dockerfile 的 web 构建阶段能看见仓库根的契约类型', () => {
  const docker = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  const stage = docker.split(/^FROM /m).find((b) => /^\S+ AS web$/m.test(b.split('\n')[0]));
  assert.ok(stage, '应存在 AS web 构建阶段');
  assert.match(stage, /^WORKDIR \/app$/m, 'web 阶段 WORKDIR 须为 /app（与仓库根同深度）');
  assert.match(stage, /^COPY web \.\/web$/m, 'web 源码须落在 ./web');
  assert.match(stage, /^COPY docs\/api \.\/docs\/api$/m, '契约类型须随阶段一起 COPY');
  assert.match(docker, /^COPY --from=web \/app\/web\/dist \.\/web\/dist$/m, '运行阶段取 /app/web/dist');
});
