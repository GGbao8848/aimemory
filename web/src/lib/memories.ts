// 记忆视图纯逻辑：作用域聚合/过滤与事件状态映射，node --test 直接守护。

import type { Memory } from '../api/contract';

/** 作用域（agent_id / run_id 维度）：'all' = 不过滤 */
export interface Scope {
  agentId: string | null;
  runId: string | null;
}

export const ALL_SCOPE: Scope = { agentId: null, runId: null };

/** 从记忆列表聚合出现过的 agent_id / run_id（保持出现顺序，去重） */
export function scopeOptions(memories: Memory[]): { agents: string[]; runs: string[] } {
  const agents: string[] = [];
  const runs: string[] = [];
  for (const m of memories) {
    if (m.agent_id && !agents.includes(m.agent_id)) agents.push(m.agent_id);
    if (m.run_id && !runs.includes(m.run_id)) runs.push(m.run_id);
  }
  return { agents, runs };
}

/** 按作用域过滤记忆（scope 为 null 维度不限制） */
export function filterByScope(memories: Memory[], scope: Scope): Memory[] {
  return memories.filter(
    (m) =>
      (scope.agentId === null || m.agent_id === scope.agentId) &&
      (scope.runId === null || m.run_id === scope.runId),
  );
}

/** 变更历史事件 → 展示元数据（标签 / 徽章配色） */
export const HISTORY_META: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' }> = {
  ADD: { label: '新增', variant: 'default' },
  UPDATE: { label: '更新', variant: 'secondary' },
  DELETE: { label: '删除', variant: 'destructive' },
};

export function historyMeta(event: string): { label: string; variant: 'default' | 'secondary' | 'destructive' } {
  return HISTORY_META[event] || { label: event, variant: 'secondary' };
}

/** 异步提炼事件状态 → 展示文案 */
export function eventStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'pending':
      return '排队中';
    case 'processing':
      return '提炼中';
    case 'done':
      return '已入库';
    case 'failed':
      return '提炼失败';
    default:
      return status || '—';
  }
}
