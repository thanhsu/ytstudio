import assert from "node:assert/strict";
import test from "node:test";
import { fetchSourceMetadata, searchSourceMetadata } from "../src/sources/yt-dlp.ts";
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

test("keyword search reads flat results without downloading media", async () => {
  const executable = await makeFakeExecutable(`
console.log(JSON.stringify({
  extractor_key: "Youtube",
  id: "abc123",
  webpage_url: "https://www.youtube.com/watch?v=abc123",
  title: "Tales of Herding Gods episode 1",
  uploader: "Donghua Channel",
  duration: 1320,
  view_count: 42000,
  thumbnail: "https://img.example/thumb.jpg"
}));
console.log(JSON.stringify({
  extractor_key: "Youtube",
  id: "def456",
  url: "https://www.youtube.com/watch?v=def456",
  title: "Episode 2 recap",
  channel: "Review Channel",
  duration: 900,
  thumbnails: [
    { url: "https://img.example/small.jpg", width: 120, height: 90 },
    { url: "https://img.example/large.jpg", width: 720, height: 404 }
  ]
}));
`);
  const seen: string[] = [];

  const results = await searchSourceMetadata("muc than ky", {
    platform: "youtube",
    limit: 2,
    ytDlpPath: process.execPath,
    ytDlpArgs: [executable],
    searchPrefixes: { youtube: "ytsearch", bilibili: "bilisearch" },
    onCommand: (_path, args) => seen.push(...args),
  });

  assert.deepEqual(
    results.map((result) => result.url),
    ["https://www.youtube.com/watch?v=abc123", "https://www.youtube.com/watch?v=def456"],
  );
  assert.equal(results[0].title, "Tales of Herding Gods episode 1");
  assert.equal(results[0].uploader, "Donghua Channel");
  assert.equal(results[0].durationSeconds, 1320);
  assert.equal(results[0].viewCount, 42000);
  assert.equal(results[0].thumbnailUrl, "https://img.example/thumb.jpg");
  assert.equal(results[1].thumbnailUrl, "https://img.example/large.jpg");
  assert.ok(seen.includes("--dump-json"));
  assert.ok(seen.includes("--flat-playlist"));
  assert.ok(seen.includes("--skip-download"));
  assert.ok(seen.includes("ytsearch2:muc than ky"));
});

test("keyword search builds a Bilibili search URL from the configured prefix", async () => {
  const executable = await makeFakeExecutable(`console.log(JSON.stringify({ extractor_key: "BiliBili", id: "BV1abc", title: "牧神记" }));`);
  const seen: string[] = [];

  const results = await searchSourceMetadata("牧神记", {
    platform: "bilibili",
    limit: 3,
    ytDlpPath: process.execPath,
    ytDlpArgs: [executable],
    searchPrefixes: { youtube: "ytsearch", bilibili: "bilisearch" },
    onCommand: (_path, args) => seen.push(...args),
  });

  assert.equal(seen.at(-1), "bilisearch3:牧神记");
  assert.equal(results[0].url, "https://www.bilibili.com/video/BV1abc");
});

test("keyword search refuses unsupported platforms instead of passing user text into the search target", async () => {
  await assert.rejects(
    () =>
      searchSourceMetadata("query", {
        platform: "javascript:alert(1)" as never,
        limit: 5,
        ytDlpPath: process.execPath,
        searchPrefixes: { youtube: "ytsearch", bilibili: "bilisearch" },
      }),
    /Unsupported source search platform/,
  );
});
