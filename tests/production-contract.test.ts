import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertValidProductionProject,
  validateProductionProject,
} from "../src/production/validate.ts";
import {
  normalizeAudioStoryProject,
  normalizeReviewProject,
} from "../src/production/adapters.ts";
import type {
  AudioStoryProductionInput,
  ReviewProductionInput,
} from "../src/production/adapters.ts";
import type { ProductionProject } from "../src/production/types.ts";
import {
  loadProductionProject,
  loadProductionProjectOrNull,
  PRODUCTION_PROJECT_RELATIVE_PATH,
  saveProductionProject,
} from "../src/production/store.ts";
import { resolveProjectPath } from "../src/project-paths.ts";

function validProject(): ProductionProject {
  return {
    version: 1,
    projectId: "contract-demo",
    workflowType: "review-recap",
    format: "shorts",
    content: {
      title: "A review",
      summary: "A short review summary.",
      sourceHash: "script-hash",
      scriptPath: "script.md",
      sourcePaths: ["notes/source.txt"],
    },
    narration: {
      relativePath: "workspace/voice/narration.wav",
      format: "wav",
      durationSeconds: 8,
      sourceHash: "script-hash",
    },
    captions: {
      relativePath: "workspace/captions/captions.srt",
      format: "srt",
      cueCount: 2,
      sourceHash: "script-hash",
    },
    assets: [
      {
        id: "clip-1",
        relativePath: "assets/clip-1.mp4",
        mediaType: "video",
        role: "source-clip",
        durationSeconds: 4,
        sourceStartSeconds: 0,
        sourceHash: "clip-hash",
        rightsStatus: "user-confirmed",
        usagePurpose: "commentary example",
      },
    ],
    timeline: {
      version: 1,
      durationSeconds: 8,
      segments: [
        {
          id: "segment-1",
          startSeconds: 0,
          endSeconds: 4,
          narrationText: "A review point.",
          assetId: "clip-1",
          fitMode: "cover",
          sourceStartSeconds: 0,
          muteSourceAudio: true,
        },
      ],
    },
    publish: {
      title: "A review",
      description: "A description.",
      tags: ["review"],
      language: "en",
    },
  };
}

function reviewInput(): ReviewProductionInput {
  const project = validProject();
  return {
    projectId: project.projectId,
    format: project.format,
    title: project.content.title,
    summary: project.content.summary,
    scriptPath: project.content.scriptPath,
    sourcePaths: project.content.sourcePaths,
    scriptHash: project.content.sourceHash,
    narration: project.narration,
    captions: project.captions,
    assets: project.assets,
    timeline: project.timeline,
    publish: project.publish,
  };
}

function audioStoryInput(): AudioStoryProductionInput {
  return {
    projectId: "story-demo",
    format: "longform",
    title: "The Dawn Train",
    logline: "A haunted train arrives at dawn.",
    storyPath: "stories/story-demo/script.txt",
    narration: {
      relativePath: "workspace/audio/narration.mp3",
      format: "mp3",
      durationSeconds: 12,
      sourceHash: "story-script-hash",
    },
    captions: {
      relativePath: "workspace/captions/story.srt",
      format: "srt",
      cueCount: 2,
      sourceHash: "story-script-hash",
    },
    assets: [
      {
        id: "scene-001",
        relativePath: "workspace/images/scene-001.png",
        mediaType: "image",
        role: "story-image",
        sourceHash: "image-hash",
        rightsStatus: "generated",
        usagePurpose: "scene background",
      },
    ],
    segments: [
      {
        id: "scene-001",
        startSeconds: 0,
        endSeconds: 6,
        narrationText: "The train arrives.",
        assetId: "scene-001",
        fitMode: "cover",
        muteSourceAudio: true,
      },
      {
        id: "scene-002",
        startSeconds: 6,
        endSeconds: 12,
        narrationText: "Nobody gets off.",
        fitMode: "cover",
        muteSourceAudio: true,
      },
    ],
    durationSeconds: 12,
    publish: {
      title: "The Dawn Train",
      description: "An original audio story.",
      tags: ["horror", "story"],
      language: "en",
    },
  };
}

test("accepts a valid version-one production project", () => {
  assert.deepEqual(validateProductionProject(validProject()), { valid: true, errors: [] });
});

test("rejects unsupported production versions", () => {
  const result = validateProductionProject({ ...validProject(), version: 2 } as never);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("; "), /unsupported production project version/i);
});

test("rejects absolute and traversal paths", () => {
  const project = validProject();
  project.narration = { ...project.narration!, relativePath: "C:/outside/audio.wav" };
  project.content.sourcePaths = ["../outside.txt"];
  const result = validateProductionProject(project);
  assert.match(result.errors.join("; "), /relative path/i);
});

test("rejects invalid timeline ranges, overlap, missing assets, and long source clips", () => {
  const project = validProject();
  project.timeline.segments = [
    { ...project.timeline.segments[0], endSeconds: 7 },
    { id: "overlap", startSeconds: 6, endSeconds: 9, assetId: "missing", fitMode: "cover", muteSourceAudio: true },
  ];
  project.assets[0].durationSeconds = 10;
  const result = validateProductionProject(project);
  assert.match(result.errors.join("; "), /overlap|five-second|asset reference|duration/i);
});

test("allows intentional gaps and assetless generated-background segments", () => {
  const project = validProject();
  project.timeline.segments = [{ id: "gap-end", startSeconds: 5, endSeconds: 8, fitMode: "cover", muteSourceAudio: true }];
  assert.equal(validateProductionProject(project).valid, true);
});

test("assertValidProductionProject throws a readable validation error", () => {
  assert.throws(() => assertValidProductionProject({ version: 2 }), /invalid production project/i);
});

test("normalizes review input into the shared production contract", () => {
  const result = normalizeReviewProject(reviewInput());
  assert.equal(result.workflowType, "review-recap");
  assert.equal(result.content.sourceHash, "script-hash");
  assert.equal(result.assets[0].role, "source-clip");
});

test("normalizes audio story narration and scenes into the shared timeline", () => {
  const result = normalizeAudioStoryProject(audioStoryInput());
  assert.equal(result.workflowType, "audio-story");
  assert.equal(result.content.summary, "A haunted train arrives at dawn.");
  assert.equal(result.timeline.durationSeconds, 12);
  assert.equal(result.timeline.segments[0].assetId, "scene-001");
});

test("changing audio-story inputs changes the content source hash", () => {
  const first = normalizeAudioStoryProject(audioStoryInput());
  const second = normalizeAudioStoryProject({ ...audioStoryInput(), logline: "A different train arrives." });
  assert.notEqual(first.content.sourceHash, second.content.sourceHash);
});

test("adapters reject invalid output instead of emitting an unsafe contract", () => {
  const input = reviewInput();
  assert.throws(
    () => normalizeReviewProject({ ...input, timeline: { ...input.timeline, durationSeconds: -1 } }),
    /invalid production project/i,
  );
});

test("saves and loads a production project under workspace production", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-production-contract-"));
  try {
    process.chdir(root);
    const project = validProject();
    await saveProductionProject(project);
    assert.deepEqual(await loadProductionProject(project.projectId), project);
    assert.equal(await loadProductionProjectOrNull("missing-project"), null);
    const savedPath = resolveProjectPath(project.projectId, PRODUCTION_PROJECT_RELATIVE_PATH);
    assert.match(await readFile(savedPath, "utf8"), /"version": 1/);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to save invalid production projects", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-production-contract-"));
  try {
    process.chdir(root);
    await assert.rejects(() => saveProductionProject({ ...validProject(), version: 2 } as never), /unsupported production project version/i);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses malformed persisted contract versions", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-production-contract-"));
  try {
    process.chdir(root);
    const project = validProject();
    await saveProductionProject(project);
    const path = resolveProjectPath(project.projectId, PRODUCTION_PROJECT_RELATIVE_PATH);
    await writeFile(path, JSON.stringify({ ...project, version: 99 }), "utf8");
    await assert.rejects(() => loadProductionProject(project.projectId), /unsupported production project version/i);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
