'use strict';

/**
 * L1 会话摘要：把 L0 归档的一个会话压成「情景记忆」。
 *
 * 定位：L0 是事实源（append-only），L1 是它的**可再生派生视图**——
 * 想换摘要算法，把 l1_summaries 的 content_hash 清掉重跑即可，不丢任何原始数据。
 *
 * 三个关键处理：
 *
 * 1. **按 rid + version 收敛**（必须）：L0 允许同一记录被观察多次，ZCode 还会原地
 *    更新内容（version 递增）。摘要必须用每个 rid 的最大 version，否则可能摘要到
 *    「写了一半」的内容。
 *
 * 2. **预算化压缩**（实测必需）：单会话平均 299K 字符、最大 4.6M，远超 LLM 上下文；
 *    且 tool 输出与 reasoning 占大头（某会话 7106 条里 3788 条是 tool）。摘要真正
 *    需要的是「用户要什么 + 助手决定了什么 + 用了哪些工具」，故按优先级装配：
 *    user 全文 > assistant 正文 > tool 仅名字 > reasoning 丢弃。
 *    超预算时保留头部与尾部（开头交代目标、结尾交代结果），中间采样。
 *
 * 3. **只认归档文件**：不碰 agent 的原始数据源，这样 L1 可以离线重跑。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const repo = require('../db/repo');
const llm = require('../llm/client');

/** 摘要输入预算（字符）：中文约 1 字符 ≈ 1 token，留足输出空间避免撑爆上下文 */
const DIGEST_BUDGET = config.l1.digestBudget;
/** 单条 user/assistant 消息的裁剪上限 */
const USER_CLIP = 600;
const ASSISTANT_CLIP = 400;
/**
 * 摘要输出上限。
 * 实测：本项目的 LLM（qwen 系列思考模型）在大输入下会先消耗约 5000 token 思考，
 * 若上限设 1500 会让 finish_reason=length、content 为空（只产出 reasoning），
 * 摘要直接失败。8000 可覆盖「思考 + 正文」，单会话耗时约 90 秒。
 */
const SUMMARY_MAX_TOKENS = config.l1.maxTokens;
/** 摘要调用超时：大输入 + 思考模型约需 90s，默认 30s 会超时（实测） */
const SUMMARY_TIMEOUT_MS = config.l1.timeoutMs;

// ============ 读取与收敛 ============

/** 归档文件路径（与 l0/store.js 的布局保持一致） */
function sessionFile(userId, deviceCode, agent, sessionId) {
  const seg = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 120) || '_';
  return path.join(config.l0Dir, seg(userId), seg(deviceCode), seg(agent), `${seg(sessionId)}.jsonl`);
}

/**
 * 读取并收敛一个会话：同一 rid 取最大 version，按时间/序号排序。
 * @returns {{records: object[], first_ts: string|null, last_ts: string|null}|null}
 */
function loadConverged(userId, deviceCode, agent, sessionId) {
  const file = sessionFile(userId, deviceCode, agent, sessionId);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // 文件不在（归档被清理）——调用方据此标记失败
  }

  const byRid = new Map();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let d;
    try { d = JSON.parse(t); } catch { continue; } // 坏行跳过，不阻断
    const rid = d.rid;
    if (!rid) continue;
    const ver = Number(d.version) || 0;
    const prev = byRid.get(rid);
    // 收敛：同一 rid 保留 version 最大的那条（L0 允许重复观察，这里取最终态）
    if (!prev || ver >= (Number(prev.version) || 0)) byRid.set(rid, d);
  }

  const records = [...byRid.values()].sort((a, b) => {
    const ta = String(a.ts || '');
    const tb = String(b.ts || '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (Number(a.seq) || 0) - (Number(b.seq) || 0);
  });

  const ts = records.map((r) => r.ts).filter(Boolean).sort();
  return { records, first_ts: ts[0] || null, last_ts: ts[ts.length - 1] || null };
}

// ============ 预算化压缩 ============

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s*\n\s*/g, '\n').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 是否为「系统注入」而非用户真实输入。
 *
 * 为什么必须过滤（实测）：归档里 56% 的 user 记录是 agent 客户端塞进来的系统内容
 * （TodoWrite 提醒、system-reminder 块、工具结果回显等），不是用户的诉求。
 * 不过滤的话摘要会把这些提醒当成"用户想要什么"，直接失真。
 *
 * 判定取开头特征而非全文包含——真实用户消息里也可能引用这些字样。
 */
const NOISE_PREFIXES = [
  /^The TodoWrite tool hasn't been used/i,
  /^<system-reminder>/i,
  /^<command-name>/i,
  /^<local-command-/i,
  /^\[SYSTEM\]/i,
  /^\{\s*"(chunk_id|output|stdout|stderr|exit_code|tool_call_id)"/,
  /^Tool ran without output/i,
  /^<tool_result/i,
  /^<function_results/i,
  /^Caveat: The messages below were generated/i, // 上下文压缩占位
  /^<task-notification>/i,   // 子任务回调
  /^<tool-use-id>/i,
  /^<output-file>/i,
  /^\[Request interrupted/i,
];

function isInjectedNoise(text) {
  const t = String(text || '').trim();
  if (t.length < 2) return true;
  return NOISE_PREFIXES.some((re) => re.test(t));
}

/**
 * 把收敛后的记录压成可喂 LLM 的文本。
 * 超预算时保留头尾、中间采样（开头是目标、结尾是结果，这两段信息量最大）。
 */
function buildDigest(records) {
  const users = [];
  const assistants = [];
  const tools = [];
  let noiseSkipped = 0;

  for (const r of records) {
    const role = r.role;
    const content = r.content || '';
    const meta = r.meta || {};
    if (role === 'user') {
      if (isInjectedNoise(content)) { noiseSkipped += 1; continue; }
      users.push(clip(content, USER_CLIP));
    } else if (role === 'assistant') {
      if (content.trim()) assistants.push(clip(content, ASSISTANT_CLIP));
    } else if (role === 'tool') {
      // 工具只看名字与调用/输出标记——输出内容对"这个会话干了什么"贡献有限却极占空间
      const name = meta.tool || meta.kind || 'tool';
      const kind = meta.kind === 'output' ? '↳' : '→';
      tools.push(`${kind} ${name}`);
    }
    // reasoning 丢弃：模型内部思考，非会话事实
  }

  const parts = [];
  // 标注过滤量：便于人工核对摘要是否基于真实用户诉求（不是 56% 的系统提醒）
  parts.push(`用户消息（${users.length} 条${noiseSkipped ? `，已滤除 ${noiseSkipped} 条系统注入内容` : ''}）：`);
  parts.push(users.map((u, i) => `[${i + 1}] ${u}`).join('\n'));

  // 工具序列压缩：连续同名合并计数（3788 条 → 往往只剩几十行）
  if (tools.length) {
    const compact = [];
    for (const t of tools) {
      const last = compact[compact.length - 1];
      if (last && last.name === t) last.n += 1;
      else compact.push({ name: t, n: 1 });
    }
    parts.push(`\n工具调用序列（${tools.length} 次，合并同名）：`);
    parts.push(compact.map((t) => (t.n > 1 ? `${t.name} ×${t.n}` : t.name)).join('  '));
  }

  parts.push(`\n助手回复（${assistants.length} 条）：`);
  parts.push(assistants.map((a, i) => `[${i + 1}] ${a}`).join('\n'));

  let digest = parts.join('\n');

  // 超预算：保留头 60% + 尾 40%（开头交代目标，结尾交代结果）——中间采样而非硬截断
  if (digest.length > DIGEST_BUDGET) {
    const head = Math.floor(DIGEST_BUDGET * 0.6);
    const tail = DIGEST_BUDGET - head - 40;
    digest = `${digest.slice(0, head)}\n\n…（中间省略 ${digest.length - head - tail} 字符）…\n\n${digest.slice(-tail)}`;
  }
  return digest;
}

/** 内容指纹：用于判断会话是否变化（变了才重新摘要） */
function contentHash(converged) {
  const h = crypto.createHash('sha256');
  // 只对收敛后的 rid+version 集合做指纹，不哈希全文（大文件哈希慢且没必要）
  for (const r of converged.records) h.update(`${r.rid}\u0000${Number(r.version) || 0}\u0000`);
  return h.digest('hex').slice(0, 32);
}

// ============ 摘要生成 ============

function buildPrompt(agent, digest, stats) {
  return [
    {
      role: 'system',
      content:
        '你是会话归档的摘要助手。根据一个 AI 编程会话的记录，提炼结构化摘要，供日后快速回忆"这个会话做了什么"。\n'
        + '只依据给定内容，不要推测或编造。若信息不足，相应字段留空数组或简短说明。\n'
        + '输出严格的 JSON（不要 markdown 代码块、不要额外文字），字段：\n'
        + '{\n'
        + '  "overview": "2-4 句话概述这个会话的目标与结果",\n'
        + '  "decisions": ["关键决定/结论，每条一句"],\n'
        + '  "pending": ["未决事项或遗留问题，没有则空数组"],\n'
        + '  "artifacts": ["产出物：文件/提交/服务/文档等，尽量含具体名称"]\n'
        + '}',
    },
    {
      role: 'user',
      content:
        `会话来源：${agent}\n`
        + `时间跨度：${stats.first_ts || '未知'} ~ ${stats.last_ts || '未知'}\n`
        + `记录数：${stats.records}（已按版本收敛）\n\n`
        + `===== 会话内容（按预算压缩）=====\n${digest}`,
    },
  ];
}

/** 解析 LLM 输出为结构化摘要；容错 markdown 代码块与字段缺失 */
function parseSummary(text) {
  let s = String(text || '').trim();
  // 容错：模型常把 JSON 包在 ```json ``` 里
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // 容错：前后可能有解释性文字 → 取第一个 { 到最后一个 }
  const l = s.indexOf('{');
  const r = s.lastIndexOf('}');
  if (l >= 0 && r > l) s = s.slice(l, r + 1);

  let d = null;
  try { d = JSON.parse(s); } catch { /* 交给下面的降级 */ }

  const asList = (v) => {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return [];
  };

  if (!d || typeof d !== 'object') {
    // 解析不出 JSON → 判失败，不落库。
    // 为什么不像早期那样"把整段当概述"：实测当 max_tokens 不足时，模型会
    // finish_reason=length、content 为空，而 reasoning 兜底会把「思考碎片」
    // （如"artifacts：产出物包括…需列具体"）当正文返回——那正是复盘时看到的
    // 垃圾摘要。宁可失败重试（下一轮预算充足即成功），也不落这种内容。
    return { ok: false, raw: String(text || '').trim().slice(0, 300) };
  }
  const overview = String(d.overview || d.summary || '').trim();
  if (!overview) return { ok: false, raw: s.slice(0, 300) };
  return {
    ok: true,
    overview: overview.slice(0, 2000),
    decisions: asList(d.decisions),
    pending: asList(d.pending),
    artifacts: asList(d.artifacts),
  };
}

/**
 * 摘要单个会话并入库。
 * @returns {{ok:boolean, skipped?:string, error?:string, summary?:object}}
 */
async function summarizeOne({ userId, deviceCode, agent, sessionId }) {
  // 源指纹：与调度器（repo.l1Sources）同源同式，必须取「读文件之前」的值。
  // 时序很关键：若先读文件再取指纹，摘要期间新到的记录会让指纹"看起来没变"，
  // 从而漏掉更新；先取指纹则是保守的——期间有新内容会被下一轮正确重摘。
  const sourceFp = repo.l1SourceFp(userId, { deviceCode, agent, sessionId });

  // 幂等保护：已摘过且源指纹未变 → 跳过。
  // 这同时让「多个进程/重复触发」变得无害（曾实测手动 tick 与常驻进程并发）。
  const existing = repo.getL1Summary(userId, { deviceCode, agent, sessionId });
  if (sourceFp && existing && existing.status === 'done' && existing.content_hash === sourceFp) {
    return { ok: true, skipped: '内容未变，已有最新摘要' };
  }

  const converged = loadConverged(userId, deviceCode, agent, sessionId);
  if (!converged) {
    repo.markL1Failed({ userId, deviceCode, agent, sessionId, error: '归档文件不存在（可能已被清理）', permanent: true });
    return { ok: false, error: '归档文件不存在' };
  }
  if (!converged.records.length) {
    repo.markL1Failed({ userId, deviceCode, agent, sessionId, error: '归档中没有可解析记录', permanent: true });
    return { ok: false, error: '归档为空' };
  }
  if (!llm.enabled()) return { ok: false, skipped: 'LLM 未启用' };

  const hash = sourceFp || contentHash(converged);
  const stats = {
    records: converged.records.length,
    first_ts: converged.first_ts,
    last_ts: converged.last_ts,
  };

  const digest = buildDigest(converged.records);
  const out = await llm.complete(buildPrompt(agent, digest, stats), {
    maxTokens: SUMMARY_MAX_TOKENS,
    temperature: 0,
    timeoutMs: SUMMARY_TIMEOUT_MS,
  });
  if (!out) {
    // LLM 失败（含熔断）→ 记一次尝试，等下一轮重试（不丢任务）
    repo.markL1Failed({ userId, deviceCode, agent, sessionId, error: 'LLM 调用失败或熔断中' });
    return { ok: false, error: 'LLM 调用失败' };
  }

  const summary = parseSummary(out);
  if (!summary.ok) {
    repo.markL1Failed({
      userId, deviceCode, agent, sessionId,
      error: `摘要输出不是有效 JSON（可能 token 预算不足）：${String(summary.raw || '').slice(0, 120)}`,
    });
    return { ok: false, error: '输出格式无效' };
  }
  repo.saveL1Summary({
    userId, deviceCode, agent, sessionId,
    contentHash: hash,
    ...stats,
    ...summary,
    model: config.llm.model,
  });
  return { ok: true, summary };
}

module.exports = {
  loadConverged, buildDigest, contentHash, parseSummary, summarizeOne, sessionFile,
  isInjectedNoise, DIGEST_BUDGET,
};
