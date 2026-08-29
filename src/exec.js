'use strict';

const { spawn } = require('child_process');
const { toShellCommand } = require('./shell');
const { ProgressParser } = require('./progress');

/**
 * Low-level command executors. Dispatch between local and remote is done by
 * InstanceManager (see instances.js).
 *
 * handlers: {
 *   onProgress(progress) — latest TRANSFERRING progress object
 *   onLine(line)         — any non-progress output line
 *   onExit({ code, signal, error })
 * }
 *
 * Returns a handle: { kill() }
 */

function makeStreamHandlers(parser, handlers) {
  return (chunk) => {
    const out = parser.push(chunk.toString('utf8'));
    if (out.progress) handlers.onProgress(out.progress);
    for (const line of out.lines) handlers.onLine(line);
  };
}

function settle(handlers, parser) {
  const flushed = parser.flush();
  if (flushed.progress) handlers.onProgress(flushed.progress);
  for (const line of flushed.lines) handlers.onLine(line);
}

function runLocal(bin, args, handlers) {
  const parser = new ProgressParser();
  let settled = false;
  let killTimer = null;

  let child;
  try {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    handlers.onExit({ code: -1, signal: null, error: err.message });
    return { kill() {} };
  }

  const dataHandler = makeStreamHandlers(parser, handlers);
  child.stdout.on('data', dataHandler);
  child.stderr.on('data', dataHandler);

  child.on('error', (err) => {
    if (settled) return;
    settled = true;
    handlers.onExit({
      code: -1,
      signal: null,
      error: err.code === 'ENOENT'
        ? `megacmd binary not found: ${bin} (set the command path on the instance)`
        : err.message,
    });
  });

  child.on('close', (code, signal) => {
    if (settled) return;
    settled = true;
    if (killTimer) clearTimeout(killTimer);
    settle(handlers, parser);
    handlers.onExit({ code: code ?? -1, signal, error: null });
  });

  return {
    kill() {
      if (settled || !child.pid) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 4000);
      if (killTimer.unref) killTimer.unref();
    },
  };
}

function runRemote(conn, megacmdPath, args, handlers) {
  const parser = new ProgressParser();
  let settled = false;
  let stream = null;
  const cmd = toShellCommand([megacmdPath, ...args]);

  conn.exec(cmd, { pty: false, term: 'xterm', env: ['LANG=en_US.UTF-8'] }, (err, sshStream) => {
    if (err) {
      if (settled) return;
      settled = true;
      handlers.onExit({ code: -1, signal: null, error: err.message });
      return;
    }
    stream = sshStream;
    const dataHandler = makeStreamHandlers(parser, handlers);
    sshStream.on('data', dataHandler);
    sshStream.stderr.on('data', dataHandler);
    sshStream.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      settle(handlers, parser);
      handlers.onExit({ code: code ?? -1, signal: signal || null, error: null });
    });
    sshStream.on('error', (e) => {
      if (settled) return;
      settled = true;
      handlers.onExit({ code: -1, signal: null, error: e.message });
    });
  });

  return {
    kill() {
      if (!stream || settled) return;
      settled = true;
      try { stream.kill('SIGTERM'); } catch { /* ignore */ }
      handlers.onExit({ code: -1, signal: 'SIGTERM', error: null });
    },
  };
}

module.exports = { runLocal, runRemote };