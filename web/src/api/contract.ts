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
