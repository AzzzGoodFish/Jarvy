import { RuntimeFault } from "../../shared/runtime.js";

/** Shared by all Bots: refresh serializes per connection, not per Pi provider name. */
export class CredentialCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private closing = false;
  async exclusive<T>(connectionId: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closing) throw new RuntimeFault("stopping", "Shutting down.");
    signal?.throwIfAborted();
    const prior = this.tails.get(connectionId) ?? Promise.resolve();
    const operation = prior.then(() => { signal?.throwIfAborted(); return action(); });
    // A cancelled waiter must not release the serialization tail of a running refresh.
    const tail = operation.then(() => {}, () => {});
    this.tails.set(connectionId, tail);
    void tail.then(() => { if (this.tails.get(connectionId) === tail) this.tails.delete(connectionId); });
    if (!signal) return operation;
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      operation.then(value => { signal.removeEventListener("abort", aborted); resolve(value); }, error => { signal.removeEventListener("abort", aborted); reject(error); });
      if (signal.aborted) aborted();
    });
  }
  async close(): Promise<void> { this.closing = true; await Promise.all(this.tails.values()); }
}
