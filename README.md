# MEGAcmd Web

A web GUI for the [MEGAcmd CLI](https://github.com/MEGA-CLI/megacmd). Run one server and drive
MEGA downloads from **multiple machines at once** — your local MEGAcmd plus any number of
remote VPS/dedicated servers reached over **SSH** — with a shared **download queue** and
**live progress**.

```
┌────────────┐   SSH    ┌──────────────┐
│ MEGAcmd Web│ ───────▶ │ VPS #1       │ megacmd get …  → /srv/downloads
│ (this app) │          │ (megacmd)    │
│            │ ───────▶ │ VPS #2       │ megacmd get …  → /downloads
│            │  local   │ …and more    │
│            │ ───────▶ │ this machine │ megacmd get …  → ~/downloads
└────────────┘
```

## Features

- **Instances** — register the machine the GUI runs on (local) and any number of remote
  servers over SSH (password or key auth). Each instance has its own:
  - `megacmd` command path
  - **download directory** (where transfers land on that machine)
  - max concurrent transfers (queue parallelism)
- **Queue** — queue downloads (MEGA link, `H:…` handle, or remote path), reorder, retry,
  cancel, clear finished. Per-instance FIFO with configurable concurrency.
- **Live progress** — the backend parses MEGAcmd's non-interactive progress output
  (`TRANSFERRING ||…||(123/456 MB: 27.4 %)`, NUL-delimited) and streams it to the browser
  over WebSocket: percentage, transferred/total, speed and ETA.
- **MEGA browser** — browse any instance's MEGA tree (via `megacmd ls -l --show-handles`)
  and queue files/folders by handle without typing paths.
- **MEGA login** — run `megacmd login` (email + password, optional MFA code, or session)
  on an instance from the UI. The session is stored by MEGAcmd on that machine.
- **Docker-ready** — single container, state in one volume, healthcheck included.

## Quick start (local development)

```bash
npm install
npm start            # http://localhost:3000
```

Environment:

| Var             | Default  | Meaning                                            |
| --------------- | -------- | -------------------------------------------------- |
| `PORT`          | `3000`   | HTTP/WS port                                       |
| `HOST`          | `0.0.0.0`| Bind address                                       |
| `DATA_DIR`      | `./data` | State dir (instances + queue JSON files)           |
| `ACCESS_TOKEN`  | *(empty)*| If set, API + WebSocket require this token         |

Add an **SSH instance**: host, port, user, password *or* pasted private key, the path to the
`megacmd` binary on the remote box, and the remote download directory. Test the connection
from the form before saving.

For a **local instance**, set the `megacmd` command path of *this* machine
(on macOS the MEGAcmd app ships `mega-exec`, e.g.
`/Applications/MEGAcmd.app/Contents/MacOS/mega-exec`).

### MEGA login on a remote instance

Either log in once manually on the box (`ssh vps && megacmd login`), or use the **Login**
button in the GUI (runs `megacmd login <email> <password> [--auth-code=…]` over SSH).
MEGAcmd stores the session in `~/.megaCmd` on that machine; this app never stores MEGA
credentials itself.

## How it works

- **Execution** — local instances run the binary directly; SSH instances reuse one
  persistent `ssh2` connection per instance (`keepalive` every 15 s; dropped connections
  reconnect lazily). Commands are shell-quoted.
- **Progress protocol** — when stdout is piped (never a TTY), MEGAcmd writes transfer
  updates as `TRANSFERRING ||<bar>||(<done>/<total> <unit>: <pct> %)` separated by NUL
  bytes, ending with `Download finished: <path>`. The server splits on NUL/newline, parses
  each update, keeps a ≥0.5 s sliding window for speed, and pushes throttled
  (~3 / s) progress frames over WebSocket.
- **Queue** — per-instance FIFO; up to `maxConcurrent` transfers run in parallel. Cancel
  sends SIGTERM to the remote process (over the SSH channel). Server restarts mark
  in-flight jobs `interrupted` so you can retry them.
- **State** — `data/instances.json` + `data/jobs.json` (atomic writes). Secrets are masked
  in API responses (`••••••`); leaving a field blank on edit keeps the stored value.

### Security notes

- Set `ACCESS_TOKEN` for anything reachable from the network — the UI shows a token gate
  and the API/WS reject unauthenticated requests (401).
- The first SSH connection **pins the host key** (SHA-256 of the wire-format public key, per
  `host:port`) into `data/hostkeys-<instance>.json`. If the key *changes* later the
  connection is refused and the mismatch is logged — so a MITM or a rebuilt box with a new
  host key will not silently connect. Delete that file (or the instance and re-add it) to
  re-pin.
- SSH passwords/keys are stored in `data/instances.json` on the GUI host — protect that
  volume accordingly.
- MEGAcmd on the remote box must already be installed and on the instance's `PATH`
  (or use an absolute path in the *megacmd command* field).

## Docker

```bash
docker build -t megacmd-gui .
docker run -d --name megacmd-gui \
  -p 3000:3000 \
  -e ACCESS_TOKEN=change-me \
  -v megacmd-gui-data:/data \
  --restart unless-stopped \
  megacmd-gui
```

or `ACCESS_TOKEN=change-me docker compose up -d --build`.

State lives in `/data`; the container is non-root and has a `/healthz` healthcheck.

### Deploying on Easypanel (GitHub source — recommended)

Easypanel supports a first-class **GitHub** git source. It fetches the repo as a tarball
via the GitHub API (log step "Download Github Archive"), so **no panel-side git SSH key
is needed**. One catch: the archive download is anonymous — the repo must be **public**
(a private repo silently skips the build step and the deploy just records the commit).

1. Push this repo to GitHub (e.g. `https://github.com/<owner>/megacmd-gui`) and make it
   **public**. (The repo contains no secrets — the access token lives on the panel.)
2. In Easypanel: **Create project** → name it `megacmd-gui`, then add an **app** service:
   - Source: **GitHub** — owner `<owner>`, repo `megacmd-gui`, branch `main`, path `/`
   - Build file: `Dockerfile`
3. **Environment**:
   - `PORT=3000`
   - `ACCESS_TOKEN=<random-secret>` *(generate: `openssl rand -hex 16`)*
   - `TZ=UTC` (or your zone)
4. **Volumes**: named volume at `/data` (state).
5. **Ports**: publish `3010` (target `3000`, tcp). ⚠️ Don't publish `3000` on the host —
   the Easypanel UI itself owns port 3000, and a conflicting `docker compose up` fails
   silently (deploy reports "Success", no container starts).
6. **Domain** (optional): destination port `3000` (container port), protocol `http`
   (TLS termination at Traefik).
7. **Deploy** — the UI Deploy button, or the `deployService` RPC. Creating the service
   triggers the first build + start automatically; later deploys build when the commit
   changes (a same-commit deploy is a fast no-op). The first build takes a few minutes.

Result: `http://<panel-host>:3010` — enter the access token on the login screen.

**Alternative — generic git source (Forgejo / self-hosted, SSH):** point the source at a
`ssh://git@<git-host>:<port>/<owner>/megacmd-gui.git` repo with the `Dockerfile` at its
root. This path *does* require the panel's Settings → Git SSH key to be configured once.

> Note: an instance whose *type is local* refers to the machine the GUI itself runs on —
> inside the Easypanel container that means the container (no MEGAcmd there). For the
> Easypanel deployment, add your machines as **SSH instances**, including your own Mac if
> it is reachable over SSH (point its *megacmd command* at the app's `mega-exec` path).

## REST API (overview)

All endpoints accept/return JSON; send `Authorization: Bearer <token>` when `ACCESS_TOKEN`
is set.

| Method & path                    | Purpose                              |
| -------------------------------- | ------------------------------------ |
| `GET /api/state`                 | instances + jobs snapshot            |
| `GET/POST /api/instances`        | list / create instance               |
| `GET/PATCH/DELETE /api/instances/:id` | read / update / remove instance  |
| `POST /api/instances/:id/test`   | test SSH + MEGA login (`whoami`)     |
| `POST /api/instances/:id/login`  | run `megacmd login` on the instance  |
| `GET /api/instances/:id/status`  | MEGA account check                   |
| `GET /api/instances/:id/browser?path=/` | list folder (`ls -l --show-handles`) |
| `GET/POST /api/jobs`             | list / queue job                     |
| `POST /api/jobs/:id/cancel`      | SIGTERM the transfer                 |
| `POST /api/jobs/:id/retry`       | re-queue to front                    |
| `POST /api/jobs/:id/move`        | reorder (`{"dir":"up"|"down"}`)      |
| `DELETE /api/jobs/:id`           | remove finished job                  |
| `POST /api/jobs/clear-completed` | drop finished jobs                   |

WebSocket: connect to `ws://host/?token=*** → `{type:"hello", instances, jobs}`;
then `{type:"state"|"progress"|"instances"}` pushes.