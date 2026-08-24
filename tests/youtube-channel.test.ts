import assert from "node:assert/strict";
import test from "node:test";
import { getChannelProfile, assertRemoteChannelId } from "../src/youtube/channel.ts";

test("normalizes the first channel profile and tolerates missing fields", async () => {
  const profile = await getChannelProfile({
    accessToken: "access",
    fetch: async (input) => {
      assert.match(String(input), /channels\?part=snippet%2CcontentDetails%2Cstatistics&mine=true/);
      return new Response(JSON.stringify({ items: [{
        id: "UC123",
        snippet: { title: "My Channel", description: "About", customUrl: "@mine", thumbnails: { default: { url: "https://img" } } },
        contentDetails: { relatedPlaylists: { uploads: "UU123" } },
        statistics: { subscriberCount: "10", videoCount: "2", viewCount: "99" },
      }] }), { status: 200 });
    },
  });
  assert.deepEqual(profile, {
    id: "UC123", title: "My Channel", description: "About", customUrl: "@mine",
    thumbnailUrl: "https://img", uploadsPlaylistId: "UU123", subscriberCount: 10, videoCount: 2, viewCount: 99,
  });
});

test("returns a stable error for an empty channel response", async () => {
  await assert.rejects(() => getChannelProfile({ accessToken: "access", fetch: async () => new Response(JSON.stringify({ items: [] })) }), /youtube-channel-not-found/);
});

test("rejects rebinding a series to a different remote channel id", () => {
  assert.throws(() => assertRemoteChannelId("UC-old", "UC-new"), (error: unknown) =>
    error instanceof Error && error.message.includes("youtube-channel-mismatch") && /reconnect/i.test(error.message));
  assert.doesNotThrow(() => assertRemoteChannelId(null, "UC-new"));
});
