import assert from "node:assert/strict";
import test from "node:test";
import { normalizeYouTubeError } from "../src/youtube/errors.ts";

test("normalizes network errors as retryable without exposing provider text", () => {
  const result = normalizeYouTubeError(new Error("socket failed with token=sk-secret-value"));
  assert.equal(result.code, "youtube-upload-failed");
  assert.equal(result.retryable, true);
  assert.doesNotMatch(result.message, /sk-secret-value/);
});

test("maps quotaExceeded to a non-retryable quota error", () => {
  const result = normalizeYouTubeError({ response: { status: 403, body: JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }) } });
  assert.deepEqual(result, {
    code: "youtube-quota-exceeded",
    message: "YouTube quota has been exceeded. Retry after the quota resets.",
    retryable: false,
    action: "retry-after-quota-reset",
  });
});

test("maps uploadLimitExceeded and redacts provider response bodies", () => {
  const result = normalizeYouTubeError({ response: { status: 403, body: "uploadLimitExceeded secret=sk-secret-value" } });
  assert.equal(result.code, "youtube-quota-exceeded");
  assert.equal(result.retryable, false);
  assert.doesNotMatch(result.message, /uploadLimitExceeded|sk-secret-value/);
});
