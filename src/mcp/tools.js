'use strict';

/**
 * MCP 工具定义与处理器。
 * 行为对齐 mem0 官方 MCP server 的同类工具（add / search / get_all / get / update / delete），
 * 另加三个 API Key 管理工具。所有数据访问强制 user_id 隔离。
 */
const { McpError, ErrorCode, ListToolsRequestSchema, CallToolRequestSchema } =
  require('@modelcontextprotocol/sdk/types.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const repo = require('../db/repo');
const tokens = require('../auth/tokens');

/** 把调用方的 user_id 解析出来；user_id 参数只能等于当前身份，否则拒绝（防跨租户） */
function resolveUserId(userId, paramsUserId) {
  if (paramsUserId !== undefined && paramsUserId !== null && paramsUserId !== userId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'user_id 只能使用当前登录身份，无权访问其他用户的数据'
    );
  }
  return userId;
}

function jsonText(obj) {
  return JSON.stringify(obj, null, 2);
}

// ============ 工具清单 ============

const tools = [
  {
    name: 'add_memory',
    description:
      '添加记忆。支持两种输入：text（单条文本）或 messages（多轮对话，LLM 自动提炼成记忆）。' +
      'agent_id/run_id 标记记忆归属（多 agent 隔离）。infer=true 时异步 LLM 提炼事实存 facts（增强语义召回），失败不影响原样入库',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容（与 messages 二选一）' },
        messages: {
          type: 'array',
          description: '多轮对话 [{role, content}, ...]，LLM 提炼成记忆（与 text 二选一，优先于 text）',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', description: 'speaker，如 user/assistant' },
              content: { type: 'string', description: '发言内容' },
            },
            required: ['role', 'content'],
          },
        },
        user_id: { type: 'string', description: '用户标识（可选，仅限当前身份）' },
        agent_id: { type: 'string', description: 'agent 标识（可选，记忆归属此 agent）' },
        run_id: { type: 'string', description: '会话/运行标识（可选，记忆归属此次 run）' },
        metadata: {
          type: 'object',
          description: '附加元数据（如 {source: "claude-code"}），可含任意键',
        },
        infer: {
          type: 'boolean',
          description: '是否 LLM 事实抽取，默认 true；false 时原样入库不抽取',
        },
      },
    },
    handler: async ({ text, messages, metadata, infer, user_id, agent_id, run_id }, userId) => {
      if ((!text || !String(text).trim()) && !(Array.isArray(messages) && messages.length)) {
        throw new McpError(ErrorCode.InvalidParams, 'text 或 messages 至少提供一个');
      }
      const uid = resolveUserId(userId, user_id);
      const inferFlag = infer !== false;

      // messages 模式：提炼成多条独立记忆并逐条入库（mem0 批量）
      if (messages && Array.isArray(messages) && messages.length) {
        const created = await repo.createMemoriesFromDialogue({
          userId: uid, messages, metadata, infer: inferFlag, agentId: agent_id, runId: run_id,
        });
        return {
          content: [{
            type: 'text',
            text: jsonText({ count: created.length, memories: created, user_id: uid, agent_id: agent_id || null, run_id: run_id || null }),
          }],
        };
      }

      const mem = await repo.createMemory({
        userId: uid,
        text: String(text),
        metadata,
        infer: inferFlag,
        agentId: agent_id,
        runId: run_id,
      });
      return { content: [{ type: 'text', text: jsonText({ id: mem.id, user_id: uid, text: mem.text, agent_id: agent_id || null, run_id: run_id || null }) }] };
    },
  },

  {
    name: 'search_memories',
    description:
      '语义+关键词+实体混合检索：向量语义召回 + FTS5 关键词召回 + 实体命中加权；rerank=true 时用 LLM 对结果按相关性重排（更精准，略增延迟）',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词' },
        user_id: { type: 'string', description: '用户标识（可选，仅限当前身份）' },
        agent_id: { type: 'string', description: '仅检索该 agent 的记忆（可选）' },
        run_id: { type: 'string', description: '仅检索该 run 的记忆（可选）' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '返回条数，默认 10' },
        threshold: {
          type: 'number',
          description: '向量相似度阈值（0~1，默认 0 不过滤）。语义召回结果中低于该值的将被排除',
        },
        filters: {
          type: 'object',
          description: '过滤条件：支持 user_id（仅当前身份）、agent_id、run_id',
        },
        rerank: {
          type: 'boolean',
          description: '用 LLM 对结果按查询相关性重排（默认 false；true 时更精准但略增延迟）。LLM 不可用时自动回退原排序',
        },
      },
      required: ['query'],
    },
    handler: async ({ query, limit, threshold, user_id, agent_id, run_id, rerank, filters = {} }, userId) => {
      if (!query || !String(query).trim()) {
        throw new McpError(ErrorCode.InvalidParams, 'query 不能为空');
      }
      const uid = resolveUserId(userId, user_id);
      if (filters && filters.user_id !== undefined && filters.user_id !== null) {
        resolveUserId(uid, filters.user_id);
      }
      // 作用域：顶层参数优先，其次 filters
      const agentId = agent_id || filters?.agent_id || undefined;
      const runId = run_id || filters?.run_id || undefined;
      const results = await repo.searchMemories({ userId: uid, query: String(query), limit, threshold, agentId, runId, rerank: rerank === true });
      return { content: [{ type: 'text', text: jsonText({ results }) }] };
    },
  },

  {
    name: 'get_memories',
    description: '分页列出当前用户的记忆（按更新时间倒序；支持按 agent/run 过滤）',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: '用户标识（可选，仅限当前身份）' },
        agent_id: { type: 'string', description: '仅列出该 agent 的记忆（可选）' },
        run_id: { type: 'string', description: '仅列出该 run 的记忆（可选）' },
        filters: { type: 'object', description: '过滤条件：支持 user_id / agent_id / run_id' },
        page: { type: 'integer', minimum: 1, description: '页码，默认 1' },
        page_size: { type: 'integer', minimum: 1, maximum: 100, description: '每页条数，默认 10' },
      },
    },
    handler: async ({ page, page_size, user_id, agent_id, run_id, filters = {} }, userId) => {
      const uid = resolveUserId(userId, user_id);
      if (filters && filters.user_id !== undefined && filters.user_id !== null) {
        resolveUserId(uid, filters.user_id);
      }
      const agentId = agent_id || filters?.agent_id || undefined;
      const runId = run_id || filters?.run_id || undefined;
      const res = repo.listMemories({ userId: uid, page, pageSize: page_size, agentId, runId });
      return { content: [{ type: 'text', text: jsonText({ results: res.results, total: res.total, page: res.page, page_size: res.page_size }) }] };
    },
  },

  {
    name: 'get_memory',
    description: '按 id 获取一条记忆，包含修改历史时间线',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: '记忆 id' },
        user_id: { type: 'string', description: '用户标识（可选，仅限当前身份）' },
      },
      required: ['memory_id'],
    },
    handler: async ({ memory_id, user_id }, userId) => {
      const uid = resolveUserId(userId, user_id);
      const mem = repo.getMemory(memory_id, uid);
      if (!mem) {
        throw new McpError(ErrorCode.InvalidParams, `memory_id ${memory_id} 不存在（或不属于当前用户）`);
      }
      return { content: [{ type: 'text', text: jsonText({ memory: mem }) }] };
    },
  },

  {
    name: 'update_memory',
    description: '更新一条记忆的 text / metadata（旧值快照进历史）',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: '记忆 id' },
        text: { type: 'string', description: '新内容（可选，不传则保留原值）' },
        metadata: { type: 'object', description: '新元数据（可选）' },
        user_id: { type: 'string', description: '用户标识（可选，仅限当前身份）' },
      },
      required: ['memory_id'],
    },
    handler: async ({ memory_id, text, metadata, user_id }, userId) => {
      const uid = resolveUserId(userId, user_id);
      const mem = repo.updateMemory({ id: memory_id, userId: uid, text, metadata });
      if (!mem) {
        throw new McpError(ErrorCode.InvalidParams, `memory_id ${memory_id} 不存在（或不属于当前用户）`);
      }
      return { content: [{ type: 'text', text: jsonText({ id: mem.id, text: mem.text }) }] };
    },
  },

  {
    name: 'delete_memory',
    description: '删除一条记忆（旧值快照进历史）',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: '记忆 id' },
        user_id: { type: 'string', description: '用户标识（可选，仅限当前身份）' },
      },
      required: ['memory_id'],
    },
    handler: async ({ memory_id, user_id }, userId) => {
      const uid = resolveUserId(userId, user_id);
      if (!repo.deleteMemory(memory_id, uid)) {
        throw new McpError(ErrorCode.InvalidParams, `memory_id ${memory_id} 不存在（或不属于当前用户）`);
      }
      return { content: [{ type: 'text', text: jsonText({ success: true }) }] };
    },
  },

  // ============ API Key 管理工具 ============

  {
    name: 'create_api_key',
    description: '创建一个新的 API Key（返回 m0- 前缀明文，仅此一次），供其他 agent/服务接入',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '密钥名称，默认 default' },
      },
    },
    handler: async ({ name }, userId) => {
      const key = tokens.createApiKey(userId, name || 'default');
      return { content: [{ type: 'text', text: jsonText({ id: key.id, name: key.name, token: key.token, created_at: key.created_at }) }] };
    },
  },

  {
    name: 'list_api_keys',
    description: '列出当前用户的 API Key（不含明文）',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, userId) => {
      return { content: [{ type: 'text', text: jsonText({ results: tokens.listApiKeys(userId) }) }] };
    },
  },

  {
    name: 'revoke_api_key',
    description: '吊销一个 API Key，吊销后立即失效',
    inputSchema: {
      type: 'object',
      properties: { key_id: { type: 'string', description: 'API Key id' } },
      required: ['key_id'],
    },
    handler: async ({ key_id }, userId) => {
      if (!tokens.revokeApiKey(key_id, userId)) {
        throw new McpError(ErrorCode.InvalidParams, `key_id ${key_id} 不存在或已吊销`);
      }
      return { content: [{ type: 'text', text: jsonText({ success: true }) }] };
    },
  },

  // ============ 实体/批量管理（对齐 mem0 工具面） ============
  // 本实例当前只有 user 维度（无 agent/app/run），故 user_id 只能等于当前身份，
  // 跨用户删除一律拒绝——多租户隔离底线不变。

  {
    name: 'delete_all_memories',
    description: '清空指定用户（默认当前身份）的全部记忆；用户本身与密钥保留',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: '用户标识（可选，仅限当前身份）' },
        agent_id: { type: 'string', description: '本实例无 agent 维度，保留兼容，忽略' },
        app_id: { type: 'string', description: '本实例无 app 维度，保留兼容，忽略' },
        run_id: { type: 'string', description: '本实例无 run 维度，保留兼容，忽略' },
      },
    },
    handler: async ({ user_id }, userId) => {
      const uid = resolveUserId(userId, user_id);
      return { content: [{ type: 'text', text: jsonText(repo.deleteAllMemories(uid)) }] };
    },
  },

  {
    name: 'list_entities',
    description: '列出有记忆的用户实体（含记忆数与最后活跃时间）',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      return { content: [{ type: 'text', text: jsonText({ entities: repo.listEntities() }) }] };
    },
  },

  {
    name: 'delete_entities',
    description: '删除指定用户（默认当前身份）及其全部记忆、密钥与 Web 会话（不可恢复）',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: '用户标识（可选，仅限当前身份）' },
        agent_id: { type: 'string', description: '本实例无 agent 维度，保留兼容，忽略' },
        app_id: { type: 'string', description: '本实例无 app 维度，保留兼容，忽略' },
        run_id: { type: 'string', description: '本实例无 run 维度，保留兼容，忽略' },
      },
    },
    handler: async ({ user_id }, userId) => {
      const uid = resolveUserId(userId, user_id);
      return { content: [{ type: 'text', text: jsonText(repo.deleteEntities(uid)) }] };
    },
  },
];

/** 为指定用户创建并注册工具的 MCP Server 实例（userId 闭包注入，天然租户隔离） */
function buildServer() {
  const server = new Server(
    {
      name: 'aimemory',
      version: '0.1.0',
      description: '企业级自托管 AI 记忆库（mem0 兼容 MCP）',
    },
    {
      capabilities: { tools: {} },
      instructions:
        '对每个工具调用，实现均按当前连接用户隔离数据；user_id 参数只能等于当前登录身份。',
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `未知工具: ${name}`);
    }
    try {
      return await tool.handler(args, server.userId);
    } catch (e) {
      if (e instanceof McpError) throw e;
      throw new McpError(ErrorCode.InternalError, `工具 ${name} 执行失败: ${e.message}`);
    }
  });

  return server;
}

module.exports = { tools, buildServer };
