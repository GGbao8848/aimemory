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
  l0Stats: () => path('/api/l0/stats'),
  l0Session: () => path('/api/l0/session'),
  l2Ops: () => path('/api/l2/ops'),
  l3Entries: () => path('/api/l3/entries'),
  l3Entry: (id: string) => withId(path('/api/l3/entries/{id}'), id),
  l3History: () => path('/api/l3/history'),
  l3Stats: () => path('/api/l3/stats'),
};

export type {
  Memory,
  MemoryListResult,
  EventStatus,
  L1Summary,
  L3Entry,
  L3History,
  Stats,
  KeyInfo,
} from '../../../docs/api/aimemory-api';

export interface Me {
  userId: string;
  username: string | null;
  via: 'token' | 'session';
}

/** L2 冲突消解审计行（memory_ops） */
export interface OpRow {
  id?: string;
  op: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP' | string;
  before_text: string | null;
  after_text: string | null;
  source: string | null;
  applied?: boolean;
  created_at: string | null;
}

/** L3 规模统计（active / 已取代 / 平均有效置信 / 待凝练） */
export interface L3Stats {
  active: number;
  superseded: number;
  effective_confidence?: number | null;
  pending?: number;
}

/** 素材受理回执：202 + event_id，需轮询到 done/failed */
export interface AcceptResult {
  event_id?: string;
  status?: string;
}
