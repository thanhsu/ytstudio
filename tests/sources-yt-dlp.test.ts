import assert from "node:assert/strict";
import test from "node:test";
import { fetchSourceMetadata } from "../src/sources/yt-dlp.ts";
import { makeFakeExecutable } from "./helpers.ts";

async function fakeYtDlp(payload: unknown): Promise<string> {
  return makeFakeExecutable(`console.log(${JSON.stringify(JSON.stringify(payload))});`);
}

test("metadata comes back normalised from a dump-json payload", async () => {
  const executable = await fakeYtDlp({
    extractor_key: "Youtube",
    id: "dQw4w9WgXcQ",
    webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Episode 1",
    uploader: "Studio",
    duration: 1440.6,
    description: "First episode.",
  });

  const metadata = await fetchSourceMetadata("https://youtu.be/dQw4w9WgXcQ", {
    ytDlpPath: process.execPath,
    ytDlpArgs: [executable],
  });

  assert.equal(metadata.platform, "Youtube");
  assert.equal(metadata.platformVideoId, "dQw4w9WgXcQ");
  assert.equal(metadata.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(metadata.title, "Episode 1");
  assert.equal(metadata.uploader, "Studio");
  assert.equal(metadata.durationSeconds, 1440);
});

test("the fetch asks for metadata and explicitly skips the download", async () => {
  const executable = await fakeYtDlp({ extractor_key: "Youtube", id: "abc" });
  const seen: string[] = [];

  await fetchSourceMetadata("https://youtu.be/abc", {
    ytDlpPath: process.execPath,
    ytDlpArgs: [executable],
    onCommand: (_path, args) => seen.push(...args),
  });

  assert.ok(seen.includes("--dump-single-json"));
  assert.ok(seen.includes("--skip-download"));
});

test("a sparse payload still yields a usable candidate", async () => {
  const executable = await fakeYtDlp({ extractor_key: "", id: "abc", duration: null });

  const metadata = await fetchSourceMetadata("https://example.com/watch/abc", {
    ytDlpPath: process.execPath,
    ytDlpArgs: [executable],
  });

  assert.equal(metadata.platform, "unknown");
  assert.equal(metadata.uploader, "");
  assert.equal(metadata.description, "");
  assert.equal(metadata.durationSeconds, 0);
  assert.equal(metadata.title, "https://example.com/watch/abc");
  assert.equal(metadata.canonicalUrl, "https://example.com/watch/abc");
});

test("a payload with no video id is refused rather than guessed at", async () => {
  const executable = await fakeYtDlp({ extractor_key: "Youtube" });

  await assert.rejects(
    () => fetchSourceMetadata("https://example.com/x", { ytDlpPath: process.execPath, ytDlpArgs: [executable] }),
    /video id/i,
  );
});

test("the fetch names the setting when no binary is configured", async () => {
  await assert.rejects(() => fetchSourceMetadata("https://example.com/x", {}), /sources\.ytDlpPath/);
});

test("a failing yt-dlp surfaces its message with credentials redacted", async () => {
  const executable = await makeFakeExecutable(
    `console.error("ERROR: token=sk-live-ABC123DEF unsupported URL"); process.exit(1);`,
  );

  await assert.rejects(
    () => fetchSourceMetadata("https://example.com/x", { ytDlpPath: process.execPath, ytDlpArgs: [executable] }),
    (error: unknown) => {
      const message = String(error);
      return /\[redacted\]/.test(message) && !/sk-live-ABC123DEF/.test(message);
    },
  );
});

test("output that is not json names the tool rather than leaking a parser error", async () => {
  const executable = await makeFakeExecutable(`console.log("not json at all");`);

  await assert.rejects(
    () => fetchSourceMetadata("https://example.com/x", { ytDlpPath: process.execPath, ytDlpArgs: [executable] }),
    /yt-dlp/,
  );
});
