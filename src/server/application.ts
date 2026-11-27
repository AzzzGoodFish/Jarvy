import { AccountService } from "./service/account/service.js";
import { ModelService } from "./service/models/service.js";
import { CredentialLogins } from "./infra/pi/auth.js";
import { User } from "./service/member.js";
import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { Store } from "./infra/storage/store.js";
import { ModelCatalog } from "./infra/pi/catalog.js";
import { ChatService } from "./service/chat/service.js";
import { ChatFiles } from "./service/chat/files.js";
import { AttachmentFiles } from "./infra/files/attachments.js";
import { Changes } from "./service/events.js";
import { CredentialCoordinator } from "./infra/credentials/coordinator.js";
import { BotService } from "./service/bot/service.js";
import { ConnectionService } from "./service/connection.js";
import { CloudService } from "./service/cloud.js";
import { UpdateService } from "./service/update.js";
import { SecretService } from "./service/secrets.js";
import { ConnectorService } from "./service/connectors.js";
import { createConnectorRegistry } from "./infra/connectors/registry.js";
import { loadConnectorEnv } from "./infra/connectors/client-env.js";
import { TaskService } from "./service/tasks.js";
import { TerminalService } from "./service/terminals.js";
import { EnvFileService } from "./service/env-files.js";
import { Deliveries } from "./service/delivery/delivery.js";
import { RuntimeFault } from "./shared/runtime.js";
import { runBounded, type ShutdownStepOutcome } from "./shared/shutdown.js";
import type { CloudStorageConfig, CloudSyncStatus } from "./shared/cloud-storage.js";
import { CloudSync } from "./infra/cloud/sync.js";
import type { SessionFactory } from "./infra/pi/session.js";

export class Application {
  readonly events = new Changes();
  readonly credentials = new CredentialCoordinator();
  readonly chats: ChatService;
  /** Every delivery goes through here (A41, A61). */
  readonly deliveries: Deliveries;
  readonly user: User;
  readonly files: ChatFiles;
  readonly bots: BotService;
  readonly auth: CredentialLogins;
  readonly account: AccountService;
  readonly models: ModelService;
  readonly connection: ConnectionService;
  readonly secrets: SecretService;
  /** External service connectors (A102). */
  readonly connectors: ConnectorService;
  /** Scheduled tasks and their timer (A58). */
  readonly tasks: TaskService;
  /** Persistent interactive terminals across environments (A103). */
  readonly terminals: TerminalService;
  /** Direct file browsing and streaming transfer across environments (A104). */
  readonly envFiles: EnvFileService;
  /** Optional encrypted S3 cloud sync engine (A107). */
  readonly cloud: CloudSync | null;
  /** Cloud storage observability & manual sync service for Settings → Storage (A109). */
  readonly storage: CloudService;
  /** Release checker & safe flush-and-restart service (A113). */
  readonly update: UpdateService;
  private closing?: Promise<void>;
  private servicesClosing?: Promise<ShutdownStepOutcome[]>;
  private storageClosing?: Promise<ShutdownStepOutcome[]>;
  private constructor(readonly store: Store, readonly dataDir: string, private readonly release: () => Promise<void>, cloud: CloudSync | null, factory?: SessionFactory) {
    this.cloud = cloud;
    this.storage = new CloudService(cloud);
    this.update = new UpdateService();
    // One delivery module for every source (A41, A61): chat messages and activity, and system notices to one member.
    this.deliveries = new Deliveries(store.chats.inbox, {
      bot: (id, urgency) => this.bots.deliver(id, urgency), user: id => { if (id === this.user.id) this.user.deliver(); } });
    this.chats = new ChatService(store.chats, this.deliveries, new AttachmentFiles(dataDir, cloud?.attachmentMirror()), {
      changed: change => this.events.publish(change), sections: ownerId => this.events.publish({ kind: "sections", ownerId }) });
    this.user = new User(store.account.userMemberId(), (actor, chat, draft) => this.chats.send(actor, chat, { ...draft }));
    this.files = new ChatFiles(this.chats);
    store.runtime.recover();
    this.secrets = new SecretService(store, this.chats);
    const registry = createConnectorRegistry();
    const connectorEnv = loadConnectorEnv(dataDir, registry.catalog());
    store.connectors.useRuntime({
      authMethods: provider => [...registry.meta(provider).authMethods],
      managedClient: provider => connectorEnv.managedInfo(provider),
      secrets: () => connectorEnv.secrets(),
    });
    this.connectors = new ConnectorService(store, this.chats, this.secrets, registry, () => this.connection.where(), connectorEnv);
    // A due task is a system notice to its Bot, delivered like any other (A58, A61).
    this.tasks = new TaskService(store, this.deliveries);
    // One model catalog: the settings' provider lists and the models a Bot's session installs read the same entries.
    const catalog = new ModelCatalog(dataDir);
    this.bots = new BotService({ store, chats: this.chats, deliveries: this.deliveries, files: this.files, credentials: this.credentials, secrets: this.secrets, connectors: this.connectors, tasks: this.tasks, catalog, cloud,
      changed: id => this.events.publish({ kind: "bot", id, status: this.bots.status(id) }), listChanged: () => this.events.publish({ kind: "bots" }), factory,
      listening: () => this.connection.where(), onReply: (connectionId, provider, headers) => this.models.observeReply(connectionId, provider, headers),
      onEnvironmentClosed: id => { this.terminals.closeForEnvironment(id); this.envFiles.closeForEnvironment(id); } });
    this.terminals = new TerminalService({
      openPty: (environmentId, options) => this.bots.openPty(environmentId, options),
      changed: () => this.events.publish({ kind: "terminals" }),
    });
    this.envFiles = new EnvFileService({
      verifyReady: environmentId => this.bots.verifyFsReady(environmentId),
      openFs: environmentId => this.bots.openFs(environmentId),
    });
    this.auth = new CredentialLogins(store, this.credentials, id => this.bots.connectionChanged(id));
    this.connection = new ConnectionService(store, dataDir);
    this.account = new AccountService(store, createHash("sha256").update(dataDir).digest("hex").slice(0, 10));
    this.models = new ModelService(store, this.credentials, this.auth, id => this.bots.connectionChanged(id), catalog);
  }
  static async open(dataDir: string, options: { factory?: SessionFactory; onCompromised?: () => void; cloud?: CloudStorageConfig; startCloudSync?: boolean } = {}): Promise<Application> {
    await mkdir(resolve(dataDir), { recursive: true, mode: 0o700 });
    const root = await realpath(resolve(dataDir));
    let app: Application | undefined;
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(root, { retries: 0, stale: 30_000, update: 10_000, lockfilePath: join(root, ".runtime.lock"),
        onCompromised: () => {
          console.error("[runtime] data lock compromised");
          if (options.onCompromised) options.onCompromised();
          else void app?.close().catch(() => console.error("[runtime] shutdown after lock loss failed"));
        } });
    } catch { throw new RuntimeFault("data_locked", "The data directory is in use, or its run lock can't be taken.", 409); }
    let cloud: CloudSync | null = null;
    let store: Store | undefined;
    try {
      if (options.cloud) {
        cloud = new CloudSync(options.cloud, root, {
          onLeaseLost: reason => {
            console.error(`[cloud] fencing shutdown: ${reason}`);
            if (options.onCompromised) options.onCompromised();
            else void app?.close().catch(() => console.error("[cloud] shutdown after lease loss failed"));
          },
        });
        await cloud.prepareBeforeOpen();
      }
      store = new Store(root);
      app = new Application(store, root, release, cloud, options.factory);
      if (cloud) await cloud.attachStore(store, options.startCloudSync ?? true);
      // Before the server listens and Bots start (A66): nothing is uploading or sending yet, so the sweep can't take
      // a file that is between being put in place and getting its row.
      await app.chats.attachments.sweep().catch(error => console.error("[chat] attachment sweep failed", { error: error instanceof Error ? error.message : String(error) }));
      return app;
    }
    catch (error) {
      await cloud?.close().catch(() => {});
      store?.close();
      await release();
      throw error;
    }
  }
  cloudStatus(): CloudSyncStatus { return this.cloud ? this.cloud.status() : { enabled: false }; }
  start(): void { this.bots.start(); this.tasks.start(); this.models.startCatalog(); this.update.start(); }
  /** Phase 2 shutdown: stops schedulers, expires waiting cards, drains active Bots/environments/devices within bounded budgets (A114). */
  closeServices(options?: { serviceTimeoutMs?: number; log?: (msg: string) => void }): Promise<ShutdownStepOutcome[]> {
    if (!this.servicesClosing) {
      const log = options?.log ?? (msg => console.warn(msg));
      const budget = options?.serviceTimeoutMs ?? 8_000;
      const stepMs = Math.max(1_000, Math.min(5_000, Math.floor(budget * 0.65)));
      const envMs = Math.max(1_000, Math.min(3_000, Math.floor(budget * 0.4)));
      this.servicesClosing = (async () => {
        this.update.stop();
        this.tasks.stop();
        this.models.stopCatalog();
        this.chats.questions.expireAll("Server is restarting");
        this.terminals.closeAll();
        this.envFiles.closeAll();
        const outcomes = await Promise.all([
          runBounded("auth.close", envMs, () => this.auth.close(), log),
          runBounded("bots.close", budget, () => this.bots.close({ botTimeoutMs: stepMs, envTimeoutMs: envMs, log }), log),
        ]);
        outcomes.push(await runBounded("credentials.close", envMs, () => this.credentials.close(), log));
        this.events.close();
        return outcomes;
      })();
    }
    return this.servicesClosing;
  }
  /** Phase 4 shutdown: flushes final cloud snapshot, unconditionally releases cloud lease, closes SQLite, and releases runtime lock (A114). */
  closeStorage(options?: { syncTimeoutMs?: number; releaseTimeoutMs?: number; log?: (msg: string) => void }): Promise<ShutdownStepOutcome[]> {
    if (!this.storageClosing) {
      const log = options?.log ?? (msg => console.warn(msg));
      const syncMs = options?.syncTimeoutMs ?? 5_000;
      const releaseMs = options?.releaseTimeoutMs ?? 3_000;
      this.storageClosing = (async () => {
        const outcomes: ShutdownStepOutcome[] = [];
        if (this.cloud) {
          outcomes.push(await runBounded("cloud.close", syncMs + releaseMs + 1_000, () => this.cloud!.close({ syncTimeoutMs: syncMs, releaseTimeoutMs: releaseMs }), log));
        }
        outcomes.push(await runBounded("store.close", 2_000, () => { this.store.close(); }, log));
        outcomes.push(await runBounded("runtime.lock.release", 2_000, () => this.release(), log));
        return outcomes;
      })();
    }
    return this.storageClosing;
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = (async () => {
      await this.closeServices();
      await this.closeStorage();
    })();
    return this.closing;
  }
}
