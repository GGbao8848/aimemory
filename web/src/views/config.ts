export type ViewName =
  | 'dashboard'
  | 'memories'
  | 'entities'
  | 'archives'
  | 'requests'
  | 'playground'
  | 'exports'
  | 'webhooks'
  | 'settings'
  | 'keys'
  | 'guide';

export interface ViewMeta {
  name: ViewName;
  nav: string;
  title: string;
  sub: string;
}

export const VIEWS: ViewMeta[] = [
  {
    name: 'dashboard',
    nav: '概览',
    title: '概览',
    sub: '记忆库的总量、操作趋势与最近活动',
  },
  {
    name: 'memories',
    nav: '我的记忆',
    title: '我的记忆',
    sub: 'agent 提交的素材经 LLM 提炼与冲突消解后的长期记忆',
  },
  {
    name: 'entities',
    nav: '实体',
    title: '实体',
    sub: '从记忆中抽取的专有名词聚合（点击实体查看关联记忆）',
  },
  {
    name: 'archives',
    nav: '素材归档',
    title: '素材归档',
    sub: '提交素材的原文（默认保留 90 天）。提炼不满意或换了模型时，可单条/批量/全库重提',
  },
  {
    name: 'requests',
    nav: '活动日志',
    title: '活动日志',
    sub: '每条记忆的新增/更新/删除留痕（含来源与生效状态）',
  },
  {
    name: 'playground',
    nav: '试玩',
    title: 'Playground',
    sub: '交互式检索与写入测试，直观感受记忆库的召回效果',
  },
  {
    name: 'exports',
    nav: '导出',
    title: '记忆导出',
    sub: '全量记忆导出为 JSON 或 CSV，数据随时可携带',
  },
  {
    name: 'webhooks',
    nav: 'Webhooks',
    title: 'Webhooks',
    sub: '记忆变更（新增/更新/删除）实时通知你的外部系统',
  },
  {
    name: 'settings',
    nav: '模型设置',
    title: '模型设置',
    sub: 'LLM / Embedding 接入参数与功能开关，保存后即时生效',
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
