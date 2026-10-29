import type { EnvironmentKind } from "../../../../contract/environment.js";
import type { EnvironmentRecord, WorkEnvironment } from "../../../shared/environment.js";
import type { Place } from "../environments.js";

/** What the code that runs tools needs, whatever kind of environment it is (A50). Three things differ by kind and
 * nothing else does: how to reach it, what the Bot is told it is, and what changes when the owner edits it. */
export interface KindDeps { computers: { available: boolean; status(botId: string): { state: string } | null; create(botId: string): void;
  ensure(botId: string): Promise<string>; environment(botId: string, record: EnvironmentRecord): WorkEnvironment };
  machines: { environment(record: EnvironmentRecord, botId: string): WorkEnvironment; about(record: EnvironmentRecord, botId: string): string;
    address(record: EnvironmentRecord): string } }
/** One kind of environment, from `kinds/`. */
export interface EnvironmentKindEntry {
  kind: EnvironmentKind;
  /** May be a Bot's default: only its sandbox (A67). An SSH machine is granted and switched to (A57). */
  home: boolean;
  /** The owner may give it to a Bot. A Bot's sandbox is its own already. */
  grantable: boolean;
  /** The environment the Bot's tools use. */
  open(record: EnvironmentRecord, botId: string, workspacePath: string, deps: KindDeps): WorkEnvironment;
  /** What the Bot calls it and the directory its tools start in (A50); `botId` is the Bot being told. */
  place(record: EnvironmentRecord, botId: string, workspacePath: string): Place;
  /** A switch starts what the environment needs first (a sandbox), before the Bot is moved there. */
  ensure?(record: EnvironmentRecord, botId: string, deps: KindDeps): Promise<void>;
  /** A switch connects first, and stays where it was when the environment's directory isn't reachable. */
  connects: boolean;
  /** Its name as other Bots read it in bots.list, shorter than the place's: own sandbox, a machine's name. */
  summary(record: EnvironmentRecord, botId: string): string;
  /** fields environments.list adds beyond the place. */
  describe(record: EnvironmentRecord, botId: string, deps: KindDeps): Record<string, unknown>;
  /** What the Bot is told when it switches here. */
  about(record: EnvironmentRecord, botId: string, deps: KindDeps): string;
  /** What an open environment is keyed by: an SSH machine reopens when its directory changes. */
  signature(record: EnvironmentRecord): string;
}
