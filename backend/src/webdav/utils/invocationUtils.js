/**
 * WebDAV Worker invocation guard helpers.
 *
 * WebDAV keeps synchronous semantics: success means the operation completed.
 * If a Worker/runtime resource limit is hit, return a clear WebDAV error
 * instead of pretending the operation will continue in the background.
 */

export const WEBDAV_INVOCATION_ERROR_CODE = "WORKER_INVOCATION_LIMIT";

export class InvocationLimitError extends Error {
  constructor(message = "Worker invocation limit reached", details = null) {
    super(message);
    this.name = "InvocationLimitError";
    this.code = WEBDAV_INVOCATION_ERROR_CODE;
    this.status = 507;
    this.expose = true;
    this.details = details;
  }
}

function collectErrorText(error, seen = new Set()) {
  if (!error || seen.has(error)) return [];
  seen.add(error);

  const values = [];
  const append = (value) => {
    if (typeof value === "string" && value.trim()) {
      values.push(value);
    }
  };

  append(error.name);
  append(error.code);
  append(error.message);
  append(error.details?.code);
  append(error.details?.message);
  append(error.details?.cause);
  append(error.cause?.code);
  append(error.cause?.message);

  return [
    ...values,
    ...collectErrorText(error.cause, seen),
    ...collectErrorText(error.originalError, seen),
  ];
}

export function isInvocationLimitError(error) {
  if (!error) return false;
  if (error instanceof InvocationLimitError) return true;
  if (error.code === WEBDAV_INVOCATION_ERROR_CODE) return true;

  const text = collectErrorText(error).join(" ").toUpperCase();
  if (!text) return false;

  return (
    text.includes("TOO MANY API REQUESTS BY SINGLE WORKER INVOCATION") ||
    text.includes("TOO MANY SUBREQUESTS BY SINGLE WORKER INVOCATION") ||
    text.includes("SUBREQUESTS BY SINGLE WORKER INVOCATION") ||
    text.includes("EXCEEDED CPU TIME") ||
    text.includes("CPU TIME LIMIT") ||
    text.includes("WORKER CPU TIME") ||
    text.includes("SCRIPT WILL NEVER GENERATE A RESPONSE") ||
    text.includes("WORKER INVOCATION") ||
    text.includes("INVOCATION LIMIT")
  );
}

export function isPayloadLimitError(error) {
  if (!error) return false;
  const status = error.status || error.statusCode || error.response?.status;
  if (status === 413) return true;

  const text = collectErrorText(error).join(" ").toUpperCase();
  return text.includes("PAYLOAD TOO LARGE") || text.includes("REQUEST BODY TOO LARGE") || text.includes("BODY SIZE LIMIT");
}

export function isTemporaryUpstreamLimitError(error) {
  if (!error) return false;
  const status = error.status || error.statusCode || error.response?.status;
  if ([408, 425, 429, 502, 503, 504, 509].includes(Number(status))) return true;

  const text = collectErrorText(error).join(" ").toUpperCase();
  return (
    text.includes("RATE_LIMIT") ||
    text.includes("RATE LIMIT") ||
    text.includes("TOO MANY REQUESTS") ||
    text.includes("THROTTL") ||
    text.includes("SLOWDOWN") ||
    text.includes("SERVICE UNAVAILABLE") ||
    text.includes("UPSTREAM TIMEOUT") ||
    text.includes("ETIMEDOUT")
  );
}

export function assertNoInvocationLimitResult(result, operation, path) {
  if (!result || typeof result !== "object") return;
  if (
    result.invocationLimitReached === true ||
    result.details?.invocationLimitReached === true ||
    result.stats?.invocationLimitReached === true ||
    isInvocationLimitError(result)
  ) {
    throw new InvocationLimitError(`${operation} hit Worker invocation limit`, {
      operation,
      path,
      result,
    });
  }
}
