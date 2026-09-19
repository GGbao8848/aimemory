'use strict';

/**
 * 前端对接包生成器（评估规划 G2）：
 * 从 docs/api/openapi.json（单一事实源）生成 docs/api/aimemory-api.ts——
 * 路径/方法面由 openapi 生成，实体接口为项目稳定形状（随 openapi 演进手工维护于此）。
 * 每次运行幂等（无时间戳）；test/api-types.test.js 守护「生成物与 openapi 不同步即红」。
 * 用法：npm run types
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OPENAPI = path.join(ROOT, 'docs/api/openapi.json');
const OUT = path.join(ROOT, 'docs/api/aimemory-api.ts');

const spec = JSON.parse(fs.readFileSync(OPENAPI, 'utf8'));

const paths = Object.keys(spec.paths).sort();
const methodsUsed = [...new Set(Object.values(spec.paths).flatMap((m) => Object.keys(m)))].map((x) => x.toUpperCase()).sort();

/** 稳定实体形状：与各域 store/repo 的对外返回一致（改形状时同步这里 + 测试） */
const ENTITIES = `\
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

/** Token 信息（列表返回；创建响应额外含一次性明文 token 字段名因入口而异：REST 为 token） */
export interface KeyInfo {
  id: string;
  user_id: string;
  name: string;
  token_plain: string;
  created_at: string;
  revoked_at: string | null;
}`;

const routesBody = paths
  .map((p) => {
    const methods = Object.keys(spec.paths[p]).map((m) => m.toUpperCase());
    return `  '${p}': [${methods.map((m) => `'${m}'`).join(', ')}],`;
  })
  .join('\n');

const out = `\
// 本文件由 \`npm run types\`（scripts/gen-api-types.js）从 docs/api/openapi.json 生成——勿手改，
// 与 openapi 不同步会被 test/api-types.test.js 打回。实体接口的语义说明见 docs/前端对接.md。
// 来源：OpenAPI ${spec.openapi} · ${spec.info?.version || 'unknown'} · ${paths.length} 条路径

// ============ 路由面（自动生成） ============

export type ApiMethod = ${methodsUsed.map((m) => `'${m}'`).join(' | ')};

export type ApiPath =
${paths.map((p) => `  | '${p}'`).join('\n')};

/** 全部 REST 路由与其支持的方法（与 express 路由表一致，由契约守护测试保证） */
export const API_ROUTES: Readonly<Record<ApiPath, readonly ApiMethod[]>> = {
${routesBody}
};

${ENTITIES}
`;

fs.writeFileSync(OUT, out);
console.log(`已生成 ${path.relative(ROOT, OUT)}（${paths.length} 条路径）`);
