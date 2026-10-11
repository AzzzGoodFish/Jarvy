import type { Store } from "../../infra/storage/store.js";

type LoginResult = { type: "success"; token: string; username: string } | { type: "invalid" } | { type: "limited" };
export class AccountService {
  private readonly failures = new Map<string, { attempts: number; until: number }>();
  /** `instance` tells apart Jarvy data directories served from the same host (see the session cookie). */
  constructor(private readonly store: Store, readonly instance: string) {}
  login(username: unknown, password: unknown, client: string): LoginResult {
    const failure = this.failures.get(client);
    if (failure && failure.until < Date.now()) this.failures.delete(client);
    if ((this.failures.get(client)?.attempts ?? 0) >= 8) return { type: "limited" };
    const token = this.store.login(username, password);
    if (!token) {
      this.failures.set(client, { attempts: (this.failures.get(client)?.attempts ?? 0) + 1, until: Date.now() + 15 * 60_000 });
      return { type: "invalid" };
    }
    this.failures.delete(client);
    return { type: "success", token, username: this.store.username()! };
  }
  authenticated(token: string | undefined) { return this.store.authenticated(token); }
  identity() { return { id: this.store.userMemberId(), username: this.store.username() }; }
  logout(token: string) { this.store.logout(token); }
}
