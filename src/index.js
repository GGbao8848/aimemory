'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const AdmZip = require('adm-zip');
const cookieParser = require('cookie-parser');
const config = require('./config');
const repo = require('./db/repo');
const { handleMcpRequest } = require('./mcp/server');
const tokens = require('./auth/tokens');
const web = require('./web/routes');
const vec = require('./l2/vec');

const app = express();
app.disable('x-powered-by');
app.use(cookieParser());

// 其余 API 维持 1mb 上限
app.use(express.json({ limit: '1mb' }));

// ===== 配套技能（下载/预览，公开）=====
// 记忆 skill 源目录（skills/）：aimemory（管理）/ aimemory-recall（召回）/ aimemory-remember（沉淀）
const SKILLS_DIR = path.join(config.root, 'skills');
const SKILL_NAMES = ['aimemory', 'aimemory-recall', 'aimemory-remember'];
const MAIN_SKILL_MD = path.join(SKILLS_DIR, 'aimemory', 'SKILL.md');

// 技能 zip 包下载：aimemory-skills.zip（zip 内为各 skill 目录，解压后放入 skills/ 或上传安装）
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

// ===== 本地口令登录（单用户）=====
// 个人部署，不需要 SSO；用 .env 里的 AIMEMORY_PASSWORD 登录，成功后建立本地会话
// （sessions 表 + aim_session cookie）。

/** 登录失败限速：同一 IP 15 分钟内失败上限（内网服务也要防暴力猜口令） */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const loginFails = new Map(); // ip -> { count, firstAt }

function loginBlocked(ip) {
  const r = loginFails.get(ip);
  if (!r) return false;
  if (Date.now() - r.firstAt > LOGIN_WINDOW_MS) { loginFails.delete(ip); return false; }
  return r.count >= LOGIN_MAX_FAILS;
}
function noteLoginFail(ip) {
  if (!loginFails.has(ip)) loginFails.set(ip, { count: 1, firstAt: Date.now() });
  else loginFails.get(ip).count += 1;
}

/** 恒定时长比较，避免通过响应时间猜口令长度 */
function passwordOk(input) {
  const a = Buffer.from(String(input == null ? '' : input));
  const b = Buffer.from(config.password);
  if (a.length !== b.length) return false;
  return require('crypto').timingSafeEqual(a, b);
}

/** 站内跳转白名单（防开放重定向） */
function safeNext(v) {
  return typeof v === 'string' && v.startsWith('/') && !v.includes('//') ? v : '/';
}

/** 登录页（口令表单；无需前端框架） */
function renderLoginPage(next, { error, blocked } = {}) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>aimemory · 登录</title>
<link rel="icon" type="image/png" href="/icon-32.png" />
<style>
  :root { --bg:#0b0f17; --surface:#131a29; --surface-2:#1a2336; --border:#243049;
          --text:#e8ecf4; --muted:#8a94a8; --accent:#4c8dff; --danger:#f87171; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:radial-gradient(600px 300px at 70% -10%, rgba(76,141,255,.08), transparent 60%), var(--bg);
         font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; color:var(--text); }
  .card { width:100%; max-width:400px; margin:24px; padding:34px 30px; background:var(--surface);
          border:1px solid var(--border); border-radius:16px; box-shadow:0 10px 30px rgba(0,0,0,.35); }
  h1 { margin:0 0 6px; font-size:20px; }
  .sub { margin:0 0 22px; color:var(--muted); font-size:13px; }
  label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
  input[type=password] { width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:8px;
                         color:var(--text); padding:11px 12px; font-size:14px; font-family:inherit; }
  input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(76,141,255,.12); }
  .btn { width:100%; border:none; background:var(--accent); color:#fff; border-radius:8px;
         padding:11px 0; font-size:14px; font-weight:600; cursor:pointer; margin-top:18px; font-family:inherit; }
  .btn:hover { background:#3a6fd8; }
  .err { color:var(--danger); font-size:12.5px; margin-top:12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>aimemory</h1>
    <p class="sub">输入访问口令以管理记忆</p>
    <form method="POST" action="/auth/local-login">
      <input type="hidden" name="next" value="${esc(next)}" />
      <label for="password">访问口令</label>
      <input type="password" id="password" name="password" autocomplete="current-password" autofocus required />
      <button class="btn" type="submit">登录</button>
      ${blocked ? '<p class="err">尝试次数过多，请 15 分钟后再试</p>' : ''}
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
    </form>
  </div>
</body>
</html>`;
}

// 登录页：?next= 支持站内跳转
app.get('/auth/login', (req, res) => {
  const next = safeNext(req.query.next);
  const ip = req.ip || req.socket.remoteAddress || '';
  res.type('html').send(renderLoginPage(next, { blocked: loginBlocked(ip) }));
});

// 口令校验 → 建立本地会话
app.post('/auth/local-login', express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || '';
  const next = safeNext((req.body || {}).next);

  if (loginBlocked(ip)) {
    return res.status(429).type('html').send(renderLoginPage(next, { blocked: true }));
  }
  if (!passwordOk((req.body || {}).password)) {
    noteLoginFail(ip);
    return res.status(401).type('html').send(renderLoginPage(next, { error: '口令不正确' }));
  }

  loginFails.delete(ip);
  const sid = require('crypto').randomBytes(24).toString('hex');
  repo.createSession(sid, config.userId, config.sessionTtlMs, config.userName);
  res.cookie('aim_session', sid, { httpOnly: true, sameSite: 'lax', maxAge: config.sessionTtlMs });
  res.redirect(next.startsWith('/') ? next : '/');
});

app.get('/auth/logout', (req, res) => {
  const sid = req.cookies?.aim_session;
  if (sid) {
    repo.deleteSession(sid);
    res.clearCookie('aim_session');
  }
  res.redirect('/');
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
    Promise.resolve(true).then(() => { repo.stats(cfg.userId); return true; }).catch(() => false),
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
setInterval(() => repo.cleanupSessions(), 3600_000).unref();
// 异步任务后台处理：启动处理一次 + 每 2s 轮询 pending（add 提炼）
repo.processPendingEvents();
setInterval(() => repo.processPendingEvents(), 2000).unref();
setInterval(() => repo.cleanupEvents(), 3600_000).unref();

// 向量索引（sqlite-vec，可选）：仅在索引落后于已有向量时补齐，不阻塞启动。
// 不可用（未装/维度不匹配/L2_VEC=0）时静默跳过，检索自动退回关键词+全扫。
setTimeout(() => {
  try {
    const r = vec.ensureIndexed({ userId: config.userId });
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
  console.log(`[aimemory] 身份: ${config.userName}（${config.userId}）· 单用户模式`);
  if (config.passwordGenerated) {
    // 首次启动自动生成口令 → 必须打印出来，否则用户无从得知（也只写在本机 .env）
    console.log(`[aimemory] ⚠ 已生成 Web 访问口令并写入 .env：${config.passwordGenerated}`);
    console.log('[aimemory] （登录 http://<内网IP>:' + config.port + ' 使用；请妥善保存）');
  } else {
    console.log(`[aimemory] Web 登录口令：.env 的 AIMEMORY_PASSWORD`);
  }
});
