import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

type CliResult = { code: number; stdout: string; stderr: string };

// The CLI is a process boundary: the only honest way to prove a flag is wired is
// to run it. Every case below fails before any request leaves the machine.
function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI_PATH, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}

async function withPaidScriptProject<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "yt-cli-"));
  try {
    await mkdir(join(root, "projects", "sample-project"), { recursive: true });
    await writeFile(
      join(root, "projects", "sample-project", "brief.json"),
      JSON.stringify({
        id: "sample-project",
        topic: "Why Qin Mu feels different",
        show: "Tales of Herding Gods",
        format: "shorts",
        audience: "EU donghua viewers",
        language: "English",
        notes: "",
        createdAt: "2026-08-22T00:00:00.000Z",
      }),
      "utf8",
    );
    await writeFile(
      join(root, "studio.config.json"),
      JSON.stringify({
        script: {
          provider: "openai-compatible",
          model: "gpt-4o-mini",
          baseUrl: "https://api.example.invalid/v1",
          apiKeyEnv: "YT_TEST_SCRIPT_KEY_THAT_IS_NOT_SET",
          paid: true,
        },
      }),
      "utf8",
    );
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the help text documents the paid confirmation flag for generate-script", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-cli-help-"));
  try {
    const result = await runCli(["help"], root);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /generate-script --project <id> \[--confirm-paid true\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generate-script refuses a paid model without the confirmation flag", async () => {
  await withPaidScriptProject(async (root) => {
    const result = await runCli(["generate-script", "--project", "sample-project"], root);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /confirmed paid request/i);
  });
});

test("--confirm-paid satisfies the paid gate rather than leaving it unsatisfiable", async () => {
  await withPaidScriptProject(async (root) => {
    const result = await runCli(
      ["generate-script", "--project", "sample-project", "--confirm-paid", "true"],
      root,
    );

    // The gate is past; the next stop is the missing key, still before any request.
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /confirmed paid request/i);
    assert.match(result.stderr, /api key/i);
  });
});
