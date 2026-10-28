import type { EnvironmentKindEntry } from "./kind.js";

/** A machine the owner added, reached over SSH (A57): where it is and what it is for come from the owner, and it is
 * granted to Bots one by one, never a default. */
export const ssh: EnvironmentKindEntry = {
  kind: "ssh", home: false, grantable: true,
  open: (record, botId, _workspacePath, deps) => deps.machines.environment(record, botId),
  place: record => ({ id: record.id, kind: "ssh", name: record.name, directory: record.directory ?? record.spec.home ?? "/" }),
  connects: true,
  summary: record => record.name,
  describe: (record, _botId, deps) => ({ address: deps.machines.address(record), ...(record.description ? { description: record.description } : {}) }),
  about: (record, botId, deps) => deps.machines.about(record, botId),
  signature: record => `${record.id}@${record.directory ?? ""}`,
};
