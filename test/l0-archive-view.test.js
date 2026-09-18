'use strict';

/**
 * 会话归档视图的层级规则测试（设备 → agent → 会话 → 详情）。
 *
 * app.js 是浏览器脚本（无导出），这里用最小 DOM stub 在受控作用域里求值，
 * 只取渲染函数来验证层级行为。锁定的是"下钻顺序"这一明确需求：
 *   - 未选设备：只有设备列表，agent/会话卡都不出现
 *   - 选了设备：出现该设备的 agent 列表，会话列表仍不出现
 *   - 再选 agent：才出现会话列表，且只含该 agent 的会话
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/** 建一个带 classList 状态的 DOM stub，用于断言卡片的显隐 */
function harness() {
  const nodes = {};
  const mkEl = (id) => {
    const cls = new Set();
    return {
      id,
      _html: '',
      textContent: '',
      dataset: {},
      _cls: cls,
      set innerHTML(v) { this._html = String(v); },
      get innerHTML() { return this._html; },
      classList: {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        toggle: (c, f) => { f ? cls.add(c) : cls.delete(c); },
        contains: (c) => cls.has(c),
      },
      addEventListener() {},
      focus() {},
      querySelectorAll() { return []; },
      querySelector() { return null; },
      closest() { return mkEl('x'); },
      scrollIntoView() {},
    };
  };

  global.document = {
    querySelector(s) { const id = String(s).replace(/^#/, ''); return nodes[id] || (nodes[id] = mkEl(id)); },
    querySelectorAll() { return []; },
    getElementById(id) { return nodes[id] || (nodes[id] = mkEl(id)); },
    createElement() {
      return {
        textContent: '',
        get innerHTML() {
          return String(this.textContent).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        },
      };
    },
    documentElement: { dataset: {} },
    body: { appendChild() {}, removeChild() {} },
  };
  global.window = { location: { search: '?logged=1', href: '', origin: 'http://x' }, isSecureContext: false };
  global.history = { replaceState() {} };
  global.location = global.window.location;
  global.URLSearchParams = URLSearchParams;

  // Node 内置的 navigator/localStorage/sessionStorage 是只读 getter，需用 defineProperty 覆盖
  const define = (name, value) => {
    try {
      Object.defineProperty(global, name, { value, configurable: true, writable: true });
    } catch {
      // 覆盖失败（不应发生）→ 该全局在本测试里非必需，忽略
    }
  };
  define('navigator', {});
  define('localStorage', { getItem() { return null; }, setItem() {} });
  define('sessionStorage', { getItem() { return null; }, setItem() {}, removeItem() {} });

  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'static', 'app.js'), 'utf8');
  const sb = {};
  // eslint-disable-next-line no-eval
  eval(src + '\n; sb.renderDevices=renderDevices; sb.renderAgents=renderAgents; '
    + 'sb.renderArchiveSessions=renderArchiveSessions; sb.aggregateAgents=aggregateAgents; '
    + 'sb.agentLabel=agentLabel; sb.fmtBytes=fmtBytes; sb.filter=archiveFilter; sb.esc=esc;');

  // 未渲染过的卡片视为隐藏（节点尚未创建 = 界面上不存在）
  const visible = (id) => !!nodes[id] && !nodes[id]._cls.has('hidden');
  const html = (id) => (nodes[id] ? nodes[id]._html : '');
  const text = (id) => (nodes[id] ? nodes[id].textContent : '');
  const count = (id, re) => (html(id).match(re) || []).length;

  return { sb, nodes, visible, html, text, count };
}

const DEVICES = [
  { device_code: 'dev_A', label: '笔记本', agents: ['codex'], info: { platform: 'darwin' }, sessions: 2, records: 20, bytes: 2000, last_seen: '2026-09-18T08:00:00Z' },
  { device_code: 'dev_B', label: '服务器', agents: ['zcode', 'codex'], info: { platform: 'linux' }, sessions: 3, records: 30, bytes: 3000, last_seen: '2026-09-18T09:00:00Z' },
];

const SESSIONS = [
  { agent: 'codex', session_id: 'a-c1', device_code: 'dev_A', records: 10, bytes: 1000, first_received: '2026-09-18T07:00:00Z', last_received: '2026-09-18T07:30:00Z' },
  { agent: 'codex', session_id: 'a-c2', device_code: 'dev_A', records: 10, bytes: 1000, first_received: '2026-09-18T07:40:00Z', last_received: '2026-09-18T07:50:00Z' },
  { agent: 'zcode', session_id: 'b-z1', device_code: 'dev_B', records: 10, bytes: 1000, first_received: '2026-09-18T08:10:00Z', last_received: '2026-09-18T08:20:00Z' },
  { agent: 'codex', session_id: 'b-c1', device_code: 'dev_B', records: 10, bytes: 1000, first_received: '2026-09-18T08:30:00Z', last_received: '2026-09-18T08:40:00Z' },
  { agent: 'codex', session_id: 'b-c2', device_code: 'dev_B', records: 10, bytes: 1000, first_received: '2026-09-18T08:45:00Z', last_received: '2026-09-18T08:50:00Z' },
];

const forDevice = (code) => SESSIONS.filter((s) => s.device_code === code);
const devicesFor = (code) => DEVICES.filter((d) => d.device_code === code);

test('层级1：未选设备时只显示设备列表，agent 与会话卡不出现', () => {
  const { sb, visible, count } = harness();
  sb.filter.device = null; sb.filter.agent = null;
  sb.renderDevices(DEVICES);
  sb.renderAgents(DEVICES, SESSIONS);
  sb.renderArchiveSessions(SESSIONS);

  assert.strictEqual(count('l0-devices', /data-device=/g), 2, '应渲染 2 台设备');
  assert.strictEqual(visible('l0-agents-card'), false, 'agent 卡不应出现');
  assert.strictEqual(visible('l0-sessions-card'), false, '会话卡不应出现');
});

test('层级2：选中设备后只出现该设备的 agent 列表，会话卡仍不出现', () => {
  const { sb, visible, count, text } = harness();
  sb.filter.device = 'dev_B'; sb.filter.agent = null;
  sb.renderDevices(devicesFor('dev_B'));
  sb.renderAgents(devicesFor('dev_B'), forDevice('dev_B'));
  sb.renderArchiveSessions(forDevice('dev_B'));

  assert.strictEqual(visible('l0-agents-card'), true, 'agent 卡应出现');
  assert.strictEqual(visible('l0-sessions-card'), false, '未选 agent，会话卡不应出现');
  assert.strictEqual(count('l0-agents', /data-agent=/g), 2, 'dev_B 有 2 个 agent');
  assert.ok(text('l0-agents-title').includes('服务器'), `标题应含设备名，实际：${text('l0-agents-title')}`);
});

test('层级3：选中 agent 后才出现会话列表，且只含该 agent 的会话', () => {
  const { sb, visible, count, text, html } = harness();
  sb.filter.device = 'dev_B'; sb.filter.agent = 'codex';
  sb.renderDevices(devicesFor('dev_B'));
  sb.renderAgents(devicesFor('dev_B'), forDevice('dev_B'));
  sb.renderArchiveSessions(forDevice('dev_B'));

  assert.strictEqual(visible('l0-sessions-card'), true, '会话卡应出现');
  assert.strictEqual(count('l0-sessions', /data-session=/g), 2, 'dev_B 的 codex 有 2 个会话');
  assert.ok(text('l0-sessions-title').includes('Codex'), `标题应是 Codex，实际：${text('l0-sessions-title')}`);
  assert.ok(!html('l0-sessions').includes('b-z1'), '不应出现 zcode 的会话');
});

test('会话条目不串台：切到 zcode 只列 zcode 会话', () => {
  const { sb, count, html } = harness();
  sb.filter.device = 'dev_B'; sb.filter.agent = 'zcode';
  sb.renderDevices(devicesFor('dev_B'));
  sb.renderAgents(devicesFor('dev_B'), forDevice('dev_B'));
  sb.renderArchiveSessions(forDevice('dev_B'));

  assert.strictEqual(count('l0-sessions', /data-session=/g), 1, 'dev_B 的 zcode 只有 1 个会话');
  assert.ok(html('l0-sessions').includes('b-z1'));
  assert.ok(!html('l0-sessions').includes('b-c1'), '不应混入 codex 的会话');
});

test('agent 聚合：按会话数/条数汇总，且按最近时间倒序', () => {
  const { sb } = harness();
  const ag = sb.aggregateAgents(forDevice('dev_B'));
  const byName = Object.fromEntries(ag.map((a) => [a.agent, a]));
  assert.strictEqual(byName.codex.sessions, 2);
  assert.strictEqual(byName.codex.records, 20);
  assert.strictEqual(byName.zcode.sessions, 1);
  assert.strictEqual(byName.zcode.records, 10);
  // b-c2 最新（08:50）> b-z1（08:20）→ codex 应排前
  assert.strictEqual(ag[0].agent, 'codex', '应按最近活跃倒序');
});

test('切换设备时下级选择被清空（agent 与设备强绑定）', () => {
  const { sb, visible, nodes } = harness();
  sb.filter.device = 'dev_A'; sb.filter.agent = 'codex';
  // 用户切到另一台设备后，agent 必须被清空——否则会把 A 机的 agent 当成 B 机的选择。
  // （真实点击路径见 renderDevices 的 onclick：切设备时置 agent=null 并隐藏下级卡片。）
  sb.filter.device = 'dev_B'; sb.filter.agent = null;
  sb.renderDevices(devicesFor('dev_B'));
  sb.renderAgents(devicesFor('dev_B'), forDevice('dev_B'));
  sb.renderArchiveSessions(forDevice('dev_B'));

  assert.strictEqual(visible('l0-agents-card'), true, '换设备后应显示新设备的 agent 列表');
  assert.strictEqual(visible('l0-sessions-card'), false, '换设备后会话卡应隐藏，等待重选 agent');
  assert.ok(!nodes['l0-agents']._html.includes('undefined'), 'agent 名不应出现 undefined');
});
