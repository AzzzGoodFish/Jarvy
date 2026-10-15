import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { WorkEnvironment } from "../../shared/environment.js";
import { overDurable } from "./durable.js";

/** The owner's computer, the machine running Jarvy (A50): commands run here as Jarvy's own user, with the environment
 * Pi builds for them, as they did before environments existed. */
export function hostEnvironment(cwd: string): WorkEnvironment {
  return overDurable("host", "host", new NodeExecutionEnv({ cwd }), { passEnv: true });
}
