import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isTransientSearchFailure, searchSourceMetadata } from "../src/sources/yt-dlp.ts";
import { makeFakeExecutable } from "./helpers.ts";

const RESULT = JSON.stringify({ extractor_key: "BiliBili", id: "BV1abc", title: "牧神记" });

/**
 * A fake yt-dlp that fails the first `failures` invocations the way Bilibili
 * really does, then succeeds. The counter lives in a file because each
 * invocation is its own process.
 */
async function flakyYtDlp(failures: number, message = "ERROR: Unable to download JSON metadata: HTTP Error 412: Precondition Failed") {
  const counter = join(await mkdtemp(join(tmpdir(), "yt-flaky-")), "count.txt");
  await writeFile(counter, "0", "utf8");
  const executable = await makeFakeExecutable(
    [
      'import { readFile, writeFile } from "node:fs/promises";',
      `const counter = ${JSON.stringify(counter)};`,
      'const attempts = Number(await readFile(counter, "utf8")) + 1;',
      'await writeFile(counter, String(attempts), "utf8");',
      `if (attempts <= ${failures}) { console.error(${JSON.stringify(message)}); process.exit(1); }`,
      `console.log(${JSON.stringify(RESULT)});`,
    ].join("\n"),
  );
  return { executable, attempts: async () => Number(await readFile(counter, "utf8")) };
}

function searchOptions(executable: string, overrides: Record<string, unknown> = {}) {
  return {
    platform: "bilibili" as const,
    limit: 2,
    ytDlpPath: process.execPath,
    ytDlpArgs: [executable],
    searchPrefixes: { bilibili: "bilisearch" },
    retryDelayMs: 0,
    ...overrides,
  };
}

test("a transient 412 is retried rather than failing the whole search", async () => {
  const fake = await flakyYtDlp(1);

  const results = await searchSourceMetadata("牧神记", searchOptions(fake.executable));

  assert.equal(results.length, 1);
  assert.equal(await fake.attempts(), 2);
});

test("retries stop at the configured attempt count and report the upstream reason", async () => {
  const fake = await flakyYtDlp(99);

  await assert.rejects(
    () => searchSourceMetadata("牧神记", searchOptions(fake.executable, { retries: 2 })),
    (error: unknown) => /412/.test(String(error)) && /3 attempts/.test(String(error)),
  );
  assert.equal(await fake.attempts(), 3);
});

test("a failure that will not change is not retried", async () => {
  const fake = await flakyYtDlp(99, "ERROR: Unsupported URL: bilisearch2:whatever");

  await assert.rejects(() => searchSourceMetadata("whatever", searchOptions(fake.executable)));

  assert.equal(await fake.attempts(), 1);
});

test("transient failures are recognised by what upstream actually returns", () => {
  assert.equal(isTransientSearchFailure("HTTP Error 412: Precondition Failed"), true);
  assert.equal(isTransientSearchFailure("HTTP Error 429: Too Many Requests"), true);
  assert.equal(isTransientSearchFailure("HTTP Error 503: Service Unavailable"), true);
  assert.equal(isTransientSearchFailure("Read timed out"), true);
  assert.equal(isTransientSearchFailure("The read operation timed out"), true);

  assert.equal(isTransientSearchFailure("Unsupported URL"), false);
  assert.equal(isTransientSearchFailure("HTTP Error 404: Not Found"), false);
  assert.equal(isTransientSearchFailure("Sign in to confirm your age"), false);
});

test("an abort during a retry pause stops immediately", async () => {
  const fake = await flakyYtDlp(99);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => searchSourceMetadata("牧神记", searchOptions(fake.executable, { signal: controller.signal, retryDelayMs: 5000 })),
  );
  assert.ok((await fake.attempts()) <= 1);
});
