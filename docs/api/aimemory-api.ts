// 本文件由 `npm run types`（scripts/gen-api-types.js）从 docs/api/openapi.json 生成——勿手改，
// 与 openapi 不同步会被 test/api-types.test.js 打回。实体接口的语义说明见 docs/前端对接.md。
// 来源：OpenAPI 3.1.0 · 0.2.0 · 17 条路径

// ============ 路由面（自动生成） ============

export type ApiMethod = 'DELETE' | 'GET' | 'POST' | 'PUT';

export type ApiPath =
  | '/api/events/{id}'
  | '/api/keys'
  | '/api/keys/{id}/revoke'
  | '/api/me'
  | '/api/memories'
  | '/api/memories/export'
  | '/api/memories/{id}'
  | '/api/openapi.json'
  | '/api/stats'
  | '/healthz'
  | '/mcp'
  | '/v1/event/{event_id}'
  | '/v1/memories'
  | '/v1/memories/{id}'
  | '/v1/memories/{id}/history'
  | '/v2/memories'
  | '/v2/memories/search';

/** 全部 REST 路由与其支持的方法（与 express 路由表一致，由契约守护测试保证） */
export const API_ROUTES: Readonly<Record<ApiPath, readonly ApiMethod[]>> = {
  '/api/events/{id}': ['GET'],
  '/api/keys': ['GET', 'POST'],
  '/api/keys/{id}/revoke': ['POST'],
  '/api/me': ['GET'],
  '/api/memories': ['GET', 'POST'],
  '/api/memories/export': ['GET'],
  '/api/memories/{id}': ['GET', 'DELETE'],
  '/api/openapi.json': ['GET'],
  '/api/stats': ['GET'],
  '/healthz': ['GET'],
  '/mcp': ['POST', 'GET'],
  '/v1/event/{event_id}': ['GET'],
  '/v1/memories': ['POST', 'DELETE'],
  '/v1/memories/{id}': ['GET', 'PUT', 'DELETE'],
  '/v1/memories/{id}/history': ['GET'],
  '/v2/memories': ['POST'],
  '/v2/memories/search': ['POST'],
};

// ============ 实体形状（与后端返回一致；字段语义见 docs/前端对接.md） ============

/** 一条记忆（memories 表提炼产物；embedding 为内部向量，永不出现在响应里） */
export interface Memory {
  id: string;
  user_id: string;
  agent_id: string | null;
  run_id: string | null;
  text: string;
  metadata: Record<string, unknown>;
  facts: string[] | null;
  entities: string[] | null;
  created_at: string;
  updated_at: string;
}

/** mem0 形态记忆（/v1 /v2 面响应；文本字段名为 memory） */
export interface Mem0Memory {
  id: string;
  memory: string;
  user_id: string;
  agent_id: string | null;
  run_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  score?: number;
}

/** mem0 形态变更历史条目（GET /v1/memories/{id}/history） */
export interface Mem0HistoryEntry {
  id: string;
  memory_id: string;
  event: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
  old_memory: string | null;
  new_memory: string | null;
  user_id: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryListResult {
  results: Memory[];
  total: number;
  page: number;
  pageSize: number;
}

/** 素材受理状态：返回 202 ≠ 已入库，必须轮询至 done/failed（见 docs/前端对接.md「写入语义」） */
export interface EventStatus {
  id: string;
  event_type: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  result: {
    count: number;
    memories: Memory[];
    ops: { added: number; updated: number; deleted: number; noop: number; degraded: boolean };
  } | null;
  error: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface Stats {
  memories: number;
  keys: number;
}

/** Token 信息（列表返回，不含明文——明文仅在创建响应里返回一次，字段名 token） */
export interface KeyInfo {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
}
