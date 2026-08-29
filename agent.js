#!/usr/bin/env node
'use strict';

/* =========================================================================
   MEGAcmd Web — PC bridge agent
   =========================================================================
   Runs ON YOUR COMPUTER (macOS/Linux/Windows with Node.js >= 22). Connects
   back to a megacmd-gui server over WebSocket and lets the web GUI execute
   this machine's `megacmd` (and a small fixed, read-only folder-listing
   shell command) on your behalf.

   Usage:
     node agent.js --server http://host:3010 --token <GUI_ACCESS_TOKEN> \
        [--name "My Mac"] [--megacmd /path/to/megacmd]

   One-liner (pulls this script from a running megacmd-gui):
     curl -fsSL http://host:3010/agent.js | node -- \
        --server http://host:3010 --token <GUI_ACCESS_TOKEN> --name "My Mac"

   Only the token you pass is stored in process memory; nothing is written
   to disk. The agent executes:
     - the configured megacmd binary with arguments supplied by the server
     - a fixed read-only directory-listing command (cd + [ -d ] test)
   ========================================================================= */

const os = require('os');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const SERVER = (args.server || process.env.MEGANET_SERVER || '').replace(/^http/, 'ws');
const TOKEN = args.token || process.env.MEGANET_TOKEN || '';
const NAME = String(args.name || os.hostname() || 'This PC').slice(0, 60);
const MEGACMD = args.megacmd || process.env.MEGACMD || 'megacmd';

if (!SERVER || !TOKEN) {
  console.error('usage: agent.js --server <ws|http url> --token <gui access token> [--name <label>] [--megacmd <path>]');
  process.exit(1);
}

// Fixed, read-only listing snippet the server may request via {type:'shell'}.
// $1 = target directory. Prints canonical path first, then one subfolder
// name per line. Rejects anything that is not exactly this command.
const LS_SNIPPET_MARKER = 'MEGANET_LS_DIRS_V1';

function buildWsUrl() {
  const u = new URL(SERVER);
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/agent';
  u.search = '';
  u.searchParams.set('token', TOKEN);
  return u.toString();
}

let ws = null;
let closed = false;
let reconnectDelay = 1000;
const procs = new Map(); // runId -> { child, killTimer }

const pingTimer = setInterval(() => send({ type: 'ping' }), 20000);
if (pingTimer.unref) pingTimer.unref();

function send(obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
  }
}

function runProc(id, kind, payload) {
  // kind: 'run' -> { bin, args } | 'shell' -> { cmd }
  let child;
  try {
    if (kind === 'run') {
      child = spawn(payload.bin, payload.args || []);
    } else {
      child = spawn('/bin/sh', ['-c', payload.cmd || '']);
    }
  } catch (err) {
    send({ type: 'exit', id, code: -1, signal: null, error: err.message });
    return;
  }
  let entry = { child, killTimer: null, settled: false };
  procs.set(id, entry);

  const onChunk = (buf) => send({ type: 'out', id, data: buf.toString('utf8') });
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  const finish = (code, signal) => {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.killTimer) clearTimeout(entry.killTimer);
    procs.delete(id);
    send({ type: 'exit', id, code: code ?? -1, signal: signal || null });
  };

  child.on('error', (err) => finish(-1, null));
  child.on('close', (code, signal) => finish(code, signal));
}

function killProc(id) {
  const entry = procs.get(id);
  if (!entry || entry.settled) return;
  try { entry.child.kill('SIGTERM'); } catch { /* ignore */ }
  entry.killTimer = setTimeout(() => {
    try { entry.child.kill('SIGKILL'); } catch { /* ignore */ }
  }, 4000);
  if (entry.killTimer.unref) entry.killTimer.unref();
}

function onMessage(ev) {
  let msg;
  try { msg = JSON.parse(typeof ev === 'string' ? ev : ev.data); } catch { return; }
  if (msg.type === 'run') {
    if (typeof msg.id !== 'string' || !msg.bin || !Array.isArray(msg.args)) return;
    runProc(msg.id, 'run', { bin: msg.bin, args: msg.args });
  } else if (msg.type === 'shell') {
    if (typeof msg.id !== 'string' || typeof msg.cmd !== 'string') return;
    if (!msg.cmd.includes(LS_SNIPPET_MARKER)) {
      // Only the fixed read-only snippet is ever accepted.
      send({ type: 'exit', id: msg.id, code: -1, signal: null, error: 'rejected command' });
      return;
    }
    runProc(msg.id, 'shell', { cmd: msg.cmd });
  } else if (msg.type === 'kill') {
    killProc(msg.id);
  } else if (msg.type === 'bye') {
    console.log('Server asked agent to stop — exiting.');
    stop();
    process.exit(0);
  }
}

function connect() {
  if (closed) return;
  ws = new WebSocket(buildWsUrl());
  ws.onopen = () => {
    reconnectDelay = 1000;
    console.log(`Connected to ${SERVER} as "${NAME}" (megacmd: ${MEGACMD})`);
    send({
      type: 'hello',
      name: NAME,
      megacmd: MEGACMD,
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      homedir: os.homedir(),
    });
  };
  ws.onmessage = onMessage;
  ws.onclose = () => {
    for (const [id, entry] of procs) {
      entry.settled = true;
      if (entry.killTimer) clearTimeout(entry.killTimer);
      try { entry.child.kill('SIGKILL'); } catch { /* ignore */ }
      send({ type: 'exit', id, code: -1, signal: 'EIO' });
    }
    procs.clear();
    if (closed) return;
    console.log(`Disconnected — reconnecting in ${Math.ceil(reconnectDelay / 1000)}s…`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(30000, reconnectDelay * 2);
  };
  ws.onerror = () => { /* onclose follows */ };
}

function stop() {
  closed = true;
  try { ws && ws.close(); } catch { /* ignore */ }
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

connect();