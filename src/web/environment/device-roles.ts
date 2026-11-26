import type { Device } from "../../contract/environment";

/** True when this client node advertises `--sandbox` compute-pool capability (A108, A109). */
export const isComputeNode = (device: Device): boolean =>
  Boolean(device.sandbox) || device.capabilities.includes("sandbox") || device.capabilities.includes("sandbox-only");

/** True when this client node connected with `--sandbox-only`, disabling direct host access (A109). */
export const isSandboxOnly = (device: Device): boolean =>
  device.capabilities.includes("sandbox-only");

/** True when Bots (and the owner) may directly open host terminals/files on this computer. */
export const allowsHostAccess = (device: Device): boolean => !isSandboxOnly(device);

/** True when one `jarvy client` serves both as a remote host AND a sandbox compute pool node. */
export const isDualRole = (device: Device): boolean => isComputeNode(device) && allowsHostAccess(device);
