import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVietnameseLocalProvider } from "../src/tts/vietnamese-local.ts";
import { sampleTtsRequest } from "./helpers.ts";

test("Vietnamese local TTS calls external Python app without paid fallback", async () => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-vietnamese-tts-"));

  try {
    process.chdir(root);
    const recordPath = join(root, "record.json");
    const fakeApp = join(root, "fake-app.mjs");
    await writeFile(
      fakeApp,
      `
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
const file = args[args.indexOf("--file") + 1];
const name = args[args.indexOf("--name") + 1];
const format = args[args.indexOf("--format") + 1];
await mkdir(out, { recursive: true });
await writeFile(${JSON.stringify(recordPath)}, JSON.stringify({ args, text: await readFile(file, "utf8") }), "utf8");
await writeFile(join(out, name + "." + format), "audio", "utf8");
`,
      "utf8",
    );

    const provider = createVietnameseLocalProvider({
      pythonPath: process.execPath,
      appPath: fakeApp,
      probeDuration: async () => 2.5,
    });
    const artifact = await provider.generate({
      ...sampleTtsRequest(),
      provider: "vietnamese-local",
      text: "Đây là bản đọc thử.",
      voice: "piper:Minh Quân (Vbee):model",
    });

    const record = JSON.parse(await readFile(recordPath, "utf8")) as { args: string[]; text: string };
    assert.equal(artifact.provider, "vietnamese-local");
    assert.equal(artifact.durationSeconds, 2.5);
    assert.equal(record.text, "Đây là bản đọc thử.");
    assert.ok(record.args.includes("--voice"));
    assert.match(await readFile(join(root, "projects", "sample-project", artifact.relativePath), "utf8"), /audio/);
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
