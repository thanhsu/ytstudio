import { access } from "node:fs/promises";
import type { BgmPlan, StoryChannelConfig } from "./types.ts";

/**
 * Phase-1 BGM is deliberately minimal: one operator-supplied, licensed ambience
 * track mixed low under the narration, or intentional silence when none is
 * configured. No generated music — SFX are limited to fixed cues and an
 * optional scene-change stinger, both configured on the channel.
 *
 * Scene-change expansion deliberately does NOT happen here: this stage runs
 * before render, on estimated (unscaled) scene timings, while the real
 * scale factor only exists in the render stage once the actual narration
 * duration is known. So this plan carries `sceneChangeSfx` verbatim and lets
 * `runRenderStage` (pipeline.ts) expand it into concrete, scaled `events`.
 */

export async function buildBgmPlan(channel: StoryChannelConfig, durationSeconds: number): Promise<BgmPlan> {
  const path = channel.bgm.ambienceTrackPath.trim();
  const sceneChangeSfx = channel.bgm.sfx.sceneChange;
  const events = clampEvents(channel.bgm.sfx.events, durationSeconds);
  if (!path) {
    return { version: 1, tracks: [], sceneChangeSfx, events };
  }
  try {
    await access(path);
  } catch {
    throw new Error(
      `The configured ambience track was not found at ${path}. Fix the channel's bgm.ambienceTrackPath or clear it for intentional silence.`,
    );
  }
  if (durationSeconds <= 0) {
    return { version: 1, tracks: [], sceneChangeSfx, events };
  }
  return {
    version: 1,
    tracks: [{ path, startSeconds: 0, volumeDb: channel.bgm.volumeDb, loop: true }],
    sceneChangeSfx,
    events,
  };
}

/** Old bgm.json files (written before sceneChangeSfx/events existed) load with sane defaults. */
export function normalizeBgmPlan(value: unknown): BgmPlan {
  const candidate = value && typeof value === "object" ? (value as Partial<BgmPlan>) : {};
  return {
    version: 1,
    tracks: Array.isArray(candidate.tracks) ? candidate.tracks : [],
    sceneChangeSfx: candidate.sceneChangeSfx ?? null,
    events: Array.isArray(candidate.events) ? candidate.events : [],
  };
}

function clampEvents(
  events: Array<{ path: string; atSeconds: number; volumeDb: number }>,
  durationSeconds: number,
): Array<{ path: string; atSeconds: number; volumeDb: number }> {
  return events.filter((event) => event.atSeconds >= 0 && event.atSeconds < durationSeconds);
}
