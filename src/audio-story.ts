import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadBrandKit, type BrandKit } from "./brand-kit.ts";
import { ensureProjectDir, writeJson } from "./fs.ts";
import { validateProjectId } from "./project-paths.ts";

export type StoryCharacter = {
  name: string;
  role: string;
  traits: string[];
  voiceNotes: string;
};

export type StoryBible = {
  version: 1;
  seriesId: string;
  title: string;
  genre: string;
  premise: string;
  tone: string;
  audience: string;
  language: string;
  rules: string[];
  characters: StoryCharacter[];
  locations: string[];
  createdAt: string;
  updatedAt: string;
};

export type CreateStoryBibleInput = {
  title: string;
  genre: string;
  premise: string;
  tone: string;
  audience: string;
  language: string;
  rules?: string[];
  characters?: StoryCharacter[];
  locations?: string[];
};

export type StoryOutlineChapter = {
  chapterNumber: number;
  titleOptions: string[];
  hook: string;
  synopsis: string;
  conflict: string;
  endingHook: string;
  estimatedMinutes: number;
  status: "planned" | "drafted" | "approved";
};

export type StoryOutline = {
  version: 1;
  seriesId: string;
  storyTitle: string;
  targetMinutesPerChapter: number;
  chapters: StoryOutlineChapter[];
  createdAt: string;
  updatedAt: string;
};

export type StoryChapter = {
  version: 1;
  seriesId: string;
  chapterNumber: number;
  title: string;
  hook: string;
  narration: string;
  estimatedMinutes: number;
  titleOptions: string[];
  youtubeTitleOptions: string[];
  description: string;
  thumbnailText: string[];
  status: "draft" | "needs-review" | "approved";
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type StoryContinuityReport = {
  version: 1;
  seriesId: string;
  chapterNumber: number;
  blocked: boolean;
  findings: string[];
  reusedTerms: string[];
  checkedAt: string;
};

export type AudioStoryExportPackage = {
  manuscriptPath: string;
  chapterIndexPath: string;
  voiceOverSrtPath: string;
  youtubeMetadataPath: string;
};

export type AudioStoryWorkspace = {
  bible?: StoryBible;
  outline?: StoryOutline;
  chapters: StoryChapter[];
  continuityReports: StoryContinuityReport[];
  outputs: Record<string, string>;
};

export async function createStoryBible(seriesIdValue: string, input: CreateStoryBibleInput): Promise<StoryBible> {
  const seriesId = validateProjectId(seriesIdValue);
  await ensureAudioStoryDir(seriesId);
  const now = new Date().toISOString();
  const bible: StoryBible = {
    version: 1,
    seriesId,
    title: required(input.title, "title"),
    genre: required(input.genre, "genre"),
    premise: required(input.premise, "premise"),
    tone: required(input.tone, "tone"),
    audience: required(input.audience, "audience"),
    language: required(input.language, "language"),
    rules: normalizeStringArray(input.rules, [
      "Create an original story. Do not copy known novels, anime, donghua, films, or named characters.",
      "Keep continuity stable across chapters.",
    ]),
    characters: normalizeCharacters(input.characters),
    locations: normalizeStringArray(input.locations, []),
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(audioStoryPath(seriesId, "bible.json"), bible);
  return bible;
}

export async function loadAudioStoryWorkspace(seriesIdValue: string): Promise<AudioStoryWorkspace> {
  const seriesId = validateProjectId(seriesIdValue);
  const outputs = await readOptionalJson<Record<string, string>>(audioStoryPath(seriesId, "outputs.json")) ?? {};
  return {
    bible: await readOptionalJson<StoryBible>(audioStoryPath(seriesId, "bible.json")),
    outline: await readOptionalJson<StoryOutline>(audioStoryPath(seriesId, "outline.json")),
    chapters: await listChapters(seriesId),
    continuityReports: await listContinuityReports(seriesId),
    outputs,
  };
}

export async function generateStoryOutline(
  seriesIdValue: string,
  input: { chapterCount: number; targetMinutesPerChapter: number },
): Promise<StoryOutline> {
  const seriesId = validateProjectId(seriesIdValue);
  await ensureAudioStoryDir(seriesId);
  const bible = await requireBible(seriesId);
  const now = new Date().toISOString();
  const count = bounded(input.chapterCount, 1, 100, 10);
  const minutes = bounded(input.targetMinutesPerChapter, 3, 60, 12);
  const chapters = Array.from({ length: count }, (_, index) => buildOutlineChapter(bible, index + 1, minutes));
  const outline: StoryOutline = {
    version: 1,
    seriesId,
    storyTitle: bible.title,
    targetMinutesPerChapter: minutes,
    chapters,
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(audioStoryPath(seriesId, "outline.json"), outline);
  return outline;
}

export async function generateStoryChapter(seriesIdValue: string, chapterNumberValue: number): Promise<StoryChapter> {
  const seriesId = validateProjectId(seriesIdValue);
  await ensureAudioStoryDir(seriesId);
  await mkdir(audioStoryPath(seriesId, "chapters"), { recursive: true });
  const bible = await requireBible(seriesId);
  const outline = await requireOutline(seriesId);
  const chapterNumber = bounded(chapterNumberValue, 1, 999, 1);
  const outlineChapter = outline.chapters.find((chapter) => chapter.chapterNumber === chapterNumber) ??
    buildOutlineChapter(bible, chapterNumber, outline.targetMinutesPerChapter);
  const existing = await readOptionalJson<StoryChapter>(chapterPath(seriesId, chapterNumber));
  const now = new Date().toISOString();
  const title = outlineChapter.titleOptions[0] ?? `${bible.title} Chapter ${chapterNumber}`;
  const chapter: StoryChapter = {
    version: 1,
    seriesId,
    chapterNumber,
    title,
    hook: outlineChapter.hook,
    narration: buildChapterNarration(bible, outlineChapter),
    estimatedMinutes: outlineChapter.estimatedMinutes,
    titleOptions: outlineChapter.titleOptions,
    youtubeTitleOptions: [
      `${title} | Original Fantasy Audio Story`,
      `${bible.title} - Chapter ${chapterNumber}`,
      `A ${bible.genre} story for late-night listening`,
    ],
    description: `${bible.title} chapter ${chapterNumber}. Original ${bible.genre} audio story in ${bible.language}.`,
    thumbnailText: [bible.title, `Chapter ${chapterNumber}`, outlineChapter.conflict],
    status: "draft",
    revision: (existing?.revision ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await writeJson(chapterPath(seriesId, chapterNumber), chapter);
  await writeFile(chapterMarkdownPath(seriesId, chapterNumber), chapter.narration, "utf8");
  await markOutlineChapterDrafted(seriesId, chapterNumber);
  return chapter;
}

export async function checkStoryContinuity(
  seriesIdValue: string,
  chapterNumberValue: number,
): Promise<StoryContinuityReport> {
  const seriesId = validateProjectId(seriesIdValue);
  await ensureAudioStoryDir(seriesId);
  await mkdir(audioStoryPath(seriesId, "continuity"), { recursive: true });
  const bible = await requireBible(seriesId);
  const chapterNumber = bounded(chapterNumberValue, 1, 999, 1);
  const chapter = await readOptionalJson<StoryChapter>(chapterPath(seriesId, chapterNumber));
  if (!chapter) throw new Error(`Chapter ${chapterNumber} has not been generated.`);

  const narration = chapter.narration.toLowerCase();
  const characterNames = new Set(bible.characters.map((character) => character.name.toLowerCase()));
  const mentionedCharacters = [...characterNames].filter((name) => narration.includes(name.toLowerCase()));
  const knownFranchiseTerms = ["qin mu", "tales of herding gods", "muc than ky", "harry potter", "naruto"];
  const reusedTerms = knownFranchiseTerms.filter((term) => narration.includes(term));
  const findings = [
    mentionedCharacters.length > 0
      ? `Characters referenced from bible: ${mentionedCharacters.join(", ")}.`
      : "No bible character was referenced in narration.",
    reusedTerms.length > 0
      ? `Potentially risky known-story terms found: ${reusedTerms.join(", ")}.`
      : "No known franchise terms found by the local originality guard.",
  ];
  const report: StoryContinuityReport = {
    version: 1,
    seriesId,
    chapterNumber,
    blocked: reusedTerms.length > 0,
    findings,
    reusedTerms,
    checkedAt: new Date().toISOString(),
  };
  await writeJson(continuityPath(seriesId, chapterNumber), report);
  return report;
}

export async function exportAudioStoryPackage(seriesIdValue: string): Promise<AudioStoryExportPackage> {
  const seriesId = validateProjectId(seriesIdValue);
  await ensureAudioStoryDir(seriesId);
  const bible = await requireBible(seriesId);
  const brandKit = await loadBrandKit(seriesId);
  const chapters = await listChapters(seriesId);
  if (chapters.length === 0) throw new Error("At least one chapter is required before export.");

  const exportDir = audioStoryPath(seriesId, "exports");
  await mkdir(exportDir, { recursive: true });
  const manuscriptPath = "audio-story/exports/manuscript.md";
  const chapterIndexPath = "audio-story/exports/chapter-index.json";
  const voiceOverSrtPath = "audio-story/exports/voice-over.srt";
  const youtubeMetadataPath = "audio-story/exports/youtube-metadata.json";
  const exported: AudioStoryExportPackage = {
    manuscriptPath,
    chapterIndexPath,
    voiceOverSrtPath,
    youtubeMetadataPath,
  };

  await writeFile(join("projects", seriesId, manuscriptPath), buildManuscript(bible, chapters), "utf8");
  await writeJson(join("projects", seriesId, chapterIndexPath), chapters.map(chapterIndexEntry));
  await writeFile(join("projects", seriesId, voiceOverSrtPath), buildVoiceOverSrt(chapters), "utf8");
  await writeJson(join("projects", seriesId, youtubeMetadataPath), buildYoutubeMetadata(bible, chapters, brandKit));
  await writeJson(audioStoryPath(seriesId, "outputs.json"), {
    manuscript: manuscriptPath,
    chapterIndex: chapterIndexPath,
    voiceOverSrt: voiceOverSrtPath,
    youtubeMetadata: youtubeMetadataPath,
  });
  return exported;
}

function buildOutlineChapter(bible: StoryBible, chapterNumber: number, minutes: number): StoryOutlineChapter {
  const character = bible.characters[0]?.name ?? "the protagonist";
  const location = bible.locations[(chapterNumber - 1) % Math.max(1, bible.locations.length)] ?? "a place that should be defined";
  return {
    chapterNumber,
    titleOptions: [
      `${bible.title} - Chapter ${chapterNumber}: ${location}`,
      `Chapter ${chapterNumber}: The ${chapterNumber === 1 ? "First" : "Next"} Omen`,
      `${character}'s Choice`,
    ],
    hook: `${character} notices one detail in ${location} that changes the direction of the story.`,
    synopsis: `Chapter ${chapterNumber} advances the original ${bible.genre} premise: ${bible.premise}`,
    conflict: chapterNumber % 3 === 0 ? "trust breaks under pressure" : "a hidden rule creates a new cost",
    endingHook: `End with a question that makes chapter ${chapterNumber + 1} feel necessary.`,
    estimatedMinutes: minutes,
    status: "planned",
  };
}

function buildChapterNarration(bible: StoryBible, outline: StoryOutlineChapter): string {
  const character = bible.characters[0]?.name ?? "the protagonist";
  const rules = bible.rules.map((rule) => `- ${rule}`).join("\n");
  return [
    `# ${outline.titleOptions[0]}`,
    "",
    outline.hook,
    "",
    `${character} starts this chapter under a simple pressure: ${outline.conflict}.`,
    `The story stays inside the original premise: ${bible.premise}`,
    `Instead of rushing into a copied power fantasy, the narration keeps the tone ${bible.tone}.`,
    "",
    `By the middle, ${character} has to choose between safety and the truth behind ${outline.synopsis}.`,
    "The scene should leave room for ambience, pauses, and a clear audio-story rhythm.",
    "",
    `Continuity rules for this draft:\n${rules}`,
    "",
    outline.endingHook,
  ].join("\n");
}

async function markOutlineChapterDrafted(seriesId: string, chapterNumber: number): Promise<void> {
  const outline = await readOptionalJson<StoryOutline>(audioStoryPath(seriesId, "outline.json"));
  if (!outline) return;
  outline.chapters = outline.chapters.map((chapter) =>
    chapter.chapterNumber === chapterNumber ? { ...chapter, status: "drafted" } : chapter,
  );
  outline.updatedAt = new Date().toISOString();
  await writeJson(audioStoryPath(seriesId, "outline.json"), outline);
}

async function listChapters(seriesId: string): Promise<StoryChapter[]> {
  const dir = audioStoryPath(seriesId, "chapters");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((file) => /^chapter-\d{3}\.json$/.test(file));
  } catch {
    return [];
  }
  const chapters = await Promise.all(files.sort().map((file) => readJson<StoryChapter>(join(dir, file))));
  return chapters.sort((left, right) => left.chapterNumber - right.chapterNumber);
}

async function listContinuityReports(seriesId: string): Promise<StoryContinuityReport[]> {
  const dir = audioStoryPath(seriesId, "continuity");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((file) => /^chapter-\d{3}\.json$/.test(file));
  } catch {
    return [];
  }
  const reports = await Promise.all(files.sort().map((file) => readJson<StoryContinuityReport>(join(dir, file))));
  return reports.sort((left, right) => left.chapterNumber - right.chapterNumber);
}

async function requireBible(seriesId: string): Promise<StoryBible> {
  const bible = await readOptionalJson<StoryBible>(audioStoryPath(seriesId, "bible.json"));
  if (!bible) throw new Error("Story Bible is required.");
  return bible;
}

async function requireOutline(seriesId: string): Promise<StoryOutline> {
  const outline = await readOptionalJson<StoryOutline>(audioStoryPath(seriesId, "outline.json"));
  if (!outline) throw new Error("Story outline is required.");
  return outline;
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return await readJson<T>(path);
  } catch {
    return undefined;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function buildManuscript(bible: StoryBible, chapters: StoryChapter[]): string {
  return [`# ${bible.title}`, "", ...chapters.map((chapter) => `## ${chapter.title}\n\n${chapter.narration}`)].join("\n\n");
}

function buildVoiceOverSrt(chapters: StoryChapter[]): string {
  let cursor = 0;
  return `${chapters
    .map((chapter, index) => {
      const start = cursor;
      cursor += chapter.estimatedMinutes * 60;
      return `${index + 1}\n${formatTime(start)} --> ${formatTime(cursor)}\n${chapter.hook}`;
    })
    .join("\n\n")}\n`;
}

function buildYoutubeMetadata(bible: StoryBible, chapters: StoryChapter[], brandKit: BrandKit): Record<string, unknown> {
  return {
    titles: [
      `${bible.title} | Original ${bible.genre} Audio Story`,
      `${bible.title}: ${chapters.length} Chapter Audio Story`,
      `A ${bible.tone} Story For Night Listening`,
    ],
    description: `${bible.title} is an original ${bible.genre} audio story for ${bible.audience}.`,
    channel: {
      name: brandKit.channelName,
      handle: brandKit.handle,
      cta: brandKit.cta,
    },
    chapters: chapters.map((chapter, index) => ({
      time: formatChapterTime(chapters.slice(0, index).reduce((sum, item) => sum + item.estimatedMinutes * 60, 0)),
      title: chapter.title,
    })),
    thumbnailText: [bible.title, "Original Story", bible.genre],
    thumbnailBrand: {
      preset: brandKit.thumbnailPreset,
      primaryColor: brandKit.primaryColor,
      secondaryColor: brandKit.secondaryColor,
      accentColor: brandKit.accentColor,
      fontStyle: brandKit.fontStyle,
      watermarkPath: brandKit.watermarkPath,
      watermarkOpacity: brandKit.watermarkOpacity,
      safeTextRules: brandKit.safeTextRules,
    },
  };
}

function chapterIndexEntry(chapter: StoryChapter): Record<string, unknown> {
  return {
    chapterNumber: chapter.chapterNumber,
    title: chapter.title,
    estimatedMinutes: chapter.estimatedMinutes,
    status: chapter.status,
    revision: chapter.revision,
  };
}

function audioStoryPath(seriesId: string, ...parts: string[]): string {
  return join("projects", validateProjectId(seriesId), "audio-story", ...parts);
}

async function ensureAudioStoryDir(seriesId: string): Promise<void> {
  await ensureProjectDir(seriesId);
  await mkdir(audioStoryPath(seriesId), { recursive: true });
}

function chapterPath(seriesId: string, chapterNumber: number): string {
  return audioStoryPath(seriesId, "chapters", `chapter-${String(chapterNumber).padStart(3, "0")}.json`);
}

function chapterMarkdownPath(seriesId: string, chapterNumber: number): string {
  return audioStoryPath(seriesId, "chapters", `chapter-${String(chapterNumber).padStart(3, "0")}.md`);
}

function continuityPath(seriesId: string, chapterNumber: number): string {
  return audioStoryPath(seriesId, "continuity", `chapter-${String(chapterNumber).padStart(3, "0")}.json`);
}

function required(value: string, field: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error(`${field} is required.`);
  return trimmed;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function normalizeCharacters(value: unknown): StoryCharacter[] {
  if (!Array.isArray(value)) {
    return [{ name: "Main character", role: "protagonist", traits: ["curious"], voiceNotes: "clear and grounded" }];
  }
  return value.map((item) => {
    const candidate = item as Partial<StoryCharacter>;
    return {
      name: String(candidate.name ?? "Unnamed").trim(),
      role: String(candidate.role ?? "supporting role").trim(),
      traits: normalizeStringArray(candidate.traits, []),
      voiceNotes: String(candidate.voiceNotes ?? "").trim(),
    };
  });
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function formatTime(seconds: number): string {
  const totalMillis = Math.round(seconds * 1000);
  const millis = totalMillis % 1000;
  const totalSeconds = Math.floor(totalMillis / 1000);
  const secs = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${String(millis).padStart(3, "0")}`;
}

function formatChapterTime(seconds: number): string {
  const totalSeconds = Math.round(seconds);
  const secs = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${pad(secs)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
