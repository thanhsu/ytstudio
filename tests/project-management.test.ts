import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStudioServer, startStudioServer } from "../src/server.ts";

async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-project-mgmt-"));
  try {
    process.chdir(root);
    await mkdir("projects", { recursive: true });
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

function jsonRequest(url: string, origin: string, method: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { "content-type": "application/json", origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createReviewProject(baseUrl: string, id: string): Promise<void> {
  const created = await jsonRequest(`${baseUrl}/api/projects`, baseUrl, "POST", {
    id,
    topic: "Original topic",
    show: "Test Show",
    format: "longform",
    audience: "Viewers",
    language: "Vietnamese",
    notes: "",
  });
  assert.equal(created.status, 200);
}

test("project brief can be edited in place and the list carries brief summaries", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      await createReviewProject(running.url, "review-one");

      const patched = await jsonRequest(`${running.url}/api/projects/review-one`, running.url, "PATCH", {
        topic: "Updated topic",
        notes: "New angle.",
      });
      assert.equal(patched.status, 200);
      const patchedBody = await patched.json();
      assert.equal(patchedBody.brief.topic, "Updated topic");
      assert.equal(patchedBody.brief.notes, "New angle.");
      assert.equal(patchedBody.brief.show, "Test Show");

      const listed = await fetch(`${running.url}/api/projects`);
      const listedBody = await listed.json();
      assert.deepEqual(listedBody.projects, ["review-one"]);
      assert.equal(listedBody.briefs[0].id, "review-one");
      assert.equal(listedBody.briefs[0].topic, "Updated topic");
      assert.equal(listedBody.briefs[0].show, "Test Show");
    } finally {
      await running.close();
    }
  });
});

test("editing a brief rejects blanking a required field", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      await createReviewProject(running.url, "review-one");
      const patched = await jsonRequest(`${running.url}/api/projects/review-one`, running.url, "PATCH", {
        topic: "   ",
      });
      assert.equal(patched.status, 400);
      assert.equal((await patched.json()).code, "brief-invalid");
    } finally {
      await running.close();
    }
  });
});

test("deleting a review project removes its folder and listing", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      await createReviewProject(running.url, "review-one");

      const deleted = await jsonRequest(`${running.url}/api/projects/review-one`, running.url, "DELETE");
      assert.equal(deleted.status, 200);
      assert.equal((await deleted.json()).id, "review-one");

      await assert.rejects(() => access(join("projects", "review-one")));
      const listed = await fetch(`${running.url}/api/projects`);
      assert.deepEqual((await listed.json()).projects, []);

      const again = await jsonRequest(`${running.url}/api/projects/review-one`, running.url, "DELETE");
      assert.equal(again.status, 404);
    } finally {
      await running.close();
    }
  });
});

test("a series folder cannot be deleted through the project route", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const created = await jsonRequest(`${running.url}/api/series`, running.url, "POST", {
        id: "series-one",
        title: "Series One",
        show: "Test Show",
        workflowType: "review-recap",
        audience: "Viewers",
        language: "Vietnamese",
      });
      assert.equal(created.status, 200);

      const deleted = await jsonRequest(`${running.url}/api/projects/series-one`, running.url, "DELETE");
      assert.equal(deleted.status, 409);
      assert.equal((await deleted.json()).code, "project-is-series");
    } finally {
      await running.close();
    }
  });
});

test("series details can be edited and deleting a series removes its episode projects", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const created = await jsonRequest(`${running.url}/api/series`, running.url, "POST", {
        id: "series-one",
        title: "Series One",
        show: "Test Show",
        workflowType: "review-recap",
        audience: "Viewers",
        language: "Vietnamese",
      });
      assert.equal(created.status, 200);
      const planned = await jsonRequest(`${running.url}/api/series/series-one/episode-plan`, running.url, "POST", {
        count: 2,
        startEpisode: 1,
      });
      assert.equal(planned.status, 200);

      const patched = await jsonRequest(`${running.url}/api/series/series-one`, running.url, "PATCH", {
        title: "Series One Renamed",
        brandNotes: "Keep the intro short.",
      });
      assert.equal(patched.status, 200);
      const patchedBody = await patched.json();
      assert.equal(patchedBody.series.title, "Series One Renamed");
      assert.equal(patchedBody.series.brandNotes, "Keep the intro short.");
      assert.equal(patchedBody.series.show, "Test Show");

      const deleted = await jsonRequest(`${running.url}/api/series/series-one`, running.url, "DELETE");
      assert.equal(deleted.status, 200);
      const deletedBody = await deleted.json();
      assert.deepEqual(deletedBody.removedEpisodeProjects, ["series-one-ep001", "series-one-ep002"]);

      await assert.rejects(() => access(join("projects", "series-one")));
      await assert.rejects(() => access(join("projects", "series-one-ep001")));
      const listedSeries = await fetch(`${running.url}/api/series`);
      assert.deepEqual((await listedSeries.json()).series, []);
      const listedProjects = await fetch(`${running.url}/api/projects`);
      assert.deepEqual((await listedProjects.json()).projects, []);
    } finally {
      await running.close();
    }
  });
});

test("deleting one episode removes it from the plan along with its project folder", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const created = await jsonRequest(`${running.url}/api/series`, running.url, "POST", {
        id: "series-one",
        title: "Series One",
        show: "Test Show",
        workflowType: "review-recap",
        audience: "Viewers",
        language: "Vietnamese",
      });
      assert.equal(created.status, 200);
      const planned = await jsonRequest(`${running.url}/api/series/series-one/episode-plan`, running.url, "POST", {
        count: 2,
        startEpisode: 1,
      });
      assert.equal(planned.status, 200);

      const deleted = await jsonRequest(`${running.url}/api/series/series-one/episodes/ep001`, running.url, "DELETE");
      assert.equal(deleted.status, 200);
      const deletedBody = await deleted.json();
      assert.equal(deletedBody.removedProjectId, "series-one-ep001");
      assert.deepEqual(deletedBody.series.episodes.map((episode: { id: string }) => episode.id), ["ep002"]);

      await assert.rejects(() => access(join("projects", "series-one-ep001")));
      await access(join("projects", "series-one-ep002"));

      const missing = await jsonRequest(`${running.url}/api/series/series-one/episodes/ep001`, running.url, "DELETE");
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).code, "episode-not-found");
    } finally {
      await running.close();
    }
  });
});
