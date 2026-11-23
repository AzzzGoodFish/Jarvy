import { t } from "../i18n";

const ACTION_KEYS: Record<string, Parameters<typeof t>[0]> = {
  create_issue: "connectorAction.create_issue",
  update_issue: "connectorAction.update_issue",
  create_comment: "connectorAction.create_comment",
  send_email: "connectorAction.send_email",
  create_draft: "connectorAction.create_draft",
};

const FIELD_KEYS: Record<string, Parameters<typeof t>[0]> = {
  title: "connectorField.title",
  name: "connectorField.name",
  subject: "connectorField.subject",
  team: "connectorField.team",
  project: "connectorField.project",
  description: "connectorField.description",
  body: "connectorField.body",
  content: "connectorField.content",
  message: "connectorField.message",
  text: "connectorField.text",
  comment: "connectorField.comment",
  from: "connectorField.from",
  to: "connectorField.to",
  cc: "connectorField.cc",
  bcc: "connectorField.bcc",
  priority: "connectorField.priority",
  status: "connectorField.status",
  state: "connectorField.status",
  assignee: "connectorField.assignee",
  labels: "connectorField.labels",
  parent: "connectorField.parent",
  url: "connectorField.url",
  owner: "connectorField.owner",
  repo: "connectorField.repo",
  repository: "connectorField.repo",
  number: "connectorField.number",
  issue_number: "connectorField.number",
  id: "connectorField.id",
};

export function connectorActionLabel(toolName: string, fallback: string): string {
  const key = ACTION_KEYS[toolName.toLowerCase()];
  return key ? t(key) : fallback;
}

export function connectorFieldLabel(key: string, fallback: string, collisions?: ReadonlyMap<string, number>): string {
  const lower = key.toLowerCase();
  if ((collisions?.get(lower) ?? 0) > 1) return fallback;
  const labelKey = FIELD_KEYS[lower];
  return labelKey ? t(labelKey) : fallback;
}
