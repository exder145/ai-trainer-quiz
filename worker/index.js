/**
 * 人工智能训练师刷题工具 · 云端同步 Worker
 *
 * 同一个 Worker 同时负责两件事：
 *   1. 把仓库里的静态文件（index.html / app.js / questions.js 等）当网站发出去；
 *   2. 提供 /api/state 接口，用 KV 保存每个同步码对应的答题进度。
 *
 * 校验与合并逻辑和浏览器端的 core.js 保持一致，这里刻意重复了一份，
 * 因为 Worker 和浏览器是两个独立运行时，不适合共享模块。
 */

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ITEMS = 5000;
const CODE_PATTERN = /^[A-Z0-9]{4,32}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

function nonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// 只接受合法记录，避免任何脏数据写进 KV 之后把客户端卡死。
function sanitizeItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const attempts = nonNegativeInt(value.attempts);
  const correct = nonNegativeInt(value.correct);
  const wrong = nonNegativeInt(value.wrong);
  const streak = nonNegativeInt(value.streak);
  if (attempts === null || correct === null || wrong === null || streak === null) return null;
  if (attempts !== correct + wrong || streak > correct) return null;
  return {
    attempts,
    correct,
    wrong,
    streak,
    lastAt: typeof value.lastAt === 'string' ? value.lastAt : null,
    lastWasCorrect: typeof value.lastWasCorrect === 'boolean' ? value.lastWasCorrect : null,
    bookmarked: value.bookmarked === true,
    markAt: typeof value.markAt === 'string' ? value.markAt : null,
  };
}

function sanitizeItems(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  let count = 0;
  for (const [id, raw] of Object.entries(input)) {
    if (count >= MAX_ITEMS) break;
    if (!ID_PATTERN.test(id)) continue;
    const item = sanitizeItem(raw);
    if (!item) continue;
    out[id] = item;
    count += 1;
  }
  return out;
}

function mergeItem(left, right) {
  const leftAt = left.lastAt || '';
  const rightAt = right.lastAt || '';
  let base;
  if (leftAt === rightAt) base = left.attempts >= right.attempts ? left : right;
  else base = rightAt > leftAt ? right : left;

  const leftMark = left.markAt || '';
  const rightMark = right.markAt || '';
  let bookmarked;
  if (leftMark === rightMark) bookmarked = left.bookmarked || right.bookmarked;
  else bookmarked = (rightMark > leftMark ? right : left).bookmarked;

  return { ...base, bookmarked };
}

function mergeItems(left, right) {
  const items = { ...left };
  for (const [id, other] of Object.entries(right)) {
    items[id] = items[id] ? mergeItem(items[id], other) : other;
  }
  return items;
}

async function readStored(env, key) {
  try {
    const raw = await env.STUDY_KV.get(key);
    if (!raw) return { items: {}, updatedAt: null };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.items !== 'object' || Array.isArray(parsed.items)) {
      return { items: {}, updatedAt: null };
    }
    return {
      items: parsed.items,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch {
    return { items: {}, updatedAt: null };
  }
}

async function handleState(request, env, url) {
  const code = (url.searchParams.get('code') || '').trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) {
    return json({ error: '同步码无效，请使用 4-32 位字母或数字。' }, 400);
  }
  if (!env.STUDY_KV) {
    return json({ error: '服务端还没有绑定 KV 存储，请先完成部署配置。' }, 500);
  }

  const key = 'state:' + code;
  const stored = await readStored(env, key);

  if (request.method === 'GET') {
    return json({ items: stored.items, updatedAt: stored.updatedAt });
  }
  if (request.method !== 'POST') {
    return json({ error: '只支持 GET 和 POST。' }, 405);
  }

  let text;
  try {
    text = await request.text();
  } catch {
    return json({ error: '读取请求内容失败。' }, 400);
  }
  if (text.length > MAX_BODY_BYTES) {
    return json({ error: '提交的数据过大。' }, 413);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: '请求内容不是合法的 JSON。' }, 400);
  }

  const incoming = sanitizeItems(body && body.items);
  const merged = mergeItems(stored.items, incoming);
  const changed = JSON.stringify(merged) !== JSON.stringify(stored.items);
  const updatedAt = changed ? new Date().toISOString() : stored.updatedAt;

  if (changed) {
    try {
      await env.STUDY_KV.put(key, JSON.stringify({ items: merged, updatedAt }));
    } catch {
      // 写失败也把合并结果返回给客户端，客户端本地记录不会丢。
      return json({ items: merged, updatedAt, warning: '云端写入失败，本次只返回合并结果。' });
    }
  }

  return json({ items: merged, updatedAt });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/state') {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      return handleState(request, env, url);
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, kv: Boolean(env.STUDY_KV) });
    }

    return env.ASSETS.fetch(request);
  },
};
