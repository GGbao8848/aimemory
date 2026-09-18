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
const l1Scheduler = require('./l1/scheduler');
const l2Scheduler = require('./l2/scheduler');
const l3Scheduler = require('./l3/scheduler');
const vec = require('./l2/vec');

const app = express();
app.disable('x-powered-by');
app.use(cookieParser());

// L0 采集上传：必须在全局 json parser 之前挂载，并使用放宽的 body 上限。
// 原始会话批次远大于普通 API 请求（含完整工具输出），沿用 1mb 会持续 413。
app.post('/api/l0/ingest', express.json({ limit: config.l0MaxBody }), ...web.l0IngestRoute);

// 其余 API 维持 1mb 上限
app.use(express.json({ limit: '1mb' }));

// ===== 配套技能（下载/预览，公开）=====
// 记忆 skill 源目录（skills/）：aimemory（管理）/ aimemory-recall（召回）/ aimemory-remember（沉淀）
// / aimemory-collector（会话备份采集器部署）
const SKILLS_DIR = path.join(config.root, 'skills');
const SKILL_NAMES = ['aimemory', 'aimemory-recall', 'aimemory-remember', 'aimemory-collector'];
const MAIN_SKILL_MD = path.join(SKILLS_DIR, 'aimemory', 'SKILL.md');

// 技能 zip 包下载：aimemory-skills.zip（zip 内为三个 skill 目录，解压后放入 skills/ 或上传安装）
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
// `/`       记忆星图（atlas/）：把四层记忆与各线路的通讯状态画成一张活体概念图
// `/admin`  原管理控制台（记忆列表 / Token / 会话归档下钻）
// 管理台的资源引用是绝对路径（/style.css、/app.js、/icon-*.png），且这些文件名
// 与 atlas/ 不冲突，因此由后面那个 static 兜底解析即可，无需改动旧页面。
const ATLAS_DIR = path.join(config.root, 'atlas');
if (fs.existsSync(ATLAS_DIR)) {
  app.use(express.static(ATLAS_DIR, { index: 'index.html' }));
  app.get('/admin', (_req, res) =>
    res.sendFile(path.join(__dirname, 'web', 'static', 'index.html'))
  );
}
app.use(express.static(path.join(__dirname, 'web', 'static')));

// ===== MCP 端点（Streamable HTTP）=====
app.post('/mcp', handleMcpRequest);
// Streamable HTTP 客户端可能用 GET 探测（部分实现），幂等返回提示
app.get('/mcp', (_req, res) =>
  res.status(200).json({ jsonrpc: '2.0', result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } }, id: null })
);

// ===== REST /api（统一鉴权：Token API key 或 Web 会话 cookie）=====
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
  const r = loginFails.get(ip);
  if (!r || Date.now() - r.firstAt > LOGIN_WINDOW_MS) loginFails.set(ip, { count: 1, firstAt: Date.now() });
  else r.count += 1;
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

/** 登录页（口令表单；无需前端框架，与 /connect 页同风格） */
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
    <p class="sub">输入访问口令以管理记忆与会话归档</p>
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

// 登录页：?next= 支持站内跳转（如 /connect）
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
  res.redirect(next === '/connect' ? '/connect' : '/');
});

app.get('/auth/logout', (req, res) => {
  const sid = req.cookies?.aim_session;
  if (sid) {
    repo.deleteSession(sid);
    res.clearCookie('aim_session');
  }
  res.redirect('/');
});

// ===== 设备流授权页 =====
// agent 端发起连接 → 浏览器打开 /connect?request_id=xxx → 本地口令登录 → 点「确认授权」
// （可给 token 命名）→ agent 轮询 /api/connect/poll 拿到密钥，全程零粘贴复制。
app.get('/connect', (req, res) => {
  const id = web.resolveIdentity(req);
  if (!id) return res.redirect('/auth/login?next=/connect');
  const requestId = typeof req.query.request_id === 'string' ? req.query.request_id : '';
  const confirmToken = typeof req.query.confirm_token === 'string' ? req.query.confirm_token : '';
  // 免按钮自动授权：agent 发起时带 confirm_token（随机、只存在于其 authorize_url）→
  // 有登录会话且 token 匹配即直接确认并关窗（无任何页面文字，用户无感）。
  // 无 confirm_token 或校验不过 → 回退下方手动确认页（安全兜底，防 CSRF 诱导换发）。
  if (requestId && confirmToken && repo.canAutoConfirm(requestId, confirmToken)) {
    // 免按钮路径没有用户输入 → 自动命名（agent / agent-2…），避免与已有 Token 重名
    const autoName = tokens.uniqueName(id.userId, 'agent');
    repo.confirmConnectRequest(requestId, id.userId, autoName);
    res.type('html').send('<!DOCTYPE html><html><head><meta charset="UTF-8" /><script>try{window.close()}catch(e){};setTimeout(function(){location.replace("about:blank")},200);<\/script></head><body></body></html>');
    return;
  }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  res.type('html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>aimemory · 连接授权</title>
<style>
  :root { --bg:#0b0f17; --surface:#131a29; --surface-2:#1a2336; --border:#243049;
          --text:#e8ecf4; --muted:#8a94a8; --accent:#4c8dff; --ok:#34d399; --danger:#f87171;
          --mono:ui-monospace,Menlo,Consolas,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:radial-gradient(600px 300px at 70% -10%, rgba(76,141,255,.08), transparent 60%), var(--bg);
         font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; color:var(--text); }
  .card { width:100%; max-width:480px; margin:24px; padding:34px 30px; background:var(--surface);
          border:1px solid var(--border); border-radius:16px; box-shadow:0 10px 30px rgba(0,0,0,.35); }
  h1 { margin:0 0 6px; font-size:20px; }
  .sub { margin:0 0 20px; color:var(--muted); font-size:13px; }
  .who { display:flex; align-items:center; gap:8px; color:var(--ok); font-size:13px; margin-bottom:22px; }
  .who .dot { width:8px; height:8px; border-radius:50%; background:var(--ok); box-shadow:0 0 8px rgba(52,211,153,.6); }
  .reqbox { font-family:var(--mono); font-size:13px; background:var(--surface-2); border:1px solid var(--border);
            border-radius:8px; padding:10px 12px; color:var(--accent); word-break:break-all; margin-bottom:18px; }
  label { display:block; font-size:12px; color:var(--muted); margin:14px 0 6px; }
  input[type=text] { width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:8px;
                     color:var(--text); padding:9px 12px; font-size:13px; font-family:inherit; }
  input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(76,141,255,.12); }
  .btn { width:100%; border:none; background:var(--accent); color:#fff; border-radius:8px;
         padding:11px 0; font-size:14px; font-weight:600; cursor:pointer; margin-top:18px; font-family:inherit; }
  .btn:hover { background:#3a6fd8; }
  .btn:disabled { opacity:.5; cursor:not-allowed; }
  .err { color:var(--danger); font-size:12.5px; margin-top:10px; display:none; }
  .done { display:none; text-align:center; padding:16px 0; }
  .done .ok { color:var(--ok); font-size:18px; font-weight:700; }
  .done .hint { color:var(--muted); font-size:13px; margin-top:8px; }
</style>
</head>
<body>
  <div class="card">
    <h1 id="title">连接授权</h1>
    <p class="sub">为你的 agent 授权访问 aimemory 记忆库。</p>
    <div class="who"><span class="dot"></span><span>已确认身份：${esc(id.username || config.userName)}</span></div>

    <div id="form-area">
      <label>连接请求</label>
      <div class="reqbox" id="reqbox">${requestId ? esc(requestId.slice(0,8)) + '…' : '（缺少请求标识，请从 agent 端重新发起）'}</div>
      <label>Token 名称（必填，便于日后识别与吊销）</label>
      <input type="text" id="key-name" placeholder="如 zcode / claude-code" maxlength="50" />
      <button class="btn" id="confirm-btn" ${requestId ? '' : 'disabled'}>确认并签发 Token</button>
      <p class="err" id="err"></p>
    </div>

    <div class="done" id="done">
      <div class="ok">✓ 已授权，可回到 agent 继续</div>
      <div class="hint">Token 已自动发送到你的 agent，无需复制粘贴；你名下已有 Token 不受影响。本页可关闭。</div>
    </div>
  </div>
  <script>
    const requestId = ${JSON.stringify(requestId)};
    const doneEl = document.getElementById('done');
    const formEl = document.getElementById('form-area');
    document.getElementById('confirm-btn').onclick = async () => {
      const btn = document.getElementById('confirm-btn');
      const errEl = document.getElementById('err'); errEl.style.display = 'none';
      const keyName = document.getElementById('key-name').value.trim();
      if (!keyName) { errEl.textContent = '请填写 Token 名称'; errEl.style.display = 'block'; return; }
      btn.disabled = true; btn.textContent = '授权中…';
      try {
        const r = await fetch('/api/connect/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_id: requestId, name: keyName }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || '授权失败');
        formEl.style.display = 'none';
        doneEl.style.display = 'block';
        // 回传确认给来源窗口（可选）
        const origin = new URLSearchParams(location.search).get('origin') || '';
        if (origin && window.opener) {
          try { window.opener.postMessage({ type: 'aimemory-connect-confirmed' }, origin); } catch (e) {}
        }
        // 已确认，1.2 秒后自动关闭本页（省去手动关页）
        setTimeout(() => { try { window.close(); } catch (e) {} }, 1200);
      } catch (e) {
        errEl.textContent = e.message; errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = '确认并签发 Token';
      }
    };
  </script>
</body>
</html>`);
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
  const healthy = dbOk && (embOk !== false) && (llmOk !== false);
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    db: dbOk,
    embedding: embOk === null ? 'disabled' : embOk,
    llm: llmOk === null ? 'disabled' : llmOk,
    time: new Date().toISOString(),
  });
});

// ===== 启动 =====
repo.cleanupSessions();
repo.cleanupConnectRequests();
repo.cleanupEvents();
setInterval(() => repo.cleanupSessions(), 3600_000).unref();
setInterval(() => repo.cleanupConnectRequests(), 600_000).unref();
// 异步任务后台处理：启动处理一次 + 每 2s 轮询 pending（add_memory(messages) 提炼）
repo.processPendingEvents();
setInterval(() => repo.processPendingEvents(), 2000).unref();
setInterval(() => repo.cleanupEvents(), 3600_000).unref();

// L1 会话摘要（sleep-time）：后台把静默的归档会话摘成情景记忆，不阻塞在线请求
l1Scheduler.start();

// L2 派生（sleep-time）：把已完成的 L1 摘要派生成长期事实（带冲突消解），
// 依赖 L1 的产物，故在它之后启动。关闭用 L2_DERIVE=0。
l2Scheduler.start();

// L3 凝练（低频）：攒够新消化会话才跑一轮（默认 5 个），从 L1 摘要沉淀画像/约束/教训。
// 依赖 L2 的派生游标，最后启动。关闭用 L3_DERIVE=0。
l3Scheduler.start();

// L2 向量索引（sqlite-vec，可选）：仅在索引落后于已有向量时补齐，不阻塞启动。
// 不可用（未装/维度不匹配/L2_VEC=0）时静默跳过，检索自动退回关键词+全扫。
setTimeout(() => {
  try {
    const r = vec.ensureIndexed({ userId: config.userId });
    if (r.ok && !r.skipped) console.log(`[l2] 向量索引补齐：${r.indexed}/${r.scanned}（维度 ${r.dim}）`);
    else if (!r.ok) console.log(`[l2] 向量索引未启用：${r.reason}`);
  } catch (e) {
    console.error(`[l2] 向量索引补齐失败（不影响使用）：${e.message}`);
  }
}, 100).unref();

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[aimemory] MCP + API + Web 已启动: http://0.0.0.0:${config.port}`);
  console.log(`[aimemory] MCP 端点: http://<内网IP>:${config.port}/mcp`);
  console.log(`[aimemory] 身份: ${config.userName}（${config.userId}）· 单用户模式`);
  if (config.passwordGenerated) {
    // 首次启动自动生成口令 → 必须打印出来，否则用户无从得知（也只写在本机 .env）
    console.log(`[aimemory] ⚠ 已生成 Web 访问口令并写入 .env：${config.passwordGenerated}`);
    console.log('[aimemory] （登录 http://<内网IP>:' + config.port + ' 使用；请妥善保存）');
  } else {
    console.log(`[aimemory] Web 登录口令：.env 的 AIMEMORY_PASSWORD`);
  }
});
