'use strict';

/**
 * 首启自检（npm run doctor）：部署后、启动前跑一遍，30 秒内给出「能不能跑、缺什么、怎么补」。
 * - 零网络调用：LLM/embedding 只查配置完整性；加 --probe 才发一次 GET /models 探活（≤4s，不耗 LLM token）。
 * - 绝不打印任何密钥值（只报「已设置/为空」）。
 * - 有 ❌ 时退出码 1，便于部署脚本卡点。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const probe = process.argv.includes('--probe');
const config = require('../src/config');

const results = [];
// ok 入参兼容 true / 'ok'（显式字符串）；false → bad；'warn' → warn
function report(ok, label, detail, fix) {
  const level = ok === false ? 'bad' : ok === 'warn' ? 'warn' : 'ok';
  results.push({ level, label, detail, fix });
}

async function checkPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

async function pingModel(base, key) {
  try {
    const r = await fetch(`${base}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(4000),
    });
    return r.ok ? 'ok' : `HTTP ${r.status}`;
  } catch (e) {
    return `不可达：${e.message.slice(0, 60)}`;
  }
}

(async () => {
  // ===== 1. Node 版本 =====
  const major = Number(process.versions.node.split('.')[0]);
  report(major >= 20, 'Node 版本', `当前 ${process.versions.node}（要求 ≥ 20）`,
    major >= 20 ? null : 'nvm install 20 && nvm use 20');

  // ===== 2. 依赖安装 =====
  // 不用 require.resolve：部分包（如 MCP SDK）的 exports map 不暴露根入口，会误报
  const deps = ['better-sqlite3', 'express', 'cookie-parser', 'adm-zip', '@modelcontextprotocol/sdk'];
  const depMissing = deps.filter((d) => !fs.existsSync(path.join(config.root, 'node_modules', d)));
  report(depMissing.length === 0, '依赖安装', depMissing.length ? `缺失：${depMissing.join(', ')}` : `${deps.length} 个核心依赖可加载`,
    depMissing.length ? 'npm install' : null);

  // ===== 2.5 管理台前端构建产物（web/ 由 Vite 构建，缺失时 /admin 只能返回提示页）=====
  const webBuild = path.join(config.root, 'web', 'dist', 'index.html');
  const webBuilt = fs.existsSync(webBuild);
  report(webBuilt, '管理台前端', webBuilt ? 'web/dist 已构建' : '未构建（访问 /admin 会得到 503 提示）',
    webBuilt ? null : 'npm run web:install && npm run web:build');

  // ===== 3. 数据目录（不存在则创建——与首启行为一致）=====
  const dirs = [['数据目录', path.dirname(config.dbPath)], ['L0 归档目录', config.l0Dir], ['L3 画像目录', config.l3Dir]];
  for (const [label, dir] of dirs) {
    let ok = true, msg, fix = null;
    try {
      const existed = fs.existsSync(dir);
      fs.mkdirSync(dir, { recursive: true });
      const probeFile = path.join(dir, `.doctor-${process.pid}`);
      fs.writeFileSync(probeFile, 'x');
      fs.unlinkSync(probeFile);
      msg = `${dir}${existed ? '' : '（已自动创建）'}`;
    } catch (e) {
      ok = false; msg = e.message; fix = `mkdir -p ${dir} && chmod u+rwX ${dir}`;
    }
    report(ok, label, msg, fix);
  }

  // ===== 4. 数据库 =====
  try {
    if (!fs.existsSync(config.dbPath)) {
      report('warn', '数据库', `${config.dbPath} 尚不存在（首次启动自动建表）`, null);
    } else {
      const Database = require('better-sqlite3');
      const db = new Database(config.dbPath, { readonly: true });
      const integ = db.pragma('integrity_check', { simple: true });
      const tables = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;
      db.close();
      report(integ === 'ok', '数据库完整性', `${integ}（${tables} 张表，${config.dbPath}）`,
        integ === 'ok' ? null : '数据库已损坏：从最近备份恢复（scripts/restore.sh）');
    }
  } catch (e) {
    report(false, '数据库', e.message, `确认 ${config.dbPath} 可读写，或用 AIMEMORY_DB 指向新路径`);
  }

  // ===== 5. LLM（素材提炼，核心依赖）=====
  if (!config.llm.enabled) {
    report('warn', 'LLM 提炼', 'LLM_ENABLED=0：add_memory 写入会被拒绝（检索/归档不受影响）', '.env 里设 LLM_ENABLED=1');
  } else {
    const miss = [!config.llm.baseUrl && 'LLM_BASE_URL', !config.llm.model && 'LLM_MODEL'].filter(Boolean);
    report(miss.length === 0, 'LLM 配置', miss.length ? `缺少 ${miss.join(', ')}` : `${config.llm.baseUrl}（${config.llm.model}）`,
      miss.length ? '在 .env 补齐后重启' : null);
    report(Boolean(config.llm.apiKey), 'LLM 密钥', config.llm.apiKey ? '已设置' : '为空（多数网关会 401）',
      config.llm.apiKey ? null : '.env 里填 LLM_API_KEY');
  }

  // ===== 6. Embedding（可选，缺失自动降级关键词检索）=====
  if (!config.embedding.enabled) {
    report('ok', 'Embedding', '未启用——检索走关键词路径（FTS + 兜底计分，功能完整）', null);
  } else {
    report(Boolean(config.embedding.baseUrl && config.embedding.model), 'Embedding 配置',
      `${config.embedding.baseUrl}（${config.embedding.model}）`,
      config.embedding.baseUrl && config.embedding.model ? null : '.env 补 EMBEDDING_BASE_URL / EMBEDDING_MODEL');
  }

  // ===== 7. 向量索引（sqlite-vec，可选）=====
  try {
    const vec = require('../src/l2/vec');
    const s = vec.status();
    const vecDetail = s.available
      ? `sqlite-vec 可用（维度 ${s.dim ?? '待首次索引'}，已索引 ${s.indexed ?? 0} 条）`
      : `未启用：${s.reason}（自动降级，不影响功能）`;
    report('ok', '向量索引', vecDetail, null);
  } catch (e) {
    report('ok', '向量索引', `未启用：${e.message}（自动降级，不影响功能）`, null);
  }

  // ===== 8. Web 登录口令 =====
  report(Boolean(config.password), 'Web 口令',
    config.passwordGenerated ? '本次已自动生成强口令并写入 .env（启动日志会再打印一次）' : '已设置（.env 的 AIMEMORY_PASSWORD）', null);

  // ===== 9. 端口占用 =====
  const portFree = await checkPort(config.port);
  report(portFree === true ? 'ok' : 'warn', `端口 ${config.port}`,
    portFree ? '空闲' : '已被占用（服务可能已在运行，或换 PORT）',
    portFree ? null : `lsof -i :${config.port}  # 查看占用进程`);

  // ===== 10. 可选探活（--probe：GET /models，≤4s，零 LLM token）=====
  if (probe) {
    if (config.llm.enabled) {
      report('ok', 'LLM 探活', `${config.llm.baseUrl}/models → ${await pingModel(config.llm.baseUrl, config.llm.apiKey)}`, null);
    }
    if (config.embedding.enabled) {
      report('ok', 'Embedding 探活', `${config.embedding.baseUrl}/models → ${await pingModel(config.embedding.baseUrl, config.embedding.apiKey)}`, null);
    }
  }

  // ===== 输出 =====
  const icon = { ok: '✅', warn: '⚠️ ', bad: '❌' };
  console.log(`\naimemory 首启自检（${os.hostname()} · ${new Date().toLocaleString()}）\n${'='.repeat(52)}`);
  for (const r of results) {
    console.log(`${icon[r.level]} ${r.label.padEnd(10)} ${r.detail}`);
    if (r.level !== 'ok' && r.fix) console.log(`     ↳ 修复：${r.fix}`);
  }
  const bad = results.filter((r) => r.level === 'bad').length;
  const warn = results.filter((r) => r.level === 'warn').length;
  console.log('='.repeat(52));
  console.log(`结果：${bad ? `${bad} 项必须修复` : '可以启动'}${warn ? `，${warn} 项建议关注` : ''}\n`);
  console.log('下一步：');
  console.log('  1. npm start                     # 启动（或 pm2 start ecosystem.config.js）');
  console.log(`  2. 浏览器打开 http://127.0.0.1:${config.port}/admin  # 口令登录（.env 的 AIMEMORY_PASSWORD）`);
  console.log('  3. /admin 接入指南页             # agent 接入（MCP / 设备流 Token / 采集器）');
  console.log('  4. npm run doctor -- --probe     # 需要探活模型服务时');
  process.exitCode = bad ? 1 : 0;
})();
