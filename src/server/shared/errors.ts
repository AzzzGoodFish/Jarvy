/** Expected business failures, classified without parsing error-message text. A `code` (A45) names a failure a
 * person can meet, so the interface words it in its own language; the message is English, for logs and the model. */
import type { ErrorCode, ErrorParams } from "../../contract/errors.js";
export class ValidationError extends Error {
  constructor(message: string, readonly code?: ErrorCode, readonly params?: ErrorParams) { super(message); }
}
export class ConflictError extends Error {
  constructor(message: string, readonly code?: ErrorCode, readonly params?: ErrorParams) { super(message); }
}
