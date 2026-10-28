import type { EnvironmentKind } from "../../../../contract/environment.js";
import type { EnvironmentKindEntry } from "./kind.js";
import { host } from "./host.js";
import { sandbox } from "./sandbox.js";
import { ssh } from "./ssh.js";

/** Every kind of work environment, once (A65): the code that runs a Bot's tools looks its kind up here instead of
 * asking what kind it is. */
export const KINDS: Record<EnvironmentKind, EnvironmentKindEntry> = { host, computer: sandbox, ssh };
