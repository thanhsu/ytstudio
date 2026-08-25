import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { addCandidateFromSearchResult } from "../src/sources/candidates.ts";
import { downloadCandidate } from "../src/sources/download.ts";
import { searchSeedanceVideoAssets } from "../src/sources/seedance.ts";
import { loadCandidate, resolveSourcePath } from "../src/sources/store.ts";
import { setCandidateRights } from "../src/sources/candidates.ts";
import { withSourcesRoot } from "./helpers.ts";

const SEEDANCE_HTML = `
<script>
self.__next_f.push([1, "x", {"prompts":[
  {
    "slug":"seedance-night-market-8956",
    "title":"Korean Night Market Matrix Spill",
    "description":"A cinematic scene in a bustling night market.",
    "authorName":"Sairah",
    "thumbnail":"https://img.example/night.jpg",
    "videoUrl":"https://cms-assets.youmind.com/media/night-market.mp4",
    "categories":["commercial-product","romance-drama"],
    "modelVersion":"seedance-2.5",
    "generationMode":"text-to-video"
  },
  {
    "slug":"seedance-fitness-9001",
    "title":"Cinematic Fitness Gym Routine",
    "description":"A gym tracking shot.",
    "authorName":"Vera",
    "thumbnail":"https://img.example/gym.jpg",
    "videoUrl":"https://cms-assets.youmind.com/media/gym-routine.mp4",
    "categories":["sports"],
    "modelVersion":"seedance-2.5",
    "generationMode":"text-to-video"
  }
]}]);
</script>`;

const ESCAPED_SEEDANCE_HTML = `
<script>
self.__next_f.push([1, "x", "[\\"$\\",\\"$L17\\",null,{\\"prompts\\":[{\\"slug\\":\\"seedance-escaped-market\\",\\"title\\":\\"Escaped Night Market\\",\\"description\\":\\"A night market result embedded in a React stream.\\",\\"authorName\\":\\"Min\\",\\"thumbnail\\":\\"https://img.example/escaped.jpg\\",\\"videoUrl\\":\\"https://cms-assets.youmind.com/media/escaped-market.mp4\\",\\"githubVideoUrl\\":null,\\"categories\\":[\\"cinematic-film\\"]}]}]"]);
</script>`;

test("Seedance asset search extracts video URLs from prompt cards and filters by query", async () => {
  const results = await searchSeedanceVideoAssets("night market", {
    limit: 5,
    fetch: async () => new Response(SEEDANCE_HTML),
  });

  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    platform: "SeedancePrompt",
    platformVideoId: "seedance-night-market-8956",
    url: "https://cms-assets.youmind.com/media/night-market.mp4",
    title: "Korean Night Market Matrix Spill",
    uploader: "Sairah",
    durationSeconds: 0,
    viewCount: 0,
    thumbnailUrl: "https://img.example/night.jpg",
    sourcePageUrl: "https://www.bestseedanceprompts.com/prompts/seedance-night-market-8956",
    description: "A cinematic scene in a bustling night market.",
    categories: ["commercial-product", "romance-drama"],
  });
});

test("Seedance asset search handles escaped Next.js stream records from the live site", async () => {
  const results = await searchSeedanceVideoAssets("escaped night", {
    limit: 5,
    fetch: async () => new Response(ESCAPED_SEEDANCE_HTML),
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].platformVideoId, "seedance-escaped-market");
  assert.equal(results[0].url, "https://cms-assets.youmind.com/media/escaped-market.mp4");
  assert.deepEqual(results[0].categories, ["cinematic-film"]);
});

test("tracking a Seedance search result creates an unknown-rights candidate without yt-dlp", async () => {
  await withSourcesRoot(async () => {
    const result = (await searchSeedanceVideoAssets("fitness", {
      limit: 1,
      fetch: async () => new Response(SEEDANCE_HTML),
    }))[0];

    const added = await addCandidateFromSearchResult(result);
    const duplicate = await addCandidateFromSearchResult(result);

    assert.equal(added.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(added.candidate.id, "seedanceprompt-seedance-fitness-9001");
    assert.equal(added.candidate.canonicalUrl, "https://cms-assets.youmind.com/media/gym-routine.mp4");
    assert.equal(added.candidate.platform, "SeedancePrompt");
    assert.equal(added.candidate.rights, "unknown");
    assert.match(added.candidate.description, /Source page: https:\/\/www\.bestseedanceprompts\.com\/prompts\/seedance-fitness-9001/);
  });
});

test("a Seedance candidate downloads the direct video only after rights are declared", async () => {
  await withSourcesRoot(async () => {
    const result = (await searchSeedanceVideoAssets("fitness", {
      limit: 1,
      fetch: async () => new Response(SEEDANCE_HTML),
    }))[0];
    const added = await addCandidateFromSearchResult(result);

    await assert.rejects(
      () => downloadCandidate(added.candidate.id, { fetch: async () => new Response("video") }),
      /rights/,
    );

    await setCandidateRights(added.candidate.id, "third-party-fair-use", "Review commentary.");
    const downloaded = await downloadCandidate(added.candidate.id, {
      fetch: async () => new Response("seedance-video", { headers: { "content-type": "video/mp4" } }),
    });

    assert.equal(downloaded.status, "downloaded");
    assert.equal(downloaded.media?.videoRelativePath, "video.mp4");
    assert.equal(await readFile(resolveSourcePath(added.candidate.id, "video.mp4"), "utf8"), "seedance-video");
    assert.equal((await loadCandidate(added.candidate.id))?.media?.audioOnly, undefined);
  });
});
