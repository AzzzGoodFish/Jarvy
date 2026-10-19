import type { AuthOperationOptions, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { CredentialCoordinator } from "../credentials/coordinator.js";
import { CredentialRepository, credentialValue } from "../storage/credential-repository.js";
import { RuntimeFault } from "../../shared/runtime.js";

export class ConnectionCredentials implements CredentialStore {
  constructor(private readonly repository: CredentialRepository, private readonly coordinator: CredentialCoordinator,
    private readonly ownerId: string, readonly connectionId: string, readonly providerName: string) {}
  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    if (providerId !== this.providerName) return undefined;
    const row = this.repository.read(this.ownerId, this.connectionId);
    // Fail closed instead of allowing the SDK to fall back to host env credentials.
    if (!row) throw new RuntimeFault("credentials_missing", "Set up this connection's credential first.", 422);
    return row.value;
  }
  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    const row = this.repository.current(this.ownerId, this.connectionId);
    return row?.value ? [{ providerId: this.providerName, type: row.value.type }] : [];
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (providerId !== this.providerName) throw new RuntimeFault("credential_scope", "The credential belongs to another connection.");
    return this.coordinator.exclusive(this.connectionId, async () => {
      // An unreadable prior value (another installation's key) is replaced as if absent.
      const prior = this.repository.current(this.ownerId, this.connectionId);
      const next = await fn(prior?.value ?? undefined);
      // A completed remote refresh may have rotated its token: retain the result even
      // if the consuming request was cancelled while the refresh was finishing.
      if (next) this.repository.replace(this.ownerId, this.connectionId, prior?.revision ?? null, credentialValue(next));
      return next ?? prior?.value ?? undefined;
    }, options?.signal);
  }
  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    if (providerId !== this.providerName) throw new RuntimeFault("credential_scope", "The credential belongs to another connection.");
    await this.coordinator.exclusive(this.connectionId, async () => { this.repository.delete(this.ownerId, this.connectionId); }, options?.signal);
  }
}

/** Binding changes only at a Bot's safe boundary; no process-wide auth mutations. */
export class CurrentCredentials implements CredentialStore {
  constructor(public current: ConnectionCredentials) {}
  read(...args: Parameters<CredentialStore["read"]>) { return this.current.read(...args); }
  list(...args: Parameters<CredentialStore["list"]>) { return this.current.list(...args); }
  modify(...args: Parameters<CredentialStore["modify"]>) { return this.current.modify(...args); }
  delete(...args: Parameters<CredentialStore["delete"]>) { return this.current.delete(...args); }
}
