import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { updateEpisodeSource, type SpoilerMode } from "./review-project.ts";
import type { Scene } from "./scene-map.ts";

export type EpisodeKeyEvent = {
  sceneId: string;
  description: string;
  importance: number;
};

export type EpisodeAnalysis = {
  version: 1;
  episodeNumber: number;
  summary: string;
  characters: string[];
  keyEvents: EpisodeKeyEvent[];
  conflict: string;
  turningPoint: string;
  loreTerms: string[];
  detailsToExplain: string[];
  endingHook: string;
  sourceSceneIds: string[];
  recommendedScenes: string[];
  omittedScenes: Array<{ sceneId: string; reason: string }>;
  spoilerBoundary: string;
  createdAt: string;
};

export type EpisodeAnalysisContext = {
  title: string;
  spoilerMode: SpoilerMode;
};

export type SavedEpisodeAnalysis = {
  episodeNumber: number;
  analysisPath: string;
  keyEventCount: number;
};

export function analyzeEpisodeScenes(scenes: Scene[], context: EpisodeAnalysisContext): EpisodeAnalysis {
  const episodeNumber = scenes[0]?.episode ?? 0;
  const rankedScenes = [...scenes].sort((left, right) => right.importance - left.importance);
  const recommended = rankedScenes.filter((scene) => !scene.excludeReason).slice(0, 8);
  const omitted = scenes
    .filter((scene) => scene.excludeReason || isLowSignalScene(scene))
    .map((scene) => ({ sceneId: scene.sceneId, reason: scene.excludeReason ?? "Low narrative movement." }));
  const characters = [...new Set(scenes.flatMap((scene) => scene.characters))].sort();
  const keyEvents = recommended.slice(0, 5).map((scene) => ({
    sceneId: scene.sceneId,
    description: scene.visualSummary || firstLine(scene.dialogue),
    importance: scene.importance,
  }));
  const conflictScene = recommended.find((scene) => scene.tags.includes("conflict")) ?? recommended[0] ?? scenes[0];
  const loreTerms = inferLoreTerms(scenes, context.title);

  return {
    version: 1,
    episodeNumber,
    summary: buildSummary(episodeNumber, keyEvents),
    characters,
    keyEvents,
    conflict: conflictScene ? conflictScene.visualSummary || firstLine(conflictScene.dialogue) : "No major conflict detected.",
    turningPoint: keyEvents[0]?.description ?? "No clear turning point detected.",
    loreTerms,
    detailsToExplain: buildDetailsToExplain(loreTerms, recommended),
    endingHook: recommended.at(-1)?.visualSummary ?? `Episode ${episodeNumber} leaves the next move unresolved.`,
    sourceSceneIds: scenes.map((scene) => scene.sceneId),
    recommendedScenes: recommended.map((scene) => scene.sceneId),
    omittedScenes: omitted,
    spoilerBoundary:
      context.spoilerMode === "donghua-only"
        ? "donghua-only: use only facts visible in the current batch and do not reveal novel/future episode information."
        : "novel-spoilers: future source knowledge may be used when explicitly needed.",
    createdAt: new Date().toISOString(),
  };
}

export async function saveEpisodeAnalysis(
  seriesId: string,
  reviewProjectId: string,
  episodeNumber: number,
  sceneMapPath: string,
  context: Partial<EpisodeAnalysisContext> = {},
): Promise<SavedEpisodeAnalysis> {
  const scenes = JSON.parse(await readFile(join("projects", seriesId, sceneMapPath), "utf8")) as Scene[];
  const analysis = analyzeEpisodeScenes(scenes, {
    title: context.title ?? reviewProjectId,
    spoilerMode: context.spoilerMode ?? "donghua-only",
  });
  const episodeFolder = join("projects", seriesId, "review-projects", reviewProjectId, "sources", `ep${String(episodeNumber).padStart(3, "0")}`);
  await mkdir(episodeFolder, { recursive: true });
  const analysisPath = ["review-projects", reviewProjectId, "sources", `ep${String(episodeNumber).padStart(3, "0")}`, "analysis.json"].join("/");
  await writeFile(join("projects", seriesId, analysisPath), `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  await updateEpisodeSource(seriesId, reviewProjectId, episodeNumber, {
    analysisPath,
    status: "analyzed",
    error: undefined,
  });
  return { episodeNumber, analysisPath, keyEventCount: analysis.keyEvents.length };
}

function buildSummary(episodeNumber: number, keyEvents: EpisodeKeyEvent[]): string {
  if (keyEvents.length === 0) return `Episode ${episodeNumber} has no usable story events yet.`;
  return `Episode ${episodeNumber} centers on ${keyEvents.map((event) => event.description).join(" Then ")}.`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

function isLowSignalScene(scene: Scene): boolean {
  return scene.importance < 0.45 || /opening|ending|credits|recap/i.test(scene.dialogue);
}

function inferLoreTerms(scenes: Scene[], title: string): string[] {
  const text = `${title} ${scenes.map((scene) => `${scene.dialogue} ${scene.visualSummary}`).join(" ")}`;
  const terms = new Set<string>();
  if (/cultivation|realm|spirit/i.test(text)) terms.add("Cultivation system");
  if (/god|herding|great ruins|darkness|nightfall/i.test(text)) terms.add("Great Ruins");
  if (/village|granny|elder/i.test(text)) terms.add("Village guardians");
  return [...terms];
}

function buildDetailsToExplain(loreTerms: string[], scenes: Scene[]): string[] {
  const details = loreTerms.map((term) => `Explain ${term} only as far as the batch reveals it.`);
  if (scenes.some((scene) => scene.tags.includes("conflict"))) details.push("Clarify why the conflict changes the batch narrative.");
  return details.length > 0 ? details : ["Explain character motivation without adding future spoilers."];
}
