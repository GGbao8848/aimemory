// 与后端契约的对接口：路径全部经 ApiPath 类型校验（来源 docs/api/openapi.json，
// 由 npm run types 生成）——后端改路径而前端没跟，会在 tsc 阶段直接红。
import type { ApiPath } from '../../../docs/api/aimemory-api';

const path = <P extends ApiPath>(p: P): P => p;

/** 带参路径：契约里的 {id} 占位统一在此替换（值一律 URL 编码） */
const withId = (tpl: string, id: string): string =>
  tpl.replace('{id}', encodeURIComponent(id));

export const endpoints = {
  me: () => path('/api/me'),
  stats: () => path('/api/stats'),
  memories: () => path('/api/memories'),
  memory: (id: string) => withId(path('/api/memories/{id}'), id),
  memoriesExport: () => path('/api/memories/export'),
  event: (id: string) => withId(path('/api/events/{id}'), id),
  keys: () => path('/api/keys'),
  keyRevoke: (id: string) => withId(path('/api/keys/{id}/revoke'), id),
  settings: () => path('/api/settings'),
  settingsTest: () => path('/api/settings/test'),
  settingsReveal: () => path('/api/settings/reveal'),
  vecRebuild: () => path('/api/settings/vec-rebuild'),
  entities: () => path('/api/entities'),
  rawMaterials: () => path('/api/raw-materials'),
  rawReextract: () => path('/api/raw-materials/reextract'),
  keywords: () => path('/api/keywords'),
  categories: () => path('/api/categories'),
  dashboard: () => path('/api/dashboard'),
  ops: () => path('/api/ops'),
  webhooks: () => path('/api/webhooks'),
  webhook: (id: string) => withId(path('/api/webhooks/{id}'), id),
  webhookDeliveries: (id: string) => withId(path('/api/webhooks/{id}/deliveries'), id),
};

export type {
  Memory,
  MemoryListResult,
  EventStatus,
  Mem0Memory,
  Mem0HistoryEntry,
  Stats,
  KeyInfo,
} from '../../../docs/api/aimemory-api';

export interface Me {
  userId: string;
  username: string | null;
  via: 'token' | 'session';
}

/** 素材受理回执：202 + event_id，需轮询到 done/failed */
export interface AcceptResult {
  event_id?: string;
  status?: string;
}

/** 实体/分类清单条目（带关联记忆计数，降序） */
export interface EntityInfo {
  id?: string;
  name: string;
  count: number;
}

/** 素材归档行（原文 + 提炼状态 + 关联记忆数） */
export interface RawMaterial {
  id: string;
  kind: 'text' | 'messages';
  input: string;
  metadata: string | null;
  agent_id: string | null;
  run_id: string | null;
  created_at: string;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'none';
  memory_count: number;
}

export interface RawMaterialPage {
  results: RawMaterial[];
  total: number;
  page: number;
  pageSize: number;
}

/** 作用域实体（mem0 Entities 页语义：user/agent/run 记忆归属维度） */
export interface EntityScope {
  type: 'user' | 'agent' | 'run';
  name: string;
  memories: number;
  last_updated: string | null;
}

// ===== Dashboard / 活动日志 / Webhooks =====

export interface OpsStats {
  ADD: number;
  UPDATE: number;
  DELETE: number;
  NOOP: number;
  total: number;
}

export interface DashboardStats {
  memories: number;
  keys: number;
  entities: number;
  ops30: OpsStats;
  daily: { day: string; n: number }[];
  recent: {
    id: number;
    memory_id: string | null;
    op: string;
    before_text: string | null;
    after_text: string | null;
    source: string;
    applied: boolean;
    created_at: string;
  }[];
  backlog: { pending: number; processing: number; failed: number; oldest_age_ms: number };
}

export interface OpsRow {
  id: number;
  memory_id: string | null;
  op: string;
  before_text: string | null;
  after_text: string | null;
  source: string;
  applied: boolean;
  created_at: string;
}

export interface OpsPage {
  results: OpsRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** webhook 配置（secret 对创建者明文可见，用于校验签名） */
export interface WebhookInfo {
  id: string;
  url: string;
  description: string | null;
  secret: string;
  events: string[];
  enabled: boolean;
  created_at: string;
}

export interface WebhookDelivery {
  id: number;
  op: string;
  memory_id: string | null;
  status: 'ok' | 'failed';
  status_code: number | null;
  attempts: number;
  error: string | null;
  created_at: string;
}

// ===== 设置页（/api/settings） =====

/** 密钥脱敏展示：服务端永不回显明文 */
export interface SettingsSecret {
  set: boolean;
  preview: string;
}

/** 模型接入（LLM / Embedding 共用形状） */
export interface ModelSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: SettingsSecret;
  timeoutMs: number;
}

export interface Settings {
  llm: ModelSettings;
  embedding: ModelSettings;
  l2: { reconcile: boolean; vec: boolean };
}

/** 连通性测试结果（ok=false 时 error 有值） */
export interface ProbeResult {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
  error?: string;
}

/** 向量索引重建结果 */
export interface VecRebuildResult {
  ok: true;
  scanned: number;
  indexed: number;
  dim: number | null;
}
