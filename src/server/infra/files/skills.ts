import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skillPath, type Skill } from "../../shared/skill.js";

/** The skills that ship with Jarvy (A55), in the package's `skills/` folder: one folder per skill with a SKILL.md
 * that starts with `name` and `description` lines between `---` markers. Found from this file upward, so it works
 * from the bundled dist/server/cli.js and from the sources alike. */
export function builtinSkills(): Skill[] {
  const dir = skillsDir();
  if (!dir) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    const skill = parseSkill(entry.name, readFileSync(file, "utf8"));
    if (skill) skills.push(skill);
    else console.warn(`Jarvy: skipped the skill in ${entry.name}: SKILL.md needs a name matching its folder and a description`);
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Writes the skills into a workspace as `skills/<name>/SKILL.md`, replacing what is there, so an upgrade brings the
 * new text. Nothing else under `skills/` is touched. */
export async function installSkills(workspace: string, skills: readonly Skill[]): Promise<void> {
  for (const skill of skills) {
    const file = join(workspace, skillPath(skill.name));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, skill.content, "utf8");
  }
}

function skillsDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(dir, "package.json"))) return existsSync(join(dir, "skills")) ? join(dir, "skills") : null;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The two frontmatter lines a skill needs; null when either is missing or the name is not its folder's. */
export function parseSkill(folder: string, content: string): Skill | null {
  const head = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!head) return null;
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(head[1]!)?.[1]?.trim() ?? "";
  const name = field("name"), description = field("description");
  if (name !== folder || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || !description) return null;
  return { name, description, content };
}
