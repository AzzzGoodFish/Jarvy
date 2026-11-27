import { defaultClientConfigDir, ensureClientPaired, runClientForeground } from "./client-cli.js";

/** Standalone zero-install connector (`node connector.mjs <Jarvy address>`): connects this computer to Jarvy (A96)
 * without installing `@goodfish/jarvy`. Shares the exact same pairing and WebSocket loop as `jarvy client run`. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const address = args.find(arg => !arg.startsWith("--"));
  const reset = args.includes("--reset");
  const nameArg = args.find(arg => arg.startsWith("--name="))?.slice(7);
  const dir = defaultClientConfigDir();
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node connector.mjs <Jarvy address, such as https://192.168.1.10:8080> [--name=<name>] [--reset]");
    return;
  }
  try {
    const saved = await ensureClientPaired(dir, { server: address, name: nameArg, reset });
    await runClientForeground({ dir, saved });
  } catch (error) {
    if (!address && error instanceof Error && error.message.includes("No Jarvy server configured")) {
      console.log("Usage: node connector.mjs <Jarvy address, such as https://192.168.1.10:8080> [--name=<name>] [--reset]");
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
