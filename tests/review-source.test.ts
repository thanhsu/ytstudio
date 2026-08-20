import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSeriesProject } from "../src/series.ts";
import { createReviewProject, loadReviewProject } from "../src/review-project.ts";
import { importReviewEpisodeMedia, importReviewEpisodeSubtitle } from "../src/review-source.ts";
import { createStudioServer, startStudioServer } from "../src/server.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-source-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    await createSeriesProject({
      id: "muc-than-ky",
      title: "Muc Than Ky Review",
      show: "Muc Than Ky",
      workflowType: "review-recap",
      audience: "Vietnamese viewers",
      language: "Vietnamese",
    });
    await createReviewProject({
      seriesId: "muc-than-ky",
      id: "ep01-05-review",
      title: "Tales of Herding Gods EP01-05",
      sourceRange: "Episodes 01-05",
      episodeNumbers: [1, 2, 3, 4, 5],
      targetLanguage: "English",
      reviewStyle: "story-review",
      targetDurationMinutes: 20,
      spoilerMode: "donghua-only",
    });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("imports an episode subtitle and writes normalized transcript", async () => {
  await withTempCwd(async () => {
    await writeFile("ep03.srt", "1\n00:00:01,000 --> 00:00:02,500\n你好\n", "utf8");

    const imported = await importReviewEpisodeSubtitle({
      seriesId: "muc-than-ky",
      reviewProjectId: "ep01-05-review",
      episodeNumber: 3,
      sourcePath: "ep03.srt",
      language: "zh",
    });

    assert.equal(imported.episodeNumber, 3);
    assert.equal(imported.cueCount, 1);
    assert.match(imported.subtitlePath, /sources\/ep003\/source\.srt/);
    assert.match(imported.transcriptPath, /sources\/ep003\/transcript\.json/);
    assert.match(await readFile(join("projects", "muc-than-ky", imported.transcriptPath), "utf8"), /EP03-CUE0001/);

    const batch = await loadReviewProject("muc-than-ky", "ep01-05-review");
    const episode = batch.episodes.find((item) => item.episodeNumber === 3);
    assert.equal(episode?.status, "transcript-ready");
    assert.equal(episode?.subtitlePath, imported.subtitlePath);
    assert.equal(episode?.transcriptPath, imported.transcriptPath);
  });
});

test("imports episode media and updates only that episode source", async () => {
  await withTempCwd(async () => {
    await writeFile("ep04.mp4", "fake-video", "utf8");

    const imported = await importReviewEpisodeMedia({
      seriesId: "muc-than-ky",
      reviewProjectId: "ep01-05-review",
      episodeNumber: 4,
      sourcePath: "ep04.mp4",
    });

    assert.equal(imported.episodeNumber, 4);
    assert.equal(imported.originalName, "ep04.mp4");
    assert.match(imported.sourceVideoPath, /sources\/ep004\/source\.mp4/);

    const batch = await loadReviewProject("muc-than-ky", "ep01-05-review");
    assert.equal(batch.episodes.find((item) => item.episodeNumber === 4)?.status, "source-ready");
    assert.equal(batch.episodes.find((item) => item.episodeNumber === 3)?.status, "empty");
  });
});

test("batch review source API imports subtitle for one episode", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const form = new FormData();
      form.append(
        "file",
        new Blob(["1\n00:00:00,000 --> 00:00:02,000\nThe village is quiet.\n"], { type: "application/x-subrip" }),
        "ep01.srt",
      );

      const response = await fetch(
        `${running.url}/api/series/muc-than-ky/review-projects/ep01-05-review/episodes/1/subtitle`,
        {
          method: "POST",
          headers: { origin: running.url },
          body: form,
        },
      );

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.imported.cueCount, 1);
      assert.equal(body.reviewProject.episodes[0].status, "transcript-ready");
    } finally {
      await running.close();
    }
  });
});
