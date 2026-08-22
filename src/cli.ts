import { createBrief } from "./brief.ts";
import { saveCopyrightCheck } from "./copyright.ts";
import { generateSourceSrtFromAsr } from "./asr.ts";
import { extractAudioForAsr, importMedia } from "./media-ingest.ts";
import { generateDryRunScript, generateScript } from "./script.ts";
import { createStudioServer, startStudioServer } from "./server.ts";
import {
  buildTranslationDraft,
  importSubtitle,
  validateTranslation,
  type TranslationGenre,
  type TranslationLanguage,
} from "./translation.ts";
import { readFile } from "node:fs/promises";
import {
  approveCurrentCopyrightCheck,
  approveCurrentScript,
  approveEmptyAssetManifest,
  generateVoice,
  prepareCaptions,
  renderDraftProject,
} from "./workflow.ts";
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
  if (typeof value !== "string") {
    return fallback;
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

  generate-script --project <id> [--confirm-paid true]
    Generate script.md, metadata.json, and scene-plan.json with the configured
    script model. Pass --confirm-paid true to authorize spend on a paid model.

  copyright-check --project <id> --commentary-percent <n> --footage-percent <n> --longest-clip-seconds <n> [--uses-full-scene true|false] [--thumbnail-from-frame true|false] [--clips-have-purpose true|false]
    Save a conservative copyright-risk checklist.

  generate-voice --project <id> --provider <piper|openai|vietnamese-local> [--voice <name>] [--confirm-paid true]
    Approve the current script and generate voice. Local providers never fall back to paid APIs.

  prepare-captions --project <id>
    Build SRT captions from script narration and current voice duration.

  render-draft --project <id>
    Approve current asset/copyright files and render a vertical Shorts draft.

  import-srt --project <id> --file <path>
    Import a source SRT into the project workspace and validate basic format.

  import-media --project <id> --file <path>
    Copy an MP4/MOV/MKV/WebM source into the project workspace.

  extract-audio --project <id> [--media <workspace/media/source.mp4>]
    Extract mono 16k WAV audio from project media for local ASR.

  generate-asr-srt --project <id> [--provider <faster-whisper|whisper-cpp>] [--audio <workspace/media/asr-audio.wav>]
    Generate source.asr.srt from extracted audio with the configured local ASR tool.

  build-translation-prompt --project <id> --source <workspace/subtitles/source.srt> --target <vi|en-au|en-gb|pt-br|de> --genre <cultivation|fantasy-system|modern-drama>
    Create a reusable subtitle translation prompt that preserves SRT structure.

  validate-translation --source <path> --translated <path>
    Validate translated SRT cue count, timestamps, line length, and Chinese leftovers.

  studio [--port <n>]
    Start the local browser studio on 127.0.0.1.
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

    await generateScript(projectId, { confirmedPaidRequest: boolArg(args, "confirm-paid") });
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

  if (command === "generate-voice") {
    const projectId = requireProject(args);
    const provider = textArg(args, "provider", "piper");
    if (provider !== "piper" && provider !== "openai" && provider !== "vietnamese-local") {
      throw new Error("--provider must be piper, openai, or vietnamese-local.");
    }
    await approveCurrentScript(projectId);
    const artifact = await generateVoice({
      projectId,
      provider,
      voice: textArg(args, "voice", provider === "openai" ? "alloy" : "default"),
      confirmedPaidRequest: boolArg(args, "confirm-paid"),
    });
    console.log(`Generated ${artifact.provider} voice: projects/${projectId}/${artifact.relativePath}`);
    return;
  }

  if (command === "prepare-captions") {
    const projectId = requireProject(args);
    const artifact = await prepareCaptions(projectId);
    console.log(`Generated captions: projects/${projectId}/${artifact.relativePath}`);
    return;
  }

  if (command === "render-draft") {
    const projectId = requireProject(args);
    await approveEmptyAssetManifest(projectId);
    await approveCurrentCopyrightCheck(projectId);
    const artifact = await renderDraftProject(projectId);
    console.log(`Rendered draft: projects/${projectId}/${artifact.relativePath}`);
    return;
  }

  if (command === "import-srt") {
    const projectId = requireProject(args);
    const file = textArg(args, "file");
    if (!file) {
      throw new Error("--file is required.");
    }
    const imported = await importSubtitle(projectId, file);
    console.log(`Imported subtitles: projects/${projectId}/${imported.relativePath}`);
    console.log(`Cues: ${imported.cueCount}`);
    printValidation(imported.validation);
    return;
  }

  if (command === "import-media") {
    const projectId = requireProject(args);
    const file = textArg(args, "file");
    if (!file) {
      throw new Error("--file is required.");
    }
    const imported = await importMedia(projectId, file);
    console.log(`Imported media: projects/${projectId}/${imported.relativePath}`);
    console.log(`Original: ${imported.originalName}`);
    console.log(`Size: ${imported.sizeBytes} bytes`);
    return;
  }

  if (command === "extract-audio") {
    const projectId = requireProject(args);
    const artifact = await extractAudioForAsr(projectId, textArg(args, "media", "workspace/media/source.mp4"));
    console.log(`Extracted ASR audio: projects/${projectId}/${artifact.relativePath}`);
    return;
  }

  if (command === "generate-asr-srt") {
    const projectId = requireProject(args);
    const provider = textArg(args, "provider");
    if (provider && provider !== "faster-whisper" && provider !== "whisper-cpp") {
      throw new Error("--provider must be faster-whisper or whisper-cpp.");
    }
    const artifact = await generateSourceSrtFromAsr({
      projectId,
      provider: provider ? (provider as "faster-whisper" | "whisper-cpp") : undefined,
      audioRelativePath: textArg(args, "audio", "workspace/media/asr-audio.wav"),
    });
    console.log(`Generated ASR subtitles: projects/${projectId}/${artifact.relativePath}`);
    console.log(`Provider: ${artifact.provider}`);
    console.log(`Cues: ${artifact.cueCount}`);
    return;
  }

  if (command === "build-translation-prompt") {
    const projectId = requireProject(args);
    const source = textArg(args, "source");
    if (!source) {
      throw new Error("--source is required.");
    }
    const target = textArg(args, "target", "vi") as TranslationLanguage;
    const genre = textArg(args, "genre", "cultivation") as TranslationGenre;
    const draft = await buildTranslationDraft(projectId, source, target, genre);
    console.log(`Created translation prompt: projects/${projectId}/${draft.promptPath}`);
    console.log(`Cues: ${draft.cueCount}`);
    return;
  }

  if (command === "validate-translation") {
    const source = textArg(args, "source");
    const translated = textArg(args, "translated");
    if (!source || !translated) {
      throw new Error("--source and --translated are required.");
    }
    const result = validateTranslation(await readFile(source, "utf8"), await readFile(translated, "utf8"));
    printValidation(result);
    if (!result.valid) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "studio") {
    const port = numberArg(args, "port", 4317);
    const running = await startStudioServer(createStudioServer(), { port });
    console.log(`YT Review Studio listening on ${running.url}`);
    await new Promise(() => undefined);
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

function requireProject(args: Args): string {
  const projectId = textArg(args, "project");
  if (!projectId) {
    throw new Error("--project is required.");
  }
  return projectId;
}

function printValidation(result: { valid: boolean; errors: string[]; warnings: string[] }): void {
  console.log(`Valid: ${result.valid ? "yes" : "no"}`);
  for (const error of result.errors) {
    console.log(`ERROR: ${error}`);
  }
  for (const warning of result.warnings) {
    console.log(`WARN: ${warning}`);
  }
}
