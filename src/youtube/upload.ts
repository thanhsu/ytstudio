import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { redact } from "../redact.ts";

const VIDEO_INIT_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const THUMBNAIL_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";

export async function uploadVideo(options: {
  accessToken: string;
  filePath: string;
  snippet: { title: string; description: string; tags: string[]; categoryId?: string; defaultLanguage?: string };
  status: { privacyStatus: string; publishAt?: string };
  fetch?: typeof fetch;
  signal?: AbortSignal;
  update?: (uploadedBytes: number, totalBytes: number) => Promise<void>;
}): Promise<{ videoId: string }> {
  const fetchImpl = options.fetch ?? fetch;
  const size = (await stat(options.filePath)).size;
  const status = options.status.publishAt ? { ...options.status, privacyStatus: "private" } : options.status;
  const initResponse = await fetchImpl(VIDEO_INIT_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-length": String(size),
      "x-upload-content-type": "video/mp4",
    },
    body: JSON.stringify({ snippet: options.snippet, status }),
    signal: options.signal,
  });
  if (!initResponse.ok) throw await apiError("YouTube video upload initialization", initResponse);
  const location = initResponse.headers.get("location");
  if (!location) throw new Error("YouTube upload initialization returned no resumable session location.");

  let uploaded = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      uploaded += chunk.length;
      const progress = options.update ? options.update(uploaded, size) : Promise.resolve();
      void progress.then(() => callback(null, chunk), callback);
    },
  });
  const body = Readable.toWeb(createReadStream(options.filePath).pipe(counter)) as unknown as BodyInit;
  const uploadResponse = await fetchImpl(location, {
    method: "PUT",
    headers: { authorization: `Bearer ${options.accessToken}`, "content-length": String(size) },
    body,
    signal: options.signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!uploadResponse.ok) throw await apiError("YouTube video upload", uploadResponse);
  const payload = await uploadResponse.json() as { id?: unknown };
  if (typeof payload.id !== "string" || !payload.id) throw new Error("YouTube video upload returned no video id.");
  return { videoId: payload.id };
}

export async function setThumbnail(options: {
  accessToken: string;
  videoId: string;
  filePath: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const response = await (options.fetch ?? fetch)(`${THUMBNAIL_ENDPOINT}?videoId=${encodeURIComponent(options.videoId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.accessToken}`, "content-type": "image/png" },
    body: await readFile(options.filePath),
    signal: options.signal,
  });
  if (!response.ok) throw await apiError("YouTube thumbnail upload", response);
}

async function apiError(operation: string, response: Response): Promise<Error> {
  const body = await response.text();
  return new Error(`${operation} failed (${response.status}): ${redact(body).slice(0, 400)}`);
}
