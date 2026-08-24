import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AssetRecord } from "./assets.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { parseSrt } from "./srt.ts";
import { extractAssetKeywords } from "./asset-analysis.ts";
import { normalizeSegmentEffects, type SegmentEffects } from "./visual-effects.ts";

export type NarrationScene = { id: string; startSeconds: number; endSeconds: number; narration: string; keywords: string[]; intent: "hook" | "context" | "analysis" | "closing" };
export type VisualMappingSegment = NarrationScene & { assetId: string | null; mediaType?: "image" | "video"; confidence: number; reason: string; fitMode: "cover" | "contain"; sourceStartSeconds: number; sourceDurationSeconds: number; muteSourceAudio: boolean; selectionMode: "automatic" | "manual"; fallback?: "generated-background"; effects?: SegmentEffects };
export type VisualMapping = { version: 1; status: "draft" | "approved" | "stale"; generatedAt: string; inputFingerprint: string; segments: VisualMappingSegment[] };

export function buildNarrationScenes(srt: string): NarrationScene[] {
  const cues = parseSrt(srt);
  const scenes: NarrationScene[] = [];
  let group: typeof cues = [];
  for (const cue of cues) {
    group.push(cue);
    const duration = seconds(group.at(-1)!.end) - seconds(group[0].start);
    if (duration >= 4 && (duration >= 7 || cue === cues.at(-1))) {
      scenes.push(sceneFromGroup(group, scenes.length));
      group = [];
    }
  }
  if (group.length) scenes.push(sceneFromGroup(group, scenes.length));
  return scenes;
}

export function generateVisualMapping(scenes: NarrationScene[], assets: AssetRecord[]): VisualMapping {
  let previousVideoId: string | null = null;
  const eligible = assets.filter((asset) => asset.rightsConfirmed && asset.usagePurpose.trim() && asset.analysisStatus !== "pending" && asset.analysisStatus !== "running" && asset.analysisStatus !== "failed");
  const segments = scenes.map((scene) => {
    const ranked = eligible
      .filter((asset) => !(asset.mediaType === "video" && asset.id === previousVideoId))
      .map((asset) => ({ asset, ...scoreAsset(scene, asset) }))
      .sort((left, right) => right.score - left.score || left.asset.id.localeCompare(right.asset.id));
    // Media-type and status bonuses only break ties between relevant assets; an
    // asset that matches nothing in the scene must never win by default.
    const selected = ranked.find((candidate) => candidate.relevance > 0);
    if (selected?.asset.mediaType === "video") previousVideoId = selected.asset.id;
    else previousVideoId = null;
    return {
      ...scene,
      assetId: selected?.asset.id ?? null,
      mediaType: selected?.asset.mediaType,
      confidence: selected ? Math.min(1, selected.score / 20) : 0,
      reason: selected ? `Matched ${scene.keywords.filter((keyword) => assetTerms(selected.asset).has(keyword)).join(", ") || selected.asset.usagePurpose}.` : "No eligible asset exceeded the match threshold.",
      fitMode: "cover" as const,
      sourceStartSeconds: 0,
      sourceDurationSeconds: selected?.asset.mediaType === "video" ? Math.min(5, scene.endSeconds - scene.startSeconds) : scene.endSeconds - scene.startSeconds,
      muteSourceAudio: true,
      selectionMode: "automatic" as const,
      ...(selected ? {} : { fallback: "generated-background" as const }),
      effects: normalizeSegmentEffects(undefined),
    };
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({ scenes, assets: eligible.map((asset) => [asset.id, asset.analysisUpdatedAt, asset.usagePurpose, asset.rightsConfirmed]) })).digest("hex");
  return { version: 1, status: "draft", generatedAt: new Date().toISOString(), inputFingerprint: fingerprint, segments };
}

export function validateVisualMapping(mapping: VisualMapping, assets: AssetRecord[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  let previousVideo: string | null = null;
  for (const segment of mapping.segments) {
    if (segment.mediaType === "video" && segment.sourceDurationSeconds > 5) errors.push(`${segment.id} exceeds the five-second video limit.`);
    if (segment.mediaType === "video" && segment.assetId && segment.assetId === previousVideo) errors.push(`${segment.id} repeats the same video in adjacent scenes.`);
    if (segment.assetId && !assets.some((asset) => asset.id === segment.assetId)) errors.push(`${segment.id} references a missing asset.`);
    if (!segment.assetId && !segment.fallback) errors.push(`${segment.id} has no asset or generated fallback.`);
    previousVideo = segment.mediaType === "video" ? segment.assetId : null;
  }
  return { valid: errors.length === 0, errors };
}

export async function saveVisualMapping(projectId: string, mapping: VisualMapping): Promise<void> {
  const path = resolveProjectPath(projectId, "workspace/editing/visual-mapping.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
}

export async function loadVisualMapping(projectId: string): Promise<VisualMapping | null> {
  try { return JSON.parse(await readFile(resolveProjectPath(projectId, "workspace/editing/visual-mapping.json"), "utf8")) as VisualMapping; }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function sceneFromGroup(group: ReturnType<typeof parseSrt>, index: number): NarrationScene {
  const narration = group.map((cue) => cue.text.replace(/\s+/g, " ")).join(" ");
  const intent = index === 0 ? "hook" : "analysis";
  return { id: `scene-${String(index + 1).padStart(3, "0")}`, startSeconds: seconds(group[0].start), endSeconds: seconds(group.at(-1)!.end), narration, keywords: extractAssetKeywords(narration), intent };
}

function scoreAsset(scene: NarrationScene, asset: AssetRecord): { relevance: number; score: number } {
  const terms = assetTerms(asset);
  const overlap = scene.keywords.filter((keyword) => terms.has(keyword)).length;
  const purposeMatch = scene.keywords.some((keyword) => asset.usagePurpose.toLowerCase().includes(keyword)) ? 5 : 0;
  const relevance = overlap * 4 + purposeMatch;
  return { relevance, score: relevance + (asset.mediaType === "video" ? 3 : 2) + (asset.analysisStatus === "limited" ? -2 : 0) };
}

function assetTerms(asset: AssetRecord): Set<string> { return new Set(extractAssetKeywords(`${asset.filename} ${asset.usagePurpose} ${asset.contextSummary ?? ""} ${(asset.keywords ?? []).join(" ")}`)); }
function seconds(timestamp: string): number { const [hours, minutes, rest] = timestamp.split(":"); const [secs, millis] = rest.split(","); return Number(hours) * 3600 + Number(minutes) * 60 + Number(secs) + Number(millis) / 1000; }
