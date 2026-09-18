/**
 * 记忆系统拓扑模型：节点 / 线路 / 链路追踪脚本。
 *
 * 这里是「概念图」的事实来源——每个节点的 role / files / endpoints / 参数都对着
 * 仓库里的真实实现写（src/ 与 collector/），不是泛泛的示意图。改代码时这里要跟着改。
 *
 * 坐标：极坐标（angle 角度制，0° = 正东，逆时针为正；radius 世界单位）。
 * 同心环按「凝练度」由外向内：L0 原始 → L1 摘要 → L2 事实 → L3 画像，中心是存储内核。
 */

/** 环带定义：标签画在环弧上，用作层级图例 */
export const RINGS = [
  {
    id: 'l3',
    radius: 96,
    label: 'L3',
    name: '画像／知识',
    note: '双时间轴 · 从 L1+L2 长期凝练',
    state: 'live',
    labelAngle: 62,
  },
  {
    id: 'l2',
    radius: 196,
    label: 'L2',
    name: '事实记忆',
    note: 'mem0 式自包含条目 · 语义 + 关键词双路召回',
    state: 'live',
    labelAngle: 262,
  },
  {
    id: 'l1',
    radius: 320,
    label: 'L1',
    name: '会话摘要',
    note: '每会话情景记忆 · 后台静默生成 · 可从 L0 重放',
    state: 'live',
    labelAngle: 78,
  },
  {
    id: 'l0',
    radius: 448,
    label: 'L0',
    name: '原始会话归档',
    note: 'append-only 唯一事实源 · 上层皆可再生',
    state: 'live',
    labelAngle: 130,
  },
  {
    id: 'edge',
    radius: 575,
    label: '接入面',
    name: 'Access',
    note: 'MCP / REST / 采集上传 / 零粘贴授权',
    state: 'live',
    labelAngle: 12,
  },
];

/**
 * 节点。
 * kind: core 存储内核 | store 表/文件 | process 计算模块 | queue 缓冲 | io 出入口 |
 *       external 外部依赖 | actor 外部实体 | device 采集设备 | pending 未建
 * metric: 遥测取值路径（见 telemetry.js 的 MODEL 快照结构）；无则不显示数字
 */
export const NODES = [
  // ---------- 内核 ----------
  {
    id: 'core',
    label: '记忆内核',
    sub: 'SQLite · data/aimemory.db',
    ring: 'core',
    angle: 0,
    radius: 0,
    kind: 'core',
    accent: '#7dd3fc',
    metric: 'stats.memories',
    metricLabel: '条记忆',
    info: {
      role: '单文件库，WAL 模式，承载全部结构化状态。所有上层都是它的派生视图。',
      files: ['src/db/index.js', 'src/db/repo.js'],
      endpoints: [],
      params: [
        ['journal_mode', 'WAL'],
        ['synchronous', 'NORMAL'],
        ['容量实测', '773 QPS / p95 <1s / 0 错误'],
      ],
      note: '不存原始会话全文——L0 原文走 jsonl 归档；素材原文在提炼后即丢弃，只留产物。',
    },
  },
  {
    id: 'l3',
    label: 'L3 画像／知识',
    sub: '双时间轴',
    ring: 'l3',
    angle: 90,
    radius: 96,
    kind: 'store',
    accent: '#8b9dc3',
    metric: 'l3.active',
    metricLabel: '条',
    info: {
      role: '长期凝练的用户画像 / 项目约束 / 经验教训。低频、高价值。',
      files: ['src/l3/store.js', 'src/l3/scheduler.js', 'docs/L3-画像与知识层.md'],
      endpoints: ['GET /api/l3/entries', 'PUT /api/l3/entries/:id', 'POST /api/l3/run'],
      params: [
        ['输入', '新消化的 L1 摘要（攒够 5 个跑一轮，低频）'],
        ['关键设计', '双时间轴（事实何时为真 / 何时入库）'],
        ['旧事实', '不删，标记 superseded'],
      ],
      note: 'data/l3/ 下的 Markdown 文件，人工可审阅可编辑；后台凝练与手改合并共存。',
    },
  },

  // ---------- L2 事实记忆 ----------
  {
    id: 'l2_mem',
    label: 'memories 表',
    sub: '提炼产物 · 原文不入库',
    ring: 'l2',
    angle: 240,
    radius: 196,
    kind: 'store',
    accent: '#5eead4',
    metric: 'stats.memories',
    metricLabel: '条',
    info: {
      role: 'mem0 式自包含结构化条目。add_memory 的输入是素材，后台 LLM 提炼成多条后入此表。',
      files: ['src/db/repo.js', 'src/llm/client.js'],
      endpoints: ['GET /api/memories', 'POST /api/memories', 'PATCH/DELETE /api/memories/:id'],
      params: [
        ['写入语义', '异步受理 → 提炼 → 入库；提炼失败不落库'],
        ['返回≠入库', '必须轮询 get_event_status 到 done'],
      ],
      note: '明文存储无加密——不写入完整密码等敏感明文。',
    },
  },
  {
    id: 'l2_fts',
    minor: true,
    label: 'FTS5 trigram',
    sub: '关键词召回',
    ring: 'l2',
    angle: 288,
    radius: 196,
    kind: 'store',
    accent: '#5eead4',
    metric: null,
    info: {
      role: 'SQLite FTS5 trigram 虚拟表，中文子串也能命中（语义向量对专名不敏感时的兜底）。',
      files: ['src/db/index.js'],
      endpoints: [],
      params: [
        ['分词', 'trigram（查询 ≥3 字符）'],
        ['同步', 'AFTER INSERT/UPDATE/DELETE 触发器'],
        ['回退', 'embedding 不可用时退化为纯关键词'],
      ],
      note: '与向量召回结果融合排序后返回。',
    },
  },
  {
    id: 'l2_vec',
    minor: true,
    label: '向量召回',
    sub: '余弦相似 · float32 BLOB',
    ring: 'l2',
    angle: 330,
    radius: 196,
    kind: 'store',
    accent: '#5eead4',
    metric: null,
    info: {
      role: '记忆入库时算 embedding（float32 BLOB 存 memories 表），检索时按余弦相似度召回。',
      files: ['src/embeddings/client.js', 'scripts/backfill-embeddings.js'],
      endpoints: ['POST {EMBEDDING_BASE_URL}/v1/embeddings'],
      params: [
        ['存储', 'memories.embedding BLOB'],
        ['回填脚本', 'scripts/backfill-embeddings.js'],
      ],
      note: '同义、口语化查询靠这一路命中；服务抖动时熔断降级不阻塞。',
    },
  },
  {
    id: 'l2_search',
    minor: true,
    label: '混合检索',
    sub: '双路召回融合',
    ring: 'l2',
    angle: 194,
    radius: 196,
    kind: 'process',
    accent: '#a78bfa',
    metric: null,
    info: {
      role: 'search_memories 的执行体：向量召回 + FTS5 关键词召回，融合后按 threshold 过滤返回。',
      files: ['src/db/repo.js', 'src/mcp/tools.js'],
      endpoints: ['GET /api/memories?q='],
      params: [
        ['参数', 'query / limit / threshold / filters'],
        ['不支持', 'rerank（已刻意移除）'],
      ],
      note: '刻意不提供批量导入、整库管理、agent/run 维度——个人单账本。',
    },
  },
  {
    id: 'l2_events',
    minor: true,
    label: 'events 队列',
    sub: '202 受理 · 串行提炼',
    ring: 'l2',
    angle: 214,
    radius: 268,
    kind: 'queue',
    accent: '#fbbf24',
    metric: 'events.pending',
    metricLabel: '待处理',
    info: {
      role: '异步任务队列。add_memory(messages) 立即返回 event_id，后台串行提炼后入库。',
      files: ['src/db/repo.js', 'src/index.js'],
      endpoints: ['GET /api/events/:id', 'MCP get_event_status'],
      params: [
        ['轮询间隔', '2s'],
        ['并发', '串行（本地 LLM 低并发，不阻塞 MCP 调用）'],
        ['状态机', 'pending → processing → done | failed'],
      ],
      note: '本地低并发 LLM 下，同步提炼会把 MCP 调用拖死，故走队列。',
    },
  },

  // ---------- L1 会话摘要 ----------
  {
    id: 'l1_sched',
    minor: true,
    label: 'L1 调度器',
    sub: '静默 5min + 指纹判变',
    ring: 'l1',
    angle: 118,
    radius: 320,
    kind: 'process',
    accent: '#60a5fa',
    metric: 'l1.queued',
    metricLabel: '排队',
    info: {
      role: 'sleep-time 后台调度：会话静默一段时间才摘要（正在变的不摘）。',
      files: ['src/l1/scheduler.js'],
      endpoints: ['GET /api/l1/stats', 'POST /api/l1/run'],
      params: [
        ['静默阈值', 'AIMEMORY_L1_QUIET_MS = 5min'],
        ['轮询间隔', 'AIMEMORY_L1_INTERVAL_MS = 60s'],
        ['每轮处理', 'AIMEMORY_L1_BATCH = 6'],
        ['最大重试', '3 次'],
      ],
      note: '用 l0_records 的 count/version 聚合指纹判断是否变化：没变跳过，变了重跑。',
    },
  },
  {
    id: 'l1_comp',
    minor: true,
    label: '预算化压缩',
    sub: '滤系统注入 · 工具合并',
    ring: 'l1',
    angle: 152,
    radius: 320,
    kind: 'process',
    accent: '#60a5fa',
    metric: null,
    info: {
      role: '单会话平均 299K 字符、最大 4.6M，远超 LLM 上下文，必须先压缩再喂。',
      files: ['src/l1/summarize.js'],
      endpoints: [],
      params: [
        ['装配优先级', 'user 全文 > assistant 正文 > tool 仅名字 > reasoning 丢弃'],
        ['超预算', '保留头尾'],
        ['坑 1', '归档里 56% 的 user 记录是 agent 塞的系统提醒，必须滤除'],
        ['坑 2', '工具序列合并同名计数（7106 条 → 几十行）'],
      ],
      note: '输入按 rid+version 取最大版本收敛——ZCode 会原地更新，不收敛会摘到「写了一半」。',
    },
  },
  {
    id: 'l1_sum',
    label: 'l1_summaries',
    sub: '概述 / 决定 / 未决 / 产出',
    ring: 'l1',
    angle: 184,
    radius: 320,
    kind: 'store',
    accent: '#60a5fa',
    metric: 'l1.total',
    metricLabel: '会话',
    info: {
      role: '情景记忆：每个归档会话一条结构化摘要。',
      files: ['src/l1/summarize.js', 'src/db/index.js'],
      endpoints: ['GET /api/l1/summaries', 'MCP list_session_summaries / get_session_summary'],
      params: [
        ['输出字段', 'overview / decisions / pending / artifacts'],
        ['content_hash', '变了才重跑'],
        ['模型', '本地思考模型，单会话约 90-110s'],
      ],
      note: '非 JSON 输出判失败，不降级存下——否则「盘算过程」会被当正文。',
    },
  },

  // ---------- L0 原始归档 ----------
  {
    id: 'l0_file',
    label: 'data/l0/**/*.jsonl',
    sub: 'append-only 事实源',
    ring: 'l0',
    angle: 55,
    radius: 448,
    kind: 'store',
    accent: '#38bdf8',
    metric: 'l0.disk_bytes',
    metricLabel: '磁盘',
    info: {
      role: '原始会话归档：data/l0/<用户>/<设备>/<agent>/<会话>.jsonl，一行一条。',
      files: ['src/l0/store.js', 'collector/lib/schema.js'],
      endpoints: ['GET /api/l0/session', 'GET /api/l0/stats'],
      params: [
        ['每行自述来源', '_dev / _agent / _bid / _recv'],
        ['单机实测', '82 会话 ≈ 3.5 万条 ≈ 147MB'],
        ['AIMEMORY_KEEP_RAW', '=0 可省约一半体积'],
      ],
      note: '链路里最敏感的数据——含全部对话原文，不加密，目录权限等同密钥权限。',
    },
  },
  {
    id: 'l0_rec',
    minor: true,
    label: 'l0_records',
    sub: '记录级去重 (rid, version)',
    ring: 'l0',
    angle: 25,
    radius: 448,
    kind: 'store',
    accent: '#38bdf8',
    metric: 'l0.records',
    metricLabel: '条',
    info: {
      role: '真实落盘的唯一记录索引。同一 rid 的不同 version 保留（供收敛），完全相同的拦掉。',
      files: ['src/db/index.js'],
      endpoints: [],
      params: [
        ['主键', '(user, device, agent, session, rid, version)'],
        ['为何必需', '批次指纹挡不住「同内容不同分块」'],
        ['对账口径', 'stats 的 records 取此表，而非 l0_batches 累计值'],
      ],
      note: 'WITHOUT ROWID —— 纯索引表，体量大且只做去重。',
    },
  },
  {
    id: 'l0_batch',
    minor: true,
    label: 'l0_batches',
    sub: '批次指纹 _bid 幂等',
    ring: 'l0',
    angle: 88,
    radius: 448,
    kind: 'store',
    accent: '#38bdf8',
    metric: 'l0.batches',
    metricLabel: '批',
    info: {
      role: '批次级幂等：sha256(设备|agent|会话|记录集) 做 batch_id，重传直接跳过。',
      files: ['src/l0/store.js'],
      endpoints: [],
      params: [
        ['batch_id', 'sha256(设备|agent|会话|记录集)'],
        ['records 列', '累计接收量，会因重复批次虚高——不能当归档规模'],
      ],
      note: '两把锁配合：批次指纹挡整批重传，记录级唯一键挡分块差异。',
    },
  },

  // ---------- 接入面 ----------
  {
    id: 'ingest',
    minor: true,
    label: 'POST /api/l0/ingest',
    sub: '采集上传 · body 上限 64mb',
    ring: 'edge',
    angle: 55,
    radius: 575,
    kind: 'io',
    accent: '#22d3ee',
    metric: 'l0.last_received',
    metricLabel: '最近上传',
    info: {
      role: '采集器唯一上传入口。校验设备三元组、批次幂等、记录级去重后 append 落盘。',
      files: ['src/web/routes.js', 'src/index.js'],
      endpoints: ['POST /api/l0/ingest'],
      params: [
        ['body 上限', 'AIMEMORY_L0_MAX_BODY = 64mb（单独放宽，不沿用全局 1mb）'],
        ['单批记录', '≤5000，超限 413'],
        ['鉴权', 'Authorization: Token m0-xxx'],
      ],
      note: '只归档、不提炼——写入路径刻意不接 LLM / embedding。',
    },
  },
  {
    id: 'devflow',
    minor: true,
    label: '设备流授权',
    sub: '零粘贴签发 Token',
    ring: 'edge',
    angle: 100,
    radius: 575,
    kind: 'io',
    accent: '#22d3ee',
    metric: 'keys.active',
    metricLabel: '枚 Token',
    info: {
      role: 'agent 发起 → 浏览器口令确认 → agent 轮询拿 Token，全程零复制粘贴。',
      files: ['src/index.js', 'src/db/repo.js'],
      endpoints: ['POST /api/connect/start', 'GET /api/connect/poll', 'POST /api/connect/confirm'],
      params: [
        ['有效期', '授权请求 600s'],
        ['自动确认', 'confirm_token 匹配即免按钮（防 CSRF 诱导换发）'],
        ['多 Token', '按客户端命名，单独吊销'],
      ],
      note: '设备码不绑定密钥：设备身份属于机器，Token 属于授权，生命周期不同。',
    },
  },
  {
    id: 'auth',
    minor: true,
    label: 'Token 鉴权',
    sub: 'sha256 · 多枚并存',
    ring: 'edge',
    angle: 272,
    radius: 505,
    kind: 'io',
    accent: '#f472b6',
    metric: 'keys.active',
    metricLabel: '生效',
    info: {
      role: '统一鉴权：Token（sha256 校验，明文另存供 Web 回看）或 Web 会话 cookie。',
      files: ['src/auth/tokens.js', 'src/web/routes.js'],
      endpoints: ['POST/GET /api/keys', 'POST /api/keys/:id/revoke'],
      params: [
        ['校验', 'sha256(token) 比对 token_hash'],
        ['唯一约束', '同一用户未吊销的 Token 名称唯一'],
        ['Web 登录', '本地口令 + 15 分钟 10 次失败限速'],
      ],
      note: '库文件含 Token 明文——data/ 目录访问权限即等同密钥权限。',
    },
  },
  {
    id: 'mcp',
    label: '/mcp',
    sub: 'MCP Streamable HTTP · 9 工具',
    ring: 'edge',
    angle: 226,
    radius: 575,
    kind: 'io',
    accent: '#22d3ee',
    metric: 'keys.active',
    metricLabel: '接入',
    info: {
      role: 'agent 读写记忆的唯一在线入口。记忆类 7 个 + 会话摘要 2 个工具。',
      files: ['src/mcp/server.js', 'src/mcp/tools.js'],
      endpoints: ['POST /mcp'],
      params: [
        ['记忆工具', 'add_memory / search_memories / get_memories / get_memory / update_memory / delete_memory / get_event_status'],
        ['摘要工具', 'list_session_summaries / get_session_summary'],
        ['刻意不提供', 'infer / rerank / agent_id / run_id'],
      ],
      note: '返回≠入库：add_memory 返回 202 + event_id，必须查状态到 done。',
    },
  },
  {
    id: 'rest',
    label: '/api/* + Web',
    sub: 'REST + 管理控制台',
    ring: 'edge',
    angle: 316,
    radius: 575,
    kind: 'io',
    accent: '#22d3ee',
    metric: 'stats.keys',
    metricLabel: 'Token',
    info: {
      role: 'REST 接口与 Web 管理台（记忆 CRUD / 会话归档四级下钻 / Token 管理 / 导出）。',
      files: ['src/web/routes.js', 'src/web/static/'],
      endpoints: ['GET /api/stats', 'GET /api/l0/stats', 'GET /api/memories/export', 'GET /healthz'],
      params: [
        ['鉴权', 'Token 或 aim_session cookie'],
        ['归档下钻', '设备 → agent → 会话 → 详情'],
        ['导出', 'GET /api/memories/export（JSON 附件）'],
      ],
      note: '单端口 18543 同时承载 /mcp + /api/* + Web 页 + /healthz。',
    },
  },

  // ---------- 外部依赖 ----------
  {
    id: 'llm',
    label: 'LLM 服务',
    sub: 'chat/completions · 提炼与摘要',
    ring: 'ext',
    angle: 140,
    radius: 530,
    kind: 'external',
    accent: '#c084fc',
    metric: 'health.llm',
    metricLabel: '健康',
    info: {
      role: 'OpenAI 兼容 chat/completions。两条消费路径：素材提炼（L2）与会话摘要（L1）。',
      files: ['src/llm/client.js'],
      endpoints: ['POST {LLM_BASE_URL}/v1/chat/completions'],
      params: [
        ['摘要 max_tokens', '8000（设 1500 会因思考耗尽预算导致 content 为空）'],
        ['摘要超时', '240s（默认 30s 不够）'],
        ['熔断', '抖动自动降级、恢复自动探测回补，无需重启'],
      ],
      note: 'LLM_ENABLED=false 时写入直接拒绝，不让素材「收了但不处理」。',
    },
  },
  {
    id: 'emb',
    label: 'Embedding 服务',
    sub: 'embeddings · 语义向量',
    ring: 'ext',
    angle: 352,
    radius: 505,
    kind: 'external',
    accent: '#c084fc',
    metric: 'health.embedding',
    metricLabel: '健康',
    info: {
      role: 'OpenAI 兼容 /v1/embeddings。入库算向量、检索算查询向量。',
      files: ['src/embeddings/client.js'],
      endpoints: ['POST {EMBEDDING_BASE_URL}/v1/embeddings'],
      params: [
        ['不可用时', '自动回退纯关键词检索（FTS5）'],
        ['健康探测', '/healthz 的 embedding 字段'],
      ],
      note: 'embedding 是可选件——不启用系统仍可用，只是失去同义/口语化召回。',
    },
  },
];

/**
 * 线路。
 * kind: data 数据流 | derive 派生/重放 | query 检索 | external 外部依赖 | pending 待建
 * dir: 1 单向 from→to；-1 反向；0 双向（保留语义，动画同向）
 * bow: 贝塞尔控制点偏移（世界单位，正值向圆心外侧弯）——手工避让用
 */
export const LINKS = [
  // 采集上传链
  { from: 'ingest', to: 'l0_batch', kind: 'data', label: '批次指纹', speed: 0.55, density: 7, weight: 1.0 },
  { from: 'ingest', to: 'l0_rec', kind: 'data', label: '记录级去重', speed: 0.55, density: 9, weight: 0.85, bow: -26 },
  { from: 'ingest', to: 'l0_file', kind: 'data', label: 'append jsonl', speed: 0.45, density: 5, weight: 1.2 },

  // L0 → L1（重放）
  { from: 'l0_file', to: 'l1_sched', kind: 'derive', label: '按 rid+version 收敛', speed: 0.30, density: 2, weight: 1.15, bow: 40 },
  { from: 'l0_rec', to: 'l1_sched', kind: 'derive', label: '内容指纹判变', speed: 0.34, density: 6, weight: 0.8, bow: 30 },

  // L1 内部
  { from: 'l1_sched', to: 'l1_comp', kind: 'data', label: '预算化装配', speed: 0.5, density: 6, weight: 1.0 },
  { from: 'l1_comp', to: 'llm', kind: 'external', label: 'prompt（240s 超时）', speed: 0.42, density: 4, weight: 1.1, bow: 18 },
  { from: 'llm', to: 'l1_sum', kind: 'external', label: 'JSON 摘要', speed: 0.42, density: 4, weight: 1.1, bow: 18 },
  { from: 'l1_sum', to: 'core', kind: 'data', label: '落库', speed: 0.6, density: 8, weight: 0.9, bow: 34 },
  { from: 'l1_sum', to: 'mcp', kind: 'query', label: 'list/get_session_summary', speed: 0.65, density: 5, weight: 0.7, bow: -70 },

  // 素材沉淀链（MCP 写）
  { from: 'mcp', to: 'l2_events', kind: 'data', label: 'add_memory → 202', speed: 0.75, density: 7, weight: 1.2, bow: 22 },
  { from: 'l2_events', to: 'llm', kind: 'external', label: '素材提炼', speed: 0.40, density: 2, weight: 1.0, bow: 80 },
  { from: 'llm', to: 'l2_mem', kind: 'external', label: '结构化事实', speed: 0.44, density: 4, weight: 1.15, bow: 40 },
  { from: 'l2_mem', to: 'core', kind: 'data', label: '入库', speed: 0.6, density: 8, weight: 0.95, bow: 26 },
  { from: 'l2_mem', to: 'l2_fts', kind: 'derive', label: 'FTS 触发器', speed: 0.7, density: 10, weight: 0.8 },
  { from: 'l2_mem', to: 'l2_vec', kind: 'derive', label: 'embedding', speed: 0.5, density: 5, weight: 0.9, bow: -40 },
  { from: 'l2_vec', to: 'emb', kind: 'external', label: '算向量', speed: 0.5, density: 4, weight: 1.05 },

  // 召回链（MCP 读）
  { from: 'mcp', to: 'l2_search', kind: 'query', label: 'search_memories', speed: 0.85, density: 8, weight: 1.3 },
  { from: 'l2_search', to: 'l2_vec', kind: 'query', label: '语义召回', speed: 0.8, density: 8, weight: 1.0, bow: -34 },
  { from: 'l2_search', to: 'l2_fts', kind: 'query', label: '关键词召回', speed: 0.8, density: 8, weight: 1.0 },
  { from: 'l2_search', to: 'mcp', kind: 'query', label: '融合排序返回', speed: 0.9, density: 6, weight: 1.0, bow: 18 },

  // 外部实体 → 入口
  { from: 'agent', to: 'mcp', kind: 'query', label: '工具调用', speed: 0.8, density: 6, weight: 1.0, bow: 24 },
  { from: 'browser', to: 'rest', kind: 'control', label: '口令会话', speed: 0.6, density: 5, weight: 0.85, bow: 22 },

  // 鉴权 / 管理
  { from: 'mcp', to: 'auth', kind: 'control', label: 'Token 校验', speed: 0.5, density: 4, weight: 0.7, bow: 20 },
  { from: 'ingest', to: 'auth', kind: 'control', label: 'Token 校验', speed: 0.5, density: 4, weight: 0.7, bow: 26 },
  { from: 'rest', to: 'auth', kind: 'control', label: '会话 / Token', speed: 0.5, density: 4, weight: 0.7, bow: 20 },
  { from: 'devflow', to: 'mcp', kind: 'control', label: '签发 Token', speed: 0.6, density: 4, weight: 0.75, bow: 40 },
  { from: 'rest', to: 'l2_mem', kind: 'query', label: '管理 / 导出', speed: 0.6, density: 4, weight: 0.7, bow: -60 },
  { from: 'rest', to: 'l0_file', kind: 'query', label: '归档下钻', speed: 0.6, density: 4, weight: 0.7, bow: -50 },

  // L3 待建（虚线、不发光）
  { from: 'l1_sum', to: 'l3', kind: 'derive', label: '长期凝练', speed: 0.18, density: 2, weight: 0.5, bow: 20 },
  { from: 'l2_mem', to: 'l3', kind: 'derive', label: '长期凝练', speed: 0.18, density: 2, weight: 0.5, bow: -20 },
];

/**
 * 链路追踪脚本：点一个按钮，逐跳点亮，配合底部说明把整条链路讲完。
 * 每步可高亮若干节点与线路；link 用 "from→to" 指定。
 */
export const TRACES = [
  {
    id: 'ingest',
    name: '追踪一次采集归档',
    desc: '从某台机器 agent 会话产生，到落成 L0 jsonl、再被 L1 摘成情景记忆',
    accent: '#38bdf8',
    steps: [
      {
        nodes: ['device:0'],
        links: [],
        title: '① 采集器读到新会话行',
        detail: '各机 pm2 常驻采集器按 15s 一轮扫描：Codex/Claude 走文件 offset，ZCode 走水位线 + 5 分钟重叠窗口。尾部未写完的半行不解析，offset 停在最后完整换行处。',
      },
      {
        nodes: ['device:0', 'ingest'],
        links: ['device:0→ingest'],
        title: '② 归一化记录流上传',
        detail: '批次带设备三元组（设备码 + 设备信息 + agent）。上传器只认归一化 schema——它不知道对面是哪种 agent，新增 agent 只加 adapter，上传层一行不改。',
      },
      {
        nodes: ['ingest', 'l0_batch'],
        links: ['ingest→l0_batch'],
        title: '③ 批次指纹幂等',
        detail: 'batch_id = sha256(设备|agent|会话|记录集)。重传同一批次直接跳过。但指纹对整个批次内容敏感——分块方式一变就算出不同指纹，所以还需要下一层的记录级兜底。',
      },
      {
        nodes: ['ingest', 'l0_rec', 'l0_file'],
        links: ['ingest→l0_rec', 'ingest→l0_file'],
        title: '④ 记录级去重后 append',
        detail: '(设备, agent, 会话, rid, version) 唯一键拦掉纯冗余；同一 rid 的不同 version 保留——ZCode 会原地更新内容，靠版本号收敛。落盘 data/l0/<用户>/<设备>/<agent>/<会话>.jsonl，每行自述来源。',
      },
      {
        nodes: ['l0_file', 'l1_sched'],
        links: ['l0_file→l1_sched', 'l0_rec→l1_sched'],
        title: '⑤ 静默 5 分钟后排队',
        detail: '会话还在变就摘要等于白跑。L1 调度器用 l0_records 的 count/version 聚合指纹判断内容是否变化：没摘过就排队，摘过且指纹相同就跳过，指纹变了重新排队。',
      },
      {
        nodes: ['l1_sched', 'l1_comp'],
        links: ['l1_sched→l1_comp'],
        title: '⑥ 预算化压缩',
        detail: '单会话平均 299K 字符、最大 4.6M，远超上下文。按「user 全文 > assistant 正文 > tool 仅名字 > reasoning 丢弃」装配。两个实测坑：归档里 56% 的 user 记录是 agent 塞的系统提醒必须滤除；工具序列要合并同名计数（7106 条 → 几十行）。',
      },
      {
        nodes: ['l1_comp', 'llm', 'l1_sum'],
        links: ['l1_comp→llm', 'llm→l1_sum'],
        title: '⑦ LLM 摘要（90-110 秒）',
        detail: '输出概述 / 关键决定 / 未决事项 / 产出物。max_tokens 必须给到 8000——设 1500 会因思考耗尽预算导致 content 为空；超时给 240s，默认 30s 会掐断。非 JSON 输出直接判失败，不降级存下。',
      },
      {
        nodes: ['l1_sum', 'core'],
        links: ['l1_sum→core'],
        title: '⑧ 落 l1_summaries',
        detail: '每个会话一条，content_hash 记录当时内容指纹。想换摘要算法？清掉 content_hash 即可从 L0 重跑——这就是「L0 是唯一事实源、上层皆可再生」的实际含义。',
      },
    ],
  },
  {
    id: 'remember',
    name: '追踪一次记忆沉淀',
    desc: 'MCP add_memory 递交素材 → 后台提炼 → 入库 → 建索引',
    accent: '#5eead4',
    steps: [
      {
        nodes: ['agent', 'mcp'],
        links: ['agent→mcp'],
        title: '① agent 递交素材',
        detail: 'add_memory { text } 或 { messages }。输入一律视为「素材」而不是记忆——它不会直接落库，也不存原文。',
      },
      {
        nodes: ['mcp', 'l2_events'],
        links: ['mcp→l2_events'],
        title: '② 异步受理，返回 202',
        detail: '立即返回 { event_id, status: pending }。本地 LLM 并发低，同步提炼会把 MCP 调用拖死，所以走队列，2 秒一轮串行处理。返回 ≠ 已入库，必须轮询 get_event_status。',
      },
      {
        nodes: ['l2_events', 'llm'],
        links: ['l2_events→llm'],
        title: '③ LLM 提炼成自包含事实',
        detail: '把素材拆成多条独立可检索的结构化记忆。提炼失败不落库——宁可让调用方看到 failed，也不留半成品污染检索。',
      },
      {
        nodes: ['llm', 'l2_mem'],
        links: ['llm→l2_mem'],
        title: '④ 结构化记忆入库',
        detail: '只有提炼产物进 memories 表。LLM_ENABLED=false 时写入直接 503 拒绝，避免「收了但不处理」。',
      },
      {
        nodes: ['l2_mem', 'l2_fts', 'l2_vec', 'emb'],
        links: ['l2_mem→l2_fts', 'l2_mem→l2_vec', 'l2_vec→emb'],
        title: '⑤ 两路索引同时建好',
        detail: 'FTS5 trigram 靠数据库触发器同步（中文子串也能命中）；向量走 embedding 服务算好后以 float32 BLOB 存回 memories 表。embedding 不可用时自动回退纯关键词，不影响写入。',
      },
      {
        nodes: ['mcp', 'l2_mem'],
        links: ['l2_mem→core'],
        title: '⑥ 轮询到 done',
        detail: 'get_event_status 返回 done 与产物记忆 id 列表。此时才真正「记住了」。',
      },
    ],
  },
  {
    id: 'recall',
    name: '追踪一次记忆召回',
    desc: 'MCP search_memories 双路召回 → 融合 → 回给 agent',
    accent: '#a78bfa',
    steps: [
      {
        nodes: ['agent', 'mcp'],
        links: ['agent→mcp'],
        title: '① agent 提问',
        detail: 'search_memories { query, limit?, threshold? }。参数刻意只保留 mem0 子集，不支持 rerank。',
      },
      {
        nodes: ['mcp', 'l2_search'],
        links: ['mcp→l2_search'],
        title: '② 混合检索执行',
        detail: '不选路，两路都走——单靠向量对专名/代码标识符不敏感，单靠关键词对同义和口语化不敏感，个人记忆库两种问法都很常见。',
      },
      {
        nodes: ['l2_search', 'l2_vec', 'emb'],
        links: ['l2_search→l2_vec', 'l2_vec→emb'],
        title: '③ 语义召回',
        detail: '查询文本算成向量，与库内 float32 向量做余弦相似度召回。这一路负责命中「换了说法的同一件事」。',
      },
      {
        nodes: ['l2_search', 'l2_fts'],
        links: ['l2_search→l2_fts'],
        title: '④ 关键词召回',
        detail: 'FTS5 trigram 分词，中文子串可命中。这一路负责精确命中标识符、路径、专名。',
      },
      {
        nodes: ['l2_search', 'mcp', 'agent'],
        links: ['l2_search→mcp', 'mcp→agent'],
        title: '⑤ 融合排序后返回',
        detail: '融合两路结果、按 threshold 过滤，按 limit 返回给 agent。整个查询路径读完就走，不写任何状态。',
      },
    ],
  },
];

/** 外部实体节点（演员）：不写死在 NODES 里，因为设备是运行时按真实数据生成的 */
export const ACTORS = [
  {
    id: 'agent',
    label: 'MCP 客户端',
    sub: 'Claude Code / ZCode / Codex',
    ring: 'ext',
    angle: 208,
    radius: 690,
    kind: 'actor',
    accent: '#94a3b8',
    metric: null,
    info: {
      role: '调用方 agent。经 MCP（Streamable HTTP）读写记忆，配置只需 url + Authorization 头。',
      files: ['skills/aimemory/SKILL.md', 'skills/aimemory-recall/SKILL.md', 'skills/aimemory-remember/SKILL.md'],
      endpoints: ['http://<内网IP>:18543/mcp'],
      params: [
        ['接入方式', '只走 skill + MCP API 两条路（已取消插件分发）'],
        ['召回技能', 'aimemory-recall 自动召回'],
        ['沉淀技能', 'aimemory-remember 自动沉淀'],
      ],
      note: '配套 skill 可在 Web「接入指南」页下载 zip。',
    },
  },
  {
    id: 'browser',
    label: '人 · 管理台',
    sub: '本地口令登录',
    ring: 'ext',
    angle: 330,
    radius: 660,
    kind: 'actor',
    accent: '#94a3b8',
    metric: null,
    info: {
      role: '你。在 Web 页看记忆、下钻会话归档、签发/吊销 Token、导出全量记忆。',
      files: ['src/web/static/', 'atlas/'],
      endpoints: ['GET /', 'GET /healthz'],
      params: [
        ['登录', 'AIMEMORY_PASSWORD 本地口令，无外部 SSO'],
        ['会话', 'sessions 表 + HttpOnly cookie'],
        ['限速', '同 IP 15 分钟 10 次失败'],
      ],
      note: '单用户部署：一个个人账本，多设备多 agent 共享。',
    },
  },
];
