import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildFinalRenderArgs, loadBranding } from "../src/final-render.ts";
import { createStudioServer, startStudioServer } from "../src/server.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-final-render-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("final render args overlay the logo and copy aac voiceover audio", () => {
  const args = buildFinalRenderArgs({
    sourcePath: "in.mp4",
    voiceoverPath: "vo.m4a",
    voiceoverIsAac: true,
    logoPath: "logo.png",
    position: "top-right",
    logoHeight: 64,
    margin: 20,
    videoEncoderArgs: ["-c:v:0", "h264_qsv", "-global_quality", "23"],
    outputPath: "out.mp4",
  });
  const joined = args.join(" ");
  assert.match(joined, /scale=-1:64\[logo\]/);
  assert.match(joined, /overlay=main_w-overlay_w-20:20/);
  assert.ok(args.includes("h264_qsv"));
  assert.ok(joined.includes("-map 1:a:0 -c:a copy"));
  assert.ok(!joined.includes("-shortest"));
});

test("mixing keeps the video's own audio under the voiceover by default", () => {
  const args = buildFinalRenderArgs({
    sourcePath: "in.mp4",
    voiceoverPath: "vo.m4a",
    voiceoverIsAac: true,
    mixOriginalAudio: true,
    originalAudioVolume: 1,
    position: "top-right",
    logoHeight: 64,
    margin: 20,
    videoEncoderArgs: ["-c:v:0", "libx264"],
    outputPath: "out.mp4",
  });
  const joined = args.join(" ");
  assert.match(joined, /\[0:a\]volume=1\[bga\]/);
  assert.match(joined, /amix=inputs=2:duration=first:normalize=0\[aout\]/);
  assert.ok(joined.includes("-map [aout] -c:a aac"));
  // No video overlays requested, so the video stream still stream-copies.
  assert.ok(joined.includes("-map 0:v:0 -c:v:0 copy"));
  assert.ok(!joined.includes("-map 1:a:0"));
});

test("mixing composes with video overlays in one filter graph", () => {
  const args = buildFinalRenderArgs({
    sourcePath: "in.mp4",
    voiceoverPath: "vo.wav",
    voiceoverIsAac: false,
    logoPath: "logo.png",
    mixOriginalAudio: true,
    originalAudioVolume: 0.4,
    position: "top-right",
    logoHeight: 64,
    margin: 20,
    videoEncoderArgs: ["-c:v:0", "libx264"],
    outputPath: "out.mp4",
  });
  const filterIndex = args.indexOf("-filter_complex");
  const graph = args[filterIndex + 1];
  assert.match(graph, /overlay=.*\[vout\]/);
  assert.match(graph, /volume=0.4\[bga\]/);
  assert.equal(args.filter((value) => value === "-filter_complex").length, 1);
});

test("final render args without a logo stream-copy the video", () => {
  const args = buildFinalRenderArgs({
    sourcePath: "in.mp4",
    voiceoverPath: "vo.wav",
    voiceoverIsAac: false,
    position: "bottom-left",
    logoHeight: 64,
    margin: 20,
    videoEncoderArgs: ["-c:v:0", "libx264"],
    outputPath: "out.mp4",
  });
  const joined = args.join(" ");
  assert.ok(joined.includes("-map 0:v:0 -c:v:0 copy"));
  assert.ok(!joined.includes("overlay"));
  assert.ok(joined.includes("-c:a aac"));
});

test("final render args attach the cover as mp4 artwork", () => {
  const args = buildFinalRenderArgs({
    sourcePath: "in.mp4",
    voiceoverPath: "vo.m4a",
    voiceoverIsAac: true,
    coverPath: "cover.jpg",
    position: "top-right",
    logoHeight: 64,
    margin: 20,
    videoEncoderArgs: ["-c:v:0", "libx264"],
    outputPath: "out.mp4",
  });
  const joined = args.join(" ");
  assert.match(joined, /-map 2:v -c:v:1 mjpeg -disposition:v:1 attached_pic/);
});

test("final render args draw a faint text watermark", () => {
  const args = buildFinalRenderArgs({
    sourcePath: "in.mp4",
    voiceoverPath: "vo.m4a",
    voiceoverIsAac: true,
    position: "top-right",
    logoHeight: 64,
    margin: 20,
    watermarkText: "YT Review Studio",
    watermarkOpacity: 0.25,
    watermarkSize: 36,
    videoEncoderArgs: ["-c:v:0", "libx264"],
    outputPath: "out.mp4",
  });
  const joined = args.join(" ");
  assert.match(joined, /drawtext=/);
  assert.match(joined, /fontcolor=white@0.25/);
  assert.match(joined, /fontsize=36/);
  assert.ok(joined.includes("[vout]"));
  assert.ok(!joined.includes("overlay"));
  assert.ok(joined.includes("libx264"));
});

test("final render args chain the watermark under the logo overlay", () => {
  const args = buildFinalRenderArgs({
    sourcePath: "in.mp4",
    voiceoverPath: "vo.m4a",
    voiceoverIsAac: true,
    logoPath: "logo.png",
    position: "top-right",
    logoHeight: 64,
    margin: 20,
    watermarkText: "kenh cua toi",
    watermarkOpacity: 0.2,
    watermarkSize: 40,
    videoEncoderArgs: ["-c:v:0", "libx264"],
    outputPath: "out.mp4",
  });
  const filterIndex = args.indexOf("-filter_complex");
  assert.ok(filterIndex > 0);
  const graph = args[filterIndex + 1];
  assert.match(graph, /drawtext=.*\[wm\]/);
  assert.match(graph, /\[wm\]\[logo\]overlay=/);
});

test("final render args burn subtitles beneath the watermark and logo", () => {
  const args = buildFinalRenderArgs({
    sourcePath: "in.mp4",
    voiceoverPath: "vo.m4a",
    voiceoverIsAac: true,
    logoPath: "logo.png",
    subtitlePath: "D:\\projects\\demo\\workspace\\subtitles\\source.srt",
    subtitleSize: 20,
    position: "top-right",
    logoHeight: 64,
    margin: 20,
    watermarkText: "brand",
    watermarkOpacity: 0.25,
    watermarkSize: 36,
    videoEncoderArgs: ["-c:v:0", "libx264"],
    outputPath: "out.mp4",
  });
  const filterIndex = args.indexOf("-filter_complex");
  const graph = args[filterIndex + 1];
  assert.match(graph, /subtitles=filename='D\\:\/projects\/demo\/workspace\/subtitles\/source.srt'/);
  assert.match(graph, /FontSize=20/);
  const subtitleAt = graph.indexOf("subtitles=");
  const drawtextAt = graph.indexOf("drawtext=");
  const overlayAt = graph.indexOf("overlay=");
  assert.ok(subtitleAt >= 0 && subtitleAt < drawtextAt && drawtextAt < overlayAt);
});

test("a bottom bar backdrop is drawn before the subtitles to cover old hardsubs", () => {
  const args = buildFinalRenderArgs({
    sourcePath: "in.mp4",
    voiceoverPath: "vo.m4a",
    voiceoverIsAac: true,
    subtitlePath: "subs.srt",
    subtitleSize: 18,
    subtitleBackdrop: "bar",
    backdropHeight: 16,
    position: "top-right",
    logoHeight: 64,
    margin: 20,
    videoEncoderArgs: ["-c:v:0", "libx264"],
    outputPath: "out.mp4",
  });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /drawbox=x=0:y=ih\*0.84:w=iw:h=ih\*0.16:color=black:t=fill/);
  const barAt = graph.indexOf("drawbox=");
  const subAt = graph.indexOf("subtitles=");
  assert.ok(barAt >= 0 && barAt < subAt, "the bar must be painted under the new subtitles");
});

test("a box backdrop styles the subtitles with an opaque background", () => {
  const args = buildFinalRenderArgs({
    sourcePath: "in.mp4",
    voiceoverPath: "vo.m4a",
    voiceoverIsAac: true,
    subtitlePath: "subs.srt",
    subtitleSize: 18,
    subtitleBackdrop: "box",
    position: "top-right",
    logoHeight: 64,
    margin: 20,
    videoEncoderArgs: ["-c:v:0", "libx264"],
    outputPath: "out.mp4",
  });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /BorderStyle=3/);
  assert.ok(!graph.includes("drawbox"));
});

test("subtitles alone still force an encode with the [vout] label", () => {
  const args = buildFinalRenderArgs({
    sourcePath: "in.mp4",
    voiceoverPath: "vo.m4a",
    voiceoverIsAac: true,
    subtitlePath: "subs.srt",
    subtitleSize: 18,
    position: "top-right",
    logoHeight: 64,
    margin: 20,
    videoEncoderArgs: ["-c:v:0", "libx264"],
    outputPath: "out.mp4",
  });
  const joined = args.join(" ");
  assert.ok(joined.includes("[vout]"));
  assert.ok(joined.includes("libx264"));
  assert.ok(!joined.includes("-c:v:0 copy"));
});

test("branding uploads and settings persist through the API", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const created = await fetch(`${running.url}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({
          id: "brand-demo",
          topic: "Topic",
          show: "Show",
          format: "longform",
          workflowType: "subtitle-render",
          audience: "Viewers",
          language: "English",
        }),
      });
      assert.equal(created.status, 200);

      const form = new FormData();
      form.append("file", new Blob([Buffer.from("fake-png")], { type: "image/png" }), "channel-logo.png");
      const uploaded = await fetch(`${running.url}/api/projects/brand-demo/branding/logo`, {
        method: "POST",
        headers: { origin: running.url },
        body: form,
      });
      assert.equal(uploaded.status, 200);
      const uploadedBody = await uploaded.json();
      assert.equal(uploadedBody.artifact.relativePath, "workspace/branding/logo.png");

      const patched = await fetch(`${running.url}/api/projects/brand-demo/branding`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({ position: "bottom-right", logoHeight: 96, margin: 24, watermarkText: "kenh cua toi", watermarkOpacity: 0.3, watermarkSize: 42, burnSubtitles: true, subtitleSize: 22 }),
      });
      assert.equal(patched.status, 200);

      const branding = await loadBranding("brand-demo");
      assert.equal(branding.logoFile, "logo.png");
      assert.equal(branding.position, "bottom-right");
      assert.equal(branding.logoHeight, 96);
      assert.equal(branding.margin, 24);
      assert.equal(branding.watermarkText, "kenh cua toi");
      assert.equal(branding.watermarkOpacity, 0.3);
      assert.equal(branding.watermarkSize, 42);
      assert.equal(branding.burnSubtitles, true);
      assert.equal(branding.subtitleSize, 22);
    } finally {
      await running.close();
    }
  });
});

test("final render refuses to start before media and voiceover exist", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      await mkdir(join("projects", "brand-demo"), { recursive: true });
      await writeFile(
        join("projects", "brand-demo", "brief.json"),
        JSON.stringify({ id: "brand-demo", topic: "T", show: "S", format: "longform", workflowType: "subtitle-render", audience: "A", language: "en", notes: "", createdAt: "2026-01-01T00:00:00.000Z" }),
        "utf8",
      );
      const response = await fetch(`${running.url}/api/projects/brand-demo/voiceover/final-render`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "final-render-prerequisites");
    } finally {
      await running.close();
    }
  });
});
