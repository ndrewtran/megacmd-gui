'use strict';

const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { ProgressParser } = require('./progress');

/**
 * Fixed, read-only shell snippet used to list subfolders of a directory on a
 * remote (SSH or PC-agent) machine. The agent only executes commands that
 * contain this marker (and the server never builds anything else).
 */
const LS_SNIPPET_MARKER = 'MEGANET_LS_DIRS_V1';

/** Build the fixed read-only listing command for a target directory.
 *  An empty/blank dir means "the user's home" ($HOME on the remote host). */
function buildLsDirsCommand(dir) {
  const d = String(dir || '').trim();
  const target = d === ''
    ? '$HOME'
    : `'${d.replace(/[^\x20-\x7e]/g, '').replace(/'/g, `'\\''`)}'`;
  return (
    `# ${LS_SNIPPET_MARKER}\n` +
    `cd -- ${target} || exit 1\n` +
    `printf '%s\\n' "$(pwd -P)"\n` +
    `for e in * .[!.]* ..?*; do [ -d "$e" ] && printf '%s\\n' "$e"; done\n` +
    `exit 0`
  );
}

/** Parse the output of buildLsDirsCommand into a normalized listing. */
function parseLsDirsOutput(out) {
  const lines = out.split('\n').map((l) => l.replace(/\r$/, ''));
  const first = lines.find((l) => l.length > 0 && l.startsWith('/'));
  if (!first) throw new Error('Could not resolve directory (no output)');
  const canonical = first;
  const entries = lines
    .slice(lines.indexOf(canonical) + 1)
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('/'))
    .map((name) => ({ name, path: `${canonical === '/' ? '' : canonical}/${name}` }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return {
    path: canonical,
    root: '/',
    parent: canonical === '/' ? null : `${canonical.slice(0, canonical.lastIndexOf('/')) || '/'}`,
    entries,
  };
}

/**
 * Manages PC bridge agents (agent.js) connecting back over WebSocket.
 * Agents are bound to `pc` instances by agent name; a first-time connection
 * auto-creates the instance.
 */
class AgentManager {
  constructor({ config, hub, instances }) {
    this.config = config;
    this.hub = hub;
    this.instances = instances; // InstanceManager (lazy-bound)
    this.agents = new Map(); // name -> { ws, hello, lastSeen, instanceId }
    this.wss = null;
  }

  get token() {
    return this.config.agentToken || this.config.accessToken || '';
  }

  attach(server) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/agent') return;
      const token = url.searchParams.get('token');
      if (!this.token || token !== this.token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this._onRawConnection(ws);
      });
    });

    this._sweep = setInterval(() => this._livenessSweep(), 30000);
    if (this._sweep.unref) this._sweep.unref();
  }

  _onRawConnection(ws) {
    let entry = null;
    let binding = null;
    let helloTimer = null;

    const fail = (code, msg) => {
      try {
        if (ws.readyState === 0) ws.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`);
      } catch { /* ignore */ }
      try { ws.destroy(); } catch { /* ignore */ }
    };

    const onMessage = (raw) => {
      let msg;
      // ws delivers payloads as Buffer (default binaryType); accept string too.
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw).toString('utf8');
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === 'hello' && !entry && !binding) {
        if (helloTimer) clearTimeout(helloTimer);
        const name = String(msg.name || 'This PC').slice(0, 60);
        binding = this._bindAgent(name, ws, msg)
          .then((e) => { entry = e; })
          .catch((err) => {
            console.error('[agents] bind failed:', err.message);
            try { ws.terminate(); } catch { /* ignore */ }
          });
        return;
      }
      if (!entry) return;
      entry.lastSeen = Date.now();
      const pending = entry._pending.get(msg.id);
      if (!pending) return;
      if (msg.type === 'out') {
        const out = pending.parser.push(String(msg.data || ''));
        if (out.progress) pending.handlers.onProgress(out.progress);
        for (const line of out.lines) pending.handlers.onLine(line);
      } else if (msg.type === 'exit') {
        entry._pending.delete(msg.id);
        const flushed = pending.parser.flush();
        if (flushed.progress) pending.handlers.onProgress(flushed.progress);
        for (const line of flushed.lines) pending.handlers.onLine(line);
        if (pending.settled) return;
        pending.settled = true;
        const error = msg.error || (msg.code === -1 && msg.signal === 'EIO' ? 'PC agent connection lost' : null);
        pending.handlers.onExit({ code: msg.code ?? -1, signal: msg.signal || null, error });
      } else if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
      }
    };

    const onClose = () => {
      if (helloTimer) clearTimeout(helloTimer);
      if (entry && entry.ws === ws) {
        this._unbindAgent(entry, 'PC agent disconnected');
      }
      try { ws.terminate(); } catch { /* ignore */ }
    };

    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', () => { /* close follows */ });
    helloTimer = setTimeout(() => {
      if (!entry && !binding) fail(400, 'Bad Request');
    }, 10000);
  }

  async _bindAgent(name, ws, hello) {
    // Replace any previous socket with the same name.
    const prev = this.agents.get(name);
    if (prev) {
      try { prev.ws.terminate(); } catch { /* ignore */ }
      this.agents.delete(name);
    }

    let instanceId = null;
    const existing = this.instances.list().find(
      (i) => i.type === 'pc' && i.agentName === name
    );
    if (existing) {
      instanceId = existing.id;
    } else {
      const created = await this.instances.add({
        name,
        type: 'pc',
        agentName: name,
        megacmdPath: String(hello.megacmd || 'megacmd'),
        downloadDir: String(hello.homedir || os.homedir()),
      });
      instanceId = created.id;
      console.log(`[agents] auto-created instance "${name}" (${instanceId})`);
    }

    // The socket may have closed while we were awaiting — don't bind a zombie.
    if (ws.readyState !== 1) return;

    const entry = { ws, name, hello, instanceId, lastSeen: Date.now(), _pending: new Map() };
    this.agents.set(name, entry);
    this.instances.setAgentStatus(instanceId, 'online', null);
    this.instances.status(instanceId).catch(() => undefined); // refresh MEGA account
    this.hub.pushInstances();
    console.log(`[agents] "${name}" connected (instance ${instanceId}, platform ${hello.platform || 'n/a'})`);
    return entry;
  }

  _unbindAgent(entry, reason) {
    for (const [id, pending] of entry._pending) {
      if (pending.settled) continue;
      pending.settled = true;
      pending.handlers.onExit({ code: -1, signal: null, error: reason });
    }
    entry._pending.clear();
    if (this.agents.get(entry.name) === entry) this.agents.delete(entry.name);
    if (entry.instanceId) {
      this.instances.setAgentStatus(entry.instanceId, 'disconnected', reason);
      console.log(`[agents] "${entry.name}" disconnected (${reason})`);
    }
    this.hub.pushInstances();
  }

  _livenessSweep() {
    const now = Date.now();
    for (const entry of [...this.agents.values()]) {
      if (now - entry.lastSeen > 90000) {
        try { entry.ws.terminate(); } catch { /* ignore */ }
      }
    }
  }

  online(name) {
    const entry = this.agents.get(name);
    return Boolean(entry && entry.ws.readyState === 1);
  }

  /** Names of currently connected agents (for the UI). */
  connected() {
    return [...this.agents.entries()].map(([name, e]) => ({
      name,
      platform: e.hello.platform || null,
      megacmd: e.hello.megacmd || null,
    }));
  }

  /**
   * Execute megacmd args on the agent bound to `instance`.
   * Returns { kill() } like the other executors.
   */
  async execFor(instance, args, handlers) {
    const entry = this.agents.get(instance.agentName);
    if (!entry || entry.ws.readyState !== 1) {
      throw new Error(`PC agent "${instance.agentName || instance.name}" is not connected — start the bridge agent on that computer`);
    }
    return this._runOn(entry, 'run', { bin: instance.megacmdPath || 'megacmd', args }, handlers);
  }

  /** Execute the fixed read-only listing command on the agent. */
  async lsDirsFor(instance, dir) {
    const entry = this.agents.get(instance.agentName);
    if (!entry || entry.ws.readyState !== 1) {
      throw new Error(`PC agent "${instance.agentName || instance.name}" is not connected`);
    }
    const out = await this._captureOn(entry, 'shell', { cmd: buildLsDirsCommand(dir) });
    return parseLsDirsOutput(out);
  }

  /** Capture full output of megacmd args on the agent (rejects on non-zero). */
  async captureFor(instance, args) {
    const entry = this.agents.get(instance.agentName);
    if (!entry || entry.ws.readyState !== 1) {
      throw new Error(`PC agent "${instance.agentName || instance.name}" is not connected — start the bridge agent on that computer`);
    }
    return this._captureOn(entry, 'run', { bin: instance.megacmdPath || 'megacmd', args });
  }

  _runOn(entry, type, payload, handlers) {
    const parser = new ProgressParser();
    const id = crypto.randomBytes(6).toString('hex');
    const pending = { parser, handlers, settled: false };
    entry._pending.set(id, pending);
    entry.lastSeen = Date.now();
    entry.ws.send(JSON.stringify({ type, id, ...payload }));
    return {
      kill() {
        if (pending.settled) return;
        try { entry.ws.send(JSON.stringify({ type: 'kill', id })); } catch { /* ignore */ }
      },
    };
  }

  _captureOn(entry, type, payload) {
    return new Promise((resolve, reject) => {
      let output = '';
      const handle = this._runOn(entry, type, payload, {
        onProgress() {},
        onLine: (line) => { output += `${line}\n`; },
        onExit: ({ code, signal, error }) => {
          if (error) reject(new Error(error));
          else if (signal && code === -1) reject(new Error(`process killed (${signal})`));
          else if (code !== 0) reject(new Error(output.trim() || `exited with code ${code}`));
          else resolve(output);
        },
      });
      if (!handle) { /* unreachable */ }
    });
  }

  /** Ask all agents to stop (server shutdown). */
  close() {
    if (this._sweep) clearInterval(this._sweep);
    for (const entry of this.agents.values()) {
      try { entry.ws.send(JSON.stringify({ type: 'bye' })); } catch { /* ignore */ }
      try { entry.ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
    }
    this.agents.clear();
    this.wss?.close();
  }
}

module.exports = { AgentManager, LS_SNIPPET_MARKER, buildLsDirsCommand, parseLsDirsOutput };