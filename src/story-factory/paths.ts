import { validateProjectId, resolveProjectPath } from "../project-paths.ts";

/**
 * Every story-factory path funnels through resolveProjectPath so the traversal
 * guard applies to the channel id, the story id, and every relative segment.
 * (The legacy audio-story module joined "projects" by hand and both ignored
 * YT_STUDIO_PROJECTS_DIR and skipped the guard — that mistake stops here.)
 */

const STORY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,80}$/;

export function validateStoryId(storyId: string): string {
  if (!STORY_ID_PATTERN.test(storyId)) {
    throw new Error(`Story id ${JSON.stringify(storyId)} must match ${STORY_ID_PATTERN}.`);
  }
  return storyId;
}

/** Absolute path inside one story's directory. */
export function storyPath(channelId: string, storyId: string, ...segments: string[]): string {
  return resolveProjectPath(validateProjectId(channelId), "stories", validateStoryId(storyId), ...segments);
}

/** Absolute path inside the channel-level story-factory folder (costs, fingerprint index). */
export function channelStoryFactoryPath(channelId: string, ...segments: string[]): string {
  return resolveProjectPath(validateProjectId(channelId), "story-channel", ...segments);
}

/** Relative path (from the channel/project root) for serving story files over the existing files route. */
export function storyRelativePath(storyId: string, ...segments: string[]): string {
  return ["stories", validateStoryId(storyId), ...segments].join("/");
}
