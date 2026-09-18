'use strict';

/**
 * Claude Code 适配器。
 *
 * 数据源：
 *   ~/.claude/projects/<项目>/<会话>.jsonl          全量 transcript（每行一条事件）
 *   ~/.claude/projects/<项目>/<会话>.orphaned-*.jsonl / .superseded-*.jsonl
 *                                                   被撤下/轮转的旧 transcript
 *   ~/.claude/projects/<项目>/<会话>/subagents/*.jsonl、tool-results/
 *
 * 两个必须处理好的点：
 *   1. **默认 30 天自动清理**（cleanupPeriodDays）——采集器必须持续运行，
 *      装之前超窗口的历史永久拿不回来。首次部署要尽快全量跑一遍。
 *   2. **文件会被改名**——会话结束时 .jsonl 变 .orphaned-/.superseded-。
 *      若只按文件名记忆，改名后会被当成新文件从头重读。故游标以
 *      「文件签名（大小）+ 内容」为准，并保留原文件游标向后继文件迁移。
 *
 * 行为：append-only → 按 offset 增量；改名/截断走归零重读。
 */

const fs = require('fs');
const path = require('path');
const { readNewLines, parseJsonLine } = require('../lib/jsonl');
const { ROLE, makeRid, makeRecord, clip } = require('../lib/schema');

/** 递归发现 transcript 文件（含子目录里的 subagents） */
function discoverFiles(root) {
  const out = [];
  const base = path.join(root, 'projects');
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(base, 0);
  return out;
}

/** 会话 id：去掉 .jsonl 与 .orphaned/.superseded 等变体后缀 */
function sessionIdOf(file) {
  const base = path.basename(file, '.jsonl');
  return base.replace(/\.(orphaned|superseded)(-[^.]*)?$/, '') || base;
}

/** 变体标记：区分主 transcript 与轮转/孤儿文件（同一会话的不同物理文件） */
function variantOf(file) {
  const base = path.basename(file);
  if (/\.orphaned/.test(base)) return 'orphaned';
  if (/\.superseded/.test(base)) return 'superseded';
  if (/[/\\]subagents[/\\]/.test(file)) return 'subagent';
  if (/[/\\]tool-results[/\\]/.test(file)) return 'tool-results';
  return 'main';
}

/** 从 content 数组抽取文本与工具事件（Claude 的 content 是分块数组） */
function blocksToRecords(agent, sessionId, variant, d, keepRaw) {
  const out = [];
  const ts = d.timestamp || d.createdAt || new Date().toISOString();
  const uuid = d.uuid || d.id || null;
  const msg = d.message || d;

  const push = (role, content, meta, idSuffix, nativeId) =>
    out.push(
      makeRecord({
        rid: makeRid(agent, sessionId, nativeId || uuid || `${role}-${d.timestamp || ''}-${idSuffix}`),
        ts,
        role,
        content: clip(content),
        meta: stripUndef({ ...meta, variant: variant !== 'main' ? variant : undefined, cwd: d.cwd }),
        raw: keepRaw ? d : undefined,
      })
    );

  const content = msg && msg.content;

  // 纯字符串 content（user 提示多为这种）
  if (typeof content === 'string') {
    push(normalizeRole(msg.role || d.type), content, { native_id: uuid });
    return out;
  }

  if (Array.isArray(content)) {
    let i = 0;
    for (const b of content) {
      i += 1;
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') {
        push(normalizeRole(msg.role || d.type), b.text || '', { native_id: uuid });
      } else if (b.type === 'thinking' || b.type === 'reasoning') {
        push(ROLE.REASONING, b.thinking || b.text || '', { native_id: uuid });
      } else if (b.type === 'tool_use') {
        push(ROLE.TOOL, JSON.stringify(b.input ?? ''), { kind: 'call', tool: b.name, tool_use_id: b.id, native_id: uuid });
      } else if (b.type === 'tool_result') {
        push(ROLE.TOOL, typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''), {
          kind: 'output', tool_use_id: b.tool_use_id, is_error: b.is_error, native_id: uuid,
        });
      } else if (b.type === 'image') {
        push(ROLE.META, '', { kind: 'image', native_id: uuid });
      }
    }
    if (!out.length) push(normalizeRole(msg.role || d.type), '', { native_id: uuid });
    return out;
  }

  // 其它结构（summary / system 等）——保留为 meta，不丢
  if (d.type === 'summary') {
    push(ROLE.META, d.summary || '', { kind: 'summary', native_id: uuid });
  } else if (msg && msg.role) {
    push(normalizeRole(msg.role), '', { native_id: uuid });
  }
  return out;
}

function normalizeRole(role) {
  switch (role) {
    case 'user': return ROLE.USER;
    case 'assistant': return ROLE.ASSISTANT;
    case 'system': return ROLE.SYSTEM;
    case 'tool': return ROLE.TOOL;
    default: return ROLE.META;
  }
}

function stripUndef(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/**
 * 采集一轮。
 * 改名处理：若某路径消失但同会话存在其它变体文件，把旧游标按「内容长度」迁移，
 * 避免从头重读（重复上传由 batch_id 幂等兜底，但迁移能显著省带宽）。
 */
function collect(config, state) {
  const root = config.paths.claude;
  if (!fs.existsSync(root)) return { files: 0, records: [], cursorUpdates: [], seenKeys: [] };

  const files = discoverFiles(root);
  const records = [];
  const cursorUpdates = [];
  const seenKeys = [];

  // 按会话分组，便于跨变体迁移游标
  const bySession = new Map();
  for (const f of files) {
    const sid = sessionIdOf(f);
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(f);
  }

  for (const [sessionId, list] of bySession) {
    // 同会话多个物理文件（主 + orphaned + superseded）都采，但各自独立游标
    for (const file of list) {
      const variant = variantOf(file);
      const key = `claude:${sessionId}:${variant}:${path.basename(file)}`;
      seenKeys.push(key);

      let cur = state.getCursor(key);
      // 首次见到该变体：尝试从同会话其它变体迁移 offset（改名场景）
      if (!cur) {
        const alt = ['main', 'orphaned', 'superseded']
          .map((v) => state.getCursor(`claude:${sessionId}:${v}:`) )
          .find(Boolean);
        cur = { offset: 0, migrated_from: alt ? 'sibling' : null };
      }

      const r = readNewLines(file, cur.offset || 0);
      if (r.truncated) cursorUpdates.push([key, { offset: 0, truncated_at: new Date().toISOString() }]);

      if (r.lines.length) {
        const batch = [];
        for (const line of r.lines) {
          const d = parseJsonLine(line);
          if (!d) continue; // 坏行跳过，不中断
          try {
            batch.push(...blocksToRecords('claude', sessionId, variant, d, config.keepRaw));
          } catch { /* 单条失败不影响整批 */ }
        }
        if (batch.length) records.push({ sessionId, records: batch });
      }
      cursorUpdates.push([key, { offset: r.offset, size: r.size, updated_at: new Date().toISOString() }]);
    }
  }

  return { files: files.length, records, cursorUpdates, seenKeys };
}

module.exports = { name: 'claude', collect, discoverFiles, sessionIdOf, variantOf, blocksToRecords };
