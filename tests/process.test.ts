import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

test("stdout lines stream to the caller while the process is still running", async () => {
  // The child announces readiness, then waits for the parent to drop a file it
  // can only drop after receiving that line live. Buffered-until-exit stdout
  // would deadlock, so the child gives up after 5s and fails the run.
  const executable = await makeFakeExecutable(`
import { access } from "node:fs/promises";
import { join } from "node:path";
const flag = process.argv[2];
console.log("ready");
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  try { await access(flag); console.log("released"); process.exit(0); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 25));
}
process.exit(1);
`);
  const flag = join(dirname(executable), "release.flag");
  const seen: string[] = [];
  const result = await runProcess(process.execPath, [executable, flag], {
    onStdoutLine: (line) => {
      seen.push(line);
      if (line === "ready") void writeFile(flag, "go", "utf8");
    },
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(seen, ["ready", "released"]);
  assert.match(result.stdout, /ready/);
});
