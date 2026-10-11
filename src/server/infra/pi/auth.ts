import { randomUUID } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { Store } from "../storage/store.js";
import type { CredentialCoordinator } from "../credentials/coordinator.js";
import { RuntimeFault } from "../../shared/runtime.js";
import { ConnectionCredentials } from "./credentials.js";

interface LoginPrompt {
  id: string; type: AuthPrompt["type"]; message: string; placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
}
export interface LoginState {
  phase: "idle" | "running" | "completed" | "cancelled" | "error";
  prompt?: LoginPrompt; event?: AuthEvent; error?: string;
}
interface LoginFlow {
  state: LoginState; controller: AbortController; task: Promise<void>;
  answer?: (value: string) => void;
}

/** Web interaction bridge only. Pi owns authorization, callback server and token refresh. */
export class CredentialLogins {
  private readonly flows = new Map<string, LoginFlow>();
  constructor(private readonly store: Store, private readonly credentials: CredentialCoordinator, private readonly changed: (id: string) => void) {}
  private connection(id: string) {
    const connection = this.store.getModelConnection(id);
    if (!connection) throw new RuntimeFault("connection_missing", "连接不存在。", 404);
    return connection;
  }
  status(id: string): LoginState {
    this.connection(id);
    return structuredClone(this.flows.get(id)?.state ?? { phase: "idle" });
  }
  start(id: string): LoginState {
    const connection = this.connection(id);
    if (this.flows.get(id)?.state.phase === "running") return this.status(id);
    const flow: LoginFlow = { state: { phase: "running" }, controller: new AbortController(), task: Promise.resolve() };
    this.flows.set(id, flow);
    flow.task = (async () => {
      try {
        const scoped = new ConnectionCredentials(this.store.credentials, this.credentials, this.store.userMemberId(), id, connection.providerName);
        const runtime = await ModelRuntime.create({ credentials: scoped, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, signal: flow.controller.signal });
        await runtime.login(connection.providerName, connection.authType, {
          signal: flow.controller.signal,
          notify: event => { flow.state.event = event; },
          prompt: prompt => this.prompt(flow, prompt),
        }, { getDeviceId: () => this.store.installationDeviceId() });
        flow.state = { phase: "completed" };
        this.changed(id);
      } catch (error) {
        flow.state = flow.controller.signal.aborted ? { phase: "cancelled" }
          : { phase: "error", error: "登录操作失败，请刷新后重试。" };
        if (!flow.controller.signal.aborted) console.error("[oauth] login failed", { connectionId: id, provider: connection.providerName, type: error instanceof Error ? error.constructor.name : "Error" });
      } finally { flow.answer = undefined; }
    })();
    return this.status(id);
  }
  private prompt(flow: LoginFlow, prompt: AuthPrompt): Promise<string> {
    const signal = prompt.signal ? AbortSignal.any([flow.controller.signal, prompt.signal]) : flow.controller.signal;
    signal.throwIfAborted();
    const id = randomUUID();
    flow.state.prompt = { id, type: prompt.type, message: prompt.message,
      ...("placeholder" in prompt ? { placeholder: prompt.placeholder } : {}),
      ...(prompt.type === "select" ? { options: prompt.options } : {}) };
    return new Promise((resolve, reject) => {
      const clear = () => { signal.removeEventListener("abort", aborted); flow.answer = undefined; delete flow.state.prompt; };
      const aborted = () => { clear(); reject(signal.reason); };
      flow.answer = value => { clear(); resolve(value); };
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
  input(id: string, body: Record<string, unknown>): LoginState {
    this.connection(id);
    const flow = this.flows.get(id), prompt = flow?.state.prompt;
    if (!flow?.answer || !prompt || body.promptId !== prompt.id) throw new RuntimeFault("login_step", "授权步骤已更新，请重新操作。", 409);
    if (typeof body.value !== "string" || !body.value.trim()) throw new RuntimeFault("login_input", "请输入授权信息。", 400);
    if (prompt.options && !prompt.options.some(option => option.id === body.value)) throw new RuntimeFault("login_input", "请选择登录方式。", 400);
    flow.answer(body.value);
    return this.status(id);
  }
  async cancel(id: string): Promise<LoginState> {
    this.connection(id);
    const flow = this.flows.get(id);
    if (flow?.state.phase === "running") { flow.controller.abort(); await flow.task; }
    return this.status(id);
  }
  async logout(id: string): Promise<void> {
    const connection = this.connection(id);
    await this.cancel(id);
    const scoped = new ConnectionCredentials(this.store.credentials, this.credentials, this.store.userMemberId(), id, connection.providerName);
    await scoped.delete(connection.providerName);
    this.flows.delete(id);
  }
  async close(): Promise<void> {
    for (const flow of this.flows.values()) if (flow.state.phase === "running") flow.controller.abort();
    await Promise.all([...this.flows.values()].map(flow => flow.task));
  }
}
