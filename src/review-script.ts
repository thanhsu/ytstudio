import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadReviewProject, updateReviewProject } from "./review-project.ts";
import type { StoryArc, StoryArcItem } from "./story-arc.ts";

export type ScriptSection = "hook" | "setup" | "rising_action" | "climax" | "resolution" | "next_batch_hook";
export type CommentaryType = "plot" | "plot_and_lore" | "analysis";

export type ScriptSegment = {
  segmentId: string;
  section: ScriptSection;
  narration: string;
  estimatedSeconds: number;
  sourceScenes: string[];
  commentaryType: CommentaryType;
  revision: number;
  updatedAt: string;
};

export type ReviewScript = {
  version: 1;
  title: string;
  sourceRange: string;
  targetDurationMinutes: number;
  revision: number;
  mix: {
    plotPercent: number;
    lorePercent: number;
    analysisPercent: number;
  };
  segments: ScriptSegment[];
  narrationText: string;
  createdAt: string;
  updatedAt: string;
};

export type ReviewScriptOptions = {
  targetDurationMinutes: number;
};

export type SavedReviewScript = {
  scriptPath: string;
  segmentCount: number;
};

export function generateReviewScript(storyArc: StoryArc, options: ReviewScriptOptions): ReviewScript {
  const targetSeconds = Math.max(5, options.targetDurationMinutes) * 60;
  const items: Array<{ section: ScriptSection; item: StoryArcItem; commentaryType: CommentaryType }> = [
    ...storyArc.hook.map((item) => ({ section: "hook" as const, item, commentaryType: "analysis" as const })),
    ...storyArc.setup.map((item) => ({ section: "setup" as const, item, commentaryType: "plot_and_lore" as const })),
    ...storyArc.risingAction.map((item) => ({ section: "rising_action" as const, item, commentaryType: "plot" as const })),
    ...storyArc.climax.map((item) => ({ section: "climax" as const, item, commentaryType: "plot_and_lore" as const })),
    ...storyArc.resolution.map((item) => ({ section: "resolution" as const, item, commentaryType: "analysis" as const })),
    ...storyArc.nextBatchHook.map((item) => ({ section: "next_batch_hook" as const, item, commentaryType: "analysis" as const })),
  ];
  const segmentSeconds = Math.max(12, Math.floor(targetSeconds / Math.max(1, items.length)));
  const now = new Date().toISOString();
  const segments = items.map((entry, index) => ({
    segmentId: `SEG-${String(index + 1).padStart(3, "0")}`,
    section: entry.section,
    narration: buildNarration(entry.section, entry.item.summary),
    estimatedSeconds: segmentSeconds,
    sourceScenes: entry.item.sourceScenes,
    commentaryType: entry.commentaryType,
    revision: 1,
    updatedAt: now,
  }));
  return normalizeScript({
    version: 1,
    title: storyArc.title,
    sourceRange: storyArc.sourceRange,
    targetDurationMinutes: options.targetDurationMinutes,
    revision: 1,
    mix: {
      plotPercent: 70,
      lorePercent: 20,
      analysisPercent: 10,
    },
    segments,
    narrationText: segments.map((segment) => segment.narration).join("\n\n"),
    createdAt: now,
    updatedAt: now,
  });
}

export function regenerateScriptSegment(script: ReviewScript, segmentId: string, narration: string): ReviewScript {
  const now = new Date().toISOString();
  const segments = script.segments.map((segment) =>
    segment.segmentId === segmentId
      ? {
          ...segment,
          narration: narration.trim(),
          revision: segment.revision + 1,
          updatedAt: now,
        }
      : segment,
  );
  return normalizeScript({
    ...script,
    revision: script.revision + 1,
    segments,
    updatedAt: now,
  });
}

export async function saveReviewScript(seriesId: string, reviewProjectId: string): Promise<SavedReviewScript> {
  const project = await loadReviewProject(seriesId, reviewProjectId);
  const storyArcPath = project.outputs.storyArc;
  if (!storyArcPath) throw new Error("Story arc is required before review script generation.");
  const storyArc = JSON.parse(await readFile(join("projects", seriesId, storyArcPath), "utf8")) as StoryArc;
  const script = generateReviewScript(storyArc, { targetDurationMinutes: project.targetDurationMinutes });
  const scriptPath = ["review-projects", reviewProjectId, "review-script.json"].join("/");
  await mkdir(join("projects", seriesId, "review-projects", reviewProjectId), { recursive: true });
  await writeFile(join("projects", seriesId, scriptPath), `${JSON.stringify(script, null, 2)}\n`, "utf8");
  await writeFile(join("projects", seriesId, "review-projects", reviewProjectId, "voice-over-script.md"), toMarkdown(script), "utf8");
  await updateReviewProject(seriesId, reviewProjectId, {
    status: "script",
    outputs: { ...project.outputs, reviewScript: scriptPath, voiceOverScript: "review-projects/" + reviewProjectId + "/voice-over-script.md" },
  });
  return { scriptPath, segmentCount: script.segments.length };
}

export function toMarkdown(script: ReviewScript): string {
  return `# ${script.title} ${script.sourceRange}\n\n${script.segments
    .map((segment) => `## ${segment.segmentId} ${segment.section}\n\n${segment.narration}\n\nSource scenes: ${segment.sourceScenes.join(", ")}`)
    .join("\n\n")}\n`;
}

function buildNarration(section: ScriptSection, summary: string): string {
  if (section === "hook") return `${summary} This is where the batch starts pulling the audience into Qin Mu's problem.`;
  if (section === "setup") return `${summary} Keep the explanation grounded in what the donghua has already shown.`;
  if (section === "next_batch_hook") return `${summary} That unanswered thread is the clean reason to continue into the next batch.`;
  return summary;
}

function normalizeScript(script: ReviewScript): ReviewScript {
  return {
    ...script,
    segments: script.segments,
    narrationText: script.segments.map((segment) => segment.narration).join("\n\n"),
  };
}
