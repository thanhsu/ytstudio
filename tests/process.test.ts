import assert from "node:assert/strict";
import test from "node:test";
import { runProcess, ProcessError } from "../src/process.ts";
import { makeFakeExecutable } from "./helpers.ts";

test("process runner preserves argument boundaries", async () => {
  const executable = await makeFakeExecutable(`console.log(JSON.stringify(process.argv.slice(2)))`);
  const result = await runProcess(process.execPath, [executable, "one value", "& unsafe"]);

  assert.deepEqual(JSON.parse(result.stdout.trim()), ["one value", "& unsafe"]);
});

test("process runner rejects non-zero exits with sanitized stderr", async () => {
  const executable = await makeFakeExecutable(`console.error("Authorization: Bearer secret-token"); process.exit(2);`);

  await assert.rejects(
    () => runProcess(process.execPath, [executable]),
    (error) =>
      error instanceof ProcessError &&
      error.exitCode === 2 &&
      error.stderr.includes("[redacted]") &&
      !error.stderr.includes("secret-token"),
  );
});
