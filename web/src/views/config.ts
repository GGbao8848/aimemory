export type ViewName = 'memories' | 'keys' | 'guide';

export interface ViewMeta {
  name: ViewName;
  nav: string;
  title: string;
  sub: string;
}

export const VIEWS: ViewMeta[] = [
  {
    name: 'memories',
    nav: '我的记忆',
    title: '我的记忆',
    sub: 'agent 提交的素材经 LLM 提炼与冲突消解后的长期记忆',
  },
  {
    name: 'keys',
    nav: '接入 Token',
    title: '接入 Token',
    sub: '为每个 agent 客户端签发独立 Token，随时单独吊销',
  },
  {
    name: 'guide',
    nav: '接入指南',
    title: '接入指南',
    sub: 'mem0 形态 REST API 与 MCP 接入方式',
  },
];
