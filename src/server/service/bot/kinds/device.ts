import type { EnvironmentKindEntry } from "./kind.js";

/** A computer that connected itself through the desktop client (A96): granted to Bots like an SSH machine and switched
 * to, never a default. Jarvy doesn't reach out to it; while its client is off or paused, its tools fail and say so. */
export const device: EnvironmentKindEntry = {
  kind: "device", home: false, grantable: true,
  open: (record, botId, _workspacePath, deps) => deps.devices.environment(record, botId),
  place: (record, _botId, _workspacePath, deps) => ({ id: record.id, kind: "device", name: record.name, directory: deps.devices.place(record) }),
  connects: true,
  summary: record => record.name,
  describe: (record, _botId, deps) => deps.devices.describe(record),
  about: (record, botId, deps) => deps.devices.about(record, botId),
  signature: record => `${record.id}@${record.directory ?? ""}@${record.spec.shell ?? ""}`,
};
