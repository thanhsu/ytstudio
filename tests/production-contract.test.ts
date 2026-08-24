import assert from "node:assert/strict";
import test from "node:test";
import {
  assertValidProductionProject,
  validateProductionProject,
} from "../src/production/validate.ts";
import type { ProductionProject } from "../src/production/types.ts";

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
