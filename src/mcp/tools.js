'use strict';

/**
 * MCP 工具定义与处理器。
 * 共 10 工具：
 * - L2 事实记忆（7）：add_memory / get_event_status / search_memories / get_memories /
 *   get_memory / update_memory / delete_memory
 * - L1 会话摘要（2）：list_session_summaries / get_session_summary（后台从 L0 归档生成）
 * - L3 画像/知识（1）：recall_context（只读召回，供 agent 开场注入长期上下文）
 * - 写入语义：所有 add_memory 输入都是"素材"（text/messages），一律异步受理返回 event_id，
 *   后台内部 LLM 提炼成结构化记忆入库（不存原文）；get_event_status 查进度。
 * - 错误语义（MCP 官方最佳实践）：输入校验/业务类错误用 toolError() → isError 结果返回
 *   （文案带行动建议，模型可自愈重试）；未知工具才是协议错误。
 * - 已裁剪：批量导入、整库/实体管理、agent/run 作用域。单用户部署：所有数据归属同一身份，无需传 user_id。
 * 注：API Key 管理不暴露为 MCP 工具，由 Web 平台 REST（/api/keys）+ 设备流接入提供。
 */
const { McpError, ErrorCode, ListToolsRequestSchema, CallToolRequestSchema } =
  require('@modelcontextprotocol/sdk/types.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const repo = require('../db/repo');
const llm = require('../llm/client');
const l2reconcile = require('../l2/reconcile');
const l3recall = require('../l3/recall');

function jsonText(obj) {
  return JSON.stringify(obj, null, 2);
}

/**
 * 工具执行错误（MCP 官方最佳实践）：输入校验/业务类错误以 isError:true 的结果返回，
 * 文案带「下一步怎么改」——模型拿到后可自我修正重试；而协议错误（-32602）模型无法修正。
 */
function toolError(message) {
  const e = new Error(message);
  e.isToolError = true;
  return e;
}

// ============ 工具清单 ============

const tools = [
  {
    name: 'add_memory',
    title: '添加记忆素材',
    description:
      '提交记忆素材。text：单条素材文本；messages：多轮对话 [{role, content}]。' +
      '素材一律**异步受理**：立即返回 {event_id, status:"pending"}，后台由 aimemory 内部 LLM 提炼成多条' +
      '自包含的结构化记忆后入库（库内只存提炼产物，不存原文），再用 get_event_status 查询提炼进度。' +
      '提炼失败（LLM 不可用/无有效产出）→ 事件 failed，素材不落库。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '记忆素材：单条文本（与 messages 二选一），后台 LLM 提炼成结构化记忆后入库' },
        messages: {
          type: 'array',
          description: '记忆素材：多轮对话 [{role, content}, ...]（与 text 二选一，优先于 text），后台 LLM 提炼成多条记忆',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', description: 'speaker，如 user/assistant' },
              content: { type: 'string', description: '发言内容' },
            },
            required: ['role', 'content'],
          },
        },
        metadata: { type: 'object', description: '附加元数据（如 {source: "zcode"}），会透传给提炼出的每条记忆' },
      },
    },
    handler: async ({ text, messages, metadata }, userId) => {
      const uid = userId;
      // LLM 关闭时写入无法受理：必须是 isError 执行错误（给部署建议与替代动作），而非协议错误
      if (!llm.enabled()) {
        throw toolError('LLM 提炼服务未启用（LLM_ENABLED=0），写入无法受理——'
          + '请让部署者在 .env 设置 LLM_ENABLED=1 并重启；或先用 search_memories 查询已有记忆。');
      }
      if ((!text || !String(text).trim()) && !(Array.isArray(messages) && messages.length)) {
        throw toolError('缺少素材：请提供 text（单条素材）或 messages（多轮对话），二者至少其一。')
      }
      const res = repo.createMemory({
        userId: uid,
        text: text ? String(text).slice(0, 8000) : undefined,
        messages: Array.isArray(messages) ? messages : undefined,
        metadata,
      });
      return { content: [{ type: 'text', text: jsonText(res) }] };
    },
  },

  {
    name: 'get_event_status',
    title: '查询素材任务状态',
    description:
      '查询异步写入任务的状态（add_memory(messages) 返回的 event_id）。status: pending | processing | done | failed；' +
      'done 含提炼结果（count + 记忆列表），failed 含 error。',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: '异步任务 id（add_memory(messages) 返回）' },
      },
      required: ['event_id'],
    },
    handler: async ({ event_id }, userId) => {
      const uid = userId;
      const ev = repo.getEvent(event_id, uid);
      if (!ev) {
        throw toolError(`event_id ${event_id} 不存在或不属于当前用户——请核对 add_memory 返回的 event_id 后重试。`)
      }
      return { content: [{ type: 'text', text: jsonText({ event: ev }) }] };
    },
  },

  {
    name: 'search_memories',
    title: '检索长期事实',
    description:
      '语义 + 关键词 + 实体混合检索：向量语义召回 + FTS 关键词召回合并去重。' +
      'threshold 过滤低相似度向量命中（0~1，默认 0 不过滤）；filters 支持 metadata 键值 / created_at、updated_at 时间范围。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '返回条数，默认 10' },
        threshold: {
          type: 'number',
          description: '向量相似度阈值（0~1，默认 0 不过滤）。语义召回结果中低于该值的将被排除',
        },
        filters: {
          type: 'object',
          description: '过滤条件：metadata（键值，如 {"source":"zcode"}）、created_at/updated_at（时间范围，如 {"gte":"2026-08-01","lte":"2026-08-31"}）',
        },
      },
      required: ['query'],
    },
    handler: async ({ query, limit, threshold, filters = {} }, userId) => {
      if (!query || !String(query).trim()) {
        throw toolError('query 不能为空：请给出要检索的关键词，例如 "部署 端口"。')
      }
      const uid = userId;
      const { user_id: _ignored, ...restFilters } = filters || {}; // user_id 已不再需要，剥离以防历史客户端传入
      const results = await repo.searchMemories({ userId: uid, query: String(query), limit, threshold, filters: restFilters });
      return { content: [{ type: 'text', text: jsonText({ results }) }] };
    },
  },

  {
    name: 'recall_context',
    title: '召回长期上下文',
    description:
      '召回「长期成立的上下文」：L3 画像/约束/教训条目（按类分组）+ 可选相关 L2 事实。' +
      '只读、零 LLM、任何环境可用，适合会话开场直接注入（agent 的自我介绍）。' +
      'query 提供时按相关度排序并附带 top-K 相关事实；省略则按置信度返回每类前几条。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '当前任务描述，用于相关度排序与相关事实召回；可省略' },
        per_kind: { type: 'integer', minimum: 1, maximum: 12, description: '每类条目最多返回几条，默认 6' },
        facts: { type: 'integer', minimum: 0, maximum: 20, description: '相关 L2 事实条数，默认 5；0 = 不带事实' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: l3recall.KIND_ORDER },
          description: '只返回指定类别（如 ["constraints","lessons"]，开场只要约束/教训时省 token）；省略 = 全部三类',
        },
      },
    },
    handler: async ({ query = '', per_kind, facts, kinds }, userId) => {
      let kindList = null;
      if (kinds !== undefined) {
        const bad = Array.isArray(kinds) ? kinds.filter((k) => !l3recall.KIND_ORDER.includes(k)) : null;
        if (!Array.isArray(kinds) || bad === null) {
          throw toolError('kinds 需为字符串数组，取值 profile / constraints / lessons，例如 ["constraints","lessons"]。');
        }
        if (bad.length) {
          throw toolError(`kinds 含未知类别：${bad.join(', ')}——只支持 ${l3recall.KIND_ORDER.join(' / ')}，请修正后重试。`);
        }
        kindList = kinds;
      }
      const r = await l3recall.recallContext({
        userId,
        query: String(query || ''),
        perKind: per_kind,
        facts,
        kinds: kindList,
      });
      return { content: [{ type: 'text', text: jsonText(r) }] };
    },
  },

  {
    name: 'get_memories',
    title: '列出记忆',
    description: '分页列出当前用户的记忆（按更新时间倒序）',
    inputSchema: {
      type: 'object',
      properties: {
        filters: { type: 'object', description: '过滤条件：metadata（键值）/ created_at、updated_at（时间范围）' },
        page: { type: 'integer', minimum: 1, description: '页码，默认 1' },
        page_size: { type: 'integer', minimum: 1, maximum: 100, description: '每页条数，默认 10' },
      },
    },
    handler: async ({ page, page_size, filters = {} }, userId) => {
      const uid = userId;
      const { user_id: _ignored, ...restFilters } = filters || {}; // user_id 已不再需要，剥离以防历史客户端传入
      const res = repo.listMemories({ userId: uid, page, pageSize: page_size, filters: restFilters });
      return { content: [{ type: 'text', text: jsonText({ results: res.results, total: res.total, page: res.page, page_size: res.page_size }) }] };
    },
  },

  {
    name: 'get_memory',
    title: '读取单条记忆',
    description: '按 id 获取一条记忆',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: '记忆 id' },
      },
      required: ['memory_id'],
    },
    handler: async ({ memory_id }, userId) => {
      const uid = userId;
      const mem = repo.getMemory(memory_id, uid);
      if (!mem) {
        throw toolError(`memory_id ${memory_id} 不存在或不属于当前用户——可先 get_memories 列出有效 id。`)
      }
      return { content: [{ type: 'text', text: jsonText({ memory: mem }) }] };
    },
  },

  {
    name: 'update_memory',
    title: '更新记忆',
    description: '更新一条记忆的 text / metadata（文本变化后自动重新抽取 facts 并补向量）',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: '记忆 id' },
        text: { type: 'string', description: '新内容（可选，不传则保留原值）' },
        metadata: { type: 'object', description: '新元数据（可选）' },
      },
      required: ['memory_id'],
    },
    handler: async ({ memory_id, text, metadata }, userId) => {
      const uid = userId;
      const mem = repo.updateMemory({ id: memory_id, userId: uid, text, metadata });
      if (!mem) {
        throw toolError(`memory_id ${memory_id} 不存在或不属于当前用户——可先 get_memories 列出有效 id。`)
      }
      // 改了文本才值得重消解；后台异步，绝不阻塞响应、失败静默（评估轮 Q5）
      if (text !== undefined) {
        l2reconcile.reconcileAfterUpdate({ userId: uid, memoryId: mem.id }).catch(() => {});
      }
      return { content: [{ type: 'text', text: jsonText({ id: mem.id, text: mem.text }) }] };
    },
  },

  {
    name: 'delete_memory',
    title: '删除记忆',
    description: '删除一条记忆',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: '记忆 id' },
      },
      required: ['memory_id'],
    },
    handler: async ({ memory_id }, userId) => {
      const uid = userId;
      if (!repo.deleteMemory(memory_id, uid)) {
        throw toolError(`memory_id ${memory_id} 不存在或不属于当前用户——可先 get_memories 列出有效 id。`)
      }
      return { content: [{ type: 'text', text: jsonText({ success: true }) }] };
    },
  },

  {
    name: 'list_session_summaries',
    title: '列出会话摘要',
    description:
      '列出会话摘要（L1 情景记忆）：后台把归档的 agent 会话（L0 原始归档）提炼成结构化摘要——'
      + '概述、关键决定、未决事项、产出物。用于回答"我最近/某台机器做了什么"这类跨会话、'
      + '跨设备的问题（区别于 search_memories 查的是提炼后的长期事实）。',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: '按设备码过滤（可选，见返回里的 device_code）' },
        agent: { type: 'string', description: '按 agent 过滤：codex / claude / zcode（可选）' },
        query: { type: 'string', description: '在摘要正文/决定/产出物里做关键词过滤（可选）' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，默认 10' },
      },
    },
    handler: async ({ device, agent, query, limit = 10 }, userId) => {
      const list = repo.listL1Summaries(userId, { deviceCode: device, agent, limit: 200 });
      let out = list;
      if (query) {
        const q = String(query).toLowerCase();
        out = list.filter((s) =>
          [s.overview, ...(s.decisions || []), ...(s.artifacts || []), ...(s.pending || [])]
            .filter(Boolean)
            .some((t) => String(t).toLowerCase().includes(q))
        );
      }
      const results = out.slice(0, Math.min(limit, 50)).map((s) => ({
        session_id: s.session_id,
        device_code: s.device_code,
        agent: s.agent,
        time: s.last_ts,
        overview: s.overview,
        decisions: s.decisions,
        pending: s.pending,
        artifacts: s.artifacts,
      }));
      return { content: [{ type: 'text', text: jsonText({ results, total: results.length }) }] };
    },
  },

  {
    name: 'get_session_summary',
    title: '读取会话摘要',
    description: '查看某个会话的摘要详情（L1）。用 list_session_summaries 拿到 session_id / device_code / agent 后调用。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '会话 id' },
        device_code: { type: 'string', description: '设备码（同名会话可能存在于多台设备，建议带上）' },
        agent: { type: 'string', description: 'agent：codex / claude / zcode' },
      },
      required: ['session_id'],
    },
    handler: async ({ session_id: sessionId, device_code: deviceCode, agent }, userId) => {
      // 允许只给 session_id（单用户下会话 id 基本唯一），但要能唯一定位
      const list = repo.listL1Summaries(userId, { limit: 500 });
      const match = list.filter((s) =>
        s.session_id === sessionId
        && (!deviceCode || s.device_code === deviceCode)
        && (!agent || s.agent === agent)
      );
      if (!match.length) {
        // 可能尚未生成（还在排队）或会话不存在
        const raw = repo.getL1Summary(userId, { deviceCode: deviceCode || '', agent: agent || '', sessionId });
        return {
          content: [{
            type: 'text',
            text: jsonText({
              found: false,
              hint: raw
                ? `该会话摘要状态为 ${raw.status}${raw.error ? `（${raw.error}）` : ''}，尚未完成。`
                : '没有该会话的摘要：可能尚未生成（后台按静默时间排队），或 session_id 有误。',
            }),
          }],
        };
      }
      const s = match[0];
      return { content: [{ type: 'text', text: jsonText(s) }] };
    },
  },
];

/** 创建并注册工具的 MCP Server 实例（userId 由 server 注入，单用户下为常量） */
function buildServer() {
  const server = new Server(
    {
      name: 'aimemory',
      version: '0.2.0',
      description: '个人自托管 AI 记忆库（mem0 兼容 MCP）',
    },
    {
      capabilities: { tools: {} },
      instructions:
        '单用户部署：所有记忆归属同一身份，无需传 user_id。'
        + '两层记忆各有用途——search_memories 查长期事实（L2，由 add_memory 素材提炼而来）；'
        + 'list_session_summaries 查"某个会话做了什么"（L1，由 agent 会话归档自动摘要）。'
        + '问"我最近做了什么/某台机器做了什么"用后者，问"关于 X 我知道什么"用前者。',
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    return callTool(name, args, server.userId);
  });

  return server;
}

/** 工具调用分发（从 buildServer 抽出以便直接测试错误语义） */
async function callTool(name, args = {}, userId) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new McpError(ErrorCode.MethodNotFound, `未知工具: ${name}`);
  }
  try {
    return await tool.handler(args, userId);
  } catch (e) {
    if (e.isToolError) {
      // 执行错误 → isError 结果（模型可读文案并自愈），而不是协议错误
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
    if (e instanceof McpError) throw e;
    throw new McpError(ErrorCode.InternalError, `工具 ${name} 执行失败: ${e.message}`);
  }
}

module.exports = { tools, buildServer, callTool };
