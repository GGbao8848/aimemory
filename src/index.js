'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const AdmZip = require('adm-zip');
const cookieParser = require('cookie-parser');
const config = require('./config');
const repo = require('./db/repo');
const keycloak = require('./auth/keycloak');
const { handleMcpRequest } = require('./mcp/server');
const web = require('./web/routes');
const vec = require('./l2/vec');

const app = express();
app.disable('x-powered-by');
app.use(cookieParser());

// 其余 API 维持 1mb 上限
app.use(express.json({ limit: '1mb' }));

// ===== 配套技能（下载/预览，公开）=====
// 配套 skill 源目录（skills/aimemory）：单一 skill + references/（召回/沉淀/管理三篇按需读）
const SKILLS_DIR = path.join(config.root, 'skills');
const SKILL_NAMES = ['aimemory'];
const MAIN_SKILL_MD = path.join(SKILLS_DIR, 'aimemory', 'SKILL.md');

// 技能 zip 包下载：aimemory-skills.zip（内含 aimemory skill 目录，解压后放入 skills/ 或上传安装）
app.get('/skill/download', (_req, res) => {
  if (!fs.existsSync(MAIN_SKILL_MD)) {
    res.status(404).send('配套技能 skills/ 不存在（请检查服务器部署目录）');
    return;
  }
  const zip = new AdmZip();
  for (const name of SKILL_NAMES) {
    const dir = path.join(SKILLS_DIR, name);
    if (fs.existsSync(dir)) zip.addLocalFolder(dir, name);
  }
  const buf = zip.toBuffer();
  const zipFileName = 'aimemory-skills.zip';
  res
    .set('Content-Type', 'application/zip')
    .set('Content-Disposition', `attachment; filename="aimemory-skills.zip"; filename*=UTF-8''${encodeURIComponent(zipFileName)}`)
    .send(buf);
});

// 单文件预览/另存：主管理技能（aimemory/SKILL.md）
app.get('/skill/SKILL.md', (_req, res) => {
  if (!fs.existsSync(MAIN_SKILL_MD)) {
    res.status(404).send('配套技能 skills/aimemory/SKILL.md 不存在（请检查服务器部署目录）');
    return;
  }
  res.type('text/markdown; charset=utf-8').sendFile(MAIN_SKILL_MD);
});

// ===== 静态资源 =====
// 管理台是 web/（React + Vite + TS）的构建产物：`/admin` 与 `/` 指向同一个 SPA。
// 契约仍只有 REST（openapi 守护）；产品前端如另建，直连 /v1 /v2 /api 与 /mcp 即可。
const WEB_DIST = path.join(config.root, 'web', 'dist');
const WEB_BUILD_FILE = path.join(WEB_DIST, 'index.html');
if (fs.existsSync(WEB_BUILD_FILE)) {
  app.get('/admin', (_req, res) => res.sendFile(WEB_BUILD_FILE));
  // 登录成功后的跳转落在 `/`，故 SPA 同时挂在根路径（/api、/mcp、/auth 等显式路由优先匹配）
  app.use(express.static(WEB_DIST));
} else {
  const hint = '前端未构建：仓库根执行 npm run web:install && npm run web:build（Docker 镜像内已自动构建）';
  app.get(['/admin', '/'], (_req, res) => res.status(503).type('text/plain; charset=utf-8').send(hint));
}

// ===== MCP 端点（Streamable HTTP）=====
app.post('/mcp', handleMcpRequest);
// Streamable HTTP 客户端可能用 GET 探测（部分实现），幂等返回提示
app.get('/mcp', (_req, res) =>
  res.status(200).json({ jsonrpc: '2.0', result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } }, id: null })
);

// ===== REST：mem0 形态 API（/v1 /v2，对外接入面）+ /api（管理台自用面）=====
app.use('/', require('./api/mem0').router);
app.use('/api', web.apiRouter);

// ===== Keycloak 登录（多租户）=====
// Web 面经 Keycloak OIDC（授权码 + PKCE）登录：成功后建立本地会话（sessions 表 +
// aim_session cookie），用户首次登录自动建档（users 表，sub 即 user_id）。
// 机器面（MCP / /v1 /v2 /api）不受影响：继续用 m0- Token 鉴权。

/** 站内跳转白名单（防开放重定向） */
function safeNext(v) {
  return typeof v === 'string' && v.startsWith('/') && !v.includes('//') ? v : '/';
}

// 登录：跳 Keycloak 授权页。?next= 支持站内跳转（回调后落到目标页）
app.get('/auth/login', async (req, res) => {
  if (!config.keycloak.enabled) {
    return res.status(503).type('text/plain; charset=utf-8').send(
      '未配置 Keycloak：多租户登录需要在 .env 设置 KEYCLOAK_URL（并按 docs/部署-生产机.md 注册 client aimemory-web），配置后重启。\n' +
      '机器接入（MCP / mem0 API）不受影响，继续使用 Authorization: Token m0-xxx。'
    );
  }
  try {
    const next = safeNext(req.query.next);
    const redirectUri = web.buildRedirectUri(req);
    const { url, state, verifier } = await keycloak.buildAuthorizeUrl(redirectUri);
    // state 校验 + verifier + next 都放 HttpOnly cookie（PKCE）
    res.cookie('kc_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
    res.cookie('kc_verifier', verifier, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
    res.cookie('kc_next', next, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
    res.redirect(url);
  } catch (e) {
    res.status(502).type('text/plain; charset=utf-8').send(`登录发起失败: ${e.message}`);
  }
});

// 回调：授权码换 token → JWKS 验签 → 登录即建档 → 建立本地会话
app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).type('text/plain; charset=utf-8').send(`Keycloak 登录失败: ${error}`);
    if (state !== req.cookies?.kc_state) return res.status(400).type('text/plain; charset=utf-8').send('state 校验失败（防 CSRF）');
    const redirectUri = web.buildRedirectUri(req);
    const { user, tokens: kcTokens } = await keycloak.exchangeCode(redirectUri, code, req.cookies.kc_verifier);
    repo.upsertUser(user);
    const sid = crypto.randomBytes(24).toString('hex');
    repo.createSession(sid, user.id, config.sessionTtlMs, user.username);
    res.cookie('aim_session', sid, { httpOnly: true, sameSite: 'lax', maxAge: config.sessionTtlMs });
    // 保存 id_token（HttpOnly，仅用于登出时拼 end_session 参数）
    if (kcTokens.id_token) {
      res.cookie('kc_id_token', kcTokens.id_token, { httpOnly: true, sameSite: 'lax', maxAge: config.sessionTtlMs });
    }
    res.clearCookie('kc_state');
    res.clearCookie('kc_verifier');
    const next = req.cookies?.kc_next || '/';
    res.clearCookie('kc_next');
    res.redirect(next.startsWith('/') ? next : '/');
  } catch (e) {
    res.status(502).type('text/plain; charset=utf-8').send(`登录回调失败: ${e.message}`);
  }
});

// 登出：清本地会话 → 跳 Keycloak end_session（携带 id_token_hint），SSO 各端同时退出
app.get('/auth/logout', async (req, res) => {
  const sid = req.cookies?.aim_session;
  if (sid) {
    repo.deleteSession(sid);
    res.clearCookie('aim_session');
  }
  res.clearCookie('kc_id_token');
  if (!config.keycloak.enabled) return res.redirect('/');
  try {
    const kcLogout = await keycloak.buildLogoutUrl(web.buildRedirectUri(req, '/'), req.cookies?.kc_id_token);
    res.redirect(kcLogout);
  } catch {
    res.redirect('/');
  }
});

// 单点登出（SLO front-channel）：Keycloak 在该 realm 任一 client 登出（end_session）后，
// 会以 iframe 加载本 client 配置的 frontchannel.logout.url —— 即本端点，据此清除本地会话
// cookie（在 BR-Agent 登出 → aimemory 也退出）。必须返回 200（iframe 要求）。
app.get('/slo-logout', (req, res) => {
  const sid = req.cookies?.aim_session;
  if (sid) {
    repo.deleteSession(sid);
    res.clearCookie('aim_session');
  }
  res.clearCookie('kc_id_token');
  res.clearCookie('kc_state');
  res.clearCookie('kc_verifier');
  res.clearCookie('kc_next');
  res.status(200).type('text/plain').send('ok');
});

// ===== 健康检查（运维：DB 可读 + 模型服务连通性） =====
app.get('/healthz', async (_req, res) => {
  const probe = async (url, { key } = {}) => {
    try {
      const r = await fetch(url, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(4000),
      });
      return r.ok;
    } catch { return false; }
  };
  const cfg = require('./config');
  const [dbOk, embOk, llmOk] = await Promise.all([
    Promise.resolve(true).then(() => { require('./db/index').prepare('SELECT 1').get(); return true; }).catch(() => false),
    cfg.embedding.enabled ? probe(`${cfg.embedding.baseUrl}/models`, { key: cfg.embedding.apiKey }) : null,
    cfg.llm.enabled ? probe(`${cfg.llm.baseUrl}/models`, { key: cfg.llm.apiKey }) : null,
  ]);
  // 提炼队列积压 = 素材「收了但不处理」，达阈值即 degraded（EVENTS_BACKLOG_WARN=0 关闭该判定）
  let queue = null;
  let backlogExceeded = false;
  try {
    queue = repo.queueBacklog();
    backlogExceeded = cfg.eventsBacklogWarn > 0 && queue.pending >= cfg.eventsBacklogWarn;
  } catch { /* 队列探测失败不改变主判定，db 状态已覆盖 */ }
  const healthy = dbOk && (embOk !== false) && (llmOk !== false) && !backlogExceeded;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    db: dbOk,
    embedding: embOk === null ? 'disabled' : embOk,
    llm: llmOk === null ? 'disabled' : llmOk,
    queue,
    time: new Date().toISOString(),
  });
});

// ===== 启动 =====
repo.cleanupSessions();
repo.cleanupEvents();
repo.cleanupRawMaterials();
setInterval(() => repo.cleanupSessions(), 3600_000).unref();
// 异步任务后台处理：启动处理一次 + 每 2s 轮询 pending（add 提炼）
repo.processPendingEvents();
setInterval(() => repo.processPendingEvents(), 2000).unref();
setInterval(() => { repo.cleanupEvents(); repo.cleanupRawMaterials(); }, 3600_000).unref();

// 向量索引（sqlite-vec，可选）：仅在索引落后于已有向量时补齐（全部用户），不阻塞启动。
// 不可用（未装/维度不匹配/L2_VEC=0）时静默跳过，检索自动退回关键词+全扫。
setTimeout(() => {
  try {
    const r = vec.ensureIndexed({});
    if (r.ok && !r.skipped) console.log(`[vec] 向量索引补齐：${r.indexed}/${r.scanned}（维度 ${r.dim}）`);
    else if (!r.ok) console.log(`[vec] 向量索引未启用：${r.reason}`);
  } catch (e) {
    console.error(`[vec] 向量索引补齐失败（不影响使用）：${e.message}`);
  }
}, 100).unref();

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[aimemory] MCP + mem0 API + Web 已启动: http://0.0.0.0:${config.port}`);
  console.log(`[aimemory] MCP 端点: http://<内网IP>:${config.port}/mcp`);
  console.log(`[aimemory] mem0 API: POST /v1/memories · POST /v2/memories/search · POST /v2/memories`);
  if (config.keycloak.enabled) {
    console.log(`[aimemory] Web 登录: Keycloak ${config.keycloak.url}（realm ${config.keycloak.realm}，client ${config.keycloak.clientId}）· 多租户`);
  } else {
    console.log('[aimemory] ⚠ 未配置 KEYCLOAK_URL：Web 登录不可用（.env 配置后重启）；MCP / API Token 接入不受影响');
  }
});
