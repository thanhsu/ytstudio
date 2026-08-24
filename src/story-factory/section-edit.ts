import { assembleScriptArtifact, readSectionFile, writeSectionFile } from "./stages/sections.ts";
import { invalidateDependents, readStageArtifact, saveStory, writeStageArtifact } from "./story-project.ts";
import type { ScriptArtifact, SectionArtifact, StoryStageId } from "./types.ts";

/**
 * Per-section HTTP editing: an operator hand-fixes one section's text without
 * regenerating the whole sections stage. The edit still goes through
 * writeStageArtifact for the "sections" stage, so script.json's hash moves
 * honestly and invalidateDependents makes every hash-bound approval and
 * downstream stage stale for real, not just in appearance.
 */

/** Every section named in script.json, in the story's section order. Empty before the sections stage has run. */
export async function listSections(channelId: string, storyId: string): Promise<SectionArtifact[]> {
  const script = await readStageArtifact<ScriptArtifact>(channelId, storyId, "sections");
  if (!script) return [];
  const sections: SectionArtifact[] = [];
  for (const entry of script.sections) {
    const section = await readSectionFile(channelId, storyId, entry.index);
    if (section) sections.push(section);
  }
  return sections;
}

export async function readSection(
  channelId: string,
  storyId: string,
  index: number,
): Promise<SectionArtifact | null> {
  return readSectionFile(channelId, storyId, index);
}

/**
 * Rewrite one section's text, then reassemble and rewrite script.json from
 * every section on disk so fullText/hashes describe what is actually there.
 */
export async function editSectionText(
  channelId: string,
  storyId: string,
  index: number,
  text: string,
): Promise<{ section: SectionArtifact; invalidated: StoryStageId[] }> {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new Error("Section text is required.");
  }
  const existing = await readSectionFile(channelId, storyId, index);
  if (!existing) {
    throw new Error(`Section ${index} not found.`);
  }

  const updated: SectionArtifact = { ...existing, text: trimmed, wordCount: trimmed.split(/\s+/).length };
  await writeSectionFile(channelId, storyId, updated);

  const sections = await listSections(channelId, storyId);
  const script = assembleScriptArtifact(sections);
  const { story } = await writeStageArtifact(channelId, storyId, "sections", script);
  const invalidated = invalidateDependents(story, "sections");
  await saveStory(story);

  return { section: updated, invalidated };
}
