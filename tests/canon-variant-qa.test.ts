import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_STUDIO_CONFIG, type StudioConfig } from "../src/config.ts";
import type { ChatMessage, ChatResult, OpenAiCompatibleConfig } from "../src/llm/chat.ts";
import { loadStoryChannel, saveStoryChannel } from "../src/story-factory/channel.ts";
import { upsertStoryFingerprints } from "../src/story-factory/fingerprint-index.ts";
import { minhashSignature } from "../src/story-factory/fingerprint.ts";
import { runOriginalityStage } from "../src/story-factory/stages/originality-qa.ts";
import type { StageContext } from "../src/story-factory/stages/context.ts";
import { createStory, loadStory, readStageArtifact, writeStageArtifact } from "../src/story-factory/story-project.ts";
import type { IdeaArtifact, NaturalizedScript, OriginalityReport } from "../src/story-factory/types.ts";

/**
 * A localization variant is one chapter of a serial with a fixed cast and
 * setting. It is SUPPOSED to resemble its siblings, so duplicate detection has
 * to exclude them — and because gateQaPassed("script") reads this verdict,
 * getting it wrong silently stops assisted mode across a whole series.
 */

const CHANNEL = "horror-es";
const SERIES = "missing-floor";

// Two near-identical chapters of one serial: the case that must NOT flag.
const SIBLING_TEXT =
  "El ascensor se abrió a las tres y diecisiete. María esperó en el vestíbulo del hotel mientras las puertas de latón se cerraban sobre un piso que no existía. El registro perdió otro nombre esa noche.";
const THIS_TEXT =
  "El ascensor se abrió a las tres y diecisiete. María esperó en el vestíbulo del hotel mientras las puertas de latón se cerraban sobre un piso que no existía. El registro perdió un nombre más esa noche.";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-variant-qa-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

function config(): StudioConfig {
  const base = structuredClone(DEFAULT_STUDIO_CONFIG);
  const endpoint = { ...base.storyFactory.models.planner, model: "test-model" };
  base.storyFactory.models = {
    planner: endpoint, writer: endpoint, qa: endpoint,
    architect: endpoint, localizer: endpoint, memory: endpoint,
  };
  return base;
}

const passingChat = async (
  _config: OpenAiCompatibleConfig,
  _messages: ChatMessage[],
): Promise<ChatResult> => ({
  content: JSON.stringify({ score: 0.9, issues: [], safetyIssues: [], publishable: true }),
  usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
});

async function seedStory(id: string, options: { canon: boolean }): Promise<void> {
  const channel = await loadStoryChannel(CHANNEL);
  await createStory(channel, {
    id,
    title: id,
    ...(options.canon
      ? {
          kind: "variant" as const,
          canonRef: { seriesId: SERIES, chapterId: "chapter-002", chapterNumber: 2, canonTextHash: "hash-2" },
        }
      : {}),
  });
  const idea: IdeaArtifact = {
    version: 1,
    logline: "A hotel elevator that opens onto a floor that does not exist.",
    premise: "A night auditor watches guests vanish.",
    themes: ["horror"],
    whyItWorks: "",
    duplicateCheck: { checkedAgainst: 0, nearest: [], flagged: false },
    provenance: { provider: "t", model: "t", promptVersion: "v1", generatedAt: "2026-08-25T00:00:00.000Z" },
  };
  const naturalized: NaturalizedScript = {
    version: 1,
    fullText: THIS_TEXT,
    sections: [{ index: 1, text: THIS_TEXT }],
    changes: [],
    locale: "es-MX",
    provenance: idea.provenance,
  };
  await writeStageArtifact(CHANNEL, id, "idea", idea);
  await writeStageArtifact(CHANNEL, id, "naturalize", naturalized);
}

async function contextFor(storyId: string): Promise<StageContext> {
  return {
    channelId: CHANNEL,
    storyId,
    channel: await loadStoryChannel(CHANNEL),
    story: await loadStory(CHANNEL, storyId),
    config: config(),
    chat: passingChat,
    confirmedPaidRequest: true,
  };
}

test("a variant is not flagged as a duplicate of its own series' other chapters", async () => {
  await withTempCwd(async () => {
    await saveStoryChannel(CHANNEL, { language: "es", locale: "es-MX", canonSeriesId: SERIES });

    // A sibling variant of the SAME canon series, already fingerprinted.
    await seedStory("chapter-001-es-mx", { canon: true });
    await upsertStoryFingerprints(CHANNEL, {
      version: 1,
      storyId: "chapter-001-es-mx",
      title: "Chapter 1",
      logline: "sibling",
      ideaSignature: minhashSignature("sibling idea"),
      scriptSignature: minhashSignature(SIBLING_TEXT),
    });

    await seedStory("chapter-002-es-mx", { canon: true });
    await runOriginalityStage(await contextFor("chapter-002-es-mx"));

    const report = await readStageArtifact<OriginalityReport>(CHANNEL, "chapter-002-es-mx", "originality-qa");
    assert.equal(report?.publishable, true, "a serial chapter must not be blocked for resembling its own series");
    assert.equal(
      report?.similarity.some((entry) => entry.storyId === "chapter-001-es-mx"),
      false,
      "a sibling of the same canon series is not a duplicate candidate at all",
    );
  });
});

test("an unrelated near-identical story on the same channel still flags", async () => {
  await withTempCwd(async () => {
    await saveStoryChannel(CHANNEL, { language: "es", locale: "es-MX", canonSeriesId: SERIES });

    // Not a variant of this series — the check's real job is intact.
    await upsertStoryFingerprints(CHANNEL, {
      version: 1,
      storyId: "some-other-story",
      title: "Other",
      logline: "other",
      ideaSignature: minhashSignature("other idea"),
      scriptSignature: minhashSignature(SIBLING_TEXT),
    });

    await seedStory("chapter-002-es-mx", { canon: true });
    const ctx = await contextFor("chapter-002-es-mx");
    await assert.rejects(() => runOriginalityStage(ctx), /too similar|Originality/i);

    const report = await readStageArtifact<OriginalityReport>(CHANNEL, "chapter-002-es-mx", "originality-qa");
    assert.equal(report?.publishable, false);
    assert.equal(report?.similarity[0]?.storyId, "some-other-story");
  });
});

test("an ordinary story is unaffected: every other story stays a candidate", async () => {
  await withTempCwd(async () => {
    await saveStoryChannel(CHANNEL, { language: "es", locale: "es-MX" });
    await seedStory("plain-002", { canon: false });
    await upsertStoryFingerprints(CHANNEL, {
      version: 1,
      storyId: "plain-001",
      title: "Plain 1",
      logline: "plain",
      ideaSignature: minhashSignature("plain idea"),
      // Deliberately unrelated text, so it does not trip the threshold.
      scriptSignature: minhashSignature("Una historia completamente distinta sobre un faro y un perro."),
    });

    await runOriginalityStage(await contextFor("plain-002"));
    const report = await readStageArtifact<OriginalityReport>(CHANNEL, "plain-002", "originality-qa");
    assert.equal(report?.publishable, true);
    assert.equal(
      report?.similarity.some((entry) => entry.storyId === "plain-001"),
      true,
      "with no canonRef nothing is excluded; the check behaves exactly as before",
    );
  });
});
