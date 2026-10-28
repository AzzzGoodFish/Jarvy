import { Type } from "typebox";
import { byteSize } from "../../chat/files.js";
import { viewFile } from "../file-view.js";
import { tool } from "./registry.js";

const FileId = Type.String({ minLength: 1, maxLength: 80, description: "The file's id: from <file id=…/> in a message, or the attachments of messages.read and messages.search" });

/** Files from messages: into the Bot's environment, or looked at directly. */
export const fileTools = [
  tool("files.get", "Put a file from a message into your environment, to work on it with your tools; the result has its path there. It goes to temp/files/ under its own name unless you give a path.",
    Type.Object({ id: FileId, path: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: "Where to put it instead: absolute, or relative to your directory" })) }, { additionalProperties: false }), async ({ id, path }, context, call) => {
    const file = context.scope.files.open(context.bot, id);
    call.signal?.throwIfAborted();
    return { path: await context.scope.workspace.put(file.name, id, context.scope.files.chunks(file), path, call.signal), name: file.name, type: file.mimeType, size: byteSize(file.size) };
  }),
  tool("files.view", "Look at a file from a message without putting it anywhere: a picture (PNG, JPEG, GIF or WebP, up to 4 MB) is shown to you, and a text file up to 64 KB comes back as text. Anything else needs files.get.",
    Type.Object({ id: FileId }, { additionalProperties: false }), async ({ id }, context) => {
    const file = context.scope.files.open(context.bot, id);
    return viewFile(file, context.scope.files);
  }),
];
