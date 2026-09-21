// 记忆视图纯逻辑：事件状态/来源/历史映射，node --test 直接守护。

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

/** 记忆写入来源 → 展示元数据（标签 / 徽章配色）；未知值兜底原样展示 */
export const ORIGIN_META: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  direct: { label: '直接存储', variant: 'secondary' },
  llm: { label: 'LLM 提炼', variant: 'outline' },
  'llm+embedding': { label: 'LLM+向量', variant: 'default' },
};

export function originMeta(origin: string | null | undefined): { label: string; variant: 'default' | 'secondary' | 'outline' } {
  return (origin && ORIGIN_META[origin]) || { label: origin || '—', variant: 'outline' };
}
