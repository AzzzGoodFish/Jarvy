import { ValidationError } from "../../shared/errors.js";

/** Text the owner typed, trimmed: required and at most `max` characters, no NUL. */
export function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new ValidationError(`${label} must be 1-${max} characters`);
  return value.trim();
}
/** As requireText, but may be empty. */
export function optionalText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new ValidationError(`${label} must be at most ${max} characters`);
  return value.trim();
}
