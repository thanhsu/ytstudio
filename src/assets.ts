import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveProjectPath } from "./project-paths.ts";
import { invalidateApproval } from "./project-state.ts";

export type AssetMediaType = "image" | "video";

export type AssetUpload = {
  filename: string;
  stream: Readable;
  mediaType: AssetMediaType;
  mimeType?: string;
  rightsConfirmed?: boolean;
  usagePurpose?: string;
};

export type AssetRecord = {
  id: string;
  filename: string;
  relativePath: string;
  mediaType: AssetMediaType;
  mimeType: string;
  sizeBytes: number;
  rightsConfirmed: boolean;
  usagePurpose: string;
  createdAt: string;
  sizeWarning?: string;
  analysisStatus?: "pending" | "running" | "ready" | "limited" | "failed";
  analysisError?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  subtitleSource?: "embedded" | "asr" | "none";
  transcriptPath?: string;
  contextPath?: string;
  keywords?: string[];
  contextSummary?: string;
  analysisUpdatedAt?: string;
};

export type AssetManifest = {
  version: 1;
  assets: AssetRecord[];
};

export type AssetMetadataUpdate = {
  usagePurpose: string;
  rightsConfirmed: boolean;
};

export type AssetValidation = {
  valid: boolean;
  errors: string[];
};

const MANIFEST_PATH = "assets/asset-manifest.json";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);
export const RECOMMENDED_UPLOAD_BYTES = 250 * 1024 * 1024;

export async function saveAsset(
  projectId: string,
  upload: AssetUpload,
  options: { warnUploadBytes?: number } = {},
): Promise<AssetRecord> {
  const extension = validateAssetFilename(upload.filename, upload.mediaType);
  const id = randomUUID();
  const directory = upload.mediaType === "image" ? "assets/images" : "assets/clips";
  const storedFilename = `${id}${extension}`;
  const relativePath = `${directory}/${storedFilename}`;
  const outputPath = resolveProjectPath(projectId, relativePath);

  await mkdir(resolveProjectPath(projectId, directory), { recursive: true });
  const counter = new ByteCounter();
  try {
    await pipeline(upload.stream, counter, createWriteStream(outputPath));
  } catch (error: unknown) {
    await rm(outputPath, { force: true });
    throw error;
  }

  const warnBytes = options.warnUploadBytes ?? RECOMMENDED_UPLOAD_BYTES;
  const sizeWarning =
    counter.sizeBytes > warnBytes
      ? `Asset is ${Math.round(counter.sizeBytes / (1024 * 1024))} MB, above the recommended ${Math.round(warnBytes / (1024 * 1024))} MB.`
      : undefined;

  const record: AssetRecord = {
    id,
    filename: basename(upload.filename),
    relativePath,
    mediaType: upload.mediaType,
    mimeType: upload.mimeType ?? mimeTypeFor(extension, upload.mediaType),
    sizeBytes: counter.sizeBytes,
    rightsConfirmed: upload.rightsConfirmed === true,
    usagePurpose: upload.usagePurpose?.trim() ?? "",
    createdAt: new Date().toISOString(),
    analysisStatus: "pending",
    ...(sizeWarning ? { sizeWarning } : {}),
  };

  const manifest = await loadAssetManifest(projectId);
  manifest.assets.push(record);
  await saveAssetManifest(projectId, manifest);
  return record;
}

export function validateAssetManifest(manifest: AssetManifest): AssetValidation {
  const errors: string[] = [];

  for (const asset of manifest.assets) {
    if (!asset.rightsConfirmed) {
      errors.push(`Asset ${asset.filename} is missing rights confirmation.`);
    }
    if (!asset.usagePurpose.trim()) {
      errors.push(`Asset ${asset.filename} is missing a usage purpose.`);
    }
    if (!asset.relativePath.startsWith("assets/images/") && !asset.relativePath.startsWith("assets/clips/")) {
      errors.push(`Asset ${asset.filename} has an invalid relative path.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export async function loadAssetManifest(projectId: string): Promise<AssetManifest> {
  try {
    return JSON.parse(await readFile(resolveProjectPath(projectId, MANIFEST_PATH), "utf8")) as AssetManifest;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return { version: 1, assets: [] };
    }
    throw error;
  }
}

export async function updateAssetMetadata(
  projectId: string,
  assetId: string,
  update: AssetMetadataUpdate,
): Promise<AssetRecord> {
  const usagePurpose = update.usagePurpose.trim();
  if (!usagePurpose) {
    throw new Error("Asset usage purpose is required.");
  }

  const manifest = await loadAssetManifest(projectId);
  const asset = manifest.assets.find((candidate) => candidate.id === assetId);
  if (!asset) {
    throw new Error(`Asset not found: ${assetId}`);
  }

  asset.usagePurpose = usagePurpose;
  asset.rightsConfirmed = update.rightsConfirmed === true;
  await saveAssetManifest(projectId, manifest);
  await invalidateApproval(projectId, "assets");
  return asset;
}

export async function saveAssetManifest(projectId: string, manifest: AssetManifest): Promise<void> {
  const path = resolveProjectPath(projectId, MANIFEST_PATH);
  await mkdir(resolveProjectPath(projectId, "assets"), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function validateAssetFilename(filename: string, mediaType: AssetMediaType): string {
  if (basename(filename) !== filename) {
    throw new Error("Invalid asset filename; path segments are not allowed.");
  }

  const extension = extname(filename).toLowerCase();
  const allowed = mediaType === "image" ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
  if (!allowed.has(extension)) {
    throw new Error(`Unsupported ${mediaType} asset extension: ${extension}`);
  }
  return extension;
}

function mimeTypeFor(extension: string, mediaType: AssetMediaType): string {
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".webm") return "video/webm";
  return `${mediaType}/octet-stream`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

class ByteCounter extends Transform {
  sizeBytes = 0;

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.sizeBytes += chunk.length;
    callback(null, chunk);
  }
}
