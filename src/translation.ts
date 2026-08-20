import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { resolveProjectPath } from "./project-paths.ts";
import { setArtifact, sha256 } from "./project-state.ts";
import { compareSrtStructure, parseSrt, stringifySrt, validateSrt, type SrtCue } from "./srt.ts";

export type TranslationLanguage = "vi" | "en-au" | "en-gb" | "pt-br" | "de";
export type TranslationGenre = "cultivation" | "fantasy-system" | "modern-drama";

export type TranslationPreset = {
  language: TranslationLanguage;
  label: string;
  targetLanguage: string;
  audience: string;
};

export type TranslationPromptInput = {
  target: TranslationLanguage;
  genre: TranslationGenre;
  sourceName: string;
  srtContent: string;
  glossary?: Record<string, string>;
};

export type ImportedSubtitle = {
  relativePath: string;
  cueCount: number;
  validation: ReturnType<typeof validateSrt>;
};

export type TranslationDraft = {
  promptPath: string;
  sourcePath: string;
  target: TranslationLanguage;
  genre: TranslationGenre;
  cueCount: number;
};

export const TRANSLATION_PRESETS: Record<TranslationLanguage, TranslationPreset> = {
  vi: {
    language: "vi",
    label: "Vietnamese",
    targetLanguage: "Vietnamese",
    audience: "Vietnamese recap and review viewers",
  },
  "en-au": {
    language: "en-au",
    label: "English Australia",
    targetLanguage: "Australian English",
    audience: "English-speaking viewers in Australia",
  },
  "en-gb": {
    language: "en-gb",
    label: "English UK/EU",
    targetLanguage: "British English",
    audience: "English-speaking viewers in the UK and EU",
  },
  "pt-br": {
    language: "pt-br",
    label: "Portuguese Brazil",
    targetLanguage: "Brazilian Portuguese",
    audience: "Brazilian recap and review viewers",
  },
  de: {
    language: "de",
    label: "German",
    targetLanguage: "German for viewers in Germany",
    audience: "German recap and review viewers",
  },
};

const GENRE_STYLE: Record<TranslationGenre, string> = {
  cultivation:
    "Chinese donghua/cultivation fantasy with sects, realms, spiritual energy, revenge, ancient titles, and dramatic combat.",
  "fantasy-system":
    "Chinese fantasy/system stories with ranks, skills, beasts, game-like prompts, fast action, and clear system messages.",
  "modern-drama":
    "Chinese modern drama or short drama with direct dialogue, emotional conflict, family status, romance, and power reversals.",
};

export async function importSubtitle(projectId: string, sourcePath: string): Promise<ImportedSubtitle> {
  const raw = await readFile(sourcePath, "utf8");
  const cues = parseSrt(raw);
  const validation = validateSrt(cues);
  const relativePath = `workspace/subtitles/source-${Date.now()}-${safeFileName(basename(sourcePath))}`;
  const outputPath = resolveProjectPath(projectId, relativePath);
  await mkdir(dirname(outputPath), { recursive: true });
  const normalized = stringifySrt(cues);
  await writeFile(outputPath, normalized, "utf8");
  await setArtifact(projectId, {
    kind: "source-subtitles",
    sourceHash: sha256(normalized),
    relativePath,
    createdAt: new Date().toISOString(),
    metadata: {
      cueCount: cues.length,
      sourceName: basename(sourcePath),
    },
  });
  return { relativePath, cueCount: cues.length, validation };
}

export async function buildTranslationDraft(
  projectId: string,
  sourceRelativePath: string,
  target: TranslationLanguage,
  genre: TranslationGenre,
): Promise<TranslationDraft> {
  const sourcePath = resolveProjectPath(projectId, sourceRelativePath);
  const srtContent = await readFile(sourcePath, "utf8");
  const prompt = buildTranslationPrompt({
    target,
    genre,
    sourceName: basename(sourceRelativePath),
    srtContent,
  });
  const promptRelativePath = `workspace/translation/${target}-${genre}-prompt.md`;
  const promptPath = resolveProjectPath(projectId, promptRelativePath);
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, prompt, "utf8");
  return {
    promptPath: promptRelativePath,
    sourcePath: sourceRelativePath,
    target,
    genre,
    cueCount: parseSrt(srtContent).length,
  };
}

export function buildTranslationPrompt(input: TranslationPromptInput): string {
  const preset = TRANSLATION_PRESETS[input.target];
  const glossaryLines = Object.entries(input.glossary ?? {})
    .map(([source, target]) => `- ${source} = ${target}`)
    .join("\n");

  return `You are a professional subtitle editor for Chinese film and donghua recap videos.

Task: translate the SRT file "${input.sourceName}" into ${preset.targetLanguage} for ${preset.audience}.

Hard rules:
1. Keep every cue number exactly unchanged.
2. Keep every timestamp exactly unchanged.
3. Do not merge cues.
4. Do not split cues.
5. Do not reorder dialogue.
6. Translate only subtitle dialogue text.
7. Preserve valid SRT format.
8. Leave no Chinese characters in the final translation.
9. Add no explanations, notes, markdown, or comments outside the SRT.
10. Return only the translated SRT content.

Style:
- Make the translation natural, short, and easy to read at video speed.
- Avoid stiff literal translation.
- Preserve character emotion, threat, irony, romance, and hierarchy.
- For tense scenes, use direct and forceful phrasing.
- For emotional scenes, keep feeling without making it melodramatic.
- Shorten lines that are too long for their time window without changing the meaning.

Genre context:
${GENRE_STYLE[input.genre]}

Names and terms:
- Keep character names consistent throughout the file.
- Do not translate names as ordinary words.
- Choose pronouns and forms of address from character relationships and context.
- If gender or relationship is unclear, prefer a neutral phrasing over guessing.
${glossaryLines ? `\nGlossary:\n${glossaryLines}\n` : ""}
Final self-check before output:
- Cue count is unchanged.
- Timestamps are unchanged.
- No Chinese characters remain.
- Names and terms are consistent.
- The file is still valid SRT.

SRT to translate:
${input.srtContent}`;
}

export function validateTranslation(sourceContent: string, translatedContent: string) {
  const source = parseSrt(sourceContent);
  const translated = parseSrt(translatedContent);
  const format = validateSrt(translated, { requireNoChinese: true });
  const structure = compareSrtStructure(source, translated);
  return {
    valid: format.valid && structure.valid,
    errors: [...format.errors, ...structure.errors],
    warnings: [...format.warnings, ...structure.warnings],
    cueCount: translated.length,
  };
}

export function replaceCueText(source: SrtCue[], replacements: Map<number, string>): string {
  return stringifySrt(source.map((cue) => ({ ...cue, text: replacements.get(cue.index) ?? cue.text })));
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "source.srt";
}
