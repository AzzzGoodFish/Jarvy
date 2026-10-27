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
import { Changes } from "./service/events.js";
import { CredentialCoordinator } from "./infra/credentials/coordinator.js";
import { BotService } from "./service/bot/service.js";
import { ConnectionService } from "./service/connection.js";
import { SecretService } from "./service/secrets.js";
import { TaskService } from "./service/tasks.js";
import { urgencyOf } from "./service/delivery/policy.js";
import { RuntimeFault } from "./shared/runtime.js";
import type { SessionFactory } from "./infra/pi/session.js";

export class Application {
  readonly events = new Changes();
  readonly credentials = new CredentialCoordinator();
  readonly chats: ChatService;
  readonly user: User;
  readonly files: ChatFiles;
  readonly bots: BotService;
  readonly auth: CredentialLogins;
  readonly account: AccountService;
  readonly models: ModelService;
  readonly connection: ConnectionService;
  readonly secrets: SecretService;
  /** Scheduled tasks and their timer (A58). */
  readonly tasks: TaskService;
  private closing?: Promise<void>;
  private constructor(readonly store: Store, readonly dataDir: string, private readonly release: () => Promise<void>, factory?: SessionFactory) {
    this.chats = new ChatService(store.chats, {
      bot: (id, urgency) => this.bots.deliver(id, urgency), user: (id, urgency) => { if (id === this.user.id) this.user.deliver(urgency); },
      saved: id => this.user.changed(id), sections: ownerId => this.events.publish({ kind: "sections", ownerId }) });
    this.user = new User(store.account.userMemberId(), (actor, chat, draft) => this.chats.send(actor, chat, { ...draft }), id => this.events.publish({ kind: "chat", id }),
      () => this.events.publish({ kind: "inbox", memberId: this.user.id }));
    this.files = new ChatFiles(this.chats);
    store.runtime.recover();
    this.secrets = new SecretService(store, this.chats);
    // The scheduler wakes a Bot through the same delivery any message uses (A58).
    this.tasks = new TaskService(store, this.chats, botId => this.bots.deliver(botId, urgencyOf("task", "schedule")!));
    this.bots = new BotService({ store, chats: this.chats, files: this.files, credentials: this.credentials, secrets: this.secrets, tasks: this.tasks,
      changed: id => this.events.publish({ kind: "bot", id, status: this.bots.status(id) }), listChanged: () => this.events.publish({ kind: "bots" }), factory });
    this.auth = new CredentialLogins(store, this.credentials, id => this.bots.connectionChanged(id));
    this.connection = new ConnectionService(store, dataDir);
    this.account = new AccountService(store, createHash("sha256").update(dataDir).digest("hex").slice(0, 10));
    this.models = new ModelService(store, this.credentials, this.auth, id => this.bots.connectionChanged(id), new ModelCatalog(dataDir));
  }
  static async open(dataDir: string, options: { factory?: SessionFactory; onCompromised?: () => void } = {}): Promise<Application> {
    await mkdir(resolve(dataDir), { recursive: true, mode: 0o700 });
    const root = await realpath(resolve(dataDir));
    let app: Application | undefined;
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(root, { retries: 0, stale: 30_000, update: 10_000, lockfilePath: join(root, ".runtime.lock"),
        onCompromised: () => { console.error("[runtime] data lock compromised"); options.onCompromised?.(); void app?.close().catch(() => console.error("[runtime] shutdown after lock loss failed")); } });
    } catch { throw new RuntimeFault("data_locked", "The data directory is in use, or its run lock can't be taken.", 409); }
    let store: Store | undefined;
    try { store = new Store(root); app = new Application(store, root, release, options.factory); return app; }
    catch (error) { store?.close(); await release(); throw error; }
  }
  start(): void { this.bots.start(); this.tasks.start(); this.models.startCatalog(); }
  close(): Promise<void> {
    if (!this.closing) this.closing = (async () => {
      this.tasks.stop(); this.models.stopCatalog(); await this.auth.close(); await this.bots.close(); await this.credentials.close(); this.events.close(); this.store.close(); await this.release();
    })();
    return this.closing;
  }
}
