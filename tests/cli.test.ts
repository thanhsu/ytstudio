import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    assert.match(result.stdout, /create-edit-manifest --project <id> --source <project-relative-srt> \[--replace true\]/);
    assert.match(result.stdout, /apply-remove-list --project <id> --remove <cue-selection>/);
    assert.match(result.stdout, /export-edit-manifest --project <id>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit manifest commands create decisions and export clean subtitles", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-cli-edit-"));
  try {
    const subtitleDir = join(root, "projects", "sample-project", "workspace", "subtitles");
    await mkdir(subtitleDir, { recursive: true });
    await writeFile(
      join(subtitleDir, "source.srt"),
      "1\n00:00:00,000 --> 00:00:01,000\nKeep\n\n2\n00:00:01,100 --> 00:00:02,000\nRemove\n",
      "utf8",
    );

    const created = await runCli(
      ["create-edit-manifest", "--project", "sample-project", "--source", "workspace/subtitles/source.srt"],
      root,
    );
    assert.equal(created.code, 0);
    assert.match(created.stdout, /Created edit manifest.*2 cues/);

    const updated = await runCli(
      ["apply-remove-list", "--project", "sample-project", "--remove", "2"],
      root,
    );
    assert.equal(updated.code, 0);
    assert.match(updated.stdout, /1 removed cue/);

    const exported = await runCli(["export-edit-manifest", "--project", "sample-project"], root);
    assert.equal(exported.code, 0);
    assert.match(exported.stdout, /workspace\/edit\/clean\.srt/);
    assert.match(await readFile(join(root, "projects", "sample-project", "workspace", "edit", "clean.srt"), "utf8"), /Keep/);

    const refused = await runCli(
      ["create-edit-manifest", "--project", "sample-project", "--source", "workspace/subtitles/source.srt"],
      root,
    );
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already exists/i);

    const replaced = await runCli(
      ["create-edit-manifest", "--project", "sample-project", "--source", "workspace/subtitles/source.srt", "--replace", "true"],
      root,
    );
    assert.equal(replaced.code, 0);
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
