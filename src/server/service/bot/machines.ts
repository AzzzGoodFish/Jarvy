import { randomUUID } from "node:crypto";
import { dirname, join, posix } from "node:path";
import { SshFault, clearRuntime, generateKey, installKey, probeHost, removeKey, scanHost, sshEnvironment, type SshAccess, type SshAddress } from "../../infra/env/ssh.js";
import type { Store } from "../../infra/storage/store.js";
import { ChatError, type ChatMessage, type MachineAsk, type QuestionSpec } from "../../shared/chat.js";
import type { EnvironmentRecord, HostKeys, SshMachine, WorkEnvironment } from "../../shared/environment.js";
import type { ChatService } from "../chat/service.js";

/** What adding a machine takes, from Settings or from a Bot's request card. */
export interface MachineInput { name?: unknown; host: unknown; port?: unknown; user: unknown; directory?: unknown }

const HOST = /^(?!-)[A-Za-z0-9._:-]{1,253}$/, USER = /^(?!-)[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;

/** Machines the owner adds over SSH (A57). Jarvy makes the key for each, installs it with the password the owner types
 * once, and keeps both the key (sealed with the master key) and the host keys the owner accepted; Bots never see
 * either. A Bot may switch to a machine its owner granted it. */
export class SshMachines {
  private readonly runtime: string;
  /** `changed`: what Bots may use changed, so the owner's page reloads them. */
  constructor(private readonly store: Store, private readonly chats: ChatService, private readonly changed: () => void = () => {}) {
    this.runtime = join(dirname(store.path), "ssh");
    clearRuntime(this.runtime);
  }
  list(): SshMachine[] { return this.store.environments.sshMachines().map(record => this.view(record)); }
  get(id: string): SshMachine { return this.view(this.need(id)); }
  /** The host keys a machine presents, to show the owner before the password is typed. */
  async scan(input: MachineInput): Promise<HostKeys> { return this.wrap(() => scanHost(address(input), this.runtime)); }
  /** Makes a key, installs it with the password, checks a login with it, then saves the machine; the password is
   * used for that one login only. Nothing is saved when any step fails. */
  async add(input: MachineInput & { password: unknown; hostKeys: HostKeys }, grantTo?: { botId: string; by: string }): Promise<SshMachine> {
    const where = address(input), name = this.freeName(text(input.name, 40) || `${where.user}@${where.host}`);
    if (typeof input.password !== "string" || !input.password) throw new ChatError(400, "A password is needed to install the key", "ssh_password_missing");
    if (!input.hostKeys.keys.length) throw new ChatError(400, "The host keys are missing; scan the machine first");
    directoryIn("/", input.directory); // a bad directory fails before anything touches the machine
    const id = randomUUID(), comment = keyComment(id);
    const record = await this.wrap(async () => {
      const key = await generateKey(this.runtime, comment), access = { ...where, runtime: this.runtime, alias: alias(id), hostKeys: input.hostKeys.keys, privateKey: key.privateKey };
      await installKey(where, this.runtime, input.hostKeys.keys, input.password as string, key.publicKey);
      try {
        const remote = await probeHost(access);
        return this.store.environments.addSsh({ name, ...where, ...remote, directory: directoryIn(remote.home, input.directory), hostKeys: input.hostKeys, privateKey: key.privateKey }, id);
      } catch (error) {
        // The key is on the machine but the machine isn't being added: take it back off.
        await removeKey(access, comment).catch(() => {});
        throw error;
      }
    });
    if (grantTo) this.store.environments.grant(record.id, grantTo.botId, grantTo.by);
    this.changed();
    return this.view(record);
  }
  update(id: string, input: { name?: unknown; directory?: unknown }): SshMachine {
    const record = this.need(id);
    const name = input.name === undefined ? undefined : text(input.name, 40);
    if (name !== undefined && !name) throw new ChatError(400, "A name is needed");
    if (name !== undefined && name !== record.name) this.freeName(name);
    this.store.environments.updateSsh(id, { ...(name !== undefined ? { name } : {}),
      ...(input.directory !== undefined ? { directory: directoryIn(record.spec.home ?? "/", input.directory) } : {}) });
    this.changed();
    return this.get(id);
  }
  /** Scans the machine again: `changed` when it no longer presents the keys the owner accepted. */
  async check(id: string): Promise<{ hostKeys: HostKeys; changed: boolean }> {
    const record = this.need(id), accepted = this.store.environments.sshSecrets(id)!.hostKeys;
    const hostKeys = await this.scan(this.addressOf(record));
    return { hostKeys, changed: hostKeys.keys.some(key => !accepted.keys.includes(key)) };
  }
  /** The owner accepts the keys the machine presents now (after a reinstall, say). */
  async trust(id: string, fingerprints: unknown): Promise<SshMachine> {
    const { hostKeys } = await this.check(id);
    if (!Array.isArray(fingerprints) || hostKeys.fingerprints.join("\n") !== fingerprints.join("\n")) throw new ChatError(409, "The machine now presents other keys; check again", "ssh_host_key_changed");
    this.store.environments.updateSsh(id, { hostKeys });
    return this.get(id);
  }
  /** Removes Jarvy's key from the machine, then forgets it. When the machine can't be reached the key stays
   * there; `force` forgets it anyway. Returns the Bots that were working there. */
  async remove(id: string, force: boolean): Promise<string[]> {
    const record = this.need(id);
    try { await this.wrap(() => removeKey(this.access(record), keyComment(id))); }
    catch (error) { if (!force) throw error; }
    const moved = this.store.environments.dropSsh(id);
    this.changed();
    return moved;
  }
  /** The machine as a Bot's environment. Its own files go in ~/.cache/jarvy/<Bot> there. */
  environment(record: EnvironmentRecord, botId: string): WorkEnvironment {
    const home = record.spec.home ?? "/tmp";
    return sshEnvironment(record.id, this.access(record), record.directory ?? home, posix.join(home, ".cache", "jarvy", botId),
      text => console.error(`[ssh ${record.name}] ${text.trim()}`));
  }
  /** What a Bot is told of a machine. */
  about(record: EnvironmentRecord, botId: string): string {
    const temp = posix.join(record.spec.home ?? "~", ".cache", "jarvy", botId);
    return `A ${record.spec.platform === "darwin" ? "macOS" : "Linux"} machine your owner added, reached over SSH as ${record.spec.user}@${record.spec.host}. Your tools run there as that user and can reach their files: work in your directory, leave other people's files and system directories alone unless the task needs it, and say in your reply what you changed there. Files from the chat and long command outputs go in ${temp}.`;
  }
  address(record: EnvironmentRecord): string { return `${record.spec.user}@${record.spec.host}${record.spec.port === "22" ? "" : `:${record.spec.port}`}`; }

  /** environments.request: a machine the Bot may already use needs no card; one already added needs only a grant;
   * else the card shows its fingerprints and takes the password. */
  async prepareRequest(botId: string, input: MachineInput & { purpose: string }): Promise<{ granted: EnvironmentRecord } | { question: QuestionSpec }> {
    const where = address(input);
    const existing = this.store.environments.sshMachines().find(record => record.spec.host === where.host && record.spec.user === where.user && record.spec.port === String(where.port));
    if (existing && this.store.environments.grantees(existing.id).includes(botId)) return { granted: existing };
    const hostKeys = existing ? this.store.environments.sshSecrets(existing.id)!.hostKeys : await this.scan(where);
    const machine: MachineAsk = { name: existing?.name ?? (text(input.name, 40) || `${where.user}@${where.host}`), ...where,
      directory: typeof input.directory === "string" && input.directory.trim() ? input.directory.trim() : null, purpose: input.purpose, hostKeys,
      existing: existing ? { id: existing.id, name: existing.name } : null };
    return { question: { question: input.purpose, options: [{ label: "Add", value: "add" }], multiple: false, allowCustom: false, machine } };
  }
  /** The owner's answer on a request card: adds the machine with the password (or grants the one already added) to
   * the Bot that asked, then settles the card. The password never enters the message. */
  async fulfil(actorId: string, chatId: string, messageId: string, input: { password?: unknown }): Promise<ChatMessage> {
    const message = this.chats.message(actorId, messageId), ask = message?.question?.machine;
    if (!message || message.chatId !== chatId || !ask || message.question?.state !== "pending") throw new ChatError(409, "The question is already settled", "question_closed");
    if (!this.chats.questions.waitingFor(messageId)) throw new ChatError(409, "The question has expired", "question_expired");
    const botId = message.sender.id, by = this.store.userMemberId();
    const existing = ask.existing && this.store.environments.get(ask.existing.id);
    if (existing) { this.store.environments.grant(existing.id, botId, by); this.changed(); }
    else await this.add({ name: ask.name, host: ask.host, port: ask.port, user: ask.user, directory: ask.directory ?? undefined, password: input.password, hostKeys: ask.hostKeys }, { botId, by });
    return this.chats.questions.respond(actorId, chatId, messageId, { action: "answer", selected: [0] });
  }
  /** The machine a request card added or granted, by its address. */
  find(botId: string, input: MachineInput): EnvironmentRecord | null {
    const where = address(input);
    return this.store.environments.grants(botId).find(record => record.kind === "ssh" && record.spec.host === where.host && record.spec.user === where.user
      && record.spec.port === String(where.port)) ?? null;
  }

  private view(record: EnvironmentRecord): SshMachine {
    const { spec } = record, secrets = this.store.environments.sshSecrets(record.id);
    return { id: record.id, name: record.name, host: spec.host ?? "", port: Number(spec.port ?? 22), user: spec.user ?? "", home: spec.home ?? "",
      directory: record.directory ?? spec.home ?? "", platform: spec.platform ?? "", fingerprints: secrets?.hostKeys.fingerprints ?? [],
      botIds: this.store.environments.grantees(record.id) };
  }
  private need(id: string): EnvironmentRecord {
    const record = this.store.environments.get(id);
    if (!record || record.kind !== "ssh") throw new ChatError(404, "No machine with this id", "machine_missing");
    return record;
  }
  private addressOf(record: EnvironmentRecord): SshAddress { return { host: record.spec.host!, port: Number(record.spec.port), user: record.spec.user! }; }
  private access(record: EnvironmentRecord): SshAccess {
    const secrets = this.store.environments.sshSecrets(record.id);
    if (!secrets?.privateKey) throw new ChatError(409, "This machine's key doesn't open under this installation's master key; delete the machine and add it again", "ssh_key_unreadable");
    return { ...this.addressOf(record), runtime: this.runtime, alias: alias(record.id), hostKeys: secrets.hostKeys.keys, privateKey: secrets.privateKey };
  }
  private freeName(name: string): string {
    if (this.store.environments.sshMachines().some(record => record.name === name)) throw new ChatError(409, "Another machine has this name", "machine_name_taken");
    return name;
  }
  /** SSH failures reach people and Bots as chat errors with a code the interface can word. */
  private async wrap<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (!(error instanceof SshFault)) throw error;
      switch (error.code) {
        case "ssh_auth_failed": throw new ChatError(403, error.message, "ssh_auth_failed");
        case "ssh_unreachable": throw new ChatError(409, error.message, "ssh_unreachable");
        case "ssh_host_key_changed": throw new ChatError(409, error.message, "ssh_host_key_changed");
        case "ssh_unsupported": throw new ChatError(409, error.message, "ssh_unsupported");
        default: throw new ChatError(409, error.message, "ssh_failed", { detail: error.message });
      }
    }
  }
}

const alias = (id: string) => `jarvy-${id}`;
/** Marks Jarvy's line in a machine's authorized_keys, to remove it again. */
const keyComment = (id: string) => `jarvy-${id}`;
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
function address(input: MachineInput): SshAddress {
  const host = text(input.host, 253), user = text(input.user, 64), port = input.port === undefined || input.port === "" ? 22 : Number(input.port);
  if (!HOST.test(host)) throw new ChatError(400, "host must be a host name or IP address", "ssh_bad_host");
  if (!USER.test(user)) throw new ChatError(400, "user must be a user name on that machine", "ssh_bad_user");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ChatError(400, "port must be 1 to 65535", "ssh_bad_port");
  return { host, port, user };
}
/** An absolute directory on the machine; `~` and paths under it are its home. Empty means home. */
function directoryIn(home: string, value: unknown): string {
  const raw = text(value, 1000);
  if (!raw || raw === "~") return home;
  if (raw.startsWith("~/")) return posix.join(home, raw.slice(2));
  if (!raw.startsWith("/") || /[\x00-\x1f]/.test(raw)) throw new ChatError(400, "directory must be an absolute path or start with ~/", "ssh_bad_directory");
  return posix.normalize(raw);
}
