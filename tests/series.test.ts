import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSeriesProject,
  generateEpisodePlan,
  listSeriesProjects,
  loadSeriesProject,
  updateSeriesEpisode,
} from "../src/series.ts";
import { createStudioServer, startStudioServer } from "../src/server.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-series-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

test("series project stores editable episode plans and linked workflow project ids", async () => {
  await withTempCwd(async () => {
    const series = await createSeriesProject({
      id: "muc-than-ky",
      title: "Muc Than Ky Review",
      show: "Muc Than Ky",
      originalTitle: "牧神记",
      workflowType: "review-recap",
      audience: "Vietnamese donghua review viewers",
      language: "Vietnamese",
    });

    assert.equal(series.episodes.length, 0);

    const planned = await generateEpisodePlan("muc-than-ky", { count: 3, startEpisode: 1 });
    assert.deepEqual(
      planned.episodes.map((episode) => episode.episodeProjectId),
      ["muc-than-ky-ep001", "muc-than-ky-ep002", "muc-than-ky-ep003"],
    );
    assert.equal(planned.episodes[0].status, "idea");
    assert.match(planned.episodes[0].titleOptions[0], /Muc Than Ky/);

    const brief = await readFile(join("projects", "muc-than-ky-ep001", "brief.json"), "utf8");
    assert.match(brief, /Muc Than Ky/);
    assert.match(brief, /review-recap/);
  });
});

test("series episodes can be edited without replacing the whole project", async () => {
  await withTempCwd(async () => {
    await createSeriesProject({
      id: "muc-than-ky",
      title: "Muc Than Ky Review",
      show: "Muc Than Ky",
      workflowType: "review-recap",
      audience: "Vietnamese viewers",
      language: "Vietnamese",
    });
    await generateEpisodePlan("muc-than-ky", { count: 1 });

    const updated = await updateSeriesEpisode("muc-than-ky", "ep001", {
      workingTitle: "Tap 1 co gi dang xem?",
      hook: "Tap dau tien khong can qua hot van giu chan nguoi xem.",
      status: "script",
    });

    assert.equal(updated.episodes[0].workingTitle, "Tap 1 co gi dang xem?");
    assert.equal(updated.episodes[0].status, "script");
    assert.equal((await loadSeriesProject("muc-than-ky")).episodes[0].hook, updated.episodes[0].hook);
  });
});

test("series API creates project plans and updates episode details", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const created = await fetch(`${running.url}/api/series`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({
          id: "muc-than-ky",
          title: "Muc Than Ky Review",
          show: "Muc Than Ky",
          originalTitle: "牧神记",
          workflowType: "review-recap",
          audience: "Vietnamese donghua viewers",
          language: "Vietnamese",
        }),
      });
      assert.equal(created.status, 200);

      const planned = await fetch(`${running.url}/api/series/muc-than-ky/episode-plan`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({ count: 2, startEpisode: 1 }),
      });
      assert.equal(planned.status, 200);
      assert.equal((await planned.json()).series.episodes.length, 2);

      const patched = await fetch(`${running.url}/api/series/muc-than-ky/episodes/ep001`, {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({ workingTitle: "Custom title", status: "script" }),
      });
      assert.equal(patched.status, 200);
      assert.equal((await patched.json()).episode.workingTitle, "Custom title");

      const listed = await fetch(`${running.url}/api/series`);
      assert.equal((await listed.json()).series[0].id, "muc-than-ky");

      const projects = await fetch(`${running.url}/api/projects`);
      assert.deepEqual((await projects.json()).projects, ["muc-than-ky-ep001", "muc-than-ky-ep002"]);
    } finally {
      await running.close();
    }
  });
});

test("listSeriesProjects ignores normal one-video projects", async () => {
  await withTempCwd(async () => {
    await mkdir(join("projects", "single-video"), { recursive: true });
    await createSeriesProject({
      id: "series-video",
      title: "Series",
      show: "Show",
      workflowType: "review-recap",
      audience: "Audience",
      language: "Vietnamese",
    });

    assert.deepEqual(await listSeriesProjects(), ["series-video"]);
  });
});
