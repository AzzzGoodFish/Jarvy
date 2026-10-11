import { HTTPException } from "hono/http-exception";
import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { RuntimeFault } from "../../shared/runtime.js";
import { ChatError } from "../../shared/chat.js";
import { ValidationError, ConflictError } from "../../shared/errors.js";
import type { ApiEnv } from "../context.js";

export const handleError: ErrorHandler<ApiEnv> = (error, c) => {
  let status: number = 500;
  if (error instanceof HTTPException || error instanceof ChatError || error instanceof RuntimeFault) status = error.status;
  else if (error instanceof ValidationError || (error instanceof TypeError && "code" in error && error.code === "ERR_INVALID_URL")) status = 400;
  else if (error instanceof ConflictError) status = 409;
  if (status === 500) console.error("[api] request failed", { path: c.req.path, code: error instanceof RuntimeFault ? error.code : "internal" });
  return c.json({ error: status === 500 ? "Internal server error" : error.message }, status as ContentfulStatusCode);
};
