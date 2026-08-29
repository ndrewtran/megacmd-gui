'use strict';

/* =========================================================================
   MEGAcmd Web — frontend
   ========================================================================= */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  authed: false,
  instances: [],
  jobs: [],
  queue: {},
  activeId: null,
  browser: { path: '/', entries: [] },
  ws: null,
  wsRetry: 0,
};

/* ------------------------------ utils ------------------------------ */

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtSpeed(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '';
  return fmtBytes(bps) + '/s';
}

function fmtEta(job) {
  const p = job.progress;
  if (!p || p.speed <= 0 || p.totalBytes <= 0) return '';
  const left = (p.totalBytes - p.doneBytes) / p.speed;
  if (left > 24 * 3600) return '—';
  const m = Math.floor(left / 60);
  const s = Math.round(left % 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

async function api(path, method = 'GET', body) {
  const opts = { method, headers: {} };
  const token = localStorage.getItem('meganet.token');
  if (token) opts.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    showGate();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ------------------------------ gate ------------------------------ */

function showGate() {
  state.authed = false;
  $('#gate').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#gate-token').focus();
}

$('#gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#gate-token').value.trim();
  if (!token) return;
  localStorage.setItem('meganet.token', token);
  try {
    const s = await api('/api/state');
    state.authed = true;
    $('#gate').classList.add('hidden');
    applyState(s);
    showApp();
    connectWs();
  } catch {
    toast('Invalid token', 'err');
    showGate();
  }
});

function showApp() {
  $('#app').classList.remove('hidden');
}

/* ------------------------------ websocket ------------------------------ */

function connectWs() {
  if (state.ws && state.ws.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = localStorage.getItem('meganet.token') || '';
  const wsUrl = `${proto}://${location.host}/?` + new URLSearchParams({ token: token }).toString();
  const ws = new WebSocket(wsUrl);
  state.ws = ws;

  ws.onopen = () => {
    state.wsRetry = 0;
    $('#conn-status').textContent = 'live';
    $('#conn-status').style.color = '';
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'hello' || msg.type === 'state') {
      state.instances = msg.instances || [];
      state.jobs = msg.jobs || [];
      state.queue = msg.queue || {};
      if (!state.activeId && state.instances.length) state.activeId = state.instances[0].id;
      renderInstances();
      renderHeader();
      renderJobs();
      if (state.activeId) loadBrowser();
    } else if (msg.type === 'instances') {
      state.instances = msg.instances;
      renderInstances();
      renderHeader();
    } else if (msg.type === 'progress') {
      for (const j of msg.jobs || []) {
        const local = state.jobs.find((x) => x.id === j.id);
        if (local) Object.assign(local, j);
      }
      updateJobProgressDom();
    }
  };
  ws.onclose = () => {
    $('#conn-status').textContent = 'reconnecting…';
    const delay = Math.min(15000, 500 * 2 ** state.wsRetry++);
    setTimeout(connectWs, delay);
  };
  ws.onerror = () => ws.close();
}

/* ------------------------------ rendering ------------------------------ */

function activeInstance() {
  return state.instances.find((i) => i.id === state.activeId) || null;
}

function renderInstances() {
  const list = $('#instance-list');
  list.innerHTML = '';
  if (state.instances.length === 0) {
    $('#empty-state').classList.remove('hidden');
    $('#instance-view').classList.add('hidden');
    return;
  }
  $('#empty-state').classList.add('hidden');
  $('#instance-view').classList.remove('hidden');

  for (const inst of state.instances) {
    const el = document.createElement('div');
    el.className = `inst-item ${inst.id === state.activeId ? 'active' : ''}`;
    const sub = inst.type === 'ssh'
      ? `${inst.ssh?.host || ''}${inst.ssh?.port && inst.ssh.port !== 22 ? `:${inst.ssh.port}` : ''}`
      : inst.type === 'pc' ? (inst.agentName || 'your computer')
        : 'this container';
    el.innerHTML = `
      <span class="pill ${inst.status || 'disconnected'}" style="pointer-events:none"><span class="dot"></span></span>
      <span class="name">${esc(inst.name)}</span>
      <span class="sub">${esc(sub)}</span>`;
    el.addEventListener('click', () => {
      state.activeId = inst.id;
      renderInstances();
      renderHeader();
      renderJobs();
      $('#new-job-form')?.reset();
      loadBrowser();
    });
    list.appendChild(el);
  }
  renderHeader();
}

function renderHeader() {
  const inst = activeInstance();
  if (!inst) return;
  $('#inst-name').textContent = inst.name;
  const pill = $('#inst-status');
  pill.className = `pill ${inst.status || 'disconnected'}`;
  pill.innerHTML = `<span class="dot"></span>${esc(inst.status || 'offline')}`;
  const bits = [];
  if (inst.type === 'ssh') bits.push(`${inst.ssh?.user}@${inst.ssh?.host}`);
  if (inst.type === 'pc') bits.push(`agent: ${inst.agentName || 'your computer'}`);
  if (inst.megaUser) bits.push(`MEGA: ${inst.megaUser}`);
  bits.push(`downloads → ${inst.downloadDir}`);
  bits.push(`concurrency ${inst.maxConcurrent}`);
  if (inst.error) bits.push(`⚠ ${inst.error}`);
  $('#inst-meta').innerHTML = bits.map(esc).join(' · ');
}

const JOB_PILL = {
  queued: ['queued', 'queued'],
  downloading: ['downloading', 'downloading'],
  uploading: ['uploading', 'uploading'],
  done: ['done', 'done'],
  failed: ['failed', 'failed'],
  cancelled: ['cancelled', 'cancelled'],
  interrupted: ['interrupted', 'interrupted'],
};

function jobOrder(a, b) {
  const rank = (j) => (['downloading', 'uploading'].includes(j.status) ? 0 : j.status === 'queued' ? 1 : 2);
  const r = rank(a) - rank(b);
  if (r !== 0) return r;
  if (a.status === 'queued' && b.status === 'queued') {
    const inst = activeInstance();
    const order = (inst && state.queue[inst.id]) || [];
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    if (ai !== -1 && bi !== -1 && ai !== bi) return ai - bi;
    if (ai !== bi) return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi);
  }
  return b.createdAt - a.createdAt;
}

function renderJobs() {
  const inst = activeInstance();
  const list = $('#job-list');
  list.innerHTML = '';
  if (!inst) return;
  const jobs = state.jobs
    .filter((j) => j.instanceId === inst.id)
    .sort(jobOrder);

  const running = jobs.filter((j) => ['downloading', 'uploading'].includes(j.status)).length;
  const queued = jobs.filter((j) => j.status === 'queued').length;
  $('#queue-count').textContent =
    jobs.length === 0 ? '' : `${running} running · ${queued} queued · ${jobs.length} total`;

  for (const job of jobs) {
    const el = document.createElement('div');
    el.className = `job ${job.status}`;
    el.dataset.id = job.id;
    const [pillClass, pillText] = JOB_PILL[job.status] || [job.status, job.status];
    const runningNow = ['downloading', 'uploading'].includes(job.status);
    const queuedNow = job.status === 'queued';
    const isGet = job.action === 'get';

    el.innerHTML = `
      <div class="job-head">
        <div>
          <div class="job-label">${esc(job.label || job.source)}</div>
          <div class="job-source">${isGet ? '⬇' : '⬆'} ${esc(job.source)}</div>
        </div>
        <span class="pill ${pillClass}"><span class="dot"></span>${pillText}</span>
        <div class="job-stats" id="stats-${job.id}">${jobStatsHtml(job)}</div>
        <div class="job-actions">
          ${queuedNow ? `<button class="btn small" data-act="up" title="Move up">↑</button>
                         <button class="btn small" data-act="down" title="Move down">↓</button>` : ''}
          ${runningNow ? `<button class="btn small danger" data-act="cancel">Cancel</button>` : ''}
          ${['failed', 'cancelled', 'interrupted'].includes(job.status) ? `<button class="btn small" data-act="retry">Retry</button>` : ''}
          ${!runningNow ? `<button class="btn small" data-act="open">Log</button>` : ''}
          ${!runningNow ? `<button class="btn small danger" data-act="del">✕</button>` : ''}
        </div>
        <div class="bar"><div id="bar-${job.id}" style="width:${job.progress?.pct || 0}%"></div></div>
      </div>
      <div class="job-log">${job.error ? `<div class="job-error">${esc(job.error)}</div>` : ''}${esc((job.log || []).join('\n'))}</div>`;

    el.querySelector('.job-head').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      el.classList.toggle('open');
    });
    el.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        try {
          if (act === 'cancel') await api(`/api/jobs/${job.id}/cancel`, 'POST');
          if (act === 'retry') await api(`/api/jobs/${job.id}/retry`, 'POST');
          if (act === 'up') await api(`/api/jobs/${job.id}/move`, 'POST', { dir: 'up' });
          if (act === 'down') await api(`/api/jobs/${job.id}/move`, 'POST', { dir: 'down' });
          if (act === 'del') await api(`/api/jobs/${job.id}`, 'DELETE');
          if (act === 'open') el.classList.toggle('open');
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    });
    list.appendChild(el);
  }
}

function jobStatsHtml(job) {
  const p = job.progress || {};
  if (job.status === 'queued') return `<span>waiting</span>`;
  if (['done', 'cancelled', 'interrupted'].includes(job.status)) {
    return `<span>${fmtTime(job.finishedAt)}</span> ${p.totalBytes ? `<b>${fmtBytes(p.totalBytes)}</b>` : ''}`;
  }
  if (job.status === 'failed') return `<span class="job-error" title="${esc(job.error || '')}">failed</span>`;
  const pct = p.pct != null ? p.pct.toFixed(1) : '0.0';
  return `
    <b>${pct}%</b>
    <span>${fmtBytes(p.doneBytes || 0)} / ${p.totalBytes ? fmtBytes(p.totalBytes) : '…'}</span>
    <span id="speed-${job.id}">${fmtSpeed(p.speed)}</span>
    <span id="eta-${job.id}">${fmtEta(job)}</span>`;
}

/** Smooth targeted updates for live progress ticks (no full re-render). */
function updateJobProgressDom() {
  const inst = activeInstance();
  if (!inst) return;
  for (const job of state.jobs) {
    if (job.instanceId !== inst.id) continue;
    if (!['downloading', 'uploading'].includes(job.status)) continue;
    const bar = $(`#bar-${job.id}`);
    if (bar) bar.style.width = `${job.progress?.pct || 0}%`;
    const head = $(`#job-list .job[data-id="${job.id}"] .job-stats`);
    if (head) {
      const speed = $(`#speed-${job.id}`);
      if (speed) speed.textContent = fmtSpeed(job.progress?.speed);
      const eta = $(`#eta-${job.id}`);
      if (eta) eta.textContent = fmtEta(job);
      const b = head.querySelector('b');
      if (b) b.textContent = `${job.progress?.pct != null ? job.progress.pct.toFixed(1) : '0.0'}%`;
      const spans = head.querySelectorAll('span');
      if (spans[1]) spans[1].textContent = `${fmtBytes(job.progress?.doneBytes || 0)} / ${job.progress?.totalBytes ? fmtBytes(job.progress.totalBytes) : '…'}`;
    }
  }
}

/* ------------------------------ browser ------------------------------ */

async function loadBrowser(path) {
  const inst = activeInstance();
  if (!inst) return;
  if (path !== undefined) {
    state.browser.path = path;
    $('#browser-path').value = path;
  }
  $('#browser-loading').classList.remove('hidden');
  $('#browser-rows').innerHTML = '';
  try {
    const res = await api(`/api/instances/${inst.id}/browser?path=${encodeURIComponent(state.browser.path)}`);
    state.browser = res;
    const rows = $('#browser-rows');
    rows.innerHTML = '';
    if (!res.entries.length) {
      rows.innerHTML = `<tr><td colspan="5" class="browser-empty">${esc(inst.megaUser ? '(empty folder)' : 'Not logged in on this instance? Use the Login button above.')}</td></tr>`;
    }
    for (const e of res.entries) {
      const tr = document.createElement('tr');
      const entryPath = joinPath(state.browser.path, e.name);
      tr.innerHTML = `
        <td class="name-cell" data-path="${esc(entryPath)}">
          <span class="ico">${e.isFolder ? '📁' : '📄'}</span>${esc(e.name)}
        </td>
        <td class="num muted">${e.size != null ? fmtBytes(e.size) : ''}</td>
        <td class="muted">${esc(e.date || '')}</td>
        <td class="mono">${esc(e.handle || '')}</td>
        <td class="right"><button class="btn small" data-queue="${esc(e.handle || entryPath)}">Queue</button></td>`;
      tr.querySelector('.name-cell').addEventListener('click', () => {
        if (e.isFolder) loadBrowser(entryPath);
      });
      tr.querySelector('button[data-queue]').addEventListener('click', () => {
        $('#jf-source').value = e.handle || entryPath;
        $('#jf-dest').value = '';
        $('#new-job-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
        $('#jf-source').focus();
        toast(`Queued source: ${e.name} — press “Queue ▸”`);
      });
      rows.appendChild(tr);
    }
  } catch (err) {
    $('#browser-rows').innerHTML = `<tr><td colspan="5" class="browser-empty">${esc(err.message)}</td></tr>`;
  } finally {
    $('#browser-loading').classList.add('hidden');
  }
}

function joinPath(base, name) {
  const b = base === '/' ? '' : base.replace(/\/+$/, '');
  return `${b}/${name}`;
}

$('#btn-browser-go').addEventListener('click', () => loadBrowser($('#browser-path').value.trim() || '/'));
$('#browser-path').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadBrowser(e.target.value.trim() || '/');
});
$('#btn-browser-refresh').addEventListener('click', () => loadBrowser());
$('#btn-browser-root').addEventListener('click', () => loadBrowser('/'));
$('#btn-browser-up').addEventListener('click', () => {
  const p = state.browser.path;
  if (p === '/' || p === '') return;
  const parent = p.replace(/\/[^/]*\/?$/, '') || '/';
  loadBrowser(parent === '' ? '/' : parent);
});

/* ------------------------------ new job form ------------------------------ */

$('#new-job-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inst = activeInstance();
  if (!inst) return;
  const body = {
    instanceId: inst.id,
    action: $('#jf-action').value,
    source: $('#jf-source').value.trim(),
    dest: $('#jf-dest').value.trim() || inst.downloadDir,
    password: $('#jf-password').value,
  };
  if (!body.source) return;
  try {
    await api('/api/jobs', 'POST', body);
    $('#new-job-form').reset();
    toast('Queued', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-clear').addEventListener('click', async () => {
  const inst = activeInstance();
  if (!inst) return;
  await api('/api/jobs/clear-completed', 'POST', { instanceId: inst.id });
});

/* ------------------------------ instance header actions ------------------------------ */

$('#btn-test').addEventListener('click', async () => {
  const inst = activeInstance();
  if (!inst) return;
  toast('Testing connection…');
  const res = await api(`/api/instances/${inst.id}/test`, 'POST', {});
  toast(res.ok ? `Connected — MEGA: ${res.megaUser || 'not logged in'}` : `Test failed: ${res.output}`, res.ok ? 'ok' : 'err');
  if (res.megaUser) api(`/api/instances/${inst.id}/status`).catch(() => undefined);
});

$('#btn-status').addEventListener('click', async () => {
  const inst = activeInstance();
  if (!inst) return;
  const res = await api(`/api/instances/${inst.id}/status`);
  toast(res.ok ? `MEGA account: ${res.megaUser}` : `Not logged in: ${res.output}`, res.ok ? 'ok' : 'err');
});

$('#btn-login').addEventListener('click', () => {
  $('#modal-login').classList.remove('hidden');
  $('#login-form').reset();
  $('#login-result').classList.add('hidden');
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inst = activeInstance();
  if (!inst) return;
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const res = await api(`/api/instances/${inst.id}/login`, 'POST', {
      email: $('#lg-ident').value.trim(),
      password: $('#lg-password').value,
      authCode: $('#lg-mfa').value.trim(),
    });
    const box = $('#login-result');
    box.classList.remove('hidden', 'ok', 'err');
    box.classList.add(res.ok ? 'ok' : 'err');
    box.textContent = res.output || (res.ok ? 'Login OK' : 'Login failed');
    if (res.ok) toast('Logged in', 'ok');
  } catch (err) {
    const box = $('#login-result');
    box.classList.remove('hidden', 'ok');
    box.classList.add('err');
    box.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------ instance modal ------------------------------ */

const modalCtx = { verified: false };

function pcAgentCommand(name) {
  const token = localStorage.getItem('meganet.token') || '<access-token>';
  return `curl -fsSL ${location.origin}/agent.js | node -- --server ${location.origin} --name "${name || 'This PC'}" --token ${token}`;
}

async function refreshPcAgentPill() {
  const name = $('#if-agent-name').value.trim() || 'This PC';
  const pill = $('#pc-agent-pill');
  try {
    const res = await api('/api/agents');
    const match = (res.agents || []).find((a) => a.name === name);
    pill.className = `pill ${match ? 'online' : 'disconnected'}`;
    pill.innerHTML = `<span class="dot"></span>${match ? 'agent connected' : 'agent offline'}`;
  } catch {
    pill.className = 'pill disconnected';
    pill.innerHTML = '<span class="dot"></span>unknown';
  }
}

function openInstanceModal(inst = null) {
  modalCtx.verified = false;
  $('#modal-instance-title').textContent = inst ? `Edit — ${inst.name}` : 'Add instance';
  $('#if-id').value = inst?.id || '';
  $('#if-name').value = inst?.name || '';
  $('#if-type').value = inst?.type || 'ssh';
  $('#if-host').value = inst?.ssh?.host || '';
  $('#if-port').value = inst?.ssh?.port || 22;
  $('#if-user').value = inst?.ssh?.user || '';
  $('#if-auth').value = inst?.ssh?.authType || 'password';
  $('#if-password').value = '';
  $('#if-password').placeholder = inst?.type === 'ssh' ? 'leave blank to keep current' : 'password';
  $('#if-key').value = '';
  $('#if-key').placeholder = inst?.ssh?.authType === 'key' ? 'leave blank to keep current key' : '-----BEGIN OPENSSH PRIVATE KEY-----';
  $('#if-key-pass').value = '';
  $('#if-agent-name').value = inst?.agentName || (inst?.type === 'pc' ? inst.name : '');
  $('#if-megacmd').value = inst?.megacmdPath || (inst?.type === 'ssh' ? 'megacmd' : '');
  $('#if-conc').value = inst?.maxConcurrent || 1;
  $('#if-dest').value = inst?.downloadDir || (inst?.type === 'ssh' ? '/root/downloads' : '');
  $('#if-notes').value = inst?.notes || '';
  $('#test-result').classList.add('hidden');
  if ($('#if-type').value === 'pc') {
    $('#pc-cmd').textContent = pcAgentCommand($('#if-agent-name').value);
    refreshPcAgentPill();
  }
  syncInstanceForm();
  $('#modal-instance').classList.remove('hidden');
}

function syncInstanceForm() {
  const type = $('#if-type').value;
  $('#ssh-fields').classList.toggle('hidden', type !== 'ssh');
  $('#pc-fields').classList.toggle('hidden', type !== 'pc');
  const auth = $('#if-auth').value;
  $('#auth-password-field').classList.toggle('hidden', auth !== 'password');
  $('#auth-key-fields').classList.toggle('hidden', auth !== 'key');

  // SSH: the download destination only appears once the connection is
  // verified (or the instance already has one).
  const hasDest = Boolean($('#if-dest').value.trim());
  const destUnlocked = type !== 'ssh' || hasDest || modalCtx.verified;
  $('#dest-row').classList.toggle('hidden', !destUnlocked);
  $('#ssh-dest-hint').hidden = destUnlocked;
  $('#btn-browse-dest').classList.toggle('hidden', !destUnlocked);
}

/* ------------------------------ download-folder picker ------------------------------ */

const fsPicker = {
  kind: 'local', // 'local' | 'instance' | 'form'
  id: null,
  body: null,
  target: 'this machine',
  browser: { path: '/', root: '/', parent: null, entries: [] },
  reqSeq: 0,
};

async function fetchFsList(dir) {
  if (fsPicker.kind === 'instance') {
    const q = dir ? `?path=${encodeURIComponent(dir)}` : '';
    return api(`/api/instances/${fsPicker.id}/directories${q}`);
  }
  if (fsPicker.kind === 'form') {
    const body = { ...fsPicker.body };
    if (dir) body.path = dir;
    return api('/api/instances/_directories', 'POST', body);
  }
  const q = dir ? `?path=${encodeURIComponent(dir)}` : '';
  return api(`/api/local/directories${q}`);
}

function renderFsFolders() {
  const browser = fsPicker.browser;
  $('#folder-path').value = browser.path;
  $('#folder-selection').textContent = browser.path;
  $('#btn-folder-up').disabled = !browser.parent;
  const list = $('#folder-list');
  list.replaceChildren();

  if (!browser.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'browser-empty';
    empty.textContent = 'No accessible subfolders';
    list.appendChild(empty);
    return;
  }

  for (const entry of browser.entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'folder-item';

    const icon = document.createElement('span');
    icon.className = 'folder-icon';
    icon.textContent = '📁';
    const name = document.createElement('span');
    name.className = 'folder-name';
    name.textContent = entry.name;
    button.append(icon, name);

    if (entry.symlink) {
      const badge = document.createElement('span');
      badge.className = 'folder-badge';
      badge.textContent = 'link';
      button.appendChild(badge);
    }
    button.addEventListener('click', () => loadFsFolders(entry.path));
    list.appendChild(button);
  }
}

async function loadFsFolders(requestedPath, { quiet = false } = {}) {
  const requestId = ++fsPicker.reqSeq;
  $('#folder-loading').classList.remove('hidden');
  $('#folder-error').classList.add('hidden');
  $('#btn-folder-select').disabled = true;
  try {
    const result = await fetchFsList(requestedPath || null);
    if (requestId !== fsPicker.reqSeq) return true;
    fsPicker.browser = result;
    renderFsFolders();
    $('#btn-folder-select').disabled = false;
    return true;
  } catch (err) {
    if (requestId !== fsPicker.reqSeq) return true;
    if (!quiet) {
      const box = $('#folder-error');
      box.textContent = err.message;
      box.classList.remove('hidden');
    }
    return false;
  } finally {
    if (requestId === fsPicker.reqSeq) $('#folder-loading').classList.add('hidden');
  }
}

async function openFolderPicker() {
  const type = $('#if-type').value;
  const instId = $('#if-id').value;
  const destVal = $('#if-dest').value.trim();
  if (type === 'pc') {
    fsPicker.kind = instId ? 'instance' : 'form';
    fsPicker.id = instId || null;
    fsPicker.body = collectInstanceForm();
    fsPicker.target = `your computer (“${$('#if-agent-name').value.trim() || 'This PC'}”)`;
  } else if (type === 'ssh') {
    if (!instId && !modalCtx.verified) return;
    fsPicker.kind = instId ? 'instance' : 'form';
    fsPicker.id = instId || null;
    fsPicker.body = collectInstanceForm();
    fsPicker.target = instId ? 'the server' : `the server (${($('#if-host').value.trim() || 'host')})`;
  } else {
    fsPicker.kind = 'local';
    fsPicker.id = null;
    fsPicker.body = null;
    fsPicker.target = 'the machine running megacmd-gui';
  }
  $('#folder-subtitle').textContent = `Folders on ${fsPicker.target}.`;
  $('#modal-local-folder').classList.remove('hidden');
  // Try: current value → /data → filesystem root → the user's home
  const candidates = [...new Set([destVal || null, '/data', '/', null])];
  for (let i = 0; i < candidates.length; i += 1) {
    if (await loadFsFolders(candidates[i], { quiet: i < candidates.length - 1 })) return;
  }
}

$('#btn-browse-dest').addEventListener('click', openFolderPicker);
$('#btn-folder-up').addEventListener('click', () => {
  if (fsPicker.browser.parent) loadFsFolders(fsPicker.browser.parent);
});
$('#btn-folder-root').addEventListener('click', () => loadFsFolders(fsPicker.browser.root || '/'));
$('#btn-folder-refresh').addEventListener('click', () => loadFsFolders(fsPicker.browser.path));
$('#btn-folder-go').addEventListener('click', () => loadFsFolders($('#folder-path').value.trim()));
$('#folder-path').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    loadFsFolders(e.currentTarget.value.trim());
  }
});
$('#btn-folder-select').addEventListener('click', () => {
  $('#if-dest').value = fsPicker.browser.path;
  modalCtx.verified = true;
  $('#modal-local-folder').classList.add('hidden');
  syncInstanceForm();
  $('#if-dest').focus();
});

$('#if-type').addEventListener('change', () => {
  modalCtx.verified = false;
  syncInstanceForm();
  if ($('#if-type').value === 'pc') {
    $('#pc-cmd').textContent = pcAgentCommand($('#if-agent-name').value);
    refreshPcAgentPill();
  }
});
$('#if-auth').addEventListener('change', syncInstanceForm);
$('#if-agent-name').addEventListener('input', () => {
  $('#pc-cmd').textContent = pcAgentCommand($('#if-agent-name').value);
});
$('#btn-pc-refresh').addEventListener('click', refreshPcAgentPill);
$('#btn-pc-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#pc-cmd').textContent);
    toast('Agent command copied', 'ok');
  } catch {
    toast('Copy failed — select the command text manually', 'err');
  }
});

$('#btn-add-instance').addEventListener('click', () => openInstanceModal(null));
$('#btn-edit').addEventListener('click', () => openInstanceModal(activeInstance()));

function collectInstanceForm() {
  const type = $('#if-type').value;
  const body = {
    name: $('#if-name').value.trim(),
    type,
    megacmdPath: $('#if-megacmd').value.trim() || (type === 'local' ? '' : 'megacmd'),
    maxConcurrent: Number($('#if-conc').value) || 1,
    downloadDir: $('#if-dest').value.trim(),
    notes: $('#if-notes').value.trim(),
  };
  if (type === 'pc') {
    body.agentName = $('#if-agent-name').value.trim() || body.name || 'This PC';
  }
  if (type === 'ssh') {
    const auth = $('#if-auth').value;
    body.ssh = {
      host: $('#if-host').value.trim(),
      port: Number($('#if-port').value) || 22,
      user: $('#if-user').value.trim(),
      authType: auth,
      password: $('#if-password').value,
      keyData: auth === 'key' ? $('#if-key').value : '',
      keyPassphrase: auth === 'key' ? $('#if-key-pass').value : '',
    };
    const keyField = $('#if-key').value.trim();
    if (keyField && (keyField.startsWith('-') || keyField.startsWith('Pu'))) {
      body.ssh.keyData = keyField;
      body.ssh.keyPath = '';
    } else if (keyField) {
      body.ssh.keyData = '';
      body.ssh.keyPath = keyField;
    }
  }
  return body;
}

$('#btn-instance-test').addEventListener('click', async () => {
  const id = $('#if-id').value;
  const body = collectInstanceForm();
  const box = $('#test-result');
  box.classList.remove('hidden', 'ok', 'err');
  box.textContent = 'Testing…';
  try {
    const res = id
      ? await api(`/api/instances/${id}/test`, 'POST', body)
      : await api('/api/instances/_test', 'POST', body);
    box.classList.add(res.ok ? 'ok' : 'err');
    box.textContent = res.ok
      ? `✔ Connection OK${res.megaUser ? `\nMEGA account: ${res.megaUser}` : '\nNot logged into MEGA yet — use Login after saving.'}`
      : `✘ ${res.output}`;
    if (res.ok && $('#if-type').value === 'ssh') {
      modalCtx.verified = true;
      syncInstanceForm(); // unlock the download destination + Browse
      toast('Connection verified — download destination unlocked', 'ok');
    }
  } catch (err) {
    box.classList.add('err');
    box.textContent = `✘ ${err.message}`;
  }
});

$('#instance-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#if-id').value;
  const body = collectInstanceForm();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (id) {
      await api(`/api/instances/${id}`, 'PATCH', body);
      toast('Instance updated', 'ok');
    } else {
      const inst = await api('/api/instances', 'POST', body);
      state.activeId = inst.id;
      toast('Instance added', 'ok');
    }
    $('#modal-instance').classList.add('hidden');
    const s = await api('/api/state');
    applyState(s);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

/* modal plumbing */
$$('.modal-root').forEach((root) => {
  root.addEventListener('click', (e) => {
    if (e.target === root || e.target.closest('[data-close]')) root.classList.add('hidden');
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const openModals = $$('.modal-root').filter((m) => !m.classList.contains('hidden'));
  openModals.at(-1)?.classList.add('hidden');
});

/* ------------------------------ boot ------------------------------ */

function applyState(s) {
  state.instances = s.instances || [];
  state.jobs = s.jobs || [];
  state.queue = s.queue || {};
  if (!state.activeId || !state.instances.some((i) => i.id === state.activeId)) {
    state.activeId = state.instances[0]?.id || null;
  }
}

(async function boot() {
  const token = localStorage.getItem('meganet.token');
  if (!token) {
    // no token stored: try open access first; the gate appears only if required
    try {
      const s = await api('/api/state');
      state.authed = true;
      applyState(s);
      showApp();
      renderInstances();
      renderJobs();
      connectWs();
      return;
    } catch {
      showGate();
      return;
    }
  }
  try {
    const s = await api('/api/state');
    state.authed = true;
    applyState(s);
    showApp();
    renderInstances();
    renderJobs();
    connectWs();
  } catch {
    showGate();
  }
})();