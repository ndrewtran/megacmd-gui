'use strict';

const { WebSocketServer } = require('ws');

/**
 * WebSocket hub. Clients receive:
 *   { type: 'state',    instances: [...], jobs: [...] }   full snapshot
 *   { type: 'progress', jobs: [...] }                     live progress ticks
 */
class Hub {
  constructor({ accessToken, getState }) {
    this.accessToken = accessToken;
    this.getState = getState; // () => { instances, jobs }
    this.wss = null;
  }

  attach(server) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const token = extractToken(req);
      if (this.accessToken && token !== this.accessToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.send(JSON.stringify({ type: 'hello', ...this.getState() }));
      ws.on('close', () => undefined);
      ws.on('error', () => undefined);
    });

    // liveness sweep
    this._sweep = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    }, 30000);
    if (this._sweep.unref) this._sweep.unref();
  }

  _broadcast(obj) {
    if (!this.wss) return;
    const msg = JSON.stringify(obj);
    for (const ws of this.wss.clients) {
      if (ws.readyState === 1) {
        try { ws.send(msg); } catch { /* ignore */ }
      }
    }
  }

  /** Full snapshot push (instances + jobs). */
  pushState() {
    this._broadcast({ type: 'state', ...this.getState() });
  }

  /** Throttled progress push (jobs with updated progress). */
  pushProgress(jobs) {
    this._broadcast({ type: 'progress', jobs });
  }

  /** Instances-only push (status changes). */
  pushInstances() {
    const { instances } = this.getState();
    this._broadcast({ type: 'instances', instances });
  }

  close() {
    if (this._sweep) clearInterval(this._sweep);
    for (const ws of this.wss?.clients || []) {
      try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
    }
    this.wss?.close();
  }
}

function extractToken(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const fromQuery = url.searchParams.get('token');
  if (fromQuery) return fromQuery;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

module.exports = { Hub, extractToken };