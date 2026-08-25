import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import {
  downloadCandidate,
  parseDownloadProgress,
  selectSubtitle,
  subtitleLanguageArgument,
  type DownloadOptions,
} from "../src/sources/download.ts";
import { loadCandidate, resolveSourcePath, saveCandidate } from "../src/sources/store.ts";
import { makeFakeExecutable, sampleCandidate, withSourcesRoot } from "./helpers.ts";

async function saveDeclaredCandidate(id: string): Promise<void> {
  await saveCandidate({ ...sampleCandidate(id), rights: "third-party-fair-use", rightsNote: "Review commentary." });
}

async function downloadOptions(
  behaviour: {
    partial?: boolean;
    fail?: boolean;
    hang?: boolean;
    subtitles?: string[];
    /** Writes the merged video, then fails the way a subtitle convertor does. */
    failAfterVideo?: boolean;
  } = {},
): Promise<DownloadOptions> {
  const lines = [
    'import { mkdir, writeFile } from "node:fs/promises";',
    'import { dirname, join } from "node:path";',
    "const argv = process.argv.slice(2);",
    'const dir = dirname(argv[argv.indexOf("-o") + 1]);',
    "await mkdir(dir, { recursive: true });",
  ];
  if (behaviour.partial) {
    lines.push('await writeFile(join(dir, "video.mp4.part"), "partial", "utf8");');
  }
  if (behaviour.hang) {
    lines.push("setInterval(() => {}, 1000);");
  } else if (behaviour.failAfterVideo) {
    lines.push('await writeFile(join(dir, "video.mp4"), "video", "utf8");');
    lines.push('console.error("ERROR: Error opening input files: Invalid data found when processing input");');
    lines.push("process.exit(1);");
  } else if (behaviour.fail) {
    lines.push('console.error("ERROR: the server said no");', "process.exit(1);");
  } else {
    lines.push('console.log("[download]  50.0% of 1.00MiB at 2MiB/s");');
    lines.push('await writeFile(join(dir, "video.mp4"), "video", "utf8");');
    for (const name of behaviour.subtitles ?? []) {
      lines.push(`await writeFile(join(dir, ${JSON.stringify(name)}), "1\\n00:00:00,000 --> 00:00:01,000\\nHi\\n", "utf8");`);
    }
  }

  return { ytDlpPath: process.execPath, ytDlpArgs: [await makeFakeExecutable(lines.join("\n"))] };
}

test("progress comes off the download lines and nothing else", () => {
  assert.equal(parseDownloadProgress("[download]  42.7% of 1.00GiB at 2MiB/s"), 42.7);
  assert.equal(parseDownloadProgress("[download] 100% of 1.00GiB"), 100);
  assert.equal(parseDownloadProgress("[info] writing subtitles"), null);
  assert.equal(parseDownloadProgress(""), null);
});

test("author subtitles beat auto-generated ones, then configured language order", () => {
  assert.deepEqual(selectSubtitle(["video.vi.srt", "video.en.srt", "video.en.auto.srt"], ["en", "vi"]), {
    path: "video.en.srt",
    language: "en",
  });
  assert.deepEqual(selectSubtitle(["video.vi.srt", "video.en.auto.srt"], ["en", "vi"]), {
    path: "video.vi.srt",
    language: "vi",
  });
  assert.deepEqual(selectSubtitle(["video.en.auto.srt"], ["en"]), { path: "video.en.auto.srt", language: "en" });
});

test("no subtitle at all is not a failure", () => {
  assert.equal(selectSubtitle(["video.mp4"], ["en"]), null);
  assert.equal(selectSubtitle([], ["en"]), null);
});

test("a language nobody configured is still taken over nothing", () => {
  assert.deepEqual(selectSubtitle(["video.ja.srt"], ["en"]), { path: "video.ja.srt", language: "ja" });
});

test("the requested subtitle languages exclude the comment streams that pose as tracks", () => {
  // Bilibili offers danmaku as its only track; converting that XML to srt is what
  // ffmpeg refused with "Invalid data found when processing input".
  assert.equal(subtitleLanguageArgument(["zh-Hans", "zh"]), "zh-Hans,zh,-danmaku,-live_chat");
  assert.equal(subtitleLanguageArgument([" en ", ""]), "en,-danmaku,-live_chat");
  // Naming no language means no preference, not "download nothing".
  assert.equal(subtitleLanguageArgument([]), "all,-danmaku,-live_chat");
});

test("a download is refused while rights are unknown", async () => {
  await withSourcesRoot(async () => {
    await saveCandidate(sampleCandidate("youtube-abc"));
    const options = await downloadOptions();

    await assert.rejects(() => downloadCandidate("youtube-abc", options), /rights/);
    assert.equal((await loadCandidate("youtube-abc"))?.status, "metadata");
  });
});

test("a download records the media it fetched and the subtitle it chose", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");
    const seen: number[] = [];

    const candidate = await downloadCandidate("youtube-abc", {
      ...(await downloadOptions({ subtitles: ["video.en.srt"] })),
      subtitleLanguages: ["en"],
      update: async (progress) => void seen.push(progress),
    });

    assert.equal(candidate.status, "downloaded");
    assert.equal(candidate.media?.videoRelativePath, "video.mp4");
    assert.equal(candidate.media?.subtitleRelativePath, "video.en.srt");
    assert.equal(candidate.media?.subtitleLanguage, "en");
    assert.ok(seen.includes(50));
    assert.equal((await loadCandidate("youtube-abc"))?.status, "downloaded");
  });
});

test("a download with no subtitle still succeeds", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");

    const candidate = await downloadCandidate("youtube-abc", await downloadOptions());

    assert.equal(candidate.status, "downloaded");
    assert.equal(candidate.media?.subtitleRelativePath, undefined);
  });
});

test("a failed download leaves status failed, an error, and no partial file", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");
    const options = await downloadOptions({ partial: true, fail: true });

    await assert.rejects(() => downloadCandidate("youtube-abc", options));

    const candidate = await loadCandidate("youtube-abc");
    assert.equal(candidate?.status, "failed");
    assert.ok(candidate?.error);
    assert.equal(candidate?.media, undefined);
    assert.deepEqual(await readdir(resolveSourcePath("youtube-abc")), ["candidate.json"]);
  });
});

test("a subtitle failure keeps the video that already arrived and records the complaint", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");

    const candidate = await downloadCandidate("youtube-abc", await downloadOptions({ failAfterVideo: true }));

    assert.equal(candidate.status, "downloaded");
    assert.equal(candidate.media?.videoRelativePath, "video.mp4");
    assert.match(candidate.warning ?? "", /Invalid data found/);
    assert.equal(candidate.error, undefined);
    assert.ok((await readdir(resolveSourcePath("youtube-abc"))).includes("video.mp4"));
  });
});

test("a half-written video is not rescued, and a later clean run clears the warning", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");

    // The merged file exists but a .part alongside it means the run was cut short.
    const cutShort = await downloadOptions({ partial: true, failAfterVideo: true });
    await assert.rejects(() => downloadCandidate("youtube-abc", cutShort));
    assert.equal((await loadCandidate("youtube-abc"))?.status, "failed");

    await downloadCandidate("youtube-abc", await downloadOptions({ failAfterVideo: true }));
    const clean = await downloadCandidate("youtube-abc", await downloadOptions());
    assert.equal(clean.warning, undefined);
  });
});

test("an aborted download returns the candidate to metadata and removes partials", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");
    const controller = new AbortController();
    const options = { ...(await downloadOptions({ partial: true, hang: true })), signal: controller.signal };

    const running = downloadCandidate("youtube-abc", options);
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(() => running);

    const candidate = await loadCandidate("youtube-abc");
    assert.equal(candidate?.status, "metadata");
    assert.equal(candidate?.error, undefined);
    assert.deepEqual(await readdir(resolveSourcePath("youtube-abc")), ["candidate.json"]);
  });
});

test("a retry clears the previous error and media before starting", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");
    const failing = await downloadOptions({ fail: true });
    await assert.rejects(() => downloadCandidate("youtube-abc", failing));

    const candidate = await downloadCandidate("youtube-abc", await downloadOptions());

    assert.equal(candidate.status, "downloaded");
    assert.equal(candidate.error, undefined);
    assert.ok(candidate.media?.videoRelativePath);
  });
});

test("the command carries the configured format and asks for subtitles", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");
    const seen: string[] = [];

    await downloadCandidate("youtube-abc", {
      ...(await downloadOptions()),
      format: "bv*+ba/b",
      subtitleLanguages: ["zh-Hans", "en"],
      onCommand: (_path, args) => seen.push(...args),
    });

    assert.ok(seen.includes("--newline"));
    assert.ok(seen.includes("--write-subs"));
    assert.ok(seen.includes("--write-auto-subs"));
    assert.equal(seen[seen.indexOf("--sub-langs") + 1], "zh-Hans,en,-danmaku,-live_chat");
    assert.equal(seen[seen.indexOf("-f") + 1], "bv*+ba/b");
    assert.equal(seen.at(-1), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

test("subtitle conversion is only requested when a converter is configured", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");
    const without: string[] = [];
    const with_: string[] = [];

    await downloadCandidate("youtube-abc", {
      ...(await downloadOptions()),
      ffmpegPath: "",
      onCommand: (_path, args) => without.push(...args),
    });
    await downloadCandidate("youtube-abc", {
      ...(await downloadOptions()),
      ffmpegPath: "C:/tools/ffmpeg.exe",
      onCommand: (_path, args) => with_.push(...args),
    });

    assert.ok(!without.includes("--convert-subs"));
    assert.ok(with_.includes("--convert-subs"));
  });
});

test("a configured ffmpeg is handed to yt-dlp so split formats can merge", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");
    const without: string[] = [];
    const with_: string[] = [];

    await downloadCandidate("youtube-abc", {
      ...(await downloadOptions()),
      ffmpegPath: "",
      onCommand: (_path, args) => without.push(...args),
    });
    await downloadCandidate("youtube-abc", {
      ...(await downloadOptions()),
      ffmpegPath: "C:/tools/ffmpeg.exe",
      onCommand: (_path, args) => with_.push(...args),
    });

    assert.ok(!without.includes("--ffmpeg-location"));
    assert.equal(with_[with_.indexOf("--ffmpeg-location") + 1], "C:/tools/ffmpeg.exe");
  });
});

test("progress streams live, once per whole percent, and ends by naming the saved file", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");
    const base = await downloadOptions();
    const noisy = await makeFakeExecutable(`
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const argv = process.argv.slice(2);
const dir = dirname(argv[argv.indexOf("-o") + 1]);
await mkdir(dir, { recursive: true });
console.log("[download]  25.0% of 1.00MiB at 2MiB/s");
console.log("[download]  25.7% of 1.00MiB at 2MiB/s");
console.log("[download]  50.0% of 1.00MiB at 2MiB/s");
console.log("[download] 100% of 1.00MiB");
await writeFile(join(dir, "video.mp4"), "video", "utf8");
`);
    const updates: Array<{ progress: number; message: string }> = [];

    await downloadCandidate("youtube-abc", {
      ...base,
      ytDlpArgs: [noisy],
      update: async (progress, message) => void updates.push({ progress, message }),
    });

    assert.deepEqual(updates.map((entry) => entry.progress), [25, 50, 100, 100]);
    assert.match(updates.at(-1)?.message ?? "", /video\.mp4$/);
    assert.equal(updates.at(-1)?.message.includes("Saved "), true);
  });
});

test("an audio-only download asks for the audio format and records the choice", async () => {
  await withSourcesRoot(async () => {
    await saveDeclaredCandidate("youtube-abc");
    const seen: string[] = [];

    const candidate = await downloadCandidate("youtube-abc", {
      ...(await downloadOptions()),
      format: "bv*+ba/b",
      audioOnly: true,
      onCommand: (_path, args) => seen.push(...args),
    });

    assert.equal(seen[seen.indexOf("-f") + 1], "ba/b");
    assert.equal(candidate.media?.audioOnly, true);

    const full = await downloadCandidate("youtube-abc", await downloadOptions());
    assert.notEqual(full.media?.audioOnly, true);
  });
});
