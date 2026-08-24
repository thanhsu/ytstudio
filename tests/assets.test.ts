import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadAssetManifest,
  saveAsset,
  saveAssetManifest,
  updateAssetMetadata,
  validateAssetManifest,
  type AssetManifest,
  type AssetRecord,
} from "../src/assets.ts";
import { approveStage, loadProjectState, sha256 } from "../src/project-state.ts";

export const sampleAsset: AssetRecord = {
  id: "asset-1",
  filename: "asset-1.png",
  relativePath: "assets/images/asset-1.png",
  mediaType: "image",
  mimeType: "image/png",
  sizeBytes: 10,
  rightsConfirmed: true,
  usagePurpose: "Background for original commentary card.",
  createdAt: "2026-08-20T00:00:00.000Z",
};

test("asset without rights confirmation blocks use", () => {
  const validation = validateAssetManifest({
    version: 1,
    assets: [{ ...sampleAsset, rightsConfirmed: false }],
  });

  assert.equal(validation.valid, false);
  assert.match(validation.errors[0], /rights/i);
});

test("asset destination remains inside project assets", async () => {
  const stream = Readable.from(["unsafe"]);

  await assert.rejects(
    () =>
      saveAsset("sample-project", {
        filename: "../../escape.mp4",
        stream,
        mediaType: "video",
        rightsConfirmed: true,
        usagePurpose: "Test asset.",
      }),
    /filename/i,
  );
});

test("saves asset and manifest for confirmed local media", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-studio-"));

  try {
    process.chdir(root);
    const asset = await saveAsset("sample-project", {
      filename: "background.png",
      stream: Readable.from(["image"]),
      mediaType: "image",
      mimeType: "image/png",
      rightsConfirmed: true,
      usagePurpose: "Original background visual.",
    });
    const manifest: AssetManifest = { version: 1, assets: [asset] };

    assert.match(asset.relativePath, /^assets\/images\/.+\.png$/);
    assert.equal(validateAssetManifest(manifest).valid, true);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("loadAssetManifest normalizes legacy assets missing a rights status", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-studio-"));

  try {
    process.chdir(root);
    const manifest: AssetManifest = {
      version: 1,
      assets: [
        { ...sampleAsset, id: "confirmed-1", rightsConfirmed: true },
        { ...sampleAsset, id: "unconfirmed-1", rightsConfirmed: false },
      ],
    };
    await saveAssetManifest("sample-project", manifest);

    const loaded = await loadAssetManifest("sample-project");
    assert.equal(loaded.assets.find((asset) => asset.id === "confirmed-1")?.rightsStatus, "user-confirmed");
    assert.equal(loaded.assets.find((asset) => asset.id === "unconfirmed-1")?.rightsStatus, "unknown");
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("loadAssetManifest keeps an already-set rights status untouched", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-studio-"));

  try {
    process.chdir(root);
    const manifest: AssetManifest = {
      version: 1,
      assets: [{ ...sampleAsset, id: "logo-1", role: "logo", rightsStatus: "licensed" }],
    };
    await saveAssetManifest("sample-project", manifest);

    const loaded = await loadAssetManifest("sample-project");
    assert.equal(loaded.assets[0].role, "logo");
    assert.equal(loaded.assets[0].rightsStatus, "licensed");
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("updateAssetMetadata sets role and rightsStatus so a logo can be marked watermark-eligible", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-studio-"));

  try {
    process.chdir(root);
    const asset = await saveAsset("sample-project", {
      filename: "logo.png",
      stream: Readable.from(["image"]),
      mediaType: "image",
      rightsConfirmed: true,
      usagePurpose: "Channel logo overlay.",
    });

    const updated = await updateAssetMetadata("sample-project", asset.id, {
      usagePurpose: "Channel logo overlay.",
      rightsConfirmed: true,
      role: "logo",
      rightsStatus: "owned",
    });

    assert.equal(updated.role, "logo");
    assert.equal(updated.rightsStatus, "owned");
    assert.equal((await loadAssetManifest("sample-project")).assets[0].rightsStatus, "owned");
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("updateAssetMetadata rejects an unsupported rights status instead of silently accepting it", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-studio-"));

  try {
    process.chdir(root);
    const asset = await saveAsset("sample-project", {
      filename: "logo.png",
      stream: Readable.from(["image"]),
      mediaType: "image",
      rightsConfirmed: true,
      usagePurpose: "Channel logo overlay.",
    });

    await assert.rejects(
      () =>
        updateAssetMetadata("sample-project", asset.id, {
          usagePurpose: "Channel logo overlay.",
          rightsConfirmed: true,
          rightsStatus: "made-up-status" as AssetRecord["rightsStatus"],
        }),
      /rights status/i,
    );
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized upload succeeds with a size warning naming the recommended limit", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-studio-"));

  try {
    process.chdir(root);
    const asset = await saveAsset(
      "sample-project",
      {
        filename: "big.png",
        stream: Readable.from([Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024)]),
        mediaType: "image",
        rightsConfirmed: true,
        usagePurpose: "Big background.",
      },
      { warnUploadBytes: 1024 * 1024 },
    );

    assert.equal(asset.sizeBytes, 2 * 1024 * 1024);
    assert.match(asset.sizeWarning ?? "", /1 MB/);
    assert.equal((await readdir(join(root, "projects", "sample-project", "assets", "images"))).length, 1);
    const manifest = await loadAssetManifest("sample-project");
    assert.match(manifest.assets[0].sizeWarning ?? "", /1 MB/);
    assert.equal(validateAssetManifest(manifest).valid, true);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("upload within the recommended size carries no warning", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-studio-"));

  try {
    process.chdir(root);
    const asset = await saveAsset("sample-project", {
      filename: "small.png",
      stream: Readable.from(["tiny"]),
      mediaType: "image",
      rightsConfirmed: true,
      usagePurpose: "Small background.",
    });

    assert.equal(asset.sizeWarning, undefined);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("updates uploaded asset metadata and invalidates the previous asset approval", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-studio-"));

  try {
    process.chdir(root);
    const asset = await saveAsset("sample-project", {
      filename: "background.png",
      stream: Readable.from(["image"]),
      mediaType: "image",
      rightsConfirmed: true,
      usagePurpose: "Initial purpose.",
    });
    const manifest = await loadAssetManifest("sample-project");
    await approveStage("sample-project", "assets", sha256(JSON.stringify(manifest)));

    const updated = await updateAssetMetadata("sample-project", asset.id, {
      usagePurpose: "Background behind original analysis captions.",
      rightsConfirmed: true,
    });

    assert.equal(updated.usagePurpose, "Background behind original analysis captions.");
    assert.equal((await loadAssetManifest("sample-project")).assets[0].usagePurpose, updated.usagePurpose);
    assert.equal((await loadProjectState("sample-project")).approvals.assets, undefined);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
