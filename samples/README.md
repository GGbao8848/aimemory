# 前端样例集（多框架对照）

> 目的：星图（`atlas/`，原生 ESM + WebGL2）之外，用不同技术栈各做一个**可运行的对照样例**，
> 评估"信息架构 × 技术栈"的组合，再决定生产前端往哪个方向深化。样例不是生产代码——
> 不追求功能对齐，每家展示自己最擅长的一种形态。

| 样例 | 访问 | 技术栈 | 形态 | 一句话点评 |
|---|---|---|---|---|
| 记忆星图（现役） | `/` | 原生 ESM + WebGL2 + 手写 GLSL | 活体概念图 | 氛围与"系统怎么运转"的表达力最强；渲染管线手写、改动成本最高 |
| **3D 星系** | `/samples/three-3d/` | Three.js r160（本地 vendor） | 真 3D 同心环 + 弧线线路 | 空间感/可玩性最强，拖拽旋转缩放；信息密度最低，适合展示而非日常运维 |
| **响应式图谱** | `/samples/vue-graph/` | Vue 3（ESM 浏览器版，免构建） | SVG 极坐标图谱 + 声明式检视面板 | 响应式模型写交互最省代码；SVG 信息密度适中，最"实用"的对照项 |
| **控制台** | `/samples/preact-dashboard/` | Preact + htm standalone（免构建，React 同款 Hooks API） | KPI 卡 + 审计表 + 条目流 | 信息密度最高、运维台账气质；放弃了空间隐喻，换"一眼看全" |

## 共同约定

- **同一数据源**：全部读 `/api/atlas/overview` + `/healthz`（React 版额外读 `/api/l2/ops`、`/api/l3/entries`），
  与 atlas 完全同源；未登录或接口不可达时自动切内置演示数据，角标会注明。
- **离线可用**：框架库已 vendor 到 `samples/lib/`（three/vue/preact-standalone），内网部署不拉 CDN。
- **拓扑事实源不抄两份**：3D 与图谱样例直接 `import '/js/topology.js'`（atlas 的数据），改拓扑两处同步。
- **零构建**：三家都可以直接静态部署；Preact 用 htm 免 JSX 编译，Vue 用浏览器版 ESM（React 18 的 UMD 构建已停止维护且实测配对有问题，故样例采用 React 同款 API 的 Preact）。

## 怎么选（给决策的粗尺子）

- 要「一眼看懂系统 + 氛围」→ atlas 星图（现役）
- 要「给人演示、有 wow 感」→ three-3d
- 要「日常真用来查问题」→ react-dashboard（信息密度）或 vue-graph（折中）
- 生产建议：**星图为门面 + react-dashboard 的审计表并入 /admin**，二者互补不互斥
