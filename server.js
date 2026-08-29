'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('./src/config').load();
const { JsonStore } = require('./src/store');
const { Hub } = require('./src/hub');
const { InstanceManager } = require('./src/instances');
const { QueueManager } = require('./src/queue');

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

const instancesStore = new JsonStore(config.dataDir, 'instances');
const jobsStore = new JsonStore(config.dataDir, 'jobs');

const hub = new Hub({
  accessToken: config.accessToken,
  getState: () => ({
    instances: instances.list(),
    jobs: queue.all(),
    queue: queue.order(),
  }),
});
const instances = new InstanceManager({ store: instancesStore, hub });
const queue = new QueueManager({ store: jobsStore, hub, instances });

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const STATIC_DIR = path.join(__dirname, 'src', 'static');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function authed(req) {
  if (!config.accessToken) return true;
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.searchParams.get('token') === config.accessToken) return true;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ') && header.slice(7).trim() === config.accessToken) return true;
  return false;
}

async function listLocalDirectories(requestedPath) {
  const input = String(requestedPath || os.homedir());
  if (!path.isAbsolute(input)) throw new Error('Directory path must be absolute');

  let current;
  try {
    current = await fs.promises.realpath(path.resolve(input));
  } catch (err) {
    throw new Error(`Cannot open directory: ${err.message}`);
  }

  let dirents;
  try {
    dirents = await fs.promises.readdir(current, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read directory: ${err.message}`);
  }

  const entries = (await Promise.all(dirents.map(async (entry) => {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) return { name: entry.name, path: entryPath };
    if (!entry.isSymbolicLink()) return null;
    try {
      const stat = await fs.promises.stat(entryPath);
      return stat.isDirectory() ? { name: entry.name, path: entryPath, symlink: true } : null;
    } catch {
      return null;
    }
  }))).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const root = path.parse(current).root;
  return {
    path: current,
    root,
    parent: current === root ? null : path.dirname(current),
    entries,
  };
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

/**
 * Explicit route table. Handlers receive (body, params, req).
 * `:id` is captured from the path.
 */
const routes = [
  { method: 'GET', pattern: /^\/api\/state$/, run: () => ({ instances: instances.list(), jobs: queue.all(), queue: queue.order() }) },
  { method: 'GET', pattern: /^\/api\/local\/directories$/, run: (_b, _p, req) => {
    const url = new URL(req.url, 'http://localhost');
    return listLocalDirectories(url.searchParams.get('path'));
  } },

  { method: 'GET', pattern: /^\/api\/instances$/, run: () => instances.list() },
  {
    method: 'POST', pattern: /^\/api\/instances$/,
    run: async (body) => {
      const inst = await instances.add(body);
      instances.status(inst.id).catch(() => undefined); // refresh MEGA account info
      return inst;
    },
  },
  { method: 'GET', pattern: /^\/api\/instances\/([^/]+)$/, run: (_b, p) => instances.get(p.id) || { error: 'not found' } },
  { method: 'PATCH', pattern: /^\/api\/instances\/([^/]+)$/, run: (body, p) => instances.update(p.id, body) },
  {
    method: 'DELETE', pattern: /^\/api\/instances\/([^/]+)$/,
    run: async (_b, p) => {
      queue.clearForInstance(p.id);
      await instances.remove(p.id);
      return { ok: true };
    },
  },
  { method: 'POST', pattern: /^\/api\/instances\/([^/]+)\/test$/, run: (body, p) => instances.test(p.id, body || {}) },
  { method: 'POST', pattern: /^\/api\/instances\/_test$/, run: (body) => instances.test(null, body || {}) },
  { method: 'POST', pattern: /^\/api\/instances\/([^/]+)\/login$/, run: (body, p) => instances.login(p.id, body || {}) },
  { method: 'GET', pattern: /^\/api\/instances\/([^/]+)\/status$/, run: (_b, p) => instances.status(p.id) },
  { method: 'GET', pattern: /^\/api\/instances\/([^/]+)\/browser$/, run: (_b, p, req) => {
    const url = new URL(req.url, 'http://localhost');
    return instances.browser(p.id, url.searchParams.get('path') || '/');
  } },

  { method: 'GET', pattern: /^\/api\/jobs$/, run: () => queue.all() },
  { method: 'POST', pattern: /^\/api\/jobs$/, run: (body) => queue.add(body) },
  { method: 'POST', pattern: /^\/api\/jobs\/([^/]+)\/cancel$/, run: (_b, p) => { queue.cancel(p.id); return { ok: true }; } },
  { method: 'POST', pattern: /^\/api\/jobs\/([^/]+)\/retry$/, run: (_b, p) => { queue.retry(p.id); return { ok: true }; } },
  { method: 'POST', pattern: /^\/api\/jobs\/([^/]+)\/move$/, run: (body, p) => {
    const dir = body?.dir === 'down' ? 'down' : 'up';
    queue.move(p.id, dir);
    return { ok: true };
  } },
  { method: 'DELETE', pattern: /^\/api\/jobs\/([^/]+)$/, run: (_b, p) => { queue.remove(p.id); return { ok: true }; } },
  { method: 'POST', pattern: /^\/api\/jobs\/clear-completed$/, run: (body) => {
    queue.clearCompleted(body?.instanceId || null);
    return { ok: true };
  } },
];

async function handleApi(req, res, pathname) {
  let body = {};
  if (req.method !== 'GET') {
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    try {
      const params = { id: decodeURIComponent(m[1] || '') };
      const result = await route.run(body, params, req);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  return sendJson(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(STATIC_DIR, pathname));
  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(STATIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(idx);
      });
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (!authed(req)) {
      if (url.pathname.startsWith('/api/')) {
        sendJson(res, 401, { error: 'unauthorized', tokenRequired: true });
      } else {
        // serve the app; the UI shows a token gate when one is configured
        return serveStatic(req, res);
      }
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname);
      return;
    }
    serveStatic(req, res);
  } catch (err) {
    console.error('[server] unhandled:', err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
});

hub.attach(server);

server.listen(config.port, config.host, () => {
  console.log(`MEGAcmd Web listening on http://${config.host}:${config.port}`);
  if (config.accessToken) {
    console.log('Access token is ENABLED — pass it via the Authorization header (Bearer) or as the token query parameter on the API and WebSocket URL');
  } else {
    console.log('No ACCESS_TOKEN set — the UI is open to anyone who can reach it. Set ACCESS_TOKEN for public deployments.');
  }
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received — shutting down`);
  try { await queue.close(); } catch { /* ignore */ }
  try { await instances.closeAll(); } catch { /* ignore */ }
  hub.close();
  instancesStore.close();
  jobsStore.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));