import { optionalStringArray, parseJsonObject, requireArray, requireObject, requireText } from "../../llm/parse.ts";
import { buildScenesMessages, SCENES_PROMPT_NAME, SCENES_PROMPT_VERSION } from "../prompts/scenes.ts";
import { readStageArtifact, writeStageArtifact } from "../story-project.ts";
import type { BibleArtifact, SceneList, ScriptArtifact, StoryScene } from "../types.ts";
import { WORDS_PER_MINUTE } from "./outline.ts";
import { readSectionFile } from "./sections.ts";
import { llmStage, promptContext, renderBibleVisualContext, renderNumberedScript, type StageContext } from "./context.ts";

export type ParsedScene = {
  summary: string;
  imagePrompt: string;
  continuityRefs: string[];
};

export function parseScenes(raw: string): ParsedScene[] {
  const payload = parseJsonObject(raw);
  return requireArray(payload.scenes, "scenes").map((entry, index) => {
    const value = requireObject(entry, `scenes[${index}]`);
    return {
      summary: requireText(value.summary, `scenes[${index}].summary`),
      imagePrompt: requireText(value.imagePrompt, `scenes[${index}].imagePrompt`),
      continuityRefs: optionalStringArray(value.continuityRefs, `scenes[${index}].continuityRefs`),
    };
  });
}

export function planSceneCount(estimatedDurationSeconds: number, imageIntervalSeconds: number): number {
  return Math.min(40, Math.max(3, Math.round(estimatedDurationSeconds / Math.max(45, imageIntervalSeconds))));
}

/** Spread scenes evenly across the estimated duration; the render rescales to real audio later. */
export function assignSceneTimings(scenes: ParsedScene[], totalDurationSeconds: number): StoryScene[] {
  const per = totalDurationSeconds / scenes.length;
  return scenes.map((scene, index) => ({
    sceneId: `SC-${String(index + 1).padStart(3, "0")}`,
    startSeconds: Math.round(index * per),
    endSeconds: Math.round((index + 1) * per),
    summary: scene.summary,
    imagePrompt: scene.imagePrompt,
    continuityRefs: scene.continuityRefs,
  }));
}

export async function runScenesStage(ctx: StageContext): Promise<SceneList> {
  const script = await readStageArtifact<ScriptArtifact>(ctx.channelId, ctx.storyId, "sections");
  const bible = await readStageArtifact<BibleArtifact>(ctx.channelId, ctx.storyId, "bible");
  if (!script || !bible) {
    throw new Error("Scene extraction needs a completed script and bible.");
  }
  const estimatedDuration = (script.wordCount / WORDS_PER_MINUTE) * 60;
  const sceneCount = planSceneCount(estimatedDuration, ctx.story.config.visualStyleProfile.imageIntervalSeconds);
  const sections = [];
  for (const entry of script.sections) {
    const section = await readSectionFile(ctx.channelId, ctx.storyId, entry.index);
    if (section) sections.push({ index: section.index, text: section.text });
  }
  const result = await llmStage(
    ctx,
    "scenes",
    SCENES_PROMPT_NAME,
    SCENES_PROMPT_VERSION,
    buildScenesMessages(promptContext(ctx), {
      sceneCount,
      stylePrompt: ctx.story.config.visualStyleProfile.stylePrompt,
      bibleVisualContext: renderBibleVisualContext(bible),
      numberedScript: renderNumberedScript(sections),
    }),
    parseScenes,
  );
  const artifact: SceneList = {
    version: 1,
    scenes: assignSceneTimings(result.value, estimatedDuration),
    provenance: result.provenance,
  };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "scenes", artifact);
  return artifact;
}
