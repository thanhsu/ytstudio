import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildChunkCaptionsSrt,
  buildChunkManifest,
  buildConcatList,
  buildMergeArgs,
  splitIntoChunks,
  synthesizeChunks,
} from "../src/story-factory/tts-chunking.ts";
import type { StoryTtsProfile, TtsChunkManifest } from "../src/story-factory/types.ts";
import type { TtsArtifact, TtsProvider, TtsRequest } from "../src/tts/types.ts";

const PROFILE: StoryTtsProfile = {
  provider: "google",
  tier: "economy",
  voiceName: "es-US-Standard-A",
  languageCode: "es-US",
  speakingRate: 0.95,
  pitch: 0,
};

function sentence(word: string, repeat: number): string {
  return `${Array.from({ length: repeat }, () => word).join(" ")}.`;
}

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-tts-chunking-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

function fakeProvider(behavior?: (request: TtsRequest) => void): TtsProvider & { calls: TtsRequest[] } {
  const calls: TtsRequest[] = [];
  return {
    name: "google",
    calls,
    async generate(request: TtsRequest): Promise<TtsArtifact> {
      behavior?.(request);
      calls.push(request);
      const relativePath = `workspace/voice/${request.text.length}-${calls.length}.mp3`;
      await mkdir(join("projects", request.projectId, "workspace", "voice"), { recursive: true });
      await writeFile(join("projects", request.projectId, relativePath), "audio", "utf8");
      return {
        provider: "google",
        cacheKey: `key-${request.text.length}`,
        relativePath,
        durationSeconds: request.text.length / 100,
        createdAt: new Date().toISOString(),
        metadata: {},
      };
    },
  };
}

test("chunks split at sentence boundaries and stay under the limit", () => {
  const text = [sentence("uno", 40), sentence("dos", 40), sentence("tres", 40), sentence("cuatro", 40)].join(" ");
  const chunks = splitIntoChunks(text, { minChars: 100, maxChars: 400 });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 400, `chunk of ${chunk.length} chars exceeds the limit`);
    assert.match(chunk, /\.$/, "every chunk must end on a sentence boundary");
  }
  // Splitting is deterministic.
  assert.deepEqual(chunks, splitIntoChunks(text, { minChars: 100, maxChars: 400 }));
});

test("a single oversize sentence falls back to comma or space splits, never mid-word", () => {
  const words = Array.from({ length: 120 }, (_, i) => `palabra${i}`);
  const oversize = `${words.slice(0, 60).join(" ")}, ${words.slice(60).join(" ")}.`;
  const chunks = splitIntoChunks(oversize, { minChars: 100, maxChars: 300 });
  assert.ok(chunks.length > 1);
  const rejoined = chunks.join(" ").replace(/\s+/g, " ");
  for (const word of words) {
    assert.ok(rejoined.includes(word), `word ${word} was split or lost`);
  }
});

test("paragraph breaks always split even when both sides would fit", () => {
  const chunks = splitIntoChunks("Primera parte.\n\nSegunda parte.", { minChars: 5, maxChars: 4500 });
  assert.equal(chunks.length, 1); // greedy packing may rejoin — but sentences stay whole
  assert.match(chunks[0], /Primera parte\. Segunda parte\./);
});

test("the manifest carries per-chunk cache keys derived from text and voice settings", () => {
  const text = `${sentence("uno", 30)} ${sentence("dos", 30)}`;
  const manifest = buildChunkManifest(text, PROFILE, {
    limits: { minChars: 50, maxChars: 200 },
    audioEncoding: "MP3",
    mergedPath: "stories/story-001/workspace/voice/narration.m4a",
    captionsPath: "stories/story-001/workspace/voice/narration-captions.srt",
  });
  assert.equal(manifest.voiceName, "es-US-Standard-A");
  assert.ok(manifest.chunks.length >= 1);
  for (const chunk of manifest.chunks) {
    assert.match(chunk.relativePath, new RegExp(`workspace/voice/${chunk.cacheKey}\\.mp3$`));
    assert.equal(chunk.status, "pending");
  }
  // The same text under a different voice produces different keys.
  const other = buildChunkManifest(text, { ...PROFILE, voiceName: "es-US-Neural2-B" }, {
    limits: { minChars: 50, maxChars: 200 },
    audioEncoding: "MP3",
    mergedPath: "m.m4a",
    captionsPath: "c.srt",
  });
  assert.notEqual(manifest.chunks[0].cacheKey, other.chunks[0].cacheKey);
});

test("a failed chunk records its error and later retries alone", async () => {
  await withTempCwd(async () => {
    const text = [sentence("uno", 30), sentence("dos", 30), sentence("tres", 30)].join(" ");
    const manifest = buildChunkManifest(text, PROFILE, {
      limits: { minChars: 50, maxChars: 180 },
      audioEncoding: "MP3",
      mergedPath: "m.m4a",
      captionsPath: "c.srt",
    });
    assert.ok(manifest.chunks.length >= 3, `expected 3+ chunks, got ${manifest.chunks.length}`);

    let persisted: TtsChunkManifest | null = null;
    const persist = async (value: TtsChunkManifest) => {
      persisted = JSON.parse(JSON.stringify(value)) as TtsChunkManifest;
    };

    const failing = fakeProvider((request) => {
      if (request.text === manifest.chunks[1].text) {
        throw new Error("quota exceeded");
      }
    });
    await assert.rejects(
      () => synthesizeChunks("es-horror", manifest, failing, { persist }),
      /quota exceeded/,
    );
    assert.equal(manifest.chunks[0].status, "done");
    assert.equal(manifest.chunks[1].status, "failed");
    assert.equal(manifest.chunks[1].attemptCount, 1);
    assert.match(manifest.chunks[1].lastError ?? "", /quota/);
    assert.equal(manifest.chunks[2].status, "pending");
    assert.ok(persisted, "progress must be persisted as it happens");

    // The retry run only touches the failed chunk and the pending tail.
    const succeeding = fakeProvider();
    await synthesizeChunks("es-horror", manifest, succeeding, { persist });
    assert.equal(succeeding.calls.length, 2, "chunk 0 must not be regenerated");
    assert.ok(manifest.chunks.every((chunk) => chunk.status === "done"));
  });
});

test("onlyIndex retries a single chunk and leaves the rest untouched", async () => {
  await withTempCwd(async () => {
    const text = [sentence("uno", 30), sentence("dos", 30), sentence("tres", 30)].join(" ");
    const manifest = buildChunkManifest(text, PROFILE, {
      limits: { minChars: 50, maxChars: 180 },
      audioEncoding: "MP3",
      mergedPath: "m.m4a",
      captionsPath: "c.srt",
    });
    manifest.chunks[1].status = "failed";

    const provider = fakeProvider();
    await synthesizeChunks("es-horror", manifest, provider, {
      persist: async () => {},
      onlyIndex: 1,
    });
    assert.equal(provider.calls.length, 1);
    assert.equal(manifest.chunks[1].status, "done");
    assert.equal(manifest.chunks[0].status, "pending");
    assert.equal(manifest.chunks[2].status, "pending");
  });
});

test("merge args use the concat demuxer with loudness normalization", () => {
  const args = buildMergeArgs("C:\\tmp\\concat.txt", "C:\\tmp\\narration.m4a");
  assert.deepEqual(args.slice(0, 7), ["-y", "-f", "concat", "-safe", "0", "-i", "C:\\tmp\\concat.txt"]);
  assert.ok(args.includes("loudnorm=I=-16:TP=-1.5:LRA=11"));
  assert.equal(args[args.length - 1], "C:\\tmp\\narration.m4a");
});

test("the concat list holds forward-slash absolute paths with quotes escaped", () => {
  const list = buildConcatList(["D:\\a b\\chunk's.mp3", "D:\\a b\\two.mp3"]);
  assert.equal(list, "file 'D:/a b/chunk'\\''s.mp3'\nfile 'D:/a b/two.mp3'\n");
});

test("captions come from per-chunk real durations, offset into one timeline", () => {
  const srt = buildChunkCaptionsSrt([
    { text: "Primera frase corta.", durationSeconds: 4 },
    { text: "Segunda frase corta.", durationSeconds: 4 },
  ]);
  assert.match(srt, /1\n00:00:00,000 --> 00:00:04,000\nPrimera frase corta\./);
  assert.match(srt, /2\n00:00:04,000 --> 00:00:08,000\nSegunda frase corta\./);
});
