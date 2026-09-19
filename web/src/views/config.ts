import type { ComponentType, SVGProps } from 'react';
import { GuideIcon, KeysIcon, L3Icon, MemoriesIcon, OpsIcon, SessionsIcon } from '../components/Icons.tsx';

export type ViewName = 'memories' | 'keys' | 'sessions' | 'ops' | 'l3' | 'guide';

export interface ViewMeta {
  name: ViewName;
  nav: string;
  title: string;
  sub: string;
  Icon: ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;
}

export const VIEWS: ViewMeta[] = [
  {
    name: 'memories',
    nav: '我的记忆',
    title: '我的记忆',
    sub: '管理 agent 为你沉淀的记忆，跨会话复用',
    Icon: MemoriesIcon,
  },
  {
    name: 'keys',
    nav: '接入 Token',
    title: '接入 Token',
    sub: '为每个 agent 客户端签发独立 Token，随时单独吊销',
    Icon: KeysIcon,
  },
  {
    name: 'sessions',
    nav: '会话归档',
    title: '会话归档',
    sub: '各设备 agent 的原始会话备份（只归档，不做 AI 加工）',
    Icon: SessionsIcon,
  },
  {
    name: 'ops',
    nav: '操作审计',
    title: '记忆操作审计',
    sub: '冲突消解的每一次判定，被删原文可追溯',
    Icon: OpsIcon,
  },
  {
    name: 'l3',
    nav: 'L3 画像',
    title: 'L3 画像/知识',
    sub: '长期成立的条目（data/l3 markdown），可直接编辑',
    Icon: L3Icon,
  },
  {
    name: 'guide',
    nav: '接入指南',
    title: '接入指南',
    sub: 'MCP 接入步骤与工具说明',
    Icon: GuideIcon,
  },
];
