/** A skill that ships with Jarvy (A55): a guide for one kind of work, kept as a file in the agent Bot's workspace. */
export interface Skill {
  /** Lowercase words joined by hyphens; also its folder's name. */
  name: string;
  /** What it covers and when to use it: the line the prompt lists. */
  description: string;
  /** The whole SKILL.md, frontmatter included. */
  content: string;
}

/** Where a skill's file sits, relative to the workspace. */
export const skillPath = (name: string) => `skills/${name}/SKILL.md`;
