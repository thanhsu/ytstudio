import assert from "node:assert/strict";
import test from "node:test";
import { redact } from "../src/redact.ts";

test("strips a bearer token following an Authorization header", () => {
  const result = redact("Authorization: Bearer sk-live-ABC123");

  assert.doesNotMatch(result, /sk-live-ABC123/);
  assert.doesNotMatch(result, /Bearer/);
  assert.match(result, /Authorization/);
});

test("strips a key echoed in provider prose with no colon separator", () => {
  const result = redact("Incorrect API key provided: sk-proj-XYZ789ABC");

  assert.doesNotMatch(result, /sk-proj-XYZ789ABC/);
});

test("strips a key value in a JSON body", () => {
  const result = redact('{"api_key":"sk-abcdefgh12345"}');

  assert.doesNotMatch(result, /sk-abcdefgh12345/);
  assert.match(result, /api_key/);
});

test("leaves text without credential-shaped content unchanged", () => {
  const result = redact("upstream failure: rate limited, try again later");

  assert.equal(result, "upstream failure: rate limited, try again later");
});
