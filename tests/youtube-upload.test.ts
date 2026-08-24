import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uploadVideo, setThumbnail } from "../src/youtube/upload.ts";

test("uploadVideo initializes a resumable upload and streams the whole file", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-upload-"));
  const videoPath = join(root, "story.mp4");
  await writeFile(videoPath, Buffer.from("video-bytes"));
  const calls: Array<{ url: string; method: string; headers: Headers; body?: ArrayBuffer }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const body = init?.body ? await new Response(init.body as BodyInit).arrayBuffer() : undefined;
    calls.push({ url: String(input), method: init?.method ?? "GET", headers, body });
    if (calls.length === 1) return new Response(null, { status: 200, headers: { location: "https://upload.test/session" } });
    return new Response(JSON.stringify({ id: "video-123" }), { status: 200 });
  };
  try {
    const result = await uploadVideo({
      accessToken: "access",
      filePath: videoPath,
      snippet: { title: "Title", description: "Description", tags: ["one", "two"] },
      status: { privacyStatus: "public", publishAt: "2026-09-01T00:00:00.000Z" },
      fetch: fetchImpl,
    });
    assert.deepEqual(result, { videoId: "video-123" });
    assert.match(calls[0].url, /upload\/youtube\/v3\/videos/);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.get("authorization"), "Bearer access");
    assert.equal(calls[0].headers.get("x-upload-content-length"), "11");
    assert.equal(calls[0].headers.get("x-upload-content-type"), "video/mp4");
    const initBody = JSON.parse(new TextDecoder().decode(calls[0].body));
    assert.equal(initBody.status.privacyStatus, "private");
    assert.equal(initBody.status.publishAt, "2026-09-01T00:00:00.000Z");
    assert.equal(calls[1].url, "https://upload.test/session");
    assert.equal(calls[1].method, "PUT");
    assert.equal(calls[1].headers.get("content-length"), "11");
    assert.deepEqual(Array.from(new Uint8Array(calls[1].body!)), Array.from(Buffer.from("video-bytes")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setThumbnail posts PNG bytes to the YouTube thumbnail endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-thumbnail-"));
  const path = join(root, "thumbnail.png");
  await writeFile(path, Buffer.from([1, 2, 3]));
  let call: { url: string; init?: RequestInit } | undefined;
  try {
    await setThumbnail({
      accessToken: "access",
      videoId: "video-123",
      filePath: path,
      fetch: async (input, init) => {
        call = { url: String(input), init };
        return new Response(null, { status: 200 });
      },
    });
    assert.match(call!.url, /thumbnails\/set\?videoId=video-123/);
    assert.equal(new Headers(call!.init?.headers).get("content-type"), "image/png");
    assert.deepEqual(Array.from(new Uint8Array(await new Response(call!.init?.body as BodyInit).arrayBuffer())), [1, 2, 3]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes upload network failures without exposing provider text", async () => {
  await assert.rejects(() => uploadVideo({ accessToken: "access", filePath: "package.json", snippet: { title: "T", description: "D", tags: [] }, status: { privacyStatus: "private" }, fetch: async () => { throw new Error("socket failed token=sk-secret-value"); } }), (error: unknown) => error instanceof Error && error.message.includes("youtube-upload-failed") && !error.message.includes("sk-secret-value"));
});
