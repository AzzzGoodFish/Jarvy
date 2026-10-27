import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./migrations/schema.js";
import { AccountRepository } from "./account-repository.js";
import { BotRepository } from "./bot-repository.js";
import { ModelConnectionRepository } from "./model-connection-repository.js";
import { ChatRepository } from "./chat-repository.js";
import { RuntimeRepository } from "./runtime-repository.js";
import { CredentialRepository } from "./credential-repository.js";
import { AgentRepository } from "./agent-repository.js";
import { EnvironmentRepository } from "./environment-repository.js";
import { SettingsRepository } from "./settings-repository.js";
import { SecretRepository } from "./secret-repository.js";
import { TaskRepository } from "./task-repository.js";
import { Cipher } from "../vault/cipher.js";
import { masterKey } from "../vault/master-key.js";

export const defaultDataDir = () => process.env.JARVY_DATA_DIR || join(homedir(), ".jarvy");
export const DATABASE_FILENAME = "jarvy.db";

/** SQLite owner: opens the database, runs migrations and holds one repository per domain. Runtime adapters never
 * receive the raw database handle. */
export class Store {
  private readonly db: DatabaseSync;
  readonly path: string;
  /** The account, its sessions and the owner's member id. */
  readonly account: AccountRepository;
  readonly bots: BotRepository;
  readonly connections: ModelConnectionRepository;
  readonly chats: ChatRepository;
  readonly runtime: RuntimeRepository;
  readonly credentials: CredentialRepository;
  readonly agent: AgentRepository;
  readonly environments: EnvironmentRepository;
  readonly settings: SettingsRepository;
  /** Scheduled tasks (A58). */
  readonly tasks: TaskRepository;
  readonly secrets: SecretRepository;
  /** Seals secrets and model credentials under the master key (A52). */
  readonly cipher: Cipher;

  constructor(dataDir = defaultDataDir()) {
    const root = resolve(dataDir);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.path = join(root, DATABASE_FILENAME);
    this.db = new DatabaseSync(this.path);
    chmodSync(this.path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.account = new AccountRepository(this.db);
    this.cipher = new Cipher(() => masterKey(this.account.installationDeviceId()));
    try { migrateDatabase(this.db, this.cipher); }
    catch (error) { this.db.close(); throw error; }
    this.chats = new ChatRepository(this.db);
    this.runtime = new RuntimeRepository(this.db);
    this.credentials = new CredentialRepository(this.db, this.cipher);
    const ownerId = () => this.account.userMemberId();
    this.connections = new ModelConnectionRepository(this.db, this.credentials, ownerId);
    this.bots = new BotRepository(this.db, root, ownerId, this.connections);
    this.agent = new AgentRepository(this.db, ownerId);
    this.environments = new EnvironmentRepository(this.db, this.cipher, ownerId);
    this.settings = new SettingsRepository(this.db);
    this.tasks = new TaskRepository(this.db);
    this.secrets = new SecretRepository(this.db, this.cipher, ownerId);
    this.agent.ensure();
  }

  close(): void { this.db.close(); }
}
