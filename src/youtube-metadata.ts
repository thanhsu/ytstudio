import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadStudioConfig, unknownScriptProviderError } from "./config.ts";
import { chatJson } from "./llm/chat.ts";
import { parseJsonObject, requireArray, requireObject, requireStringArray, requireText } from "./llm/parse.ts";
import { projectDir, readJson } from "./fs.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { loadProjectState, setArtifact, sha256 } from "./project-state.ts";
import { parseSrt, type SrtCue } from "./srt.ts";
import type { VideoBrief } from "./types.ts";

export type YoutubeTitleOption = {
  type: "ctr" | "seo" | "balanced";
  title: string;
  reason: string;
};

export type YoutubeMetadata = {
  version: 1;
  summary: string;
  titles: YoutubeTitleOption[];
  description: string;
  tags: string[];
  provider: string;
  model: string;
  generatedAt: string;
};

const OUTPUT_DIR = join("workspace", "youtube");
const JSON_RELATIVE = "workspace/youtube/metadata.json";
const MD_RELATIVE = "workspace/youtube/metadata.md";
// Long features overflow model context; the head carries the setup and the tail
// carries the ending, which is what titles and descriptions are written from.
const MAX_TRANSCRIPT_CHARS = 60000;

export async function loadYoutubeMetadata(projectId: string): Promise<YoutubeMetadata | null> {
  try {
    return JSON.parse(await readFile(resolveProjectPath(projectId, JSON_RELATIVE), "utf8")) as YoutubeMetadata;
  } catch {
    return null;
  }
}

export async function findSourceSubtitlePath(projectId: string): Promise<string | null> {
  const state = await loadProjectState(projectId);
  const relative = state.artifacts["source-subtitles"]?.relativePath;
  if (!relative) return null;
  try {
    await readFile(resolveProjectPath(projectId, relative), "utf8");
    return relative;
  } catch {
    return null;
  }
}

export async function generateYoutubeMetadata(
  projectId: string,
  options: { confirmedPaidRequest?: boolean; signal?: AbortSignal; onProgress?: (progress: number, message: string) => Promise<void> },
): Promise<YoutubeMetadata> {
  const brief = await readJson<VideoBrief>(join(projectDir(projectId), "brief.json"));
  const subtitleRelative = await findSourceSubtitlePath(projectId);
  if (!subtitleRelative) {
    throw new Error("Import a source SRT before generating YouTube metadata.");
  }
  const cues = parseSrt(await readFile(resolveProjectPath(projectId, subtitleRelative), "utf8"));
  if (cues.length === 0) {
    throw new Error("The source SRT has no cues to read the story from.");
  }

  if (options.onProgress) await options.onProgress(10, "Reading the transcript");
  const transcript = buildTranscript(cues);

  const config = await loadStudioConfig();
  let metadata: YoutubeMetadata;
  if (config.script.provider === "dry-run") {
    metadata = buildDryRunMetadata(brief, cues);
  } else if (config.script.provider === "openai-compatible") {
    if (options.onProgress) await options.onProgress(30, `Asking ${config.script.model} for SEO metadata`);
    const raw = await chatJson(
      {
        baseUrl: config.script.baseUrl,
        model: config.script.model,
        apiKey: config.script.apiKeyEnv ? process.env[config.script.apiKeyEnv] ?? "" : "",
        apiKeyEnv: config.script.apiKeyEnv,
        paid: config.script.paid,
        temperature: config.script.temperature,
        maxOutputTokens: config.script.maxOutputTokens,
      },
      buildPrompt(brief, transcript),
      { confirmedPaidRequest: options.confirmedPaidRequest === true, signal: options.signal },
    );
    metadata = parseMetadataResponse(raw, config.script.provider, config.script.model);
  } else {
    throw unknownScriptProviderError(config.script.provider);
  }

  if (options.onProgress) await options.onProgress(85, "Saving metadata files");
  await mkdir(resolveProjectPath(projectId, OUTPUT_DIR), { recursive: true });
  await writeFile(resolveProjectPath(projectId, JSON_RELATIVE), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await writeFile(resolveProjectPath(projectId, MD_RELATIVE), renderMarkdown(brief, metadata), "utf8");
  await setArtifact(projectId, {
    kind: "youtube-metadata",
    sourceHash: sha256(`${subtitleRelative}:${metadata.generatedAt}`),
    relativePath: MD_RELATIVE,
    createdAt: metadata.generatedAt,
    metadata: { provider: metadata.provider, model: metadata.model, titleCount: metadata.titles.length },
  });
  return metadata;
}

function cueTimestamp(cue: SrtCue): string {
  return cue.start.slice(0, 8);
}

function buildTranscript(cues: SrtCue[]): string {
  const lines = cues.map((cue, index) => (index % 40 === 0 ? `[${cueTimestamp(cue)}] ${cue.text}` : cue.text));
  const full = lines.join("\n");
  if (full.length <= MAX_TRANSCRIPT_CHARS) return full;
  const head = full.slice(0, Math.floor(MAX_TRANSCRIPT_CHARS * 0.6));
  const tail = full.slice(-Math.floor(MAX_TRANSCRIPT_CHARS * 0.35));
  return `${head}\n[... middle of the transcript trimmed for length ...]\n${tail}`;
}

function buildPrompt(brief: VideoBrief, transcript: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content:
        "You are a YouTube SEO, CTR and thumbnail strategist. You answer with a single JSON object and nothing else. " +
        "Never invent plot points that are not in the transcript. Titles must comply with YouTube policies: no misleading claims, no all-caps spam.",
    },
    {
      role: "user",
      content: [
        `Market / audience: ${brief.audience}. Output language: ${brief.language}.`,
        `Topic: ${brief.topic}. Show: ${brief.show}. Format: ${brief.format}.`,
        "From the subtitle transcript below (timestamps appear as [HH:MM:SS] markers), produce JSON with exactly these fields:",
        `{"summary": "main characters, central conflict, strongest dramatic beats, and which details belong on the title/thumbnail",`,
        ` "titles": [{"type": "ctr", "title": "...", "reason": "..."}, {"type": "seo", ...}, {"type": "balanced", ...}],`,
        ` "description": "YouTube-ready description: first two lines keyword-strong, natural tone for the target market, a CHAPTERS block using real [HH:MM:SS] timestamps from the transcript, hashtags at the end",`,
        ` "tags": ["10-15 search tags"]}`,
        "",
        "TRANSCRIPT:",
        transcript,
      ].join("\n"),
    },
  ];
}

function parseMetadataResponse(raw: string, provider: string, model: string): YoutubeMetadata {
  const parsed = parseJsonObject(raw);
  const titles = requireArray(parsed.titles, "titles").map((entry) => {
    const title = requireObject(entry, "titles[]");
    const type = requireText(title.type, "titles[].type");
    if (type !== "ctr" && type !== "seo" && type !== "balanced") {
      throw new Error(`titles[].type must be ctr, seo, or balanced; got ${type}`);
    }
    const option: YoutubeTitleOption = {
      type,
      title: requireText(title.title, "titles[].title"),
      reason: requireText(title.reason, "titles[].reason"),
    };
    return option;
  });
  if (titles.length !== 3) {
    throw new Error(`Expected exactly 3 title options, got ${titles.length}.`);
  }
  return {
    version: 1,
    summary: requireText(parsed.summary, "summary"),
    titles,
    description: requireText(parsed.description, "description"),
    tags: requireStringArray(parsed.tags, "tags"),
    provider,
    model,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The offline template mirrors the real output's shape so the whole flow can be
 * exercised without a model: titles from the brief, chapters from evenly spaced
 * real cue timestamps.
 */
function buildDryRunMetadata(brief: VideoBrief, cues: SrtCue[]): YoutubeMetadata {
  const anchors = [0, 0.2, 0.4, 0.6, 0.8, 0.98]
    .map((ratio) => cues[Math.min(cues.length - 1, Math.floor(cues.length * ratio))])
    .map((cue) => `${cueTimestamp(cue)} ${cue.text.slice(0, 60)}`);
  const chapterBlock = ["CHAPTERS", ...anchors].join("\n");
  return {
    version: 1,
    summary:
      `Dry-run summary for "${brief.topic}" (${brief.show}): the transcript has ${cues.length} cues; ` +
      `opening beat "${cues[0].text.slice(0, 80)}", closing beat "${cues[cues.length - 1].text.slice(0, 80)}". ` +
      "Configure a real script model in Config to get an actual SEO analysis.",
    titles: [
      { type: "ctr", title: `${brief.topic} — You Won't Believe How It Ends | ${brief.show} Recap`, reason: "Dry-run placeholder tuned for curiosity; replace with a model-generated hook." },
      { type: "seo", title: `${brief.show} Full Recap: ${brief.topic} Explained`, reason: "Dry-run placeholder front-loading searchable keywords." },
      { type: "balanced", title: `${brief.topic} | ${brief.show} Recap (Full Story)`, reason: "Dry-run placeholder balancing hook and keywords." },
    ],
    description: [
      `${brief.topic} — a full recap of ${brief.show} for ${brief.audience}.`,
      `Watch the complete story explained in ${brief.language}.`,
      "",
      chapterBlock,
      "",
      "#recap #anime #fullstory",
    ].join("\n"),
    tags: ["recap", "full story", brief.show.toLowerCase(), brief.topic.toLowerCase(), "anime recap", "summary"],
    provider: "dry-run",
    model: "local-template",
    generatedAt: new Date().toISOString(),
  };
}

function renderMarkdown(brief: VideoBrief, metadata: YoutubeMetadata): string {
  return [
    `# YouTube metadata — ${brief.topic}`,
    "",
    `Generated ${metadata.generatedAt} by ${metadata.provider} · ${metadata.model}`,
    "",
    "## Summary",
    metadata.summary,
    "",
    "## Titles",
    ...metadata.titles.flatMap((title) => [`- **[${title.type.toUpperCase()}]** ${title.title}`, `  - Why: ${title.reason}`]),
    "",
    "## Description",
    "```",
    metadata.description,
    "```",
    "",
    "## Tags",
    metadata.tags.join(", "),
    "",
  ].join("\n");
}
