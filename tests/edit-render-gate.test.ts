import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { applyRemoveSelection, createEditManifest } from "../src/edit-manifest.ts";
import { resolveProjectPath } from "../src/project-paths.ts";
import { setArtifact } from "../src/project-state.ts";
import { approveCurrentCopyrightCheck, evaluateEditRenderGate, renderEditedCutProject } from "../src/workflow.ts";
import { makeFakeExecutable } from "./helpers.ts";

const PROJECT_ID = "sample-project";

const srt =
  "1\n00:00:00,000 --> 00:00:03,000\nHe enters the village.\n\n" +
  "2\n00:00:03,000 --> 00:00:07,000\nA filler line nobody needs.\n\n" +
  "3\n00:00:07,000 --> 00:00:12,500\nThe training changes him.\n";

type Scaffold = { manifest?: boolean; media?: boolean; copyright?: boolean };

async function scaffoldProject(options: Scaffold = {}): Promise<void> {
  const projectDir = resolveProjectPath(PROJECT_ID);
  await mkdir(join(projectDir, "workspace", "edit"), { recursive: true });

  if (options.manifest !== false) {
    await writeFile(join(projectDir, "workspace", "edit", "source.srt"), srt, "utf8");
    await createEditManifest(PROJECT_ID, "workspace/edit/source.srt");
  }
  if (options.media !== false) {
    await writeFile(join(projectDir, "workspace", "source.mp4"), "video", "utf8");
    await setArtifact(PROJECT_ID, {
      kind: "media",
      sourceHash: "source-hash",
      relativePath: "workspace/source.mp4",
      createdAt: "2026-08-22T00:00:00.000Z",
      metadata: {},
    });
  }
  if (options.copyright !== false) {
    await writeCopyrightCheck({ blocked: false, risk: "low" });
    await approveCurrentCopyrightCheck(PROJECT_ID);
  }
}

async function writeCopyrightCheck(value: Record<string, unknown>): Promise<void> {
  await writeFile(resolveProjectPath(PROJECT_ID, "copyright-check.json"), JSON.stringify(value), "utf8");
}

async function withProjectsRoot(run: () => Promise<void>): Promise<void> {
  const previous = process.env.YT_STUDIO_PROJECTS_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-edit-gate-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR;
    else process.env.YT_STUDIO_PROJECTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("a fully prepared project may cut", async () => {
  await withProjectsRoot(async () => {
    await scaffoldProject();
    assert.deepEqual(await evaluateEditRenderGate(PROJECT_ID), { allowed: true, reasons: [] });
  });
});

test("cutting is refused until the copyright check is approved", async () => {
  await withProjectsRoot(async () => {
    await scaffoldProject({ copyright: false });
    const gate = await evaluateEditRenderGate(PROJECT_ID);
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.includes("copyright-approval-missing"));
  });
});

test("editing the copyright check after approval makes the gate stale again", async () => {
  await withProjectsRoot(async () => {
    await scaffoldProject();
    await writeCopyrightCheck({ blocked: false, risk: "medium" });
    const gate = await evaluateEditRenderGate(PROJECT_ID);
    assert.equal(gate.allowed, false);
    assert.ok(gate.reasons.includes("copyright-approval-stale"));
  });
});

test("cutting is refused when the project has no source video", async () => {
  await withProjectsRoot(async () => {
    await scaffoldProject({ media: false });
    assert.ok((await evaluateEditRenderGate(PROJECT_ID)).reasons.includes("source-media-missing"));
  });
});

test("cutting is refused before an edit manifest exists", async () => {
  await withProjectsRoot(async () => {
    await scaffoldProject({ manifest: false });
    assert.ok((await evaluateEditRenderGate(PROJECT_ID)).reasons.includes("edit-manifest-missing"));
  });
});

test("cutting is refused when every cue was removed", async () => {
  await withProjectsRoot(async () => {
    await scaffoldProject();
    await applyRemoveSelection(PROJECT_ID, "1-3");
    assert.ok((await evaluateEditRenderGate(PROJECT_ID)).reasons.includes("edit-manifest-keeps-no-cues"));
  });
});

test("the cut is written with subtitles realigned to it", async () => {
  await withProjectsRoot(async () => {
    await scaffoldProject();
    await applyRemoveSelection(PROJECT_ID, "2");
    const fakeFfmpeg = await makeFakeExecutable(
      [
        'import { mkdir, writeFile } from "node:fs/promises";',
        'import { dirname } from "node:path";',
        "const outputPath = process.argv.at(-1);",
        "await mkdir(dirname(outputPath), { recursive: true });",
        'await writeFile(outputPath, "video", "utf8");',
      ].join("\n"),
    );

    const artifact = await renderEditedCutProject(PROJECT_ID, {
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [fakeFfmpeg],
    });

    assert.equal(artifact.kind, "render");
    assert.equal(artifact.metadata.keptCues, 2);
    assert.equal(artifact.metadata.removedCues, 1);
    assert.match(artifact.relativePath, /^workspace\/renders\/cut-.+\.mp4$/);

    const outputPath = resolveProjectPath(PROJECT_ID, artifact.relativePath);
    await access(outputPath);
    await access(join(dirname(outputPath), `${artifact.relativePath.split("/").at(-1)!.replace(/\.mp4$/, "")}.srt`));
  });
});

test("the cut is refused outright when the gate is unmet", async () => {
  await withProjectsRoot(async () => {
    await scaffoldProject({ copyright: false });
    await assert.rejects(() => renderEditedCutProject(PROJECT_ID), /copyright-approval-missing/);
  });
});
