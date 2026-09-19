'use strict';

/**
 * 管理台前端（web/）的纯逻辑守护：Node 原生类型擦除直接 require .ts 模块。
 * 锁住的是「层级下钻」这一明确需求（原 test/l0-archive-view.test.js 用 DOM stub 验的东西）：
 *   - 未选设备：agent 卡与会话卡都不出现
 *   - 选了设备：出现 agent 卡，会话卡仍不出现
 *   - 再选 agent：会话卡才出现，且只含该 agent 的会话
 *   - 换设备必须清空 agent（否则把 A 机的 agent 当成 B 机的筛选）
 * 以及展示格式与 MCP 配置生成的三种 Token 状态。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'web', 'src', 'lib');
const archive = require(path.join(LIB, 'archive.ts'));
const format = require(path.join(LIB, 'format.ts'));
const mcp = require(path.join(LIB, 'mcp-config.ts'));

const SESSIONS = [
  { agent: 'codex', session_id: 'a-c1', device_code: 'dev_A', records: 10, bytes: 1000, first_received: '2026-09-18T07:00:00Z', last_received: '2026-09-18T07:30:00Z' },
  { agent: 'codex', session_id: 'a-c2', device_code: 'dev_A', records: 10, bytes: 1000, first_received: '2026-09-18T07:40:00Z', last_received: '2026-09-18T07:50:00Z' },
  { agent: 'zcode', session_id: 'b-z1', device_code: 'dev_B', records: 10, bytes: 1000, first_received: '2026-09-18T08:10:00Z', last_received: '2026-09-18T08:20:00Z' },
  { agent: 'codex', session_id: 'b-c1', device_code: 'dev_B', records: 10, bytes: 1000, first_received: '2026-09-18T08:30:00Z', last_received: '2026-09-18T08:40:00Z' },
  { agent: 'codex', session_id: 'b-c2', device_code: 'dev_B', records: 10, bytes: 1500, first_received: '2026-09-18T08:45:00Z', last_received: '2026-09-18T08:50:00Z' },
];

const DEVICES = [
  { device_code: 'dev_A', label: '笔记本', agents: ['codex'], info: { platform: 'darwin' }, sessions: 2, records: 20, bytes: 2000, last_seen: '2026-09-18T08:00:00Z' },
  { device_code: 'dev_B', label: '服务器', agents: ['zcode', 'codex'], info: { platform: 'linux' }, sessions: 3, records: 30, bytes: 3500, last_seen: '2026-09-18T09:00:00Z' },
];

const forDevice = (code) => SESSIONS.filter((s) => s.device_code === code);

test('层级1：未选设备时 agent 卡与会话卡都不可见', () => {
  const shown = archive.layersVisible(archive.emptyFilter);
  assert.strictEqual(shown.agents, false);
  assert.strictEqual(shown.sessions, false);
  assert.deepStrictEqual(archive.visibleSessions(SESSIONS, archive.emptyFilter), [], '未选设备不应列出任何会话');
});

test('层级2：选中设备后出现 agent 层级，会话层级仍收起', () => {
  const f = archive.toggleDevice(archive.emptyFilter, 'dev_B');
  const shown = archive.layersVisible(f);
  assert.strictEqual(shown.agents, true);
  assert.strictEqual(shown.sessions, false);
  assert.strictEqual(archive.aggregateAgents(forDevice('dev_B')).length, 2, 'dev_B 有 2 个 agent');
  assert.strictEqual(archive.deviceName(DEVICES, 'dev_B'), '服务器', '标题用设备名而非设备码');
});

test('层级3：选中 agent 后才会话列表出现，且只含该 agent 的会话', () => {
  let f = archive.toggleDevice(archive.emptyFilter, 'dev_B');
  f = archive.toggleAgent(f, 'codex');
  assert.strictEqual(archive.layersVisible(f).sessions, true);
  const rows = archive.visibleSessions(forDevice('dev_B'), f);
  assert.strictEqual(rows.length, 2, 'dev_B 的 codex 有 2 个会话');
  assert.ok(!rows.some((r) => r.session_id === 'b-z1'), '不应混入 zcode 的会话');
});

test('会话条目不串台：切到 zcode 只列 zcode 会话', () => {
  let f = archive.toggleDevice(archive.emptyFilter, 'dev_B');
  f = archive.toggleAgent(f, 'codex');
  f = archive.toggleAgent(f, 'zcode');
  const rows = archive.visibleSessions(forDevice('dev_B'), f);
  assert.deepStrictEqual(rows.map((r) => r.session_id), ['b-z1']);
});

test('切换设备时下级选择被清空（agent 与设备强绑定）', () => {
  let f = archive.toggleDevice(archive.emptyFilter, 'dev_A');
  f = archive.toggleAgent(f, 'codex');
  assert.strictEqual(f.agent, 'codex');
  f = archive.toggleDevice(f, 'dev_B');
  assert.strictEqual(f.device, 'dev_B');
  assert.strictEqual(f.agent, null, '换设备后 agent 必须清空，否则会把 A 机的 agent 当成 B 机的筛选');
  assert.strictEqual(archive.layersVisible(f).sessions, false, '换设备后会话层级应收起，等待重选 agent');
});

test('再点同一设备/agent 收起本级选择', () => {
  let f = archive.toggleDevice(archive.emptyFilter, 'dev_B');
  f = archive.toggleDevice(f, 'dev_B');
  assert.strictEqual(f.device, null, '再点同一设备收起');
  f = archive.toggleDevice(archive.emptyFilter, 'dev_B');
  const g = archive.toggleAgent(archive.toggleAgent(f, 'codex'), 'codex');
  assert.strictEqual(g.agent, null, '再点同一 agent 收起');
  assert.strictEqual(g.device, 'dev_B', '收起 agent 不影响已选设备');
});

test('agent 聚合：按会话数/条数汇总，且按最近时间倒序', () => {
  const ag = archive.aggregateAgents(forDevice('dev_B'));
  const byName = Object.fromEntries(ag.map((a) => [a.agent, a]));
  assert.strictEqual(byName.codex.sessions, 2);
  assert.strictEqual(byName.codex.records, 20);
  assert.strictEqual(byName.zcode.sessions, 1);
  assert.strictEqual(byName.zcode.records, 10);
  assert.strictEqual(ag[0].agent, 'codex', 'b-c2 最新（08:50）应排在 zcode（08:20）之前');
  assert.strictEqual(byName.codex.bytes, 2500);
});

test('空聚合不报错（新设备尚无会话）', () => {
  assert.deepStrictEqual(archive.aggregateAgents([]), []);
  assert.strictEqual(archive.totalBytes([]), 0);
});

test('展示格式：字节 / 时间 / agent 名 / 角色名', () => {
  assert.strictEqual(format.fmtBytes(0), '0 B');
  assert.strictEqual(format.fmtBytes(999), '999 B');
  assert.strictEqual(format.fmtBytes(2048), '2.0 KB');
  assert.strictEqual(format.fmtBytes(5 * 1024 * 1024), '5.0 MB');
  assert.strictEqual(format.fmtBytes(3 * 1024 * 1024 * 1024), '3.0 GB');
  assert.strictEqual(format.fmtBytes(null), '0 B');
  assert.strictEqual(format.fmtTime(null), '—');
  assert.strictEqual(format.fmtTime('not-a-date'), 'not-a-date', '无法解析的时间原样返回，不显示 Invalid Date');
  assert.strictEqual(format.fmtCompactTime('2026-09-19T04:12:33Z'), '09-19 04:12');
  assert.strictEqual(format.agentLabel('codex'), 'Codex');
  assert.strictEqual(format.agentLabel('claude'), 'Claude Code');
  assert.strictEqual(format.agentLabel('custom-agent'), 'custom-agent', '未知 agent 原样显示');
  assert.strictEqual(format.roleLabel('user'), '用户');
  assert.strictEqual(format.roleLabel(undefined), '元信息');
  assert.strictEqual(format.fingerprintLabel('machine-id'), '系统安装标识');
  assert.strictEqual(format.fingerprintLabel('weird'), 'weird');
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
