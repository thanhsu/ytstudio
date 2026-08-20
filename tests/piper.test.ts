import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiperProvider } from "../src/tts/piper.ts";
import { sampleTtsRequest } from "./helpers.ts";

test("Piper writes a local draft without network fallback", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-review-studio-"));

  try {
    process.chdir(root);
    const recordPath = join(root, "piper-record.json");
    const modelPath = join(root, "voice.onnx");
    await writeFile(modelPath, "model", "utf8");
    const fakePiper = join(root, "fake-piper.mjs");
    await writeFile(
      fakePiper,
      `
import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("--output_file") + 1];
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => stdin += chunk);
process.stdin.on("end", async () => {
  await writeFile(${JSON.stringify(recordPath)}, JSON.stringify({ args, stdin }), "utf8");
  await writeFile(outputPath, "audio", "utf8");
});
`,
      "utf8",
    );

    const provider = createPiperProvider({
      executable: process.execPath,
      prefixArgs: [fakePiper],
      modelPath,
      probeDuration: async () => 1.25,
    });
    const artifact = await provider.generate(sampleTtsRequest());

    assert.equal(artifact.provider, "piper");
    assert.equal(artifact.durationSeconds, 1.25);
    assert.match(await readFile(recordPath, "utf8"), /--model/);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
