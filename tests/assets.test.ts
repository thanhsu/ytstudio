import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveAsset, validateAssetManifest, type AssetManifest, type AssetRecord } from "../src/assets.ts";

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
