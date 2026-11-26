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

### Phase 2 — Encrypted S3 Cloud Storage & Stateless `jarvy server` (Completed)
- [x] **S3 Storage Adapter** (`src/server/infra/cloud/`)
  - [x] Minimal zero-dependency S3 v4 signer client (`s3-client.ts`: `GET`/`PUT`/`HEAD`/`DELETE`/`LIST`, conditional `If-Match`/`If-None-Match`, Range reads, Pre-signed URL generator) compatible with R2, OSS, COS, B2, AWS S3, MinIO.
  - [x] Client-side AES-256-GCM envelope encryption (`crypto.ts`, `JVY1` format + optional gzip + AAD bound to object key) with `jarvy:v1:` key or `scrypt` Recovery Passphrase, sealing the installation Master Key at `meta/master-key.enc`.
- [x] **Single-Writer Fencing Lease (`lease.json`)** (`src/server/infra/cloud/lease.ts`)
  - [x] Heartbeat renewal + `If-Match` ETag validation before every sync flush.
  - [x] `jarvy server start --storage s3://... --takeover` bumps `epoch` atomically; displaced servers detect `412` conflict on renewal and shut down via `onCompromised`.
- [x] **Tiered Sync Engine** (`sync.ts`, `restore.ts`, `workspace-sync.ts`, `infra/storage/snapshot.ts`)
  - [x] SQLite (`jarvy.db`, `bots/*/history.db`): atomic online backup via `node:sqlite` `backup()` (retaining last 10 revisions); automatic restore on fresh VPS boot.
  - [x] Pi Sessions (`bots/*/agent/pi/sessions/*.jsonl`): incremental SHA-256 sync.
  - [x] Attachments (`attachments/`): immutable upload on commit + lazy on-demand hydration on local cache miss (`AttachmentCloudMirror`).
  - [x] Workspaces (`bots/*/workspace/`): content-addressed blob store (`workspaces/blobs/`) + versioned manifest (`workspace_rev`) + default `.jarvyignore` exclusions (`node_modules`, `.venv`, `target`, `__pycache__`, `.cache`, `temp`).
- [x] **CLI & Recovery Tooling** (`cli-cloud.ts`, `cli.ts`)
  - [x] `jarvy server backup`, `jarvy server restore [--force] [--include-attachments]`, `--storage*`, `--recovery-key`, `--takeover`, and cloud config display in `jarvy server status`.

---

### Phase 3 — Remote On-Demand Sandbox Compute Pool (`jarvy client --sandbox`) (Completed)
- [x] **Connector Compute Protocol Extension** (`src/contract/device.ts`, `src/connect/connector.ts`, `src/server/infra/env/device-link.ts`)
  - [x] Advertise `capabilities: ["sandbox"]` and `SandboxNodeInfo` (`docker`, `cpus`, `memory`, `image`, `activeContainers`, `maxContainers`) in device `hello` & `state` updates.
  - [x] Multiplex sandbox lifecycle RPCs (`sandbox_ensure`, `sandbox_stop`, `sandbox_pause`, `sandbox_remove`, `sandbox_stats`, `workspace_pull`, `workspace_push_plan`, `workspace_push_exec`) and per-container `pi-env` + PTY channels (`open { container }`) over the existing outbound WSS tunnel.
- [x] **Ephemeral / Warm-Pooled Sandbox Scheduler** (`src/connect/sandbox-host.ts`, `src/server/service/bot/compute-pool.ts`, `computers.ts`)
  - [x] On-demand container provisioning on any online `--sandbox` compute node when local Docker is unavailable (`jarvy client start --sandbox`).
  - [x] Shared host package cache mounts (`uv`/`pip`, `npm`, `cargo`) on compute nodes to keep fresh container installs fast.
  - [x] Idle warm-pause (`--idle-pause-min`) + LRU reclamation (`--idle-reclaim-min`, `--max-sandboxes`) preserving containers with active channels, listening ports, or pins.
- [x] **Direct Compute-Node ↔ S3 Workspace Sync** (`src/connect/workspace-direct.ts`, `src/server/infra/cloud/sync.ts`)
  - [x] Server issues short-lived S3 Pre-signed GET/PUT URLs to `jarvy client` so encrypted workspace blobs flow directly between compute node and S3 without traversing the lightweight VPS.
  - [x] Strict `workspace_rev` check before `bash` / sandbox start and debounced Push on exec / stop / reset; preserves divergent dirty files under `recovered/<timestamp>/` on unexpected power loss.
- [x] **Remote Published Port Tunneling** (`src/server/infra/net/proxy.ts`, `src/server/service/bot/ports.ts`, `device-link.ts`, `connector.ts`)
  - [x] Tunnels `ports.publish` HTTP/WS traffic from `jarvy server` over WSS `tcp_open` into the remote compute node's container IP with strict container-IP allowlisting (`tunnel_denied` for non-container intranet IPs).

---

### Phase 4 — Observability, Multi-Node Scheduling & Failover UX (Completed)
- [x] **Cloud Storage Status UI** (`Settings → Storage`, `GET /api/cloud/status`, `POST /api/cloud/sync`): sync health, bucket/prefix/endpoint, active lease epoch, DB revision, last flush timestamp, error banner, and manual sync trigger.
- [x] **Compute Pool View & Role Separation** (`Environments`, `Device.sandbox`, `--sandbox-only`): separates **Bot Sandboxes**, **Compute Nodes**, and **Remote Hosts** (`desktop/host` + `SSH`); adds `--sandbox-only` client isolation disabling direct host access; displays live CPU/RAM capacity & remote sandbox usage with per-sandbox slot reclamation (`POST /api/bots/:id/computer/reclaim`).
- [x] **Graceful Failover & Independent Bot Workspace UX**:
  - [x] Unified Radix `<Select>` preferred compute node per Bot (`PUT /api/bots/:id/computer/compute-node`, `SandboxComputeNode`) with automatic fallback to another online node or Workspace-only mode when offline, plus accurate remote-container-only messaging in `SandboxType`.
  - [x] Direct **Workspace** tab right inside `BotInfo` plus offline `/workspace` browse/download backed by on-demand S3 workspace hydration (`CloudSync.ensureLocalWorkspace`) with explicit offline-snapshot indicator.

---

### Phase 5 — Remote KVM/libvirt VM Compute Nodes (Planned)
- [ ] Probe KVM/libvirt capability on `jarvy client --sandbox` compute nodes and advertise `vm` support in `SandboxNodeInfo`.
- [ ] Extend compute-node RPCs for remote VM lifecycle + `workspace.qcow2` / `/workspace` S3 snapshot sync so physical compute nodes with KVM can host full Linux VM sandboxes for stateless cloud servers.
