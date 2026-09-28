/**
 * 本地开发 / 自测服务器。
 *
 * 它不重新实现同步逻辑，而是直接把 worker/index.js 跑起来：
 *   - STUDY_KV   用 .sync-data.json 这个本地文件顶替 Cloudflare KV
 *   - ASSETS     从当前文件夹读静态文件顶替 Cloudflare 的静态资源
 * 所以这里测通了，部署到 Cloudflare 之后行为是一致的。
 *
 * 用法：node dev-server.js     然后浏览器打开打印出来的地址。
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8787;
const DATA_FILE = path.join(ROOT, '.sync-data.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

let store = {};

async function loadStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    store = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    store = {};
  }
}

async function saveStore() {
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2));
}

const STUDY_KV = {
  async get(key) {
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
  },
  async put(key, value) {
    store[key] = String(value);
    await saveStore();
  },
};

// 和部署到 Cloudflare 时遵守同一份 .assetsignore，避免本地能拿到源码而线上拿不到。
let ignorePatterns = null;

async function assetIgnores() {
  if (ignorePatterns) return ignorePatterns;
  const raw = await fs.readFile(path.join(ROOT, '.assetsignore'), 'utf8').catch(() => '');
  ignorePatterns = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return ignorePatterns;
}

function isIgnored(pathname, patterns) {
  const segments = pathname.split('/').filter(Boolean);
  return segments.some((segment) => patterns.some((pattern) => (
    pattern.startsWith('*.') ? segment.endsWith(pattern.slice(1)) : segment === pattern
  )));
}

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    if (isIgnored(url.pathname, await assetIgnores())) {
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    let target = path.join(ROOT, decodeURIComponent(url.pathname));
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    let stat = await fs.stat(target).catch(() => null);
    if (stat && stat.isDirectory()) {
      target = path.join(target, 'index.html');
      stat = await fs.stat(target).catch(() => null);
    }
    if (!stat || !stat.isFile()) {
      return new Response('Not Found: ' + url.pathname, {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    const body = await fs.readFile(target);
    return new Response(body, {
      headers: {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      },
    });
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

async function main() {
  await loadStore();
  const worker = (await import(pathToFileURL(path.join(ROOT, 'worker', 'index.js')).href)).default;
  const env = { STUDY_KV, ASSETS };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
      const init = { method: req.method, headers: req.headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await readBody(req);
      const response = await worker.fetch(new Request(url, init), env);
      const buffer = Buffer.from(await response.arrayBuffer());
      const headers = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      res.writeHead(response.status, headers);
      res.end(buffer);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('本地服务器出错：' + error.message);
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log('本机访问：  http://localhost:' + PORT);
    for (const address of lanAddresses()) {
      console.log('同一 Wi-Fi：http://' + address + ':' + PORT);
    }
    console.log('同步接口：  /api/state   数据文件：' + path.basename(DATA_FILE));
    console.log('按 Control + C 停止。');
  });
}

main().catch((error) => {
  console.error('启动失败：' + error.message);
  process.exit(1);
});
