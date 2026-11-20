import type { RemoteMcpTransport } from "../../pi/mcp.js";
import type { ConnectorAdapter } from "../adapter.js";

/** Curated Linear connector (A102): Linear's official Streamable HTTP MCP server with dynamic OAuth registration. */
export function createLinearAdapter(mcp: RemoteMcpTransport): ConnectorAdapter {
  return {
    id: "linear",
    name: "Linear",
    kind: "remote_mcp",
    defaultUrl: "https://mcp.linear.app/mcp",
    authMethods: ["oauth"],
    probe: input => mcp.probe(input),
    callTool: input => mcp.callTool(input),
    startOAuth: input => mcp.startOAuth(input),
    completeOAuth: input => mcp.completeOAuth(input),
  };
}
