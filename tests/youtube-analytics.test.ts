import assert from "node:assert/strict";
import test from "node:test";
import { fetchVideoStats } from "../src/youtube/analytics.ts";

test("normalizes stats counters and redacts provider errors", async () => {
  const result = await fetchVideoStats({ accessToken: "access", videoIds: ["one", "two"], fetch: async () => new Response(JSON.stringify({ items: [{ id: "one", statistics: { viewCount: "12", likeCount: "3" } }, { id: "two", statistics: {} }] })) });
  assert.deepEqual([...result], [["one", { views: 12, likes: 3, comments: 0 }], ["two", { views: 0, likes: 0, comments: 0 }]]);
  await assert.rejects(() => fetchVideoStats({ accessToken: "access", videoIds: ["one"], fetch: async () => new Response("api_key=sk-secret-value", { status: 403 }) }), (error: unknown) => error instanceof Error && !error.message.includes("sk-secret-value"));
});
