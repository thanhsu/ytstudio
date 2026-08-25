import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareYoutubeCaptions, srtToVtt } from "../src/youtube-captions.ts";

const SAMPLE_SRT = `1
00:00:04,000 --> 00:00:06,500
<i>Who's on the flag platform?</i>

2
00:10:00,000 --> 00:10:02,000
He awakened a <b>legendary</b> root!
`;

test("srtToVtt converts timestamps and keeps cue text", () => {
  const vtt = srtToVtt(SAMPLE_SRT);
  assert.ok(vtt.startsWith("WEBVTT\n"));
  assert.match(vtt, /00:00:04\.000 --> 00:00:06\.500/);
  assert.ok(!vtt.includes(","));
});

test("prepareYoutubeCaptions writes sanitized srt and vtt and registers the artifact", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-captions-"));
  try {
    process.chdir(root);
    const dir = join("projects", "cap-demo");
    await mkdir(join(dir, "workspace", "subtitles"), { recursive: true });
    await writeFile(join(dir, "workspace", "subtitles", "source.srt"), SAMPLE_SRT, "utf8");
    await writeFile(
      join(dir, "project-state.json"),
      JSON.stringify({
        version: 1,
        approvals: {},
        artifacts: {
          "source-subtitles": {
            kind: "source-subtitles",
            sourceHash: "x",
            relativePath: "workspace/subtitles/source.srt",
            createdAt: "2026-01-01T00:00:00.000Z",
            metadata: {},
          },
        },
      }),
      "utf8",
    );

    const result = await prepareYoutubeCaptions("cap-demo");
    assert.equal(result.srtRelativePath, "workspace/youtube/captions.srt");
    assert.equal(result.vttRelativePath, "workspace/youtube/captions.vtt");
    assert.equal(result.cueCount, 2);

    const srt = await readFile(join(dir, "workspace", "youtube", "captions.srt"), "utf8");
    assert.ok(!srt.includes("<i>"), "html tags are stripped for YouTube");
    assert.match(srt, /Who's on the flag platform\?/);
    const vtt = await readFile(join(dir, "workspace", "youtube", "captions.vtt"), "utf8");
    assert.ok(vtt.startsWith("WEBVTT"));

    const state = JSON.parse(await readFile(join(dir, "project-state.json"), "utf8"));
    assert.equal(state.artifacts["youtube-captions"].relativePath, "workspace/youtube/captions.srt");
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
