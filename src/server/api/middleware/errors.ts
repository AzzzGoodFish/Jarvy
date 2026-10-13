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
  if (status === 500) return c.json({ error: "Internal server error" }, 500);
  // A coded failure (A45) carries its code and the values its sentence needs; the interface words it.
  const coded = error instanceof RuntimeFault || error instanceof ChatError || error instanceof ValidationError || error instanceof ConflictError ? error : null;
  return c.json({ error: error.message, ...(coded?.code ? { code: coded.code } : {}), ...(coded?.params ? { params: coded.params } : {}) }, status as ContentfulStatusCode);
};
