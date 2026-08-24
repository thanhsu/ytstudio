import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildIdeaMessages } from "../src/story-factory/prompts/idea.ts";
import { buildSectionMessages } from "../src/story-factory/prompts/sections.ts";
import {
  loadPromptOverrides,
  PROMPT_CATALOG,
  resolvePromptSystem,
  savePromptOverride,
} from "../src/story-factory/prompt-overrides.ts";
import type { StoryPromptContext } from "../src/story-factory/prompts/context.ts";

const context: StoryPromptContext = {
  language: "en",
  locale: "en-AU",
  niche: "horror",
  subNiche: "urban legends",
  tone: "quiet and cinematic",
  promptStyle: "natural narration",
  targetDurationMinutes: 10,
};

test("default idea and section prompts retain their current system wording", () => {
  const idea = buildIdeaMessages(context, { avoidPremises: ["old premise"] });
  const section = buildSectionMessages(context, {
    sectionIndex: 1,
    sectionCount: 2,
    title: "The station",
    goal: "Open the mystery",
    beats: ["A late train", "An empty platform"],
    targetWords: 500,
    bibleContext: "Setting: station",
    previousTail: "",
    hookText: "The train arrived without a driver.",
  });

  assert.match(idea[0].content, /You are the idea generator for an original audio-story channel\./);
  assert.match(idea[0].content, /House style: natural narration/);
  assert.match(idea[0].content, /Fields:\n- "logline"/);
  assert.match(section[0].content, /You write one section of a long-form audio story\./);
  assert.match(section[0].content, /House style: natural narration/);
  assert.match(section[0].content, /Fields:\n- "title"/);
});

test("an override replaces the system and receives a hash-bound custom version", () => {
  const resolved = resolvePromptSystem(
    { version: 1, entries: { "story.idea": { system: "Custom {{context}} {{jsonRule}}", updatedAt: "now" } } },
    "story.idea",
    "Default {{context}} {{jsonRule}}",
    "idea-v1",
    { context: "CTX", jsonRule: "JSON" },
  );
  assert.equal(resolved.system, "Custom CTX JSON");
  assert.match(resolved.version, /^idea-v1\+custom\.[a-f0-9]{8}$/);
  const messages = buildIdeaMessages(
    context,
    { avoidPremises: [] },
    { version: 1, entries: { "story.idea": { system: "OVERRIDE {{context}} {{jsonRule}}", updatedAt: "now" } } },
  );
  assert.match(messages[0].content, /^OVERRIDE Channel context:/);
});

test("saving an unknown variable is rejected and an empty override deletes it", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-prompt-overrides-"));
  try {
    process.chdir(root);
    await assert.rejects(() => savePromptOverride("channel-demo", "story.idea", "Bad {{unknown}}"), /unknown variable/i);
    const saved = await savePromptOverride("channel-demo", "story.idea", "Custom {{context}} {{jsonRule}}");
    assert.equal(saved.entries["story.idea"]?.system, "Custom {{context}} {{jsonRule}}");
    const deleted = await savePromptOverride("channel-demo", "story.idea", "   ");
    assert.equal(deleted.entries["story.idea"], undefined);
    assert.deepEqual(await loadPromptOverrides("channel-demo"), { version: 1, entries: {} });
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("prompt catalog lists all ten editable prompt definitions with variables", () => {
  assert.equal(PROMPT_CATALOG.length, 10);
  assert.equal(new Set(PROMPT_CATALOG.map((entry) => entry.name)).size, 10);
  for (const entry of PROMPT_CATALOG) {
    assert.ok(entry.template.trim());
    assert.ok(entry.variables.length > 0);
  }
});
