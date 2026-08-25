import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256 } from "../project-state.ts";
import { loadStoryChannel } from "../story-factory/channel.ts";
import { storyPath, storyRelativePath } from "../story-factory/paths.ts";
import {
  createStory,
  listStories,
  loadStory,
  readStageArtifact,
  saveStageRun,
  saveStory,
  writeStageArtifact,
} from "../story-factory/story-project.ts";
import type {
  BibleArtifact,
  HookArtifact,
  IdeaArtifact,
  SceneList,
  StoryProject,
} from "../story-factory/types.ts";
import { loadBible, loadCharacters } from "./entities.ts";
import { chapterNumberFrom, loadCanonSeries } from "./series.ts";
import { isNotFound } from "./store.ts";
import type { CanonChapterArtifact } from "./types.ts";

/**
 * Creating a localized publication variant from an approved canon chapter.
 *
 * Four existing stages hard-require artifacts a variant has no way to produce:
 * `metadata` and `originality-qa` need `idea`/`hook`, `scenes` needs `bible`,
 * and `final-qa` needs an originality verdict. Rather than branch four stages
 * on story kind, this PROJECTS the canon chapter into those artifacts once, at
 * creation. Every one of those stages then runs completely unmodified, which is
 * the difference between a variant costing one stage and costing a fork of the
 * whole pipeline.
 */

/** A canon chapter's directory, read from another project. */
export function canonChapterPath(seriesId: string, chapterId: string, ...segments: string[]): string {
  return storyPath(seriesId, chapterId, ...segments);
}

export class CanonChapterNotApprovedError extends Error {
  readonly missing: string;

  constructor(chapterId: string, missing: string) {
    super(`Canon chapter ${chapterId} is not ready to publish: ${missing}.`);
    this.name = "CanonChapterNotApprovedError";
    this.missing = missing;
  }
}

export type CreateVariantInput = {
  seriesId: string;
  chapterId: string;
  /** The publication channel; must be a different project from the series. */
  channelId: string;
  /** Defaults to `<chapterId>-<locale>`, lowercased. */
  storyId?: string;
};

export async function createPublicationVariant(input: CreateVariantInput): Promise<StoryProject> {
  const series = await loadCanonSeries(input.seriesId);
  if (!series) {
    throw new Error(`Project ${input.seriesId} is not a canon series.`);
  }
  const chapterNumber = chapterNumberFrom(input.chapterId);
  if (chapterNumber === null) {
    throw new Error(`${input.chapterId} is not a canon chapter id.`);
  }

  const chapterStory = await loadStory(input.seriesId, input.chapterId);
  // Only an approved chapter may be published. Without this, a draft could be
  // localized into four languages and uploaded before anyone read it.
  if (chapterStory.approvals.canon === undefined) {
    throw new CanonChapterNotApprovedError(input.chapterId, "it has no canon approval");
  }
  const chapter = await readStageArtifact<CanonChapterArtifact>(input.seriesId, input.chapterId, "canon-write");
  if (!chapter?.canonicalText?.trim()) {
    throw new CanonChapterNotApprovedError(input.chapterId, "it has no canonical text");
  }
  const anchor = chapterStory.stages["canon-write"];
  if (!anchor?.artifactHash || anchor.artifactHash !== chapterStory.approvals.canon.artifactHash) {
    throw new CanonChapterNotApprovedError(input.chapterId, "its canon approval is stale");
  }

  const channel = await loadStoryChannel(input.channelId);
  const storyId = (input.storyId ?? `${input.chapterId}-${channel.locale}`).toLowerCase();

  const variant = await createStory(channel, {
    id: storyId,
    title: chapter.title,
    kind: "variant",
    canonRef: {
      seriesId: input.seriesId,
      chapterId: input.chapterId,
      chapterNumber,
      canonTextHash: chapter.canonTextHash,
    },
  });

  await projectCanonArtifacts(input.seriesId, input.chapterId, variant, chapter, series.genre);
  return loadStory(input.channelId, storyId);
}

/**
 * Write the artifacts the untouched downstream stages expect. These are
 * projections of canon, not generated content — no model is called.
 */
async function projectCanonArtifacts(
  seriesId: string,
  chapterId: string,
  variant: StoryProject,
  chapter: CanonChapterArtifact,
  genre: string,
): Promise<void> {
  const [bible, characters] = await Promise.all([loadBible(seriesId), loadCharacters(seriesId)]);
  const provenance = {
    provider: "canon",
    model: `canon:${seriesId}/${chapterId}`,
    promptVersion: "projection-v1",
    generatedAt: new Date().toISOString(),
  };

  const idea: IdeaArtifact = {
    version: 1,
    logline: chapter.summary,
    premise: bible.premise || chapter.summary,
    themes: [genre, ...bible.worldRules.slice(0, 3).map((rule) => rule.text)].filter(Boolean),
    whyItWorks: `Chapter ${chapter.chapterNumber} of the canon series.`,
    // Duplicate detection is meaningless for a variant: it is SUPPOSED to
    // match its own series. originality-qa excludes same-series stories.
    duplicateCheck: { checkedAgainst: 0, nearest: [], flagged: false },
    provenance,
  };
  await writeStageArtifact(variant.channelId, variant.id, "idea", idea);

  const opening = chapter.canonicalText.split(/\n{2,}/)[0]?.trim() ?? "";
  const hook: HookArtifact = {
    version: 1,
    hookText: opening.slice(0, 600),
    altHooks: [],
    estimatedSeconds: 30,
    provenance,
  };
  await writeStageArtifact(variant.channelId, variant.id, "hook", hook);

  await writeProjectedBible(seriesId, variant.channelId, variant.id);

  // The canon scene plan and its rendered images are shared across every
  // locale: the same chapter, so the same pictures. Only the narration differs.
  const scenes = await readStageArtifact<SceneList>(seriesId, chapterId, "scenes");
  if (scenes) {
    await writeStageArtifact(variant.channelId, variant.id, "scenes", scenes);
    await saveStageRun(variant.channelId, variant.id, "scenes", {
      status: "done",
      finishedAt: new Date().toISOString(),
    });
  }

  // Mark the projected stages done so the pipeline does not try to regenerate
  // them; they are inputs, not work to be performed.
  for (const stage of ["idea", "hook", "bible"] as const) {
    await saveStageRun(variant.channelId, variant.id, stage, {
      status: "done",
      finishedAt: new Date().toISOString(),
    });
  }
}

/**
 * Copy a canon chapter's rendered scene image into a variant, if one exists.
 * Cross-project PATHS are impossible — resolveProjectPath refuses anything
 * outside the named project — so this is a second guarded read plus a copy, and
 * the variant's manifest keeps channel-relative paths or render/export break.
 */
export async function copyCanonSceneImage(
  seriesId: string,
  chapterId: string,
  sceneId: string,
  destinationAbsolutePath: string,
): Promise<boolean> {
  const source = canonChapterPath(seriesId, chapterId, "workspace", "images", `${sceneId}.png`);
  try {
    await mkdir(dirname(destinationAbsolutePath), { recursive: true });
    await copyFile(source, destinationAbsolutePath);
    return true;
  } catch (error: unknown) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * Project the canon bible into the story-factory `bible` artifact shape.
 *
 * Both a canon chapter and a localized variant need this: `runScenesStage`
 * requires a `bible` artifact, and neither has one of its own. Projecting it
 * lets scene extraction — and therefore the shared visuals — run on both
 * without a single branch on story kind.
 */
export async function writeProjectedBible(
  seriesId: string,
  targetChannelId: string,
  targetStoryId: string,
): Promise<BibleArtifact> {
  const [bible, characters] = await Promise.all([loadBible(seriesId), loadCharacters(seriesId)]);
  const projected: BibleArtifact = {
    version: 1,
    setting: bible.setting || bible.premise,
    characters: characters.characters.map((character) => ({
      name: character.name,
      role: character.role,
      description: character.staticProfile.appearance,
      arc: character.state.goals.join("; "),
    })),
    timeline: [],
    locations: bible.locations.map((location) => ({ name: location.name, description: location.description })),
    supernaturalRules: bible.worldRules.map((rule) => rule.text),
    knownFacts: bible.fixedFacts.map((fact) => fact.text),
    openQuestions: bible.mysteries.filter((mystery) => mystery.status === "OPEN").map((mystery) => mystery.question),
    endingConstraints: bible.endingConstraints,
    provenance: {
      provider: "canon",
      model: `canon:${seriesId}`,
      promptVersion: "projection-v1",
      generatedAt: new Date().toISOString(),
    },
  };
  await writeStageArtifact(targetChannelId, targetStoryId, "bible", projected);
  return projected;
}

/** Where a variant's images live, relative to its channel project. */
export function variantImageRelativePath(storyId: string, sceneId: string): string {
  return storyRelativePath(storyId, "workspace", "images", `${sceneId}.png`);
}

// ---------------------------------------------------------------------------
// Staleness — derived, never stored
// ---------------------------------------------------------------------------

export type VariantLink = {
  channelId: string;
  storyId: string;
  locale: string;
  chapterId: string;
  chapterNumber: number;
  /** "stale" when the canon chapter has been rewritten since localization. */
  state: "fresh" | "stale" | "unlinked";
  published: boolean;
};

/**
 * Every variant of a series, across the channels that publish it. Staleness is
 * computed here by comparing hashes, exactly as `approvalState` compares
 * approval anchors — nothing is stored, so a crashed process can never leave a
 * stale label behind.
 */
export async function listSeriesVariants(seriesId: string, channelIds: string[]): Promise<VariantLink[]> {
  const chapterHashes = new Map<string, string>();
  for (const chapter of await listStories(seriesId)) {
    if (chapter.kind !== "canon") continue;
    const artifact = await readStageArtifact<CanonChapterArtifact>(seriesId, chapter.id, "canon-write");
    if (artifact?.canonTextHash) chapterHashes.set(chapter.id, artifact.canonTextHash);
  }

  const links: VariantLink[] = [];
  for (const channelId of channelIds) {
    for (const story of await listStories(channelId)) {
      if (story.kind !== "variant" || story.canonRef?.seriesId !== seriesId) continue;
      const current = chapterHashes.get(story.canonRef.chapterId) ?? null;
      links.push({
        channelId,
        storyId: story.id,
        locale: story.config.locale,
        chapterId: story.canonRef.chapterId,
        chapterNumber: story.canonRef.chapterNumber,
        state:
          current === null
            ? "unlinked"
            : current === story.canonRef.canonTextHash
              ? "fresh"
              : "stale",
        published: story.stages.publish?.status === "done",
      });
    }
  }
  return links;
}

/**
 * Lock a canon chapter because one of its variants has published. This is what
 * makes "published content is never silently regenerated" enforceable: a locked
 * chapter refuses regeneration until a human explicitly unlocks it.
 */
export async function lockCanonChapter(seriesId: string, chapterId: string): Promise<StoryProject> {
  const chapter = await loadStory(seriesId, chapterId);
  if (!chapter.lockedAt) {
    chapter.lockedAt = new Date().toISOString();
    chapter.updatedAt = chapter.lockedAt;
    await saveStory(chapter);
  }
  return chapter;
}

export async function unlockCanonChapter(seriesId: string, chapterId: string, note: string): Promise<StoryProject> {
  if (!note.trim()) {
    throw new Error("Unlocking a published chapter needs a note explaining why.");
  }
  const chapter = await loadStory(seriesId, chapterId);
  delete chapter.lockedAt;
  chapter.updatedAt = new Date().toISOString();
  await saveStory(chapter);
  return chapter;
}

/** Channels that publish this series, discovered from their channel config. */
export async function channelsForSeries(seriesId: string, candidateChannelIds: string[]): Promise<string[]> {
  const linked: string[] = [];
  for (const channelId of candidateChannelIds) {
    if (channelId === seriesId) continue;
    try {
      const channel = await loadStoryChannel(channelId);
      if (channel.canonSeriesId === seriesId) linked.push(channelId);
    } catch {
      // Not a channel project; skip it rather than failing the whole listing.
    }
  }
  return linked;
}

export async function readCanonChapterArtifact(
  seriesId: string,
  chapterId: string,
): Promise<CanonChapterArtifact | null> {
  try {
    return JSON.parse(await readFile(canonChapterPath(seriesId, chapterId, "chapter.json"), "utf8")) as CanonChapterArtifact;
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export { sha256 };
