/** A tool result with pictures for the model beside its text (files.view, A50); the adapter turns it into Pi's
 * content blocks. */
export interface ToolMedia { kind: "media"; text: string; images: { data: string; mimeType: string }[] }
export const isToolMedia = (value: unknown): value is ToolMedia =>
  !!value && typeof value === "object" && (value as { kind?: unknown }).kind === "media" && Array.isArray((value as { images?: unknown }).images);

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
