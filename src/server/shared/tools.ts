export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
  /** Strings are rendered text; structured values are encoded as JSON by the adapter. */
  execute(arguments_: unknown, context: ToolContext): Promise<unknown>;
}
export interface ToolContext {
  toolCallId: string;
  signal?: AbortSignal;
}
