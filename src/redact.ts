const CREDENTIAL_PATTERN =
  /(authorization|api[_-]?key|token)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^"'\s]+/gi;

// Providers frequently echo the offending key in plain prose ("Incorrect API
// key provided: sk-proj-...") with no colon/equals separator next to a
// recognizable keyword, so a bare secret-shaped token is stripped on its own.
const SECRET_LOOKING_PATTERN = /sk-[A-Za-z0-9_-]{8,}/g;

/**
 * Scrubs credential-shaped substrings from arbitrary upstream text (an error
 * body, a log line) before it is included in a thrown error. Shared by every
 * provider adapter that forwards a bearer key to an HTTP API, so a fix here
 * covers all of them at once.
 */
export function redact(value: string): string {
  return value
    .replace(CREDENTIAL_PATTERN, "$1$2[redacted]")
    .replace(SECRET_LOOKING_PATTERN, "[redacted]");
}
