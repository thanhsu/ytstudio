import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateScript } from "../src/script.ts";
import type { LlmProvider } from "../src/llm/types.ts";

async function withProject<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-script-"));
  try {
    process.chdir(root);
    await mkdir(join("projects", "sample-project"), { recursive: true });
    await writeFile(
      join("projects", "sample-project", "brief.json"),
      JSON.stringify({
        id: "sample-project",
        topic: "Why Qin Mu is different",
        show: "Tales of Herding Gods",
        format: "shorts",
        audience: "EU donghua viewers",
        language: "English",
        notes: "",
        createdAt: "2026-08-22T00:00:00.000Z",
      }),
      "utf8",
    );
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

function stubProvider(): LlmProvider {
  return {
    name: "stub",
    async generate(request) {
      return {
        provider: "stub",
        model: "stub-model",
        script: "# Stub\n\n## Hook\n\nDistinct commentary.",
        metadata: {
          projectId: request.projectId,
          titles: ["Stub title"],
          description: "Stub description.",
          hashtags: ["#stub"],
          pinnedComment: "Stub question?",
        },
        scenePlan: {
          projectId: request.projectId,
          scenes: [{ label: "Hook", durationSeconds: 8, purpose: "Open.", visualDirection: "Card." }],
        },
      };
    },
  };
}

test("generation writes the script, metadata, and scene plan together", async () => {
  await withProject(async () => {
    await generateScript("sample-project", { provider: stubProvider() });

    assert.match(await readFile(join("projects", "sample-project", "script.md"), "utf8"), /Distinct commentary/);
    const metadata = JSON.parse(await readFile(join("projects", "sample-project", "metadata.json"), "utf8"));
    assert.deepEqual(metadata.titles, ["Stub title"]);
    assert.deepEqual(metadata.generator, { provider: "stub", model: "stub-model" });
    const scenePlan = JSON.parse(await readFile(join("projects", "sample-project", "scene-plan.json"), "utf8"));
    assert.equal(scenePlan.scenes[0].durationSeconds, 8);
  });
});

test("a provider failure writes nothing and surfaces the reason", async () => {
  await withProject(async () => {
    const failing: LlmProvider = {
      name: "failing",
      async generate() {
        throw new Error("Could not reach the model server at http://127.0.0.1:11434/v1/chat/completions");
      },
    };

    await assert.rejects(() => generateScript("sample-project", { provider: failing }), /11434/);
    await assert.rejects(() => stat(join("projects", "sample-project", "script.md")), /ENOENT/);
  });
});

test("the metadata records which provider and model produced the script", async () => {
  await withProject(async () => {
    const result = await generateScript("sample-project", { provider: stubProvider() });

    assert.deepEqual(result.metadata.generator, { provider: "stub", model: "stub-model" });

    // Repointing the studio at a different model must not relabel the script
    // that is already on disk.
    await writeFile(
      "studio.config.json",
      JSON.stringify({ script: { provider: "openai-compatible", model: "qwen2.5:14b" } }),
      "utf8",
    );

    const persisted = JSON.parse(await readFile(join("projects", "sample-project", "metadata.json"), "utf8"));
    assert.deepEqual(persisted.generator, { provider: "stub", model: "stub-model" });
  });
});
