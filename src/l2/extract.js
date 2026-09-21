'use strict';

/**
 * 素材提炼管线（LLM 域）：提炼 → 标注 → 消解入库。
 * 从 events 队列域拆出（2026-09-20 模块治理）：events 只管任务队列的受理/轮询/状态，
 * 本模块只管"一段素材如何变成已入库的记忆"。队列 worker（events.processEvent）调用 processMemoryMaterial。
 * 对测试友好：llm 客户端是单例对象引用，stub complete 即可覆盖提炼与标注两条路径。
 */

const config = require('../config');
const llm = require('../llm/client');
const memories = require('../db/repo/memories');

/**
 * LLM 提炼：把一段素材（对话拼接文本或单条原文）提炼成多条独立、自包含、可复用的记忆陈述。
 * 返回字符串数组；LLM 不可用/无有效产出返回 []（调用方据此判失败，不回退存原文）。
 */
async function extractMemories(source) {
  const content = await llm.complete([
    {
      role: 'system',
      content: '你是记忆提炼助手。把下面的内容提炼成多条独立的、可复用的完整事实陈述。要求：1) 每条必须是完整句子，自包含、带明确主语，不得省略主语（如"10.10.10.214 上运行 X 服务"而不是"上运行 X 服务"）；2) 每条用一行输出，不要编号、不要前缀、不要解释；3) 合并同主题，拆开不同主题，每条都是独立可检索的事实；4) 保留关键信息（IP、端口、地址、人名、数字、决策、偏好、技术细节）；5) 丢弃与事实无关的寒暄/过程性内容，不猜测、不添加原文没有的信息；\n'
        + '   6) 长期价值硬门槛（宁缺毋滥）：只保留同时满足『跨会话仍有用』『是事实而非过程』『自包含可被检索』的陈述。\n'
        + '      明确丢弃：任务/待办状态（如"XX 已完成、XX 进行中"）、一次性指令（如"用户要求部署 X"）、本次会话的操作过程、寒暄、以及随时能从代码/文档/归档里查到的过程性细节。\n'
        + '      无法提炼出任何值得长期记住的事实时输出空——空是正确答案，不要硬凑。',
    },
    { role: 'user', content: `素材：\n${source.slice(0, 6000)}` },
  ], { maxTokens: 2048, temperature: 0.1 });

  if (!content) return [];
  return content
    .split('\n')
    .map((l) => l.replace(/^[-*•\d.\s]+/, '').trim())
    // 质量门槛：过短残句不视为可复用记忆（过滤超时截断的碎片）
    .filter((l) => l.length >= 10)
    .slice(0, 20);
}

/**
 * 批量实体/分类标注（对齐 mem0 平台的 entities + categories）：一次 LLM 调用给整批事实打标。
 * 返回与 facts 等长的 [{entities:[], categories:[]}]；LLM 不可用/输出不可解析返回 null
 * （标注是增强不是门槛，失败绝不阻断入库）。
 */
async function classifyFacts(facts) {
  if (!facts.length) return [];
  const content = await llm.complete([
    {
      role: 'system',
      content: [
        '你是记忆标注助手。对输入的多条记忆事实逐条标注实体与分类，只输出 JSON 数组，不要解释、不要 markdown 代码块：',
        '[{"entities":["..."],"categories":["..."],"importance":7}, ...]',
        '数组长度必须与输入条数一致、顺序一一对应。',
        'entities：从该条事实里抽取的专有名词实体（产品/技术/人名/组织/主机名/IP/端口/路径/版本号等），保持原文写法，最多 5 个，去重；没有给空数组。',
        'categories：1~2 个小写英文类别词，从这些候选里选最贴近的：tech, devops, network, deploy, project, work, preference, contact, schedule, finance, learning, other。',
        'importance：长期价值评分 1~10 整数（10=核心长期事实：身份/关键环境/重大决策/明确的用户要求；1=纯日常与瞬态过程）。'
        + '评分口径：跨会话仍有用、丢了会造成重复劳动或信息缺失的 ≥6；稳定的环境/接口/偏好事实 4~7；任务状态、一次性操作、过程性细节 ≤3。',
      ].join('\n'),
    },
    { role: 'user', content: JSON.stringify(facts.map((f) => String(f).slice(0, 300))) },
    // 思考模型会把预算烧在 reasoning 上：批量标注的 JSON 输出需要更大额度，否则截断不可解析
  ], { maxTokens: 4096, temperature: 0 });

  const empty = facts.map(() => ({ entities: [], categories: [] }));
  if (!content) return null;
  let s = String(content).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const l = s.indexOf('[');
  const r = s.lastIndexOf(']');
  if (l < 0 || r <= l) return null;
  let arr;
  try { arr = JSON.parse(s.slice(l, r + 1)); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  return facts.map((_, i) => {
    const raw = arr[i];
    if (!raw || typeof raw !== 'object') return empty[i];
    const imp = Number(raw.importance);
    return {
      entities: Array.isArray(raw.entities) ? raw.entities.filter((e) => typeof e === 'string') : [],
      categories: Array.isArray(raw.categories) ? raw.categories.filter((c) => typeof c === 'string') : [],
      importance: Number.isInteger(imp) ? Math.max(1, Math.min(imp, 10)) : null,
    };
  });
}

/**
 * 后台执行素材提炼入库（events 队列 worker 调用，不阻塞调用方）。
 * kind='messages'：input 为 [{role,content}] → 拼成对话文本；kind='text'：input 为原文。
 * 流程：LLM 提炼成事实 → 实体/分类标注 → **与已有记忆冲突消解**（ADD/UPDATE/DELETE/NOOP）→ 入库。
 * 提炼无产物/失败 → 抛错（调用方标记事件 failed，素材不落库）；
 * 消解失败则降级为纯追加，绝不让事实丢失。
 */
async function processMemoryMaterial({ userId, kind, input, metadata = {}, agentId = null, runId = null }) {
  const source = kind === 'messages' && Array.isArray(input)
    ? input.map((m) => `${m.role}: ${m.content}`).join('\n')
    : String(input || '');
  if (!source.trim()) throw new Error('素材为空');
  let extracted = await extractMemories(source);
  if (!extracted.length) throw new Error('LLM 未能从素材提炼出有效记忆（无产物，素材未入库）');
  // 实体/分类/重要性标注：增强性质，失败不阻断入库（classifications 传 null 由消解层兼容）
  let classifications = await classifyFacts(extracted);
  // 长期价值门槛：标注成功时，低于阈值的事实不入库（宁缺毋滥，防低价值数据污染记忆库）
  if (classifications) {
    const min = config.l2.minImportance;
    const kept = extracted
      .map((fact, i) => ({ fact, c: classifications[i] || null }))
      .filter(({ c }) => c == null || c.importance == null || c.importance >= min);
    if (!kept.length) throw new Error(`素材中没有达到长期价值门槛（importance ≥ ${min}）的内容，未入库`);
    extracted = kept.map((k) => k.fact);
    classifications = kept.map((k) => k.c);
  }
  // 延迟 require：l2 侧要用到本模块的记忆读取，写在顶部会形成循环依赖
  const { reconcileFacts } = require('./reconcile');
  const r = await reconcileFacts({ userId, facts: extracted, source: 'add_memory', metadata, mode: 'material', agentId, runId, classifications });
  const created = r.memoryIds.map((id) => memories.getMemory(id, userId)).filter(Boolean);
  return { created, ops: r };
}

module.exports = { extractMemories, classifyFacts, processMemoryMaterial };
