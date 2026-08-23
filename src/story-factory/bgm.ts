import { access } from "node:fs/promises";
import type { BgmPlan, StoryChannelConfig } from "./types.ts";

/**
 * Phase-1 BGM is deliberately minimal: one operator-supplied, licensed ambience
 * track mixed low under the narration, or intentional silence when none is
 * configured. No generated music, no SFX spam — narration stays dominant.
 */

export async function buildBgmPlan(channel: StoryChannelConfig, durationSeconds: number): Promise<BgmPlan> {
  const path = channel.bgm.ambienceTrackPath.trim();
  if (!path) {
    return { version: 1, tracks: [] };
  }
  try {
    await access(path);
  } catch {
    throw new Error(
      `The configured ambience track was not found at ${path}. Fix the channel's bgm.ambienceTrackPath or clear it for intentional silence.`,
    );
  }
  if (durationSeconds <= 0) {
    return { version: 1, tracks: [] };
  }
  return {
    version: 1,
    tracks: [{ path, startSeconds: 0, volumeDb: channel.bgm.volumeDb, loop: true }],
  };
}
