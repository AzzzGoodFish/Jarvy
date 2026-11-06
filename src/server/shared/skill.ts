/** A skill that ships with Jarvy (A55): a guide for one kind of work, which the agent Bot reads with skills.read. */
export interface Skill {
  /** Lowercase words joined by hyphens; also its folder's name. */
  name: string;
  /** What it covers and when to use it: the line the prompt lists. */
  description: string;
  /** The whole SKILL.md, frontmatter included. */
  content: string;
}
