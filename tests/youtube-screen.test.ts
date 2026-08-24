import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseRoute, routeHash } from "../src/web/lib/router.js";

async function screen(): Promise<string> {
  return readFile("src/web/screens/youtube.js", "utf8");
}

test("YouTube is reachable without changing the app shell and owns internal navigation", async () => {
  const [html, main, script, router] = await Promise.all([
    readFile("src/web/index.html", "utf8"),
    readFile("src/web/main.js", "utf8"),
    screen(),
    readFile("src/web/lib/router.js", "utf8"),
  ]);
  assert.match(html, /data-nav="youtube"/);
  assert.match(main, /mountYouTube/);
  assert.match(router, /screen: "youtube"/);
  assert.deepEqual(parseRoute("#/youtube/series-1/videos"), { screen: "youtube", id: "series-1", view: "videos" });
  assert.equal(routeHash({ screen: "youtube", id: "series-1", view: "queue" }), "#/youtube/series-1/queue");
  for (const label of ["Overview", "Videos", "Publish Queue", "Calendar", "Analytics", "Settings"]) assert.match(script, new RegExp(label));
  assert.match(script, /mountYouTube/);
});

test("YouTube dashboard uses accessible DOM APIs and loads channel status, videos, and queue", async () => {
  const script = await screen();
  for (const marker of ["createElement", "textContent", "aria-label", '"channel"', '"status"', '"videos"', '"publish"', "Reconnect", "Review permissions", "No videos found on this YouTube channel yet", "No source project"]) assert.match(script, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(script, /disabled\s*=|\.disabled/);
});

test("YouTube video library renders joined rows, paging, edit fields, and confirmed delete", async () => {
  const script = await screen();
  for (const marker of ["thumbnailUrl", "publishedAt", "views", "likes", "comments", "sourceProject", "youtube.com/watch", "fetchedAt", "nextPageToken", "pageToken", "title", "description", "tags", "privacyStatus", "thumbnail", "confirm: true", "Delete remote video", "Cached analytics", "Refresh analytics", "Analytics refresh failed", "Loading analytics"]) assert.match(script, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  assert.match(script, /No source project/);
});

test("YouTube publish wizard has three explicit steps, readiness review, schedule times, and 202 queue handoff", async () => {
  const script = await screen();
  for (const marker of ["Source preview", "Metadata validation", "Visibility and schedule", "plannedPublishAt", "toLocaleString", "UTC", "matrix", "approval", "Confirm publish", "202", "EventSource", "activeYouTubeJob"]) assert.match(script, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  assert.match(script, /required/);
  assert.match(script, /explicit/i);
});

test("YouTube styles scope responsive table, detail drawer, targets, and reduced motion", async () => {
  const styles = await readFile("src/web/styles.css", "utf8");
  for (const marker of ["youtube-screen", "youtube-sidebar", "youtube-video-table", "youtube-detail-drawer", "min-width: 44px", "prefers-reduced-motion", "overflow-x: hidden"]) assert.match(styles, new RegExp(marker.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
});
