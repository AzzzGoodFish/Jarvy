# Distributed Deployment & Stateless Server Roadmap

[Architecture Index](index.md) · [Work Environments](architecture/environments.md) · [Storage](architecture/storage.md) · [Decisions (ADR)](decisions.md)

## Vision: Separation of Storage, Control Plane, and Compute

Decouple Jarvy into three independent planes so a user can host the Jarvy platform on any lightweight/disposable VPS (or personal host), access it anywhere without a company VPN, keep all durable data safely backed up outside any single machine, and plug high-compute machines (e.g. a company intranet server or home GPU workstation) in purely as stateless compute providers:

```text
                       S3-Compatible Object Storage (Encrypted Source of Truth)
                     ┌──────────────────────────────────────────────────────────┐
                     │ lease.json          Single-writer fencing lease (epoch)  │
                     │ db/                 SQLite snapshot + WAL stream         │
                     │ sessions/           Pi JSONL append-only logs            │
                     │ attachments/        Immutable content blobs              │
                     │ workspaces/<botId>/ Content-addressed incremental chunks │
                     └──────────────▲──────────────────────────▲────────────────┘
                                    │ DB / sessions / meta     │ Pre-signed URL direct sync
                                    │                          │ (bypasses small VPS pipe)
    User (Phone / Desktop) ─────────┴───┐                  ┌───┴─────────────────────────┐
          HTTPS / WSS                   ▼                  ▼                             │
                           ┌────────────────────────┐   ┌─────────────────────────────┐  │
                           │     jarvy server       │◀─▶│        jarvy client         │  │
                           │ (Stateless Light VPS)  │WSS│ (Company / Home Compute)    │  │
                           │ • Web UI / Chat / Pi   │   │ • Host access (--host)      │  │
                           │ • Jailed Workspace FS  │   │ • Ephemeral Docker/VM       │  │
                           │ • Local hot cache      │   │   sandbox pool (--sandbox)  │  │
                           └────────────────────────┘   └─────────────────────────────┘  │
```

## Core Architectural Principles

1. **Workspace ≠ Sandbox**:
   - A Bot's `/workspace` is its durable personal folder. Pure file tools (`read`, `write`, `edit`, chat attachments, Environments Files tab) operate directly on `/workspace` via a jailed pure-Node filesystem engine without requiring Docker or a VM.
   - Only shell/code execution (`bash`, `bash_job`, interactive sandbox terminals) requires a sandbox container/VM or an external connected machine.
2. **Dual-Mode CLI (`jarvy server` / `jarvy client`)**:
   - One published `jarvy` binary serves both roles with symmetrical commands (`init`/`login`, `start`, `stop`, `run`, `status`, `logout`).
   - Clean redesign without legacy command-compatibility baggage (`jarvy on/off/run` replaced by `jarvy server start/stop/run`).
3. **S3-First Encrypted Persistence (Never Mount Cloud Drives for SQLite)**:
   - SQLite (`jarvy.db`, `history.db`) always executes on local disk and replicates via consistent snapshots / WAL streaming to S3-compatible object storage (Cloudflare R2, Aliyun OSS, Tencent COS, Backblaze B2, MinIO).
   - End-to-end client-side encryption with the user's Master Key / Recovery Key; S3 stores ciphertext only.
   - Conditional S3 writes (`If-Match` / `If-None-Match`) enforce a single-writer fencing lease (`lease.json`) so rotated/orphaned VPS instances can never split-brain overwrite live state.
4. **Local-Disk Fast Compute + Incremental Cloud Workspace Sync**:
   - Remote sandboxes bind-mount a real local POSIX directory on the compute node (full NVMe speed for `git`, `npm`, `cargo`, `sqlite`), never S3 FUSE mounts.
   - Workspaces sync incrementally via content-addressed manifests and Pre-signed S3 URLs on turn-end debounce, periodic timers, and stop/migrate boundaries (skipping rebuildable caches via `.jarvyignore`).
   - Versioned with `workspace_rev` + single-active-lease; abnormal power-loss divergence preserves unsynced files in a `recovered/` snapshot rather than overwriting newer state.

---

## Phased Implementation TODO

### Phase 1 — Workspace Decoupling & Dual-Mode CLI (Completed)
- [x] **Jailed Pure-Node Workspace Engine** (`src/server/infra/env/workspace-fs.ts`)
  - [x] `createWorkspaceEnvironment()`: implements `WorkEnvironment` mapped to virtual `/workspace` inside `bots/<botId>/workspace/`, with strict `realpath` jail containment (no `..` or symlink escape); `exec()` returns a clear sandbox-unavailable fault explaining file tools still work under `/workspace`.
  - [x] `openWorkspaceFs()`: implements `EnvironmentFs` (`listDir`, `stat`, `realPath`, `exists`, `openRead`, `writeStream`, `mkdir`, `rename`, `remove`) jailed to `/workspace` for the Environments → Files tab.
- [x] **Wire Workspace Fallback into `Computers` & Environments UI**
  - [x] Container-type sandboxes serve `/workspace` file operations via jailed `WorkspaceEnv` whenever Docker is unavailable or the container is stopped (lazy container start: `read`/`write`/`edit` in `/workspace` no longer require Docker or cold-booting a container; `bash` or non-`/workspace` paths still use Docker when available).
  - [x] VM-type sandboxes remain strictly bound to `workspace.qcow2` (no silent fallback to host folder).
  - [x] Environments → Files tab remains available (`ready`) for container sandboxes even when Docker is unavailable or the container is stopped; Terminal tab continues showing stopped/unavailable state accurately.
  - [x] Update Bot sandbox `about()` wording (`src/server/service/bot/kinds/sandbox.ts`) so Bots know `/workspace` file tools remain usable when `bash` is unavailable.
- [x] **Redesign Dual-Mode CLI (`jarvy server` / `jarvy client`)**
  - [x] Generalize `src/server/daemon.ts` to manage background PID/log/IPC lifecycle for both `server` (`jarvy.pid`/`jarvy.log`) and `client` (`client.pid`/`client.log`), including Linux zombie-process (`Z`/`X`) liveness handling inside containers without `--init`.
  - [x] Create shared client CLI runner (`src/connect/client-cli.ts`) used by both `jarvy client <login|start|stop|run|status|logout>` and standalone `dist/server/connector.mjs`.
  - [x] Redesign `src/server/cli.ts` around `jarvy server <init|start|stop|run|status>` and `jarvy client <login|start|stop|run|status|logout>`.
  - [x] Update `package.json` `start` script, UI connection hint (`DeviceDetail.tsx`), `README.md`, `skills/setup/SKILL.md`, and `docs/decisions.md` (A106).
- [x] **End-to-End Verification**
  - [x] `npm run build` (`check:architecture`, `lint`, `tsc`, `vite build`, `bundle-server.mjs`).
  - [x] Verify `jarvy server init/start/status/stop` & `jarvy client start/status/online/stop/logout` against a real isolated server.
  - [x] Verify Workspace `read`/`write`/`edit`, symlink/dangling-symlink escape rejection, `bash` error wording, and Files tab API with Docker unavailable.

---

### Phase 2 — Encrypted S3 Cloud Storage & Stateless `jarvy server`
- [ ] **S3 Storage Adapter** (`src/server/infra/cloud/`)
  - [ ] Minimal zero-bloat S3 v4 signer client (`GET`/`PUT`/`HEAD`/`DELETE`/`LIST`, conditional `If-Match`/`If-None-Match`, Range reads, Pre-signed URL generator) compatible with R2, OSS, COS, B2, AWS S3, MinIO.
  - [ ] Client-side AES-256-GCM envelope encryption bound to object key + Master Key / Recovery Passphrase (`jarvy server init --storage ...` / `--recovery-key`).
- [ ] **Single-Writer Fencing Lease (`lease.json`)**
  - [ ] Heartbeat renewal + epoch validation before every sync flush.
  - [ ] `jarvy server start --storage s3://... --takeover` bumps epoch cleanly; orphaned instances detect lease loss and shut down read-only via `onCompromised`.
- [ ] **Tiered Sync Engine**
  - [ ] SQLite (`jarvy.db`, `bots/*/history.db`): atomic online backup snapshot + WAL incremental upload; automatic restore on fresh VPS boot.
  - [ ] Pi Sessions (`bots/*/agent/pi/sessions/*.jsonl`): append-only sync at end of each Bot turn.
  - [ ] Attachments (`attachments/`): immutable upload to S3 + bounded local LRU cache on VPS disk with on-demand Range/stream fetch.
  - [ ] Workspaces (`bots/*/workspace/`): content-addressed chunk manifest (`workspace_rev`) + default `.jarvyignore` exclusions (`node_modules`, `.venv`, `target`, `__pycache__`, `.cache`).
- [ ] **CLI & Recovery Tooling**
  - [ ] `jarvy server backup` / `jarvy server restore` / `jarvy server status` (showing sync lag & lease state).

---

### Phase 3 — Remote On-Demand Sandbox Compute Pool (`jarvy client --sandbox`)
- [ ] **Connector Compute Protocol Extension** (`src/connect/connector.ts`, `src/server/infra/env/device-link.ts`)
  - [ ] Advertise `capabilities.sandbox` (`docker`, `cpus`, `memory`, active containers) in device `hello` & periodic telemetry.
  - [ ] Multiplex sandbox lifecycle RPCs (`sandbox_ensure`, `sandbox_stop`, `sandbox_pause`, `sandbox_remove`, `sandbox_stats`) and per-container `pi-env` + PTY channels over the existing outbound WSS tunnel.
- [ ] **Ephemeral / Warm-Pooled Sandbox Scheduler**
  - [ ] On-demand container provisioning on any online compute node when a Bot invokes `bash` (or owner opens a sandbox terminal).
  - [ ] Shared host package cache mounts (`uv`/`pip`, `npm`/`pnpm`, `apt`) on compute nodes to keep fresh container installs fast.
  - [ ] Idle warm-pause + LRU reclamation (never reclaiming containers with active `bash_job`, running terminals, active `ports.publish` traffic, or owner pin).
- [ ] **Direct Compute-Node ↔ S3 Workspace Sync**
  - [ ] Server issues short-lived S3 Pre-signed URLs to `jarvy client` so large workspace Pull/Push flows directly between compute node and S3 without traversing the lightweight VPS.
  - [ ] Strict `workspace_rev` check before `bash` execution and debounced Push on turn end / stop / migrate; preserve divergent dirty state under `recovered/` on unexpected power loss.
- [ ] **Remote Published Port Tunneling**
  - [ ] Tunnel `ports.publish` HTTP/WS traffic from `jarvy server` over WSS into the remote compute node's container IP so web previews work anywhere without VPN.

---

### Phase 4 — Observability, Multi-Node Scheduling & Failover UX
- [ ] **Cloud Storage Status UI** (Settings → Storage): sync health, last flush timestamp, active lease epoch, manual sync/verify trigger.
- [ ] **Compute Pool View** (Environments): online compute nodes, CPU/RAM utilization, active ephemeral sandboxes, pin/reclaim controls.
- [ ] **Graceful Failover & Offline Workspace Browsing**:
  - [ ] Preferred compute node per Bot with automatic fallback to another online node or Workspace-only mode when offline.
  - [ ] Read-only browse/download of last-synced S3 workspace snapshot even when all compute nodes are offline.
