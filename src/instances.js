'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');
const { runLocal, runRemote } = require('./exec');

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function genId() {
  return crypto.randomBytes(8).map((b) => ID_ALPHABET[b % 36]).join('');
}

function parseWhoami(out) {
  const m = /Account e-mail:\s*(\S+)/i.exec(out);
  return m ? m[1] : null;
}

/** SHA-256 base64 fingerprint of an sshpk/ssh2 key object (wire format). */
function hostKeyFingerprint(key) {
  try {
    let buf = null;
    if (key && typeof key.toBuffer === 'function') buf = key.toBuffer('ssh');
    else if (key && typeof key.getPublicKey === 'function') {
      const pub = key.getPublicKey();
      buf = pub && typeof pub.toBuffer === 'function' ? pub.toBuffer() : pub;
    }
    if (!buf) return null;
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    return crypto.createHash('sha256').update(buf).digest('base64');
  } catch {
    return null;
  }
}

function loadHostKeyCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveHostKeyCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2));
  } catch { /* best effort */ }
}

/**
 * Parse `ls -l --show-handles` output:
 *   FLAGS VERS      SIZE            DATE          HANDLE NAME
 *   d---    -            - 06Sep2025 14:07:09 H:f5EyzBia Allie Peebles
 *   ----    1       744022 06Sep2025 14:07:09 H:joU2gZqR  00773.jpeg
 */
const LS_L_RE = /^([d-])(\S{3})\s+(\S+)\s+(\d+|-)\s+(\d{2}\w{3}\d{4} \d{2}:\d{2}:\d{2})\s+(H:\S+|-)\s+(.+)$/;

function parseLsHandles(out) {
  const entries = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || line.endsWith(':')) continue;
    const m = LS_L_RE.exec(line);
    if (!m) continue;
    entries.push({
      name: m[7].trim(),
      isFolder: m[1] === 'd',
      size: m[4] === '-' ? null : Number(m[4]),
      date: m[5],
      handle: m[6].startsWith('H:') ? m[6] : null,
    });
  }
  return entries;
}

/**
 * Manages the persistent SSH connection for one remote instance.
 */
class SshManager {
  constructor(instance, onStatusChange, dataDir) {
    this.instance = instance;
    this.onStatusChange = onStatusChange;
    this.conn = null;
    this.connecting = null; // in-flight connect promise
    this._hostKeyFile = dataDir
      ? path.join(dataDir, `hostkeys-${instance.id}.json`)
      : null;
    this._hostKeys = this._hostKeyFile ? loadHostKeyCache(this._hostKeyFile) : {};
  }

  get cfg() {
    return this.instance.ssh || {};
  }

  isConnected() {
    return Boolean(this.conn);
  }

  ensure() {
    if (this.conn) return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting;

    const { host, port = 22, user, authType, password, keyData, keyPath, keyPassphrase } = this.cfg;
    if (!host || !user) {
      return Promise.reject(new Error('SSH host and user are required'));
    }

    const p = new Promise((resolve, reject) => {
      const conn = new Client();
      const config = {
        host,
        port: Number(port) || 22,
        username: user,
        readyTimeout: 15000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        // First contact pins the host key (SHA-256, per host:port) into the
        // data dir; a *changed* key on later connects is rejected.
        hostVerifier: (key) => {
          const fp = hostKeyFingerprint(key);
          if (!fp) return true; // unparseable key: accept (logged by ssh2)
          const label = `${host}:${Number(port) || 22}`;
          const known = this._hostKeys[label];
          if (known && known !== fp) {
            console.warn(`[ssh] HOST KEY MISMATCH for ${label} — expected ${known}, got ${fp} — connection refused`);
            return false;
          }
          this._hostKeys[label] = fp;
          if (this._hostKeyFile) saveHostKeyCache(this._hostKeyFile, this._hostKeys);
          return true;
        },
      };

      if (authType === 'key') {
        let key = keyData;
        if (!key && keyPath) {
          try { key = fs.readFileSync(keyPath, 'utf8'); } catch { key = null; }
        }
        if (!key) {
          conn.end();
          return reject(new Error('Private key is required (paste the key or set a key path)'));
        }
        config.privateKey = key;
        if (keyPassphrase) config.passphrase = keyPassphrase;
      } else {
        if (!password) {
          conn.end();
          return reject(new Error('Password is required'));
        }
        config.password = password;
      }

      conn.on('ready', () => {
        if (this.connecting === p) this.connecting = null;
        this.conn = conn;
        resolve(conn);
      });
      conn.on('error', (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!this.conn) {
          if (this.connecting === p) this.connecting = null;
          reject(new Error(msg));
        } else {
          this.conn = null;
          this.onStatusChange(this.instance.id, 'error', `SSH connection lost: ${msg}`);
        }
      });
      conn.on('close', () => {
        if (this.conn === conn) {
          this.conn = null;
          this.onStatusChange(this.instance.id, 'disconnected', 'SSH connection closed');
        }
      });
      conn.connect(config);
    });

    this.connecting = p;
    return p.catch((err) => {
      this.connecting = null;
      this.onStatusChange(this.instance.id, 'error', err.message);
      throw err;
    });
  }

  /**
   * Run megacmd args over SSH; returns a handle { kill() }.
   * handlers: { onProgress, onLine, onExit }
   */
  async exec(args, handlers) {
    const conn = await this.ensure();
    this.onStatusChange(this.instance.id, 'online', null);
    return runRemote(conn, this.instance.megacmdPath || 'megacmd', args, handlers);
  }

  /** Run megacmd args and capture full output (rejects on non-zero exit). */
  async execCapture(args) {
    const conn = await this.ensure();
    return new Promise((resolve, reject) => {
      let output = '';
      runRemote(conn, this.instance.megacmdPath || 'megacmd', args, {
        onProgress() {},
        onLine: (line) => { output += `${line}\n`; },
        onExit: ({ code, signal, error }) => {
          if (error) reject(new Error(error));
          else if (signal) reject(new Error(`process killed (${signal})`));
          else if (code !== 0) reject(new Error(output.trim() || `exited with code ${code}`));
          else resolve(output);
        },
      });
    });
  }

  close() {
    this.connecting = null;
    if (this.conn) {
      try { this.conn.end(); } catch { /* ignore */ }
      this.conn = null;
    }
  }

  /** Drop the connection; next exec reconnects with fresh config. */
  invalidateConfig() {
    this.close();
  }
}

/**
 * Registry of MEGAcmd instances (local machine or remote hosts over SSH).
 */
class InstanceManager {
  constructor({ store, hub }) {
    this.store = store;
    this.hub = hub;
    this._dataDir = path.dirname(store.file);
    this.instances = new Map();
    this._loadFromStore();
    // refresh MEGA/SSH status for all instances shortly after boot
    setTimeout(() => {
      for (const inst of this.instances.values()) {
        this.status(inst.id).catch(() => undefined);
      }
    }, 800);
    this._healthTimer = setInterval(() => this._healthCheckAll(), 60000);
    if (this._healthTimer.unref) this._healthTimer.unref();
  }

  _loadFromStore() {
    const data = this.store.get();
    for (const rec of data.instances) this._createInstance(rec);
  }

  _createInstance(rec) {
    const inst = { ...structuredClone(rec), status: 'disconnected', error: null };
    this.instances.set(inst.id, inst);
    if (inst.type === 'ssh') {
      inst._ssh = new SshManager(inst, (id, status, error) => this._setStatus(id, status, error), this._dataDir);
    }
    return inst;
  }

  _setStatus(id, status, error) {
    const inst = this.instances.get(id);
    if (!inst) return;
    inst.status = status;
    inst.error = error || null;
    this.hub.pushInstances();
  }

  _persist() {
    this.store.update((d) => {
      d.instances = [...this.instances.values()].map((i) => sanitize(i));
    });
  }

  list() {
    return [...this.instances.values()].map(sanitize);
  }

  get(id) {
    return this.instances.get(id) || null;
  }

  /** Stored config for an instance (secrets intact, for merging overrides). */
  rawConfig(id) {
    const inst = this.instances.get(id);
    if (!inst) return null;
    const { _ssh, status, error, ...rest } = inst;
    return structuredClone(rest);
  }

  async add(cfg) {
    const id = genId();
    const rec = normalizeConfig(cfg, id);
    this.store.update((d) => {
      d.instances.push(rec);
    });
    const inst = this._createInstance(rec);
    this.hub.pushInstances();
    return sanitize(inst);
  }

  async update(id, patch) {
    const inst = this.instances.get(id);
    if (!inst) throw new Error('Instance not found');
    const merged = effectiveConfig(this.rawConfig(id), patch);
    const sshChanged = JSON.stringify(merged.ssh) !== JSON.stringify(inst.ssh) || merged.type !== inst.type;
    Object.assign(inst, normalizeConfig(merged, id));
    if (inst.type === 'ssh') {
      if (!inst._ssh) {
        inst._ssh = new SshManager(inst, (id, status, error) => this._setStatus(id, status, error), this._dataDir);
      } else if (sshChanged) {
        inst._ssh.invalidateConfig();
      }
    }
    this._persist();
    this.hub.pushInstances();
    return sanitize(inst);
  }

  async remove(id) {
    const inst = this.instances.get(id);
    if (!inst) throw new Error('Instance not found');
    if (inst._ssh) inst._ssh.close();
    this.instances.delete(id);
    this.store.update((d) => {
      d.instances = d.instances.filter((r) => r.id !== id);
    });
    this.hub.pushInstances();
  }

  /**
   * Execute megacmd args on an instance. Returns a handle { kill() }.
   */
  async exec(instanceId, args, handlers) {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error('Instance not found');
    if (inst.type === 'local') {
      this._setStatus(instanceId, 'online', null);
      return runLocal(inst.megacmdPath || 'megacmd', args, handlers);
    }
    return inst._ssh.exec(args, handlers);
  }

  async _capture(inst, args) {
    if (inst.type === 'local') {
      return new Promise((resolve, reject) => {
        let output = '';
        runLocal(inst.megacmdPath || 'megacmd', args, {
          onProgress() {},
          onLine: (line) => { output += `${line}\n`; },
          onExit: ({ code, signal, error }) => {
            if (error) reject(new Error(error));
            else if (signal) reject(new Error(`process killed (${signal})`));
            else if (code !== 0) reject(new Error(output.trim() || `exited with code ${code}`));
            else resolve(output);
          },
        });
      });
    }
    return inst._ssh.execCapture(args);
  }

  /**
   * Test an instance config. `overrides` are raw form fields (same shape as
   * add/update) merged over the stored config; use for both saved instances
   * and the add dialog.
   */
  async test(instanceId, overrides) {
    const base = instanceId ? this.rawConfig(instanceId) : null;
    const cfg = normalizeConfig(effectiveConfig(base || { type: overrides?.type || 'local' }, overrides || {}), '_test');

    if (cfg.type === 'local') {
      const out = await new Promise((resolve, reject) => {
        let output = '';
        runLocal(cfg.megacmdPath || 'megacmd', ['whoami'], {
          onProgress() {},
          onLine: (line) => { output += `${line}\n`; },
          onExit: ({ code, signal, error }) => {
            if (error) reject(new Error(error));
            else if (signal) reject(new Error(`process killed (${signal})`));
            else resolve(output);
          },
        });
      });
      return { ok: /e-mail/i.test(out), output: out.trim(), megaUser: parseWhoami(out) };
    }

    const fake = { id: '_test', ...cfg, status: 'disconnected', error: null };
    const mgr = new SshManager(fake, () => undefined, this._dataDir);
    try {
      const out = await mgr.execCapture(['whoami']);
      return { ok: /e-mail/i.test(out), output: out.trim(), megaUser: parseWhoami(out) };
    } catch (err) {
      return { ok: false, output: err.message, megaUser: null };
    } finally {
      mgr.close();
    }
  }

  /**
   * Log into MEGA on an instance with email + password (and optional MFA
   * code) or with a session id / exported link. The session is stored by
   * megacmd itself on that machine.
   */
  async login(instanceId, { email, password, authCode }) {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error('Instance not found');
    const args = ['login'];
    if (email && password) {
      args.push(email, password);
      if (authCode) args.push(`--auth-code=${authCode}`);
    } else if (email) {
      args.push(email);
    } else {
      throw new Error('Email (or session) is required');
    }
    let output;
    let ok = true;
    try {
      output = await this._capture(inst, args);
    } catch (err) {
      ok = false;
      output = err.message;
    }
    if (ok) {
      try {
        const who = await this._capture(inst, ['whoami']);
        inst.megaUser = parseWhoami(who) || email || null;
      } catch { /* keep whatever we had */ }
      this._persist();
      this.hub.pushInstances();
    }
    return { ok, output: output.trim() };
  }

  /** Check MEGA login status of an instance. */
  async status(instanceId) {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error('Instance not found');
    try {
      const out = await this._capture(inst, ['whoami']);
      inst.megaUser = parseWhoami(out);
      if (inst.type === 'local') this._setStatus(inst.id, 'online', null);
      this._persist();
      this.hub.pushInstances();
      return { ok: Boolean(inst.megaUser), megaUser: inst.megaUser, output: out.trim() };
    } catch (err) {
      inst.megaUser = null;
      if (inst.type === 'local') this._setStatus(inst.id, 'error', err.message);
      this.hub.pushInstances();
      return { ok: false, megaUser: null, output: err.message };
    }
  }

  /** ls -l --show-handles for the browser view */
  async browser(instanceId, remotePath) {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error('Instance not found');
    const out = await this._capture(inst, ['ls', '-l', '--show-handles', remotePath || '/']);
    return { path: remotePath || '/', entries: parseLsHandles(out) };
  }

  _healthCheckAll() {
    for (const inst of this.instances.values()) {
      if (inst.type !== 'ssh' || !inst._ssh || !inst._ssh.isConnected()) continue;
      if (inst.status === 'online') continue;
      this._setStatus(inst.id, 'online', null);
    }
  }

  async closeAll() {
    for (const inst of this.instances.values()) if (inst._ssh) inst._ssh.close();
    clearInterval(this._healthTimer);
  }
}

/** Merge raw form fields over a stored instance config (skipping empty fields). */
function effectiveConfig(stored, overrides) {
  const base = structuredClone(stored || {});
  const o = overrides || {};
  const out = { ...base };
  if (o.name !== undefined) out.name = o.name;
  if (o.type !== undefined) out.type = o.type;
  if (o.megacmdPath !== undefined) out.megacmdPath = o.megacmdPath;
  if (o.downloadDir !== undefined) out.downloadDir = o.downloadDir;
  if (o.maxConcurrent !== undefined) out.maxConcurrent = o.maxConcurrent;
  if (o.notes !== undefined) out.notes = o.notes;
  if (o.ssh && typeof o.ssh === 'object') {
    const s = { ...(out.ssh || { host: '', port: 22, user: '', authType: 'password', password: '', keyData: '', keyPath: '', keyPassphrase: '' }) };
    for (const k of ['host', 'port', 'user', 'authType', 'password', 'keyData', 'keyPath', 'keyPassphrase']) {
      if (o.ssh[k] !== undefined && o.ssh[k] !== '') s[k] = o.ssh[k];
      // masked placeholders must never clobber stored secrets
      else if (o.ssh[k] === '••••••') { /* skip */ }
    }
    out.ssh = s;
  }
  return out;
}

function normalizeConfig(cfg, id) {
  const type = cfg.type === 'ssh' ? 'ssh' : 'local';
  return {
    id,
    name: String(cfg.name || 'unnamed').slice(0, 60),
    type,
    ssh: type === 'ssh'
      ? {
        host: String(cfg.ssh?.host || '').trim(),
        port: Number(cfg.ssh?.port || 22) || 22,
        user: String(cfg.ssh?.user || '').trim(),
        authType: cfg.ssh?.authType === 'key' ? 'key' : 'password',
        password: cfg.ssh?.password || '',
        keyData: cfg.ssh?.keyData || '',
        keyPath: cfg.ssh?.keyPath || '',
        keyPassphrase: cfg.ssh?.keyPassphrase || '',
      }
      : null,
    megacmdPath: String(cfg.megacmdPath || (type === 'local' ? guessLocalBin() : 'megacmd')).slice(0, 200),
    downloadDir: String(cfg.downloadDir || (type === 'local' ? os.homedir() : '/root/downloads')).slice(0, 500),
    maxConcurrent: Math.max(1, Math.min(8, Number(cfg.maxConcurrent || 1) || 1)),
    notes: String(cfg.notes || '').slice(0, 500),
    megaUser: cfg.megaUser || null,
  };
}

function guessLocalBin() {
  const candidates = [
    `${os.homedir()}/.local/bin/megacmd`,
    '/usr/local/bin/megacmd',
    '/Applications/MEGAcmd.app/Contents/MacOS/mega-exec',
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch { /* keep looking */ }
  }
  return 'megacmd';
}

function sanitize(inst) {
  return {
    id: inst.id,
    name: inst.name,
    type: inst.type,
    ssh: inst.ssh
      ? { ...inst.ssh, password: inst.ssh.password ? '••••••' : '', keyData: inst.ssh.keyData ? '••••••' : '' }
      : null,
    megacmdPath: inst.megacmdPath,
    downloadDir: inst.downloadDir,
    maxConcurrent: inst.maxConcurrent,
    notes: inst.notes,
    megaUser: inst.megaUser,
    status: inst.status,
    error: inst.error,
  };
}

module.exports = { InstanceManager, genId, parseLsHandles, parseWhoami };