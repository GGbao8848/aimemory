'use strict';

/**
 * MCP 工具定义与处理器。
 * 核心 7 工具：add_memory / get_event_status / search_memories / get_memories / get_memory /
 * update_memory / delete_memory。
 * - 写入语义：所有 add_memory 输入都是"素材"（text/messages），一律异步受理返回 event_id，
 *   后台内部 LLM 提炼成结构化记忆入库（不存原文）；get_event_status 查进度。
 * - 已裁剪：批量导入、整库/实体管理、agent/run 作用域。单用户部署：所有数据归属同一身份，无需传 user_id。
 * 注：API Key 管理不暴露为 MCP 工具，由 Web 平台 REST（/api/keys）+ 设备流接入提供。
 */
const { McpError, ErrorCode, ListToolsRequestSchema, CallToolRequestSchema } =
  require('@modelcontextprotocol/sdk/types.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const repo = require('../db/repo');

function jsonText(obj) {
  return JSON.stringify(obj, null, 2);
}

// ============ 工具清单 ============

const tools = [
  {
    name: 'add_memory',
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
      if ((!text || !String(text).trim()) && !(Array.isArray(messages) && messages.length)) {
        throw new McpError(ErrorCode.InvalidParams, 'text 或 messages 至少提供一个');
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
        throw new McpError(ErrorCode.InvalidParams, `event_id ${event_id} 不存在（或不属于当前用户）`);
      }
      return { content: [{ type: 'text', text: jsonText({ event: ev }) }] };
    },
  },

  {
    name: 'search_memories',
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
        throw new McpError(ErrorCode.InvalidParams, 'query 不能为空');
      }
      const uid = userId;
      const { user_id: _ignored, ...restFilters } = filters || {}; // user_id 已不再需要，剥离以防历史客户端传入
      const results = await repo.searchMemories({ userId: uid, query: String(query), limit, threshold, filters: restFilters });
      return { content: [{ type: 'text', text: jsonText({ results }) }] };
    },
  },

  {
    name: 'get_memories',
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
        throw new McpError(ErrorCode.InvalidParams, `memory_id ${memory_id} 不存在（或不属于当前用户）`);
      }
      return { content: [{ type: 'text', text: jsonText({ memory: mem }) }] };
    },
  },

  {
    name: 'update_memory',
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
        throw new McpError(ErrorCode.InvalidParams, `memory_id ${memory_id} 不存在（或不属于当前用户）`);
      }
      return { content: [{ type: 'text', text: jsonText({ id: mem.id, text: mem.text }) }] };
    },
  },

  {
    name: 'delete_memory',
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
        throw new McpError(ErrorCode.InvalidParams, `memory_id ${memory_id} 不存在（或不属于当前用户）`);
      }
      return { content: [{ type: 'text', text: jsonText({ success: true }) }] };
    },
  },
];

/** 创建并注册工具的 MCP Server 实例（userId 由 server 注入，单用户下为常量） */
function buildServer() {
  const server = new Server(
    {
      name: 'aimemory',
      version: '0.2.0',
      description: '企业级自托管 AI 记忆库（mem0 兼容 MCP）',
    },
    {
      capabilities: { tools: {} },
      instructions:
        '单用户部署：所有记忆归属同一身份，无需传 user_id。',
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
