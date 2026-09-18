'use strict';

/**
 * L3 凝练测试：解析容错、supersede 校验、游标语义、幂等与「宁缺毋滥」。
 *
 * 关键验收：
 * - 攒不够新会话不跑（低频是硬要求，省 token）；
 * - LLM 失败 / 输出不可解析 → 游标不动（宁可重来不跳过）；
 * - 空输出 [] → 游标推进（这批摘要已消化，不重跑）；
 * - supersedes 只认本轮可见的条目 id（防幻觉 id 改历史）。
 *
 * LLM 全部 stub，0 token。独立临时库 + 独立临时 L3 目录。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aimemory-l3d-'));
process.env.AIMEMORY_DB = path.join(tmpRoot, 'test.db');
process.env.AIMEMORY_L3_DIR = path.join(tmpRoot, 'l3');
process.env.LLM_ENABLED = '1';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const db = require('../src/db');
const llm = require('../src/llm/client');
const l2store = require('../src/l2/store');
const l3store = require('../src/l3/store');
const { buildPrompt, parseOutput, applyOutput } = require('../src/l3/derive');
const scheduler = require('../src/l3/scheduler');

const u = config.userId;
const past = (min = 60) => new Date(Date.now() - min * 60_000).toISOString();

function stubLlmSeq(responses) {
  let i = 0;
  llm.complete = async () => responses[Math.min(i++, responses.length - 1)];
}

let seq = 0;
/** 造一条「L1 摘要 done + L2 派生 done」链（L3 的输入形态） */
function mkConsumed({ sessionId = `s${++seq}`, overview = `会话${sessionId}的目标与结论`, updatedAt = past() } = {}) {
  const ts = updatedAt;
  db.prepare(
    `INSERT INTO l1_summaries (user_id, device_code, agent, session_id, status, overview, decisions, pending, artifacts, created_at, updated_at)
     VALUES (?, 'dev1', 'zcode', ?, 'done', ?, '["决定X"]', '[]', '["产出Y"]', ?, ?)`
  ).run(u, sessionId, overview, ts, ts);
  db.prepare(
    `INSERT INTO l2_sources (user_id, device_code, agent, session_id, status, added, created_at, updated_at)
     VALUES (?, 'dev1', 'zcode', ?, 'done', 2, ?, ?)`
  ).run(u, sessionId, ts, ts);
  return { sessionId, updatedAt };
}

before(() => {});
after(() => {
  db.close();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  for (const t of ['l1_summaries', 'l2_sources', 'l3_state', 'memories']) db.prepare(`DELETE FROM ${t}`).run();
  try { fs.rmSync(config.l3Dir, { recursive: true, force: true }); } catch {}
});

// ============ 一、parseOutput ============

test('parseOutput：容错 markdown 围栏；非法 kind / 空 text 跳过', () => {
  const out = parseOutput(
    '```json\n[{"kind":"constraints","text":"约束A"},{"kind":"nope","text":"x"},{"kind":"profile","text":""},{"kind":"lessons","text":"教训B","confidence":2}]\n```',
    { existingIds: new Set() }
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'constraints');
  assert.equal(out[1].confidence, 1, 'confidence 应被夹到 0-1');
});

test('parseOutput：supersedes 只认本轮可见的条目 id（防幻觉改历史）', () => {
  const out = parseOutput(
    '[{"kind":"profile","text":"新表述","supersedes":"真实id"},{"kind":"profile","text":"另一个","supersedes":"幻觉id"}]',
    { existingIds: new Set(['真实id']) }
  );
  assert.equal(out[0].supersedes, '真实id');
  assert.equal(out[1].supersedes, null);
});

test('parseOutput：非 JSON → null（调用方游标不动）', () => {
  assert.equal(parseOutput('我觉得没有值得沉淀的', { existingIds: new Set() }), null);
});

// ============ 二、applyOutput ============

test('applyOutput：追加 + supersede 生效', () => {
  const oldId = l3store.appendEntry({ kind: 'profile', text: '旧偏好' });
  const r = applyOutput(
    [{ kind: 'profile', text: '新偏好', supersedes: oldId, confidence: 0.9 }, { kind: 'lessons', text: '独立教训', supersedes: null }],
    { source: 'l1:zcode/s1' }
  );
  assert.equal(r.added, 2);
  assert.equal(r.superseded, 1);
  const active = l3store.listEntries({ kind: 'profile' });
  assert.equal(active.length, 1);
  assert.equal(active[0].text, '新偏好');
  assert.equal(l3store.getEntry(oldId).superseded_by, active[0].id);
  assert.equal(l3store.getEntry(active[0].id).source, 'l1:zcode/s1', '来源可溯');
});

// ============ 三、调度：触发阈值 / 游标 / 幂等 ============

test('tick：新会话不足时不跑（低频省 token），LLM 零调用', async () => {
  mkConsumed({}); // 只有 1 个，阈值默认 5
  let called = 0;
  llm.complete = async () => { called += 1; return '[]'; };
  const r = await scheduler.tick();
  assert.equal(r.skipped.includes('不足'), true);
  assert.equal(called, 0);
  assert.equal(scheduler.getCursor(), null, '游标不该动');
});

test('tick：攒够阈值 → 凝练入库并推进游标；再跑一轮不重复（幂等）', async () => {
  for (let i = 0; i < 5; i++) mkConsumed({ sessionId: `s${i}` });
  stubLlmSeq(['[{"kind":"constraints","text":"测试约束","confidence":0.7}]']);
  const r1 = await scheduler.tick();
  assert.equal(r1.consumed, 5);
  assert.equal(r1.added, 1);
  assert.ok(scheduler.getCursor(), '游标应推进');

  let called = 0;
  llm.complete = async () => { called += 1; return '[]'; };
  const r2 = await scheduler.tick();
  assert.ok(r2.skipped, '消化完应不再触发');
  assert.equal(called, 0);
  assert.equal(l3store.listEntries({}).length, 1, '不重复凝练');
});

test('tick：LLM 失败 / 输出不可解析 → 游标不动，下轮重试', async () => {
  for (let i = 0; i < 5; i++) mkConsumed({});
  llm.complete = async () => null;
  let r = await scheduler.tick();
  assert.ok(r.skipped.includes('LLM'));
  assert.equal(scheduler.getCursor(), null);

  stubLlmSeq(['这不是 JSON']);
  r = await scheduler.tick();
  assert.ok(r.skipped.includes('不可解析'));
  assert.equal(scheduler.getCursor(), null);
  assert.equal(l3store.listEntries({}).length, 0, '失败时不落任何条目');
});

test('tick：空输出 [] 是合法结果 → 游标照常推进（宁缺毋滥）', async () => {
  for (let i = 0; i < 5; i++) mkConsumed({});
  stubLlmSeq(['[]']);
  const r = await scheduler.tick();
  assert.equal(r.consumed, 5);
  assert.equal(r.added, 0);
  assert.ok(scheduler.getCursor(), '空产出也要推进游标，否则永远重跑');
});

test('tick：supersedes 让旧条目被取代（跨轮演化）', async () => {
  const oldId = l3store.appendEntry({ kind: 'constraints', text: '端口 18543' });
  for (let i = 0; i < 5; i++) mkConsumed({});
  stubLlmSeq([`[{"kind":"constraints","text":"端口改为 18544","supersedes":"${oldId}"}]`]);
  const r = await scheduler.tick();
  assert.equal(r.added, 1);
  assert.equal(r.superseded, 1);
  const active = l3store.listEntries({ kind: 'constraints' });
  assert.equal(active.length, 1);
  assert.equal(active[0].text, '端口改为 18544');
});

test('collectInput：L2 事实采样近更新优先、直读库（零 LLM）', () => {
  const u = config.userId;
  l2store.insertFact({ userId: u, text: '采样背景事实 A', metadata: {} });
  l2store.insertFact({ userId: u, text: '采样背景事实 B', metadata: {} });
  const { facts } = scheduler.collectInput({ force: true });
  assert.ok(Array.isArray(facts) && facts.length >= 2);
  assert.ok(facts.some((f) => f.includes('采样背景事实')));
  assert.ok(facts.length <= config.l3.maxFactsSample, '不超过采样上限');
});

test('手动 force：无新增也取最近会话跑（便于验收/演示）', async () => {
  mkConsumed({ sessionId: 'only-1' });
  stubLlmSeq(['[{"kind":"lessons","text":"force 触发的教训"}]']);
  const r = await scheduler.tick({ force: true });
  assert.equal(r.consumed, 1);
  assert.equal(r.added, 1);
});

test('buildPrompt：包含摘要与已有条目，且带「宁缺毋滥」约束', () => {
  const msgs = buildPrompt({
    summaries: [{ agent: 'zcode', session_id: 'abc', overview: '目标', decisions: '["D"]', artifacts: '[]' }],
    entries: [{ id: 'e1', kind: 'profile', text: '已有画像' }],
  });
  const text = msgs.map((m) => m.content).join('\n');
  assert.ok(text.includes('[S1]'), '摘要应编号进入 prompt');
  assert.ok(text.includes('[E:e1]'), '已有条目应进入 prompt 供取代判定');
  assert.ok(text.includes('宁缺毋滥'));
});

test('buildPrompt：L2 事实采样作为背景进入 prompt，且带「不得照抄」约束与裁剪', () => {
  const long = '这是一条非常长的 L2 事实，用来验证单条裁剪是否生效，后面全是填充内容'.repeat(3);
  const msgs = buildPrompt({
    summaries: [{ agent: 'zcode', session_id: 'abc', overview: '目标', decisions: '[]', artifacts: '[]' }],
    entries: [],
    facts: ['背景事实甲', long],
  });
  const user = msgs[1].content;
  assert.ok(user.includes('[B1] 背景事实甲'), '事实采样应编号进入 prompt');
  assert.ok(user.includes('不要直接抄进条目'), '必须声明仅作背景');
  assert.ok(!user.includes(long), '超长事实应被裁剪');
  assert.ok(msgs[0].content.includes('不得照抄事实原文'), 'system 侧也要约束');
  const noFacts = buildPrompt({ summaries: [], entries: [], facts: [] });
  assert.ok(!noFacts[1].content.includes('[B1]'), '无采样时不出现事实段');
});
