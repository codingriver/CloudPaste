const DEFAULT_RETRY_POLICY = {
  limit: 3,
  delay: 2e3,
  backoff: "exponential"
};
const MAX_BACKOFF_DELAY = 6e4;
const RETRYABLE_PATTERNS = [
  "TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ECONNABORTED",
  "ENETRESET",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "THROTTL",
  "TEMPORARILY",
  "UNAVAILABLE",
  "OVERLOAD",
  "RATE_LIMIT",
  "TOO_MANY",
  "BUSY",
  "RETRY",
  "NETWORK",
  "SOCKET",
  "CONNECTION",
  "DNS",
  "SLOWDOWN",
  "INTERNAL_ERROR",
  "SERVICE_EXCEPTION",
  "REQUEST_TIMEOUT",
  "OPERATION_ABORTED"
];
const NON_RETRYABLE_STATUS_CODES = [
  400,
  401,
  403,
  404,
  405,
  409,
  410,
  413,
  415,
  422
];
const RETRYABLE_STATUS_CODES = [
  408,
  425,
  429,
  500,
  502,
  503,
  504,
  507,
  509
];
function collectErrorMessages(error, seen = /* @__PURE__ */ new Set()) {
  if (!error || seen.has(error)) {
    return [];
  }
  seen.add(error);
  const messages = [];
  const append = (value) => {
    if (typeof value === "string" && value.trim()) {
      messages.push(value);
    }
  };
  append(error?.message);
  append(error?.details?.cause);
  append(error?.details?.message);
  return [
    ...messages,
    ...collectErrorMessages(error?.cause, seen),
    ...collectErrorMessages(error?.originalError, seen)
  ];
}
function isRetryableError(error) {
  if (!error) return false;
  const rawMessages = collectErrorMessages(error).join(" ").toUpperCase();
  if (rawMessages.includes("TOO MANY API REQUESTS BY SINGLE WORKER INVOCATION") || rawMessages.includes("TOO MANY SUBREQUESTS BY SINGLE WORKER INVOCATION") || rawMessages.includes("SUBREQUESTS BY SINGLE WORKER INVOCATION")) {
    return false;
  }
  if (typeof error.retryable === "boolean") {
    return error.retryable;
  }
  const status = error?.status || error?.statusCode || error?.response?.status;
  if (typeof status === "number") {
    if (NON_RETRYABLE_STATUS_CODES.includes(status)) {
      return false;
    }
    if (RETRYABLE_STATUS_CODES.includes(status)) {
      return true;
    }
  }
  const code = String(error?.code || "").toUpperCase();
  if (code && RETRYABLE_PATTERNS.some((pattern) => code.includes(pattern))) {
    return true;
  }
  const message = String(error?.message || "").toUpperCase();
  if (message && RETRYABLE_PATTERNS.some((pattern) => message.includes(pattern))) {
    return true;
  }
  const cause = error?.cause || error?.originalError || error?.details?.cause;
  if (cause && cause !== error) {
    return isRetryableError(cause);
  }
  return false;
}
function calculateBackoffDelay(attempt, policy) {
  const { delay, backoff } = policy;
  let calculatedDelay;
  if (backoff === "exponential") {
    calculatedDelay = delay * Math.pow(2, attempt - 1);
  } else {
    calculatedDelay = delay * attempt;
  }
  const jitter = calculatedDelay * 0.1 * (Math.random() * 2 - 1);
  calculatedDelay = Math.round(calculatedDelay + jitter);
  return Math.min(calculatedDelay, MAX_BACKOFF_DELAY);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function formatRetryLog(attempt, maxRetries, delay, path, error) {
  const delayStr = delay >= 1e3 ? `${(delay / 1e3).toFixed(1)}s` : `${delay}ms`;
  const errorStr = error ? ` - ${error}` : "";
  return `[\u91CD\u8BD5 ${attempt}/${maxRetries}] ${path}, \u5EF6\u8FDF ${delayStr}${errorStr}`;
}
export {
  DEFAULT_RETRY_POLICY,
  calculateBackoffDelay,
  formatRetryLog,
  isRetryableError,
  sleep
};
