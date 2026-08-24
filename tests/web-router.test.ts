import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute, routeHash } from "../src/web/lib/router.js";

test("parseRoute maps hashes to screens", () => {
  assert.deepEqual(parseRoute(""), { screen: "projects" });
  assert.deepEqual(parseRoute("#/projects"), { screen: "projects" });
  assert.deepEqual(parseRoute("#/sources"), { screen: "sources" });
  assert.deepEqual(parseRoute("#/config"), { screen: "config" });
  assert.deepEqual(parseRoute("#/project/demo-1"), { screen: "review-project", id: "demo-1", phase: "overview" });
  assert.deepEqual(parseRoute("#/project/demo-1/edit"), { screen: "review-project", id: "demo-1", phase: "edit" });
  assert.deepEqual(parseRoute("#/series/muc-than-ky/content"), { screen: "series", id: "muc-than-ky", phase: "content" });
  assert.deepEqual(parseRoute("#/channel/es-horror/publish"), { screen: "channel", id: "es-horror", phase: "publish" });
  assert.deepEqual(parseRoute("#/channel/es-horror/story/story-001"), { screen: "channel", id: "es-horror", storyId: "story-001" });
});

test("parseRoute tolerates junk and legacy hashes", () => {
  assert.deepEqual(parseRoute("#/nope/what"), { screen: "projects" });
  assert.deepEqual(parseRoute("#/project"), { screen: "projects" });
  assert.deepEqual(parseRoute("#/project/demo-1/bogus"), { screen: "review-project", id: "demo-1", phase: "overview" });
  assert.deepEqual(parseRoute("#story-factory"), { screen: "projects", typeFilter: "channel" });
  assert.deepEqual(parseRoute("#series"), { screen: "projects", typeFilter: "series" });
  assert.deepEqual(parseRoute("#sources"), { screen: "sources" });
  assert.deepEqual(parseRoute("#config"), { screen: "config" });
  assert.deepEqual(parseRoute("#/project/demo%2F1"), { screen: "review-project", id: "demo/1", phase: "overview" });
});

test("routeHash is the inverse of parseRoute", () => {
  for (const route of [
    { screen: "projects" },
    { screen: "sources" },
    { screen: "config" },
    { screen: "review-project", id: "demo-1", phase: "content" },
    { screen: "series", id: "muc-than-ky", phase: "overview" },
    { screen: "channel", id: "es-horror", phase: "edit" },
    { screen: "channel", id: "es-horror", storyId: "story-001" },
  ]) {
    assert.deepEqual(parseRoute(routeHash(route)), route);
  }
});
