import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { updateEpisodeSource } from "./review-project.ts";
import type { TranscriptSegment } from "./transcript.ts";

export type Scene = {
  episode: number;
  sceneId: string;
  startMs: number;
  endMs: number;
  dialogue: string;
  characters: string[];
  visualSummary: string;
  importance: number;
  tags: string[];
  sourceCueIds: string[];
  keyframes: string[];
  excludeReason?: string;
};

export type SceneMapOptions = {
  maxGapMs?: number;
  targetSceneMs?: number;
};

export type SavedSceneMap = {
  episodeNumber: number;
  sceneMapPath: string;
  sceneCount: number;
};

export function buildSceneMap(transcript: TranscriptSegment[], options: SceneMapOptions = {}): Scene[] {
  if (transcript.length === 0) return [];
  const maxGapMs = options.maxGapMs ?? 6000;
  const targetSceneMs = options.targetSceneMs ?? 45000;
  const sorted = [...transcript].sort((left, right) => left.startMs - right.startMs);
  const groups: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];

  for (const segment of sorted) {
    const previous = current[current.length - 1];
    const currentDuration = current.length > 0 ? previous.endMs - current[0].startMs : 0;
    if (previous && (segment.startMs - previous.endMs > maxGapMs || currentDuration >= targetSceneMs)) {
      groups.push(current);
      current = [];
    }
    current.push(segment);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, index) => {
    const first = group[0];
    const last = group[group.length - 1];
    return {
      episode: first.episode,
      sceneId: `${episodePrefix(first.episode)}-SC${String(index + 1).padStart(3, "0")}`,
      startMs: first.startMs,
      endMs: last.endMs,
      dialogue: group.map((segment) => segment.text).join("\n"),
      characters: [...new Set(group.map((segment) => segment.speaker).filter(Boolean) as string[])],
      visualSummary: summarizeDialogue(group),
      importance: Math.min(1, 0.35 + group.length * 0.18),
      tags: inferTags(group),
      sourceCueIds: group.map((segment) => segment.cueId),
      keyframes: [],
    };
  });
}

export async function saveReviewEpisodeSceneMap(
  seriesId: string,
  reviewProjectId: string,
  episodeNumber: number,
  transcriptPath: string,
  options: SceneMapOptions = {},
): Promise<SavedSceneMap> {
  const absoluteTranscriptPath = join("projects", seriesId, transcriptPath);
  const transcript = JSON.parse(await readFile(absoluteTranscriptPath, "utf8")) as TranscriptSegment[];
  const scenes = buildSceneMap(transcript, options);
  const sceneMapPath = ["review-projects", reviewProjectId, "sources", `ep${String(episodeNumber).padStart(3, "0")}`, "scenes.json"].join("/");
  const absoluteScenePath = join("projects", seriesId, sceneMapPath);
  await mkdir(join("projects", seriesId, "review-projects", reviewProjectId, "sources", `ep${String(episodeNumber).padStart(3, "0")}`), {
    recursive: true,
  });
  await writeFile(absoluteScenePath, `${JSON.stringify(scenes, null, 2)}\n`, "utf8");
  await updateEpisodeSource(seriesId, reviewProjectId, episodeNumber, {
    sceneMapPath,
    status: "scene-ready",
    error: undefined,
  });
  return { episodeNumber, sceneMapPath, sceneCount: scenes.length };
}

function summarizeDialogue(group: TranscriptSegment[]): string {
  const text = group.map((segment) => segment.text).join(" ").replace(/\s+/g, " ").trim();
  return text.length <= 120 ? text : `${text.slice(0, 117).trim()}...`;
}

function inferTags(group: TranscriptSegment[]): string[] {
  const text = group.map((segment) => segment.text).join(" ").toLowerCase();
  const tags = new Set<string>();
  if (/danger|dark|death|kill|fight|battle|enemy/.test(text)) tags.add("conflict");
  if (/village|sect|realm|god|cultivation|spirit/.test(text)) tags.add("lore");
  if (/why|how|secret|truth|remember/.test(text)) tags.add("explain");
  return [...tags];
}

function episodePrefix(episode: number): string {
  return `EP${String(episode).padStart(2, "0")}`;
}
