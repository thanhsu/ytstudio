import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SourceCandidate } from "../src/sources/store.ts";
import type { ProjectState, VideoBrief } from "../src/types.ts";
import type { TtsRequest } from "../src/tts/types.ts";

export async function makeFakeExecutable(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yt-review-exe-"));
  const path = join(dir, "fake-executable.mjs");
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
  return path;
}

export async function makeRecordingExecutable(recordPath: string): Promise<string> {
  return makeFakeExecutable(`
import { writeFile } from "node:fs/promises";
await writeFile(${JSON.stringify(recordPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  stdin: await new Promise((resolve) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => value += chunk);
    process.stdin.on("end", () => resolve(value));
  }),
}), "utf8");
`);
}

export function sampleTtsRequest(): TtsRequest {
  return {
    projectId: "sample-project",
    provider: "piper",
    text: "Qin Mu breaks the usual cultivation pattern.",
    voice: "default",
    format: "wav",
    speed: 1,
    instructions: "",
    confirmedPaidRequest: false,
  };
}

export function stateWithApprovedScript(hash: string): ProjectState {
  return {
    version: 1,
    approvals: {
      script: {
        sourceHash: hash,
        approvedAt: "2026-08-20T00:00:00.000Z",
        note: "",
      },
    },
    artifacts: {},
  };
}

export async function createSampleProject(root: string): Promise<VideoBrief> {
  const brief: VideoBrief = {
    id: "sample-project",
    topic: "Why Qin Mu feels different",
    show: "Tales of Herding Gods",
    format: "shorts",
    audience: "EU and Australia donghua viewers",
    language: "English",
    notes: "",
    createdAt: "2026-08-20T00:00:00.000Z",
  };
  await writeFile(join(root, "brief.json"), JSON.stringify(brief, null, 2), "utf8");
  return brief;
}

export async function withSourcesRoot(run: (root: string) => Promise<void>): Promise<void> {
  const previous = process.env.YT_STUDIO_SOURCES_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-sources-"));
  process.env.YT_STUDIO_SOURCES_DIR = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.YT_STUDIO_SOURCES_DIR;
    else process.env.YT_STUDIO_SOURCES_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

export function sampleCandidate(id: string): SourceCandidate {
  return {
    version: 1,
    id,
    canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    platform: "Youtube",
    platformVideoId: "dQw4w9WgXcQ",
    title: "Episode 1",
    uploader: "Studio",
    durationSeconds: 1440,
    description: "First episode.",
    addedAt: "2026-08-22T00:00:00.000Z",
    status: "metadata",
    rights: "unknown",
    rightsNote: "",
  };
}
