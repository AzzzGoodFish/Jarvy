import type { RemoteMcpTransport } from "../../pi/mcp.js";
import type { ConnectorAdapter } from "../adapter.js";

/** Custom Remote HTTP MCP connector (A99): supports OAuth, static headers, or unauthenticated servers. */
export function createCustomMcpAdapter(mcp: RemoteMcpTransport): ConnectorAdapter {
  return {
    id: "custom_mcp",
    name: "Custom MCP",
    kind: "remote_mcp",
    defaultUrl: "",
    authMethods: ["oauth", "headers", "none"],
    probe: input => mcp.probe(input),
    callTool: input => mcp.callTool(input),
    startOAuth: input => mcp.startOAuth(input),
    completeOAuth: input => mcp.completeOAuth(input),
  };
}
