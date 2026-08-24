import assert from "node:assert/strict";
import test from "node:test";
import { listRemoteVideos, getRemoteVideo, updateRemoteVideo, deleteRemoteVideo } from "../src/youtube/videos.ts";

const video = (id: string) => ({ id, snippet: { title: "Title", description: "Desc", tags: ["tag"], publishedAt: "2026-08-24T00:00:00Z", thumbnails: { default: { url: "https://img" } } }, status: { privacyStatus: "public" }, statistics: { viewCount: "4", likeCount: "2", commentCount: "1" } });

test("lists uploads through the channel uploads playlist and forwards page tokens", async () => {
  const urls: string[] = []; const result = await listRemoteVideos({ accessToken: "access", pageToken: "next", fetch: async (input) => { urls.push(String(input)); if (urls.length === 1) return new Response(JSON.stringify({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UU123" } } }] })); if (urls.length === 2) return new Response(JSON.stringify({ nextPageToken: "later", items: [{ contentDetails: { videoId: "v1" } }] })); return new Response(JSON.stringify({ items: [video("v1")] })); } });
  assert.match(urls[0], /channels\?part=contentDetails&mine=true/); assert.match(urls[1], /playlistItems\?part=contentDetails&playlistId=UU123.*pageToken=next/); assert.deepEqual(result.videos[0], { videoId: "v1", title: "Title", description: "Desc", tags: ["tag"], publishedAt: "2026-08-24T00:00:00Z", thumbnailUrl: "https://img", privacyStatus: "public", views: 4, likes: 2, comments: 1 }); assert.equal(result.nextPageToken, "later");
});

test("normalizes remote metadata and validates update and delete inputs", async () => {
  const result = await getRemoteVideo({ accessToken: "access", videoId: "v1", fetch: async () => new Response(JSON.stringify({ items: [video("v1")] })) });
  assert.equal(result.title, "Title"); assert.equal(result.views, 4); assert.equal(result.privacyStatus, "public");
  await assert.rejects(() => updateRemoteVideo({ accessToken: "access", videoId: "v1", metadata: { title: "", description: "", tags: [], privacyStatus: "public" }, fetch: async () => new Response(null) }), /youtube-invalid-metadata/);
  await assert.rejects(() => deleteRemoteVideo({ accessToken: "access", videoId: "v1", confirm: false, fetch: async () => new Response(null) }), /youtube-confirmation-required/);
  let method = ""; await deleteRemoteVideo({ accessToken: "access", videoId: "v1", confirm: true, fetch: async (_input, init) => { method = init?.method ?? ""; return new Response(null, { status: 204 }); } }); assert.equal(method, "DELETE");
});
