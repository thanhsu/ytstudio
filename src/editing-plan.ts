import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadReviewProject, updateReviewProject } from "./review-project.ts";
import type { ReviewScript, ScriptSegment } from "./review-script.ts";
import type { Scene } from "./scene-map.ts";

export type EditingAssetType = "footage" | "keyframe" | "character-card" | "map" | "graphic";

export type EditingPlanItem = {
  segmentId: string;
  source: {
    episode: number;
    sceneId: string;
    startMs: number;
    endMs: number;
  };
  instruction: string;
  assetType: EditingAssetType;
  narration: string;
};

export type EditingPlan = {
  version: 1;
  title: string;
  sourceRange: string;
  items: EditingPlanItem[];
  missingSceneIds: string[];
  createdAt: string;
};

export type SavedEditingPlan = {
  editingPlanPath: string;
  itemCount: number;
};

export function buildEditingPlan(script: ReviewScript, scenes: Scene[]): EditingPlan {
  const bySceneId = new Map(scenes.map((scene) => [scene.sceneId, scene]));
  const items: EditingPlanItem[] = [];
  const missingSceneIds = new Set<string>();

  for (const segment of script.segments) {
    const matchedScenes = segment.sourceScenes.map((sceneId) => bySceneId.get(sceneId));
    segment.sourceScenes.forEach((sceneId, index) => {
      if (!matchedScenes[index]) missingSceneIds.add(sceneId);
    });
    const firstScene = matchedScenes.find(Boolean);
    if (!firstScene) continue;
    items.push(toPlanItem(segment, firstScene));
  }

  return {
    version: 1,
    title: script.title,
    sourceRange: script.sourceRange,
    items,
    missingSceneIds: [...missingSceneIds],
    createdAt: new Date().toISOString(),
  };
}

export async function saveEditingPlan(seriesId: string, reviewProjectId: string): Promise<SavedEditingPlan> {
  const project = await loadReviewProject(seriesId, reviewProjectId);
  const scriptPath = project.outputs.reviewScript;
  if (!scriptPath) throw new Error("Review script is required before editing plan generation.");
  const script = JSON.parse(await readFile(join("projects", seriesId, scriptPath), "utf8")) as ReviewScript;
  const scenes = await loadProjectScenes(seriesId, reviewProjectId);
  const editingPlan = buildEditingPlan(script, scenes);
  const editingPlanPath = ["review-projects", reviewProjectId, "editing-plan.json"].join("/");
  await mkdir(join("projects", seriesId, "review-projects", reviewProjectId), { recursive: true });
  await writeFile(join("projects", seriesId, editingPlanPath), `${JSON.stringify(editingPlan, null, 2)}\n`, "utf8");
  await updateReviewProject(seriesId, reviewProjectId, {
    status: "editing-plan",
    outputs: { ...project.outputs, editingPlan: editingPlanPath },
  });
  return { editingPlanPath, itemCount: editingPlan.items.length };
}

export async function loadProjectScenes(seriesId: string, reviewProjectId: string): Promise<Scene[]> {
  const project = await loadReviewProject(seriesId, reviewProjectId);
  const scenes: Scene[] = [];
  for (const episode of project.episodes) {
    if (!episode.sceneMapPath) continue;
    scenes.push(...(JSON.parse(await readFile(join("projects", seriesId, episode.sceneMapPath), "utf8")) as Scene[]));
  }
  return scenes;
}

function toPlanItem(segment: ScriptSegment, scene: Scene): EditingPlanItem {
  const useSeconds = Math.min(6, Math.max(3, Math.round((scene.endMs - scene.startMs) / 1000)));
  return {
    segmentId: segment.segmentId,
    source: {
      episode: scene.episode,
      sceneId: scene.sceneId,
      startMs: scene.startMs,
      endMs: scene.endMs,
    },
    instruction: `Use ${useSeconds} seconds, crop toward the main character when possible, remove original audio, and keep narration as the primary value.`,
    assetType: scene.keyframes.length > 0 && scene.importance < 0.55 ? "keyframe" : "footage",
    narration: segment.narration,
  };
}
