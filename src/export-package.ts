import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadReviewProject, updateReviewProject } from "./review-project.ts";
import type { EditingPlan } from "./editing-plan.ts";
import type { ReviewScript } from "./review-script.ts";

export type ReviewExportPackage = {
  jsonPath: string;
  csvPath: string;
  voiceOverSrtPath: string;
  youtubeMetadataPath: string;
};

export async function exportReviewPackage(seriesId: string, reviewProjectId: string): Promise<ReviewExportPackage> {
  const project = await loadReviewProject(seriesId, reviewProjectId);
  if (!project.outputs.reviewScript) throw new Error("Review script is required before export.");
  if (!project.outputs.editingPlan) throw new Error("Editing plan is required before export.");

  const script = JSON.parse(await readFile(join("projects", seriesId, project.outputs.reviewScript), "utf8")) as ReviewScript;
  const editingPlan = JSON.parse(await readFile(join("projects", seriesId, project.outputs.editingPlan), "utf8")) as EditingPlan;
  const exportDir = join("projects", seriesId, "review-projects", reviewProjectId, "exports");
  await mkdir(exportDir, { recursive: true });

  const jsonPath = ["review-projects", reviewProjectId, "exports", "editing-plan.json"].join("/");
  const csvPath = ["review-projects", reviewProjectId, "exports", "editing-sheet.csv"].join("/");
  const voiceOverSrtPath = ["review-projects", reviewProjectId, "exports", "voice-over.srt"].join("/");
  const youtubeMetadataPath = ["review-projects", reviewProjectId, "exports", "youtube-metadata.json"].join("/");

  await writeFile(join("projects", seriesId, jsonPath), `${JSON.stringify(editingPlan, null, 2)}\n`, "utf8");
  await writeFile(join("projects", seriesId, csvPath), toCsv(editingPlan), "utf8");
  await writeFile(join("projects", seriesId, voiceOverSrtPath), toVoiceOverSrt(script), "utf8");
  await writeFile(join("projects", seriesId, youtubeMetadataPath), `${JSON.stringify(buildYoutubeMetadata(script), null, 2)}\n`, "utf8");
  await updateReviewProject(seriesId, reviewProjectId, {
    status: "exported",
    outputs: {
      ...project.outputs,
      exportJson: jsonPath,
      editingSheetCsv: csvPath,
      voiceOverSrt: voiceOverSrtPath,
      youtubeMetadata: youtubeMetadataPath,
    },
  });

  return { jsonPath, csvPath, voiceOverSrtPath, youtubeMetadataPath };
}

function toCsv(plan: EditingPlan): string {
  const rows = ["segmentId,sceneId,episode,startMs,endMs,assetType,instruction,narration"];
  for (const item of plan.items) {
    rows.push(
      [
        item.segmentId,
        item.source.sceneId,
        String(item.source.episode),
        String(item.source.startMs),
        String(item.source.endMs),
        item.assetType,
        item.instruction,
        item.narration,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}

function toVoiceOverSrt(script: ReviewScript): string {
  let cursor = 0;
  return `${script.segments
    .map((segment, index) => {
      const start = cursor;
      cursor += segment.estimatedSeconds;
      return `${index + 1}\n${formatTime(start)} --> ${formatTime(cursor)}\n${segment.narration}`;
    })
    .join("\n\n")}\n`;
}

function buildYoutubeMetadata(script: ReviewScript): Record<string, unknown> {
  return {
    titles: [
      `${script.title}: ${script.sourceRange} Explained`,
      `Why ${script.title} Gets Interesting in ${script.sourceRange}`,
      `${script.title} Batch Review - ${script.sourceRange}`,
    ],
    description: `${script.title} story review for ${script.sourceRange}. Commentary-led recap with lore explanations and no future spoilers.`,
    chapters: script.segments.map((segment, index) => ({
      time: formatChapterTime(script.segments.slice(0, index).reduce((sum, item) => sum + item.estimatedSeconds, 0)),
      title: `${segment.segmentId} ${segment.section}`,
    })),
    thumbnailText: [script.title, script.sourceRange, "Story Review"],
  };
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function formatTime(seconds: number): string {
  const totalMillis = Math.round(seconds * 1000);
  const millis = totalMillis % 1000;
  const totalSeconds = Math.floor(totalMillis / 1000);
  const secs = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${String(millis).padStart(3, "0")}`;
}

function formatChapterTime(seconds: number): string {
  const totalSeconds = Math.round(seconds);
  const secs = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${pad(secs)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
