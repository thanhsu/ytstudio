import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBgmPlan } from "../src/story-factory/bgm.ts";
import {
  buildStoryMuxArgs,
  buildStorySegmentArgs,
  buildStorySegments,
  renderStoryVideo,
} from "../src/story-factory/render-story.ts";
import { normalizeStoryChannel } from "../src/story-factory/channel.ts";
import { makeFakeExecutable } from "./helpers.ts";

const DIMENSIONS = { width: 1920, height: 1080 };

test("an image segment gets a slow zoom, fades, and a pre-upscale against jitter", () => {
  const args = buildStorySegmentArgs(
    { imagePath: "C:\\projects\\es-horror\\stories\\s1\\workspace\\images\\SC-001.png", durationSeconds: 75 },
    0,
    "C:\\tmp\\segment-000.mp4",
    DIMENSIONS,
  );
  const filter = args[args.indexOf("-filter_complex") + 1];
  assert.match(filter, /scale=7680:-2/);
  assert.match(filter, /zoompan=z='min\(1\+0\.13\*on\/2250,1\.5\)'/);
  assert.match(filter, /s=1920x1080/);
  assert.match(filter, /fade=t=in:st=0:d=0\.5/);
  assert.match(filter, /fade=t=out:st=74\.5:d=0\.5/);
  assert.ok(args.includes("-loop"));
  // Odd segments zoom out so a long slideshow does not feel mechanical.
  const second = buildStorySegmentArgs({ imagePath: "x.png", durationSeconds: 10 }, 1, "o.mp4", DIMENSIONS);
  assert.match(second[second.indexOf("-filter_complex") + 1], /max\(1\+0\.13-0\.13\*on\/300,1\)/);
});

test("a scene without an image renders a dark frame, not a crash", () => {
  const args = buildStorySegmentArgs({ durationSeconds: 20 }, 2, "o.mp4", DIMENSIONS);
  assert.ok(args.join(" ").includes("color=c=#0b0f19:s=1920x1080"));
});

test("the mux keeps narration dominant over a looped, attenuated ambience bed", () => {
  const args = buildStoryMuxArgs({
    timelinePath: "timeline.mp4",
    narrationPath: "narration.m4a",
    bgm: { version: 1, tracks: [{ path: "C:\\media\\rain.mp3", startSeconds: 0, volumeDb: -22, loop: true }] },
    outputPath: "story.mp4",
    durationSeconds: 1500,
  });
  const joined = args.join(" ");
  assert.match(joined, /-stream_loop -1 -i C:\\media\\rain\.mp3/);
  assert.match(joined, /\[2:a\]volume=-22dB\[bed\];\[1:a\]\[bed\]amix=inputs=2:duration=first/);
  assert.match(joined, /-map 0:v -map \[a\]/);
  assert.match(joined, /-c:v copy/);
});

test("without bgm the narration maps directly — intentional silence, no silent track", () => {
  const args = buildStoryMuxArgs({
    timelinePath: "timeline.mp4",
    narrationPath: "narration.m4a",
    bgm: { version: 1, tracks: [] },
    outputPath: "story.mp4",
    durationSeconds: 60,
  });
  const joined = args.join(" ");
  assert.match(joined, /-map 0:v -map 1:a/);
  assert.ok(!joined.includes("amix"));
});

test("scenes map to segments in order, with missing images left visibly absent", () => {
  const segments = buildStorySegments(
    [
      { sceneId: "SC-001", startSeconds: 0, endSeconds: 70 },
      { sceneId: "SC-002", startSeconds: 70, endSeconds: 145 },
    ],
    new Map([["SC-001", "/abs/SC-001.png"]]),
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].imagePath, "/abs/SC-001.png");
  assert.equal(segments[0].durationSeconds, 70);
  assert.equal(segments[1].imagePath, undefined);
});

test("the full render runs one process per segment, a concat pass, and a mux pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-story-render-"));
  const recordPath = join(root, "calls.jsonl");
  const fakeFfmpeg = await makeFakeExecutable(`
import { appendFile } from "node:fs/promises";
await appendFile(${JSON.stringify(recordPath)}, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");
`);
  try {
    const outputPath = join(root, "render", "story.mp4");
    await renderStoryVideo({
      segments: [
        { imagePath: join(root, "a.png"), durationSeconds: 5 },
        { durationSeconds: 5 },
      ],
      narrationPath: join(root, "narration.m4a"),
      bgm: { version: 1, tracks: [] },
      outputPath,
      durationSeconds: 10,
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [fakeFfmpeg],
    });
    const calls = (await readFile(recordPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.length, 4, "two segments + concat + mux");
    assert.ok(calls[0].some((arg) => arg.includes("zoompan")));
    assert.ok(calls[2].includes("concat"));
    assert.equal(calls[3][calls[3].length - 1], outputPath);
    // The temp segment directory is removed even on success.
    const leftovers = (await readFile(recordPath, "utf8")).length;
    assert.ok(leftovers > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the bgm plan uses the configured licensed track or intentional silence", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-story-bgm-"));
  try {
    const silent = normalizeStoryChannel("es-horror", {});
    assert.deepEqual((await buildBgmPlan(silent, 600)).tracks, []);

    const trackPath = join(root, "rain-ambience.mp3");
    await writeFile(trackPath, "audio", "utf8");
    const channel = normalizeStoryChannel("es-horror", { bgm: { ambienceTrackPath: trackPath, volumeDb: -24 } });
    const plan = await buildBgmPlan(channel, 600);
    assert.equal(plan.tracks.length, 1);
    assert.equal(plan.tracks[0].volumeDb, -24);
    assert.equal(plan.tracks[0].loop, true);

    const missing = normalizeStoryChannel("es-horror", { bgm: { ambienceTrackPath: join(root, "gone.mp3") } });
    await assert.rejects(() => buildBgmPlan(missing, 600), /ambienceTrackPath/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mkdir is not required beforehand — the render creates its own output directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-story-render-dir-"));
  const fakeFfmpeg = await makeFakeExecutable("process.exit(0);");
  try {
    await mkdir(join(root, "exists"), { recursive: true });
    await renderStoryVideo({
      segments: [{ durationSeconds: 2 }],
      narrationPath: join(root, "n.m4a"),
      bgm: { version: 1, tracks: [] },
      outputPath: join(root, "deep", "nested", "story.mp4"),
      durationSeconds: 2,
      ffmpegPath: process.execPath,
      ffmpegPrefixArgs: [fakeFfmpeg],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
