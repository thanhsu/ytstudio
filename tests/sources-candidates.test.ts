import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { addCandidate } from "../src/sources/candidates.ts";
import { listCandidates, loadCandidate, saveCandidate } from "../src/sources/store.ts";
import { makeFakeExecutable, sampleCandidate, withSourcesRoot } from "./helpers.ts";

const PAYLOAD = {
  extractor_key: "Youtube",
  id: "dQw4w9WgXcQ",
  webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Episode 1",
  uploader: "Studio",
  duration: 1440,
  description: "First episode.",
};

async function ytDlpOptions(payload: unknown = PAYLOAD) {
  return {
    ytDlpPath: process.execPath,
    ytDlpArgs: [await makeFakeExecutable(`console.log(${JSON.stringify(JSON.stringify(payload))});`)],
  };
}

test("pasting the same video twice returns the first candidate", async () => {
  await withSourcesRoot(async () => {
    const first = await addCandidate("https://youtu.be/dQw4w9WgXcQ", await ytDlpOptions());
    const second = await addCandidate("https://www.youtube.com/watch?v=dQw4w9WgXcQ", await ytDlpOptions());

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.candidate.id, first.candidate.id);
    assert.equal(second.candidate.addedAt, first.candidate.addedAt);
    assert.equal((await listCandidates()).length, 1);
  });
});

test("a different video colliding on one id is refused, naming both", async () => {
  await withSourcesRoot(async () => {
    await saveCandidate({ ...sampleCandidate("youtube-dqw4w9wgxcq"), platformVideoId: "OTHERVIDEO" });
    const options = await ytDlpOptions();

    await assert.rejects(
      () => addCandidate("https://youtu.be/dQw4w9WgXcQ", options),
      (error: unknown) => /OTHERVIDEO/.test(String(error)) && /dQw4w9WgXcQ/.test(String(error)),
    );
  });
});

test("a directory with no candidate file cannot be created over", async () => {
  await withSourcesRoot(async (root) => {
    await mkdir(join(root, "youtube-dqw4w9wgxcq"), { recursive: true });
    const options = await ytDlpOptions();

    await assert.rejects(() => addCandidate("https://youtu.be/dQw4w9WgXcQ", options), /youtube-dqw4w9wgxcq/);
  });
});

test("a candidate starts with unknown rights, no score, and nothing downloaded", async () => {
  await withSourcesRoot(async () => {
    const { candidate } = await addCandidate("https://youtu.be/dQw4w9WgXcQ", await ytDlpOptions());

    assert.equal(candidate.rights, "unknown");
    assert.equal(candidate.rightsNote, "");
    assert.equal(candidate.status, "metadata");
    assert.equal(candidate.score, undefined);
    assert.equal(candidate.media, undefined);
    assert.equal(candidate.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

test("concurrent adds of one video still leave a single candidate", async () => {
  await withSourcesRoot(async () => {
    const [a, b] = await Promise.all([
      addCandidate("https://youtu.be/dQw4w9WgXcQ", await ytDlpOptions()),
      addCandidate("https://youtu.be/dQw4w9WgXcQ", await ytDlpOptions()),
    ]);

    assert.equal(a.candidate.id, b.candidate.id);
    assert.equal([a.created, b.created].filter(Boolean).length, 1);
    assert.equal((await listCandidates()).length, 1);
  });
});

test("a download is refused while rights are unknown, naming the candidate", async () => {
  const { assertDownloadable } = await import("../src/sources/candidates.ts");
  assert.throws(() => assertDownloadable(sampleCandidate("youtube-abc")), /youtube-abc/);
});

test("declaring rights records the note and permits the download", async () => {
  await withSourcesRoot(async () => {
    const { assertDownloadable, setCandidateRights } = await import("../src/sources/candidates.ts");
    await saveCandidate(sampleCandidate("youtube-abc"));

    const updated = await setCandidateRights("youtube-abc", "third-party-fair-use", "Review commentary only.");

    assert.equal(updated.rights, "third-party-fair-use");
    assert.equal(updated.rightsNote, "Review commentary only.");
    assert.doesNotThrow(() => assertDownloadable(updated));
    assert.equal((await loadCandidate("youtube-abc"))?.rights, "third-party-fair-use");
  });
});

test("an unrecognised rights value is refused rather than coerced", async () => {
  await withSourcesRoot(async () => {
    const { setCandidateRights } = await import("../src/sources/candidates.ts");
    await saveCandidate(sampleCandidate("youtube-abc"));

    await assert.rejects(() => setCandidateRights("youtube-abc", "whatever" as never, ""), /rights/);
    assert.equal((await loadCandidate("youtube-abc"))?.rights, "unknown");
  });
});

test("declaring rights on a candidate that does not exist is refused", async () => {
  await withSourcesRoot(async () => {
    const { setCandidateRights } = await import("../src/sources/candidates.ts");
    await assert.rejects(() => setCandidateRights("youtube-missing", "own", ""), /youtube-missing/);
  });
});
