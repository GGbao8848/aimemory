// 本文件由 `npm run types`（scripts/gen-api-types.js）从 docs/api/openapi.json 生成——勿手改，
// 与 openapi 不同步会被 test/api-types.test.js 打回。实体接口的语义说明见 docs/前端对接.md。
// 来源：OpenAPI 3.1.0 · 0.2.0 · 31 条路径

// ============ 路由面（自动生成） ============

export type ApiMethod = 'DELETE' | 'GET' | 'POST' | 'PUT';

export type ApiPath =
  | '/api/atlas/overview'
  | '/api/connect/confirm'
  | '/api/connect/poll'
  | '/api/connect/start'
  | '/api/events/{id}'
  | '/api/keys'
  | '/api/keys/{id}/revoke'
  | '/api/l0/ingest'
  | '/api/l0/session'
  | '/api/l0/stats'
  | '/api/l1/run'
  | '/api/l1/stats'
  | '/api/l1/summaries'
  | '/api/l2/ops'
  | '/api/l2/run'
  | '/api/l2/sources'
  | '/api/l2/stats'
  | '/api/l2/vec/rebuild'
  | '/api/l3/entries'
  | '/api/l3/entries/{id}'
  | '/api/l3/history'
  | '/api/l3/run'
  | '/api/l3/stats'
  | '/api/me'
  | '/api/memories'
  | '/api/memories/export'
  | '/api/memories/{id}'
  | '/api/openapi.json'
  | '/api/stats'
  | '/healthz'
  | '/mcp';

/** 全部 REST 路由与其支持的方法（与 express 路由表一致，由契约守护测试保证） */
export const API_ROUTES: Readonly<Record<ApiPath, readonly ApiMethod[]>> = {
  '/api/atlas/overview': ['GET'],
  '/api/connect/confirm': ['POST'],
  '/api/connect/poll': ['GET'],
  '/api/connect/start': ['POST'],
  '/api/events/{id}': ['GET'],
  '/api/keys': ['GET', 'POST'],
  '/api/keys/{id}/revoke': ['POST'],
  '/api/l0/ingest': ['POST'],
  '/api/l0/session': ['GET'],
  '/api/l0/stats': ['GET'],
  '/api/l1/run': ['POST'],
  '/api/l1/stats': ['GET'],
  '/api/l1/summaries': ['GET'],
  '/api/l2/ops': ['GET'],
  '/api/l2/run': ['POST'],
  '/api/l2/sources': ['GET'],
  '/api/l2/stats': ['GET'],
  '/api/l2/vec/rebuild': ['POST'],
  '/api/l3/entries': ['GET'],
  '/api/l3/entries/{id}': ['PUT'],
  '/api/l3/history': ['GET'],
  '/api/l3/run': ['POST'],
  '/api/l3/stats': ['GET'],
  '/api/me': ['GET'],
  '/api/memories': ['GET', 'POST'],
  '/api/memories/export': ['GET'],
  '/api/memories/{id}': ['GET', 'DELETE'],
  '/api/openapi.json': ['GET'],
  '/api/stats': ['GET'],
  '/healthz': ['GET'],
  '/mcp': ['POST', 'GET'],
};

// ============ 实体形状（与后端返回一致；字段语义见 docs/前端对接.md） ============

/** 一条记忆（memories 表提炼产物；embedding 为内部向量，永不出现在响应里） */
export interface Memory {
  id: string;
  user_id: string;
  text: string;
  metadata: Record<string, unknown>;
  facts: string[] | null;
  entities: string[] | null;
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

/** L1 会话摘要（列表接口不含 status/error，单条接口含） */
export interface L1Summary {
  device_code: string;
  agent: string;
  session_id: string;
  overview: string | null;
  decisions: string[];
  pending: string[];
  artifacts: unknown[];
  records: number;
  first_ts: string | null;
  last_ts: string | null;
  model: string | null;
  updated_at: string;
  status?: 'pending' | 'running' | 'done' | 'failed';
  error?: string | null;
}

/** L3 画像条目（markdown 存储，双时间轴；effective_confidence 为时效衰减只读视图） */
export interface L3Entry {
  id: string;
  kind: 'profile' | 'constraints' | 'lessons';
  kind_label: string;
  text: string;
  confidence: number | null;
  effective_confidence: number | null;
  valid_from: string;
  created_at: string;
  updated_at: string;
  superseded_by: string | null;
  source: string | null;
}

/** L3 变更历史：现行条目 + 被其直接/间接取代的旧版链（新→旧）；orphan 指向不存在的取代者 */
export interface L3History {
  chains: { active: L3Entry; history: L3Entry[]; depth: number }[];
  orphans: L3Entry[];
  total: number;
  active_total: number;
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
