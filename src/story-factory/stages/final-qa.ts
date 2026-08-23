import { StoryContentError } from "../errors.ts";
import type { RenderStageArtifact } from "../export.ts";
import { readStageArtifact, writeStageArtifact } from "../story-project.ts";
import type {
  FinalQaCheck,
  FinalQaReport,
  ImageManifest,
  OriginalityReport,
  StoryMetadataArtifact,
  TtsChunkManifest,
} from "../types.ts";
import type { StageContext } from "./context.ts";

/**
 * Final QA is deliberately local and free: it checks that every deliverable
 * exists and is coherent, not whether the model liked it. Anything editorial
 * already happened in continuity and originality QA.
 */
export async function runFinalQaStage(ctx: StageContext): Promise<FinalQaReport> {
  const tts = await readStageArtifact<TtsChunkManifest>(ctx.channelId, ctx.storyId, "tts");
  const render = await readStageArtifact<RenderStageArtifact>(ctx.channelId, ctx.storyId, "render");
  const images = await readStageArtifact<ImageManifest>(ctx.channelId, ctx.storyId, "images");
  const metadata = await readStageArtifact<StoryMetadataArtifact>(ctx.channelId, ctx.storyId, "metadata");
  const originality = await readStageArtifact<OriginalityReport>(ctx.channelId, ctx.storyId, "originality-qa");
  const thumbnail = await readStageArtifact<{ finalPath?: string }>(ctx.channelId, ctx.storyId, "thumbnail");

  const targetSeconds = ctx.story.config.targetDurationMinutes * 60;
  const actualSeconds = tts?.totalDurationSeconds ?? 0;
  const checks: FinalQaCheck[] = [
    check("narration", actualSeconds > 0, `narration duration ${Math.round(actualSeconds)}s`),
    check(
      "duration-vs-target",
      actualSeconds > 0 && Math.abs(actualSeconds - targetSeconds) / targetSeconds <= 0.4,
      `target ${targetSeconds}s, actual ${Math.round(actualSeconds)}s`,
    ),
    check("render", Boolean(render?.videoPath), render?.videoPath ?? "render.json missing"),
    check(
      "images",
      Boolean(images && images.images.length > 0 && images.images.every((image) => image.status === "done")),
      images ? `${images.images.filter((image) => image.status === "done").length}/${images.images.length} done` : "images.json missing",
    ),
    check("thumbnail", Boolean(thumbnail?.finalPath), thumbnail?.finalPath ?? "thumbnail.json missing"),
    check(
      "metadata",
      Boolean(metadata && metadata.titles.length >= 5 && metadata.chosenTitle && metadata.description && metadata.tags.length > 0),
      metadata ? `${metadata.titles.length} title candidates` : "metadata.json missing",
    ),
    check("originality", originality?.publishable === true, originality ? `score ${originality.score}` : "originality-report.json missing"),
  ];
  const report: FinalQaReport = { version: 1, checks, pass: checks.every((entry) => entry.pass) };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "final-qa", report);
  if (!report.pass) {
    const failing = checks.filter((entry) => !entry.pass).map((entry) => entry.id);
    throw new StoryContentError(`Final QA failed: ${failing.join(", ")}. See final-qa.json for details.`);
  }
  return report;
}

function check(id: string, pass: boolean, note: string): FinalQaCheck {
  return { id, pass, note };
}
