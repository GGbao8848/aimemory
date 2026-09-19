// 会话归档（L0）层级下钻逻辑：设备 → agent → 会话 → 详情。
// 纯函数，不含 DOM——「切换设备必须清空 agent 选择」这类层级不变量由 test/web-logic.test.js 守护。

export interface DeviceRow {
  device_code: string;
  label?: string | null;
  agents?: string[];
  info?: Record<string, unknown>;
  fingerprint?: string | null;
  fingerprint_source?: string | null;
  sessions?: number;
  records?: number;
  bytes?: number;
  last_seen?: string | null;
}

export interface SessionRow {
  agent: string;
  session_id: string;
  device_code?: string | null;
  records?: number;
  bytes?: number;
  first_received?: string | null;
  last_received?: string | null;
}

export interface ArchiveFilter {
  device: string | null;
  agent: string | null;
}

export interface AgentAgg {
  agent: string;
  sessions: number;
  records: number;
  bytes: number;
  last: string | null;
}

export const emptyFilter: ArchiveFilter = { device: null, agent: null };

/** 点设备：再点同一台收起；换设备时清空 agent（否则会把旧设备的 agent 当成新设备的筛选） */
export function toggleDevice(current: ArchiveFilter, deviceCode: string): ArchiveFilter {
  return { device: current.device === deviceCode ? null : deviceCode, agent: null };
}

/** 点 agent：再点同一个收起；设备不变 */
export function toggleAgent(current: ArchiveFilter, agent: string): ArchiveFilter {
  return { device: current.device, agent: current.agent === agent ? null : agent };
}

/** 层级可见性：agent 卡要先选设备，会话卡要再选 agent */
export function layersVisible(filter: ArchiveFilter): { agents: boolean; sessions: boolean } {
  return { agents: !!filter.device, sessions: !!filter.device && !!filter.agent };
}

/** 该设备的 agent 汇总（按会话数/条数聚合，最近活跃倒序） */
export function aggregateAgents(sessions: SessionRow[]): AgentAgg[] {
  const m = new Map<string, AgentAgg>();
  for (const s of sessions) {
    const a = m.get(s.agent) || { agent: s.agent, sessions: 0, records: 0, bytes: 0, last: null };
    a.sessions += 1;
    a.records += s.records || 0;
    a.bytes += s.bytes || 0;
    if (!a.last || String(s.last_received || '') > a.last) a.last = s.last_received || null;
    m.set(s.agent, a);
  }
  return [...m.values()].sort((x, y) => String(y.last || '').localeCompare(String(x.last || '')));
}

/** 当前筛选下的会话明细：未选 agent 不展示（下钻到第三级才出现） */
export function visibleSessions(sessions: SessionRow[], filter: ArchiveFilter): SessionRow[] {
  if (!filter.device || !filter.agent) return [];
  return sessions.filter((s) => s.agent === filter.agent);
}

export function deviceName(devices: DeviceRow[], deviceCode: string | null): string {
  const dev = devices.find((d) => d.device_code === deviceCode);
  return (dev && (dev.label || dev.device_code)) || String(deviceCode || '');
}

export function totalBytes(sessions: SessionRow[]): number {
  return sessions.reduce((n, s) => n + (s.bytes || 0), 0);
}
