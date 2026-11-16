import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { call, Connector, fetchRoot, findShells, type Status, type Trust } from "./connector.js";

/** `node connector.mjs <Jarvy address>`: connects the computer it runs on to Jarvy (A96), the desktop client's
 * connection without its window. The first run checks Jarvy's root certificate with the person, signs in as the owner
 * and registers the computer; later runs connect with the computer's own token. Bots can use the computer only once the
 * owner grants it to them on the Environments page, and only while this runs. */
const VERSION = "connector-1";
interface Saved { server: string; token: string; ca: string | null; name: string }

const folder = process.platform === "win32" ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Jarvy", "connector") : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "jarvy-connector");
const file = join(folder, "device.json");

async function main(): Promise<void> {
  const args = process.argv.slice(2), address = args.find(arg => !arg.startsWith("--")), reset = args.includes("--reset");
  const nameArg = args.find(arg => arg.startsWith("--name="))?.slice(7);
  let saved = reset ? null : await readFile(file, "utf8").then(text => JSON.parse(text) as Saved).catch(() => null);
  if (!address && !saved) { console.log("Usage: node connector.mjs <Jarvy address, such as https://192.168.1.10:12520> [--name=<name>] [--reset]"); process.exitCode = 2; return; }
  const server = address ? new URL(address).origin : saved!.server;
  if (!saved || saved.server !== server) saved = await register(server, nameArg ?? hostname());
  const shells = findShells();
  console.log(`Shells here: ${[shells.bash && `bash (${shells.bash})`, shells.powershell && `PowerShell (${shells.powershell})`].filter(Boolean).join(", ") || "none found"}`);
  const connector = new Connector({ server, token: saved.token, trust: { ca: saved.ca }, cache: join(folder, "daemon"), client: VERSION,
    onStatus: status => console.log(`[${new Date().toLocaleTimeString()}] ${describe(status)}`), log: text => { if (process.env.JARVY_CONNECTOR_DEBUG) console.error(text); } });
  connector.start();
  console.log("Type p and Enter to pause or resume Bots' work here; Ctrl+C to stop.");
  let paused = false;
  const input = createInterface({ input: process.stdin });
  input.on("line", line => { if (line.trim() === "p") { paused = !paused; connector.setPaused(paused); console.log(paused ? "Paused: Bots can't work here until you resume." : "Resumed."); } });
  const stop = () => { connector.stop(); input.close(); setTimeout(() => process.exit(0), 300); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function describe(status: Status): string {
  switch (status.state) {
    case "connecting": return "Connecting…";
    case "online": return `Connected as "${status.name}"${status.working.length ? `; working here: ${status.working.join(", ")}` : ""}`;
    case "offline": return `${status.reason}${status.retryIn ? `; trying again in ${Math.round(status.retryIn / 1000)} s` : ""}`;
    case "unpaired": return "This computer was unpaired in Jarvy. Run again with --reset to connect it anew.";
    case "outdated": return `This connector is too old for this Jarvy (protocol ${status.protocol}); download it again from Jarvy.`;
  }
}

/** The first run: trust Jarvy's root, sign in as the owner, register this computer, keep its token. */
async function register(server: string, name: string): Promise<Saved> {
  const ask = prompter();
  let trust: Trust = { ca: null };
  if (new URL(server).protocol === "https:") {
    const root = await fetchRoot(server);
    if (root) {
      console.log(`Jarvy's root certificate: SHA-256 ${root.fingerprint}`);
      console.log("Check that it matches the fingerprint in Jarvy's Settings › 网络 (Network).");
      if (!/^y(es)?$/i.test((await ask.line("Does it match? (y/N) ")).trim())) throw new Error("Not connected: the certificate wasn't confirmed");
      trust = { ca: root.pem };
    }
  }
  const username = (await ask.line("Jarvy username: ")).trim(), password = await ask.hidden("Password: ");
  ask.close();
  const login = await call(server, trust, "POST", "/api/login", { body: JSON.stringify({ username, password }) });
  if (login.status !== 200) throw new Error(login.status === 401 ? "Wrong username or password" : `Sign-in failed (${login.status})`);
  const cookie = ([] as string[]).concat(login.headers["set-cookie"] ?? []).map(line => line.split(";")[0]).join("; ");
  const created = await call(server, trust, "POST", "/api/environments/devices", { headers: { Cookie: cookie }, body: JSON.stringify({ name }) });
  if (created.status !== 201) throw new Error(`Couldn't register this computer (${created.status}): ${created.body.toString().slice(0, 200)}`);
  const { device, token } = JSON.parse(created.body.toString()) as { device: { name: string }; token: string };
  const saved: Saved = { server, token, ca: trust.ca, name: device.name };
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  console.log(`Registered as "${device.name}". Grant it to a Bot on Jarvy's Environments page to let the Bot work here.`);
  return saved;
}

function prompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  const write = (rl as unknown as { _writeToOutput: (text: string) => void });
  const original = write._writeToOutput.bind(rl);
  write._writeToOutput = text => { if (!muted || text.includes("\n")) original(muted ? "\n" : text); };
  return {
    line: (question: string) => new Promise<string>(resolve => rl.question(question, resolve)),
    // The prompt is written first, then what is typed is hidden: readline redraws the line as it is typed, which would
    // otherwise show it, or wipe a prompt written before the question.
    hidden: (question: string) => new Promise<string>(resolve => { rl.question(question, answer => { muted = false; resolve(answer); }); muted = true; }),
    close: () => rl.close(),
  };
}

// A failure ends it at once: the open prompt on standard input would keep it running.
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
