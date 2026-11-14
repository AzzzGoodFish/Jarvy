import type { ConnectorProvider, ConnectorTool } from "../../../contract/connectors.js";
import type { McpCallResult, McpOAuthSnapshot, McpProbeResult, McpStartOAuthResult } from "../../shared/connector.js";
import { GITHUB_TOOLS, callGitHubTool, completeGitHubOAuth, probeGitHub, startGitHubOAuth } from "./github.js";
import { GMAIL_TOOLS, callGmailTool, completeGmailOAuth, probeGmail, startGmailOAuth } from "./gmail.js";
import { SLACK_TOOLS, callSlackTool, completeSlackOAuth, probeSlack, startSlackOAuth } from "./slack.js";

export function builtinToolsFor(provider: ConnectorProvider): ConnectorTool[] {
  if (provider === "github") return GITHUB_TOOLS;
  if (provider === "gmail") return GMAIL_TOOLS;
  if (provider === "slack") return SLACK_TOOLS;
  return [];
}

export async function probeBuiltin(options: {
  provider: ConnectorProvider;
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthSnapshot;
  clientId?: string;
  clientSecret?: string;
}): Promise<McpProbeResult> {
  if (options.provider === "github") return probeGitHub(options);
  if (options.provider === "gmail") return probeGmail(options);
  if (options.provider === "slack") return probeSlack(options);
  return { outcome: "error", message: `Unsupported built-in connector "${options.provider}"` };
}

export async function callBuiltinTool(options: {
  provider: ConnectorProvider;
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthSnapshot;
  clientId?: string;
  clientSecret?: string;
  toolName: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<McpCallResult> {
  if (options.provider === "github") return callGitHubTool(options);
  if (options.provider === "gmail") return callGmailTool(options);
  if (options.provider === "slack") return callSlackTool(options);
  return { outcome: "error", message: `Unsupported built-in connector "${options.provider}"` };
}

export async function startBuiltinOAuth(options: {
  provider: ConnectorProvider;
  url: string;
  clientId?: string;
  clientSecret?: string;
  redirectUrl: string;
}): Promise<McpStartOAuthResult> {
  if (options.provider === "github") return startGitHubOAuth(options);
  if (options.provider === "gmail") return startGmailOAuth(options);
  if (options.provider === "slack") return startSlackOAuth(options);
  throw new Error(`Unsupported built-in OAuth provider "${options.provider}"`);
}

export async function completeBuiltinOAuth(options: {
  provider: ConnectorProvider;
  url: string;
  oauth?: McpOAuthSnapshot;
  clientId?: string;
  clientSecret?: string;
  redirectUrl: string;
  code: string;
  signal?: AbortSignal;
}): Promise<McpOAuthSnapshot> {
  if (options.provider === "github") return completeGitHubOAuth(options);
  if (options.provider === "gmail") return completeGmailOAuth(options);
  if (options.provider === "slack") return completeSlackOAuth(options);
  throw new Error(`Unsupported built-in OAuth provider "${options.provider}"`);
}
