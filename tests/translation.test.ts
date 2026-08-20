import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTranslationDraft, buildTranslationPrompt, importSubtitle, validateTranslation } from "../src/translation.ts";

const SOURCE = `1
00:00:00,000 --> 00:00:01,000
你是谁？

2
00:00:01,100 --> 00:00:02,000
我是秦牧。
`;

test("builds translation prompt with SRT preservation rules", () => {
  const prompt = buildTranslationPrompt({
    target: "en-au",
    genre: "cultivation",
    sourceName: "sample.srt",
    srtContent: SOURCE,
    glossary: { "秦牧": "Qin Mu" },
  });

  assert.match(prompt, /Australian English/);
  assert.match(prompt, /Keep every timestamp exactly unchanged/);
  assert.match(prompt, /秦牧 = Qin Mu/);
});

test("validates translated SRT structure and Chinese leftovers", () => {
  const result = validateTranslation(
    SOURCE,
    `1
00:00:00,000 --> 00:00:01,000
Who are you?

2
00:00:01,100 --> 00:00:02,000
我是 Qin Mu.
`,
  );

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /Chinese characters/);
});

test("imports subtitle and creates project prompt draft", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-translation-"));

  try {
    process.chdir(root);
    await mkdir("input", { recursive: true });
    await writeFile(join("input", "source.srt"), SOURCE, "utf8");

    const imported = await importSubtitle("sample-project", join("input", "source.srt"));
    const draft = await buildTranslationDraft("sample-project", imported.relativePath, "vi", "fantasy-system");

    assert.equal(imported.cueCount, 2);
    assert.match(imported.relativePath, /^workspace\/subtitles\/source-/);
    assert.equal(draft.cueCount, 2);
    assert.equal(draft.promptPath, "workspace/translation/vi-fantasy-system-prompt.md");
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
