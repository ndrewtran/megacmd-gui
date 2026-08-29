'use strict';

const crypto = require('crypto');

const JOB_STATUSES = {
  queued: 'queued',
  downloading: 'downloading',
  uploading: 'uploading',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted', // was running when the server restarted
};

const MAX_LOG_LINES = 400;

function genId() {
  return crypto.randomBytes(8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function publicJob(job) {
  return {
    id: job.id,
    instanceId: job.instanceId,
    action: job.action,
    source: job.source,
    dest: job.dest,
    status: job.status,
    progress: {
      pct: job.progress.pct,
      doneBytes: job.progress.doneBytes,
      totalBytes: job.progress.totalBytes,
      speed: job.progress.speed,
    },
    label: job.label,
    error: job.error,
    log: job.log.slice(-80),
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

/**
 * Per-instance FIFO download queue with live progress.
 *
 * Store shape: { jobs: {id: job}, order: {instanceId: [jobId,...]}, seq }
 */
class QueueManager {
  constructor({ store, hub, instances }) {
    this.store = store;
    this.hub = hub;
    this.instances = instances;
    this.jobs = new Map();
    this.handles = new Map(); // jobId -> {kill()}
    this._dirty = new Set();
    this._loadFromStore();

    this._flushTimer = setInterval(() => this._flushProgress(), 300);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  _loadFromStore() {
    const data = this.store.get();
    for (const [id, job] of Object.entries(data.jobs || {})) {
      const j = structuredClone(job);
      if (j.status === 'downloading' || j.status === 'uploading') {
        j.status = 'interrupted';
        j.error = 'Server restarted while this transfer was running';
      }
      j.log = j.log || [];
      this.jobs.set(id, j);
    }
    // re-arm pumps for any queued work
    for (const inst of this.instances.list()) this.pump(inst.id);
  }

  _persist() {
    this.store.update((d) => {
      d.jobs = Object.fromEntries(this.jobs);
      d.order = structuredClone(this._order());
    });
  }

  _order() {
    const order = {};
    for (const inst of this.instances.list()) {
      order[inst.id] = this.queuedIds(inst.id);
    }
    return order;
  }

  all() {
    return [...this.jobs.values()].map(publicJob);
  }

  /** Per-instance queue order (job ids, front first). */
  order() {
    const data = this.store.get();
    const out = {};
    for (const [instId, list] of Object.entries(data.order || {})) {
      out[instId] = (list || []).filter((id) => this.jobs.has(id));
    }
    return out;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  queuedIds(instanceId) {
    const data = this.store.get();
    return (data.order && data.order[instanceId]) || [];
  }

  runningCount(instanceId) {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.instanceId === instanceId && (job.status === 'downloading' || job.status === 'uploading')) n += 1;
    }
    return n;
  }

  /**
   * Queue a new job.
   * params: { instanceId, action: 'get'|'put', source, dest?, password? }
   */
  add(params) {
    const inst = this.instances.get(params.instanceId);
    if (!inst) throw new Error('Instance not found');
    if (!['get', 'put'].includes(params.action)) throw new Error('Action must be get or put');
    const source = String(params.source || '').trim();
    if (!source) throw new Error('Source (MEGA link, handle or path) is required');
    const dest = String(params.dest || '').trim() || inst.downloadDir;
    if (!dest) throw new Error('Download destination is required (set it on the instance)');

    const data = this.store.get();
    const id = genId();
    const job = {
      id,
      instanceId: inst.id,
      action: params.action,
      source,
      dest,
      password: params.password ? String(params.password) : '',
      label: labelFor(params.action, source),
      status: 'queued',
      progress: { pct: 0, doneBytes: 0, totalBytes: 0, speed: 0 },
      _speedWindow: null,
      log: [],
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      _killRequested: false,
    };
    this.jobs.set(id, job);
    this.store.update((d) => {
      d.jobs[id] = publicJobWithSecrets(job);
      d.order = d.order || {};
      d.order[inst.id] = [...(d.order[inst.id] || []), id];
    });
    this.hub.pushState();
    this.pump(inst.id);
    return publicJob(job);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Job not found');
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      this._removeFromOrder(job.instanceId, id);
      this._persist();
      this.hub.pushState();
      this.pump(job.instanceId);
      return;
    }
    if (job.status === 'downloading' || job.status === 'uploading') {
      job._killRequested = true;
      const handle = this.handles.get(id);
      if (handle) handle.kill();
      // onExit will finalize; if the process is wedged, force it after 6s
      setTimeout(() => {
        if (job.status === 'downloading' || job.status === 'uploading') {
          this._finalize(job, 'cancelled', 'Stopped');
        }
      }, 6000);
    }
  }

  retry(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Job not found');
    if (job.status === 'downloading' || job.status === 'uploading') throw new Error('Job is still running');
    Object.assign(job, {
      status: 'queued',
      progress: { pct: 0, doneBytes: 0, totalBytes: 0, speed: 0 },
      _speedWindow: null,
      log: [`— retried at ${new Date().toISOString()} —`],
      error: null,
      startedAt: null,
      finishedAt: null,
      _killRequested: false,
    });
    // move to front of the queue
    this.store.update((d) => {
      d.order = d.order || {};
      d.order[job.instanceId] = [id, ...((d.order[job.instanceId] || []).filter((x) => x !== id))];
    });
    this._persist();
    this.hub.pushState();
    this.pump(job.instanceId);
  }

  move(id, dir) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Job not found');
    if (job.status !== 'queued') throw new Error('Only queued jobs can be reordered');
    this.store.update((d) => {
      d.order = d.order || {};
      const list = [...(d.order[job.instanceId] || [])];
      const idx = list.indexOf(id);
      if (idx === -1) {
        // not in the order list (e.g. after a restart) — place sensibly
        const at = dir === 'up' ? Math.max(0, list.length - 1) : list.length;
        list.splice(at, 0, id);
      } else {
        const to = dir === 'up' ? idx - 1 : idx + 1;
        if (to < 0 || to >= list.length) return;
        list.splice(idx, 1);
        list.splice(to, 0, id);
      }
      d.order[job.instanceId] = list;
    });
    this.hub.pushState();
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Job not found');
    if (job.status === 'downloading' || job.status === 'uploading') throw new Error('Cancel the job first');
    this.jobs.delete(id);
    this._removeFromOrder(job.instanceId, id);
    this._persist();
    this.hub.pushState();
  }

  clearCompleted(instanceId) {
    for (const job of this.jobs.values()) {
      if (instanceId && job.instanceId !== instanceId) continue;
      if (['done', 'failed', 'cancelled', 'interrupted'].includes(job.status)) {
        this.jobs.delete(job.id);
      }
    }
    this.store.update((d) => {
      d.order = d.order || {};
      if (instanceId) d.order[instanceId] = (d.order[instanceId] || []).filter((id) => this.jobs.has(id));
    });
    this._persist();
    this.hub.pushState();
  }

  /** Drop all jobs belonging to an instance (called on instance removal). */
  clearForInstance(instanceId) {
    for (const job of [...this.jobs.values()]) {
      if (job.instanceId !== instanceId) continue;
      if (job.status === 'downloading' || job.status === 'uploading') {
        const handle = this.handles.get(job.id);
        if (handle) handle.kill();
      }
      this.jobs.delete(job.id);
    }
    this.store.update((d) => {
      d.order = d.order || {};
      delete d.order[instanceId];
    });
    this._persist();
    this.hub.pushState();
  }

  /** Start as many queued jobs as the instance allows. */
  pump(instanceId) {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    let guard = 0;
    while (guard++ < 16 && this.runningCount(instanceId) < inst.maxConcurrent) {
      const nextId = this._nextQueued(instanceId);
      if (!nextId) break;
      this._start(nextId);
    }
  }

  _nextQueued(instanceId) {
    const data = this.store.get();
    const list = (data.order || {})[instanceId] || [];
    for (const id of list) {
      const job = this.jobs.get(id);
      if (job && job.status === 'queued') return id;
    }
    return null;
  }

  async _start(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') return;
    const inst = this.instances.get(job.instanceId);
    if (!inst) {
      this._finalize(job, 'failed', 'Instance was removed');
      return;
    }

    job.status = job.action === 'get' ? 'downloading' : 'uploading';
    job.startedAt = Date.now();
    job.error = null;
    this.hub.pushState();

    const args = this._buildArgs(job);
    try {
      const handle = await this.instances.exec(job.instanceId, args, {
        onProgress: (p) => this._onProgress(job, p),
        onLine: (line) => this._onLine(job, line),
        onExit: ({ code, signal, error }) => this._onExit(job, { code, signal, error }),
      });
      this.handles.set(id, handle);
    } catch (err) {
      this._finalize(job, 'failed', err.message);
    }
  }

  _buildArgs(job) {
    const args = [job.action];
    if (job.action === 'get') {
      args.push(job.source, job.dest);
      if (job.password) args.push(`--password=${job.password}`);
    } else {
      // put: localfile [localfile2 ...] [dstremotepath]
      args.push(job.source, job.dest);
    }
    return args;
  }

  _onProgress(job, p) {
    const now = Date.now();
    const smooth = p.smoothDone ?? p.doneBytes;
    // sliding window (>= 0.5s between anchor samples) for a stable speed
    // estimate, robust against bursty NUL-delimited progress output
    const w = job._speedWindow || (job._speedWindow = { t: now, done: smooth });
    if (smooth > w.done) {
      const dt = (now - w.t) / 1000;
      if (dt >= 0.5) {
        const inst = (smooth - w.done) / dt;
        job.progress.speed = job.progress.speed > 0
          ? job.progress.speed * 0.7 + inst * 0.3
          : inst;
        w.t = now;
        w.done = smooth;
      }
    }
    job.progress.pct = p.pct;
    job.progress.doneBytes = p.doneBytes;
    job.progress.totalBytes = p.totalBytes || job.progress.totalBytes;
    this._dirty.add(job.id);
  }

  _onLine(job, line) {
    if (job.log.length >= MAX_LOG_LINES) job.log.shift();
    job.log.push(line);
    if (/^Download finished:/i.test(line)) {
      const m = /Download finished:\s*(.+)$/.exec(line);
      if (m) job.log.push(`✔ ${m[1].trim()}`);
    }
    this.hub.pushState();
  }

  _onExit(job, { code, signal, error }) {
    this.handles.delete(job.id);
    if (error) {
      this._finalize(job, 'failed', error);
      return;
    }
    if (signal) {
      this._finalize(job, job._killRequested ? 'cancelled' : 'failed',
        job._killRequested ? 'Stopped' : `Process terminated by signal ${signal}`);
      return;
    }
    if (code === 0) {
      job.progress.pct = 100;
      this._finalize(job, 'done', null);
    } else {
      const tail = job.log.slice(-3).join(' | ');
      this._finalize(job, 'failed', `exited with code ${code}${tail ? ` — ${tail}` : ''}`);
    }
  }

  _finalize(job, status, error) {
    if (job.status !== 'downloading' && job.status !== 'uploading') return;
    job.status = status;
    job.error = error || null;
    job.finishedAt = Date.now();
    job.progress.speed = 0;
    this._removeFromOrder(job.instanceId, job.id);
    this._dirty.delete(job.id);
    this._persist();
    this.hub.pushState();
    this.pump(job.instanceId);
  }

  _removeFromOrder(instanceId, jobId) {
    this.store.update((d) => {
      d.order = d.order || {};
      if (d.order[instanceId]) {
        d.order[instanceId] = d.order[instanceId].filter((id) => id !== jobId);
      }
    });
  }

  _flushProgress() {
    if (this._dirty.size === 0) return;
    const jobs = [...this._dirty].map((id) => {
      const job = this.jobs.get(id);
      return job ? publicJob(job) : null;
    }).filter(Boolean);
    this._dirty.clear();
    this.hub.pushProgress(jobs);
  }

  async close() {
    clearInterval(this._flushTimer);
    for (const handle of this.handles.values()) {
      try { handle.kill(); } catch { /* ignore */ }
    }
    this.handles.clear();
    this._persist();
  }
}

function publicJobWithSecrets(job) {
  // store keeps the password so retries work without re-entering it
  return { ...publicJob(job), password: job.password };
}

function labelFor(action, source) {
  if (source.startsWith('H:')) return source;
  if (/^https?:\/\//i.test(source)) {
    try {
      const u = new URL(source);
      return u.host + (u.pathname.length > 40 ? u.pathname.slice(0, 40) + '…' : u.pathname);
    } catch {
      return source;
    }
  }
  const parts = source.split('/').filter(Boolean);
  return parts[parts.length - 1] || source;
}

module.exports = { QueueManager, JOB_STATUSES };