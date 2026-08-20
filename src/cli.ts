import { createBrief } from "./brief.ts";
import { saveCopyrightCheck } from "./copyright.ts";
import { generateDryRunScript } from "./script.ts";
import type { CopyrightCheckInput, VideoFormat } from "./types.ts";

type Args = Record<string, string | boolean>;

function parseArgs(raw: string[]): { command: string; args: Args } {
  const [command = "help", ...rest] = raw;
  const args: Args = {};

  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) {
      continue;
    }

    const key = item.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }

  return { command, args };
}

function textArg(args: Args, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function numberArg(args: Args, key: string, fallback: number): number {
  const value = Number(textArg(args, key, String(fallback)));
  if (!Number.isFinite(value)) {
    throw new Error(`--${key} must be a number.`);
  }
  return value;
}

function boolArg(args: Args, key: string, fallback = false): boolean {
  const value = args[key];
  if (value === undefined) {
    return fallback;
  }
  if (value === true) {
    return true;
  }
  return ["true", "yes", "1", "y"].includes(value.toLowerCase());
}

function printHelp(): void {
  console.log(`YT Review Studio CLI

Commands:
  sample
    Create a sample Tales of Herding Gods project.

  create-brief --id <id> --topic <topic> --show <show> --format <shorts|longform> --audience <audience> --language <language> [--notes <notes>]
    Create projects/<id>/brief.json.

  generate-script --project <id>
    Generate dry-run script.md, metadata.json, and scene-plan.json.

  copyright-check --project <id> --commentary-percent <n> --footage-percent <n> --longest-clip-seconds <n> [--uses-full-scene true|false] [--thumbnail-from-frame true|false] [--clips-have-purpose true|false]
    Save a conservative copyright-risk checklist.
`);
}

async function run(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "sample") {
    const brief = await createBrief({
      id: "tales-herding-gods-qin-mu",
      topic: "Why Qin Mu is not your typical cultivation MC",
      show: "Tales of Herding Gods",
      format: "shorts",
      audience: "English-speaking donghua viewers in EU and Australia",
      language: "English",
      notes: "Use original commentary. Avoid replaying full scenes.",
    });
    await generateDryRunScript(brief.id);
    const check = await saveCopyrightCheck({
      projectId: brief.id,
      commentaryPercent: 70,
      footagePercent: 15,
      longestClipSeconds: 5,
      usesFullScene: false,
      thumbnailFromCopyrightFrame: false,
      clipsHaveCommentaryPurpose: true,
    });
    console.log(`Created sample project ${brief.id} with copyright risk ${check.risk}.`);
    return;
  }

  if (command === "create-brief") {
    const brief = await createBrief({
      id: textArg(args, "id"),
      topic: textArg(args, "topic"),
      show: textArg(args, "show"),
      format: textArg(args, "format", "shorts") as VideoFormat,
      audience: textArg(args, "audience"),
      language: textArg(args, "language", "English"),
      notes: textArg(args, "notes"),
    });
    console.log(`Created brief: projects/${brief.id}/brief.json`);
    return;
  }

  if (command === "generate-script") {
    const projectId = textArg(args, "project");
    if (!projectId) {
      throw new Error("--project is required.");
    }

    await generateDryRunScript(projectId);
    console.log(`Generated script files for ${projectId}.`);
    return;
  }

  if (command === "copyright-check") {
    const projectId = textArg(args, "project");
    if (!projectId) {
      throw new Error("--project is required.");
    }

    const input: CopyrightCheckInput = {
      projectId,
      commentaryPercent: numberArg(args, "commentary-percent", 70),
      footagePercent: numberArg(args, "footage-percent", 15),
      longestClipSeconds: numberArg(args, "longest-clip-seconds", 5),
      usesFullScene: boolArg(args, "uses-full-scene"),
      thumbnailFromCopyrightFrame: boolArg(args, "thumbnail-from-frame"),
      clipsHaveCommentaryPurpose: boolArg(args, "clips-have-purpose", true),
    };
    const result = await saveCopyrightCheck(input);
    console.log(`Copyright risk: ${result.risk} (score ${result.score})`);
    for (const finding of result.findings) {
      console.log(`- ${finding}`);
    }
    return;
  }

  printHelp();
  throw new Error(`Unknown command: ${command}`);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
