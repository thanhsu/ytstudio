import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveProjectPath } from "./project-paths.ts";
import { loadProjectState, setArtifact, sha256 } from "./project-state.ts";
import { parseSrt, stringifySrt, type SrtCue } from "./srt.ts";

export type YoutubeCaptionsResult = {
  projectId: string;
  srtRelativePath: string;
  vttRelativePath: string;
  cueCount: number;
};

const SRT_RELATIVE = "workspace/youtube/captions.srt";
const VTT_RELATIVE = "workspace/youtube/captions.vtt";

// YouTube's caption ingest handles plain text best; inline markup from editing
// tools renders as literal angle brackets in some players.
function sanitizeCueText(text: string): string {
  return text.replace(/<[^>\n]{1,60}>/g, "").replace(/[ \t]+$/gm, "").trim();
}

export function srtToVtt(srtContent: string): string {
  const cues = parseSrt(srtContent);
  const blocks = cues.map(
    (cue) => `${cue.start.replace(",", ".")} --> ${cue.end.replace(",", ".")}\n${cue.text}`,
  );
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

export async function prepareYoutubeCaptions(projectId: string): Promise<YoutubeCaptionsResult> {
  const state = await loadProjectState(projectId);
  const sourceRelative = state.artifacts["source-subtitles"]?.relativePath;
  if (!sourceRelative) {
    throw new Error("Import a source SRT before preparing YouTube captions.");
  }
  const cues = parseSrt(await readFile(resolveProjectPath(projectId, sourceRelative), "utf8"));
  if (cues.length === 0) {
    throw new Error("The source SRT has no cues.");
  }

  const sanitized: SrtCue[] = cues.map((cue, index) => ({
    index: index + 1,
    start: cue.start,
    end: cue.end,
    text: sanitizeCueText(cue.text),
  }));

  await mkdir(resolveProjectPath(projectId, join("workspace", "youtube")), { recursive: true });
  const srtContent = stringifySrt(sanitized);
  await writeFile(resolveProjectPath(projectId, SRT_RELATIVE), srtContent, "utf8");
  await writeFile(resolveProjectPath(projectId, VTT_RELATIVE), srtToVtt(srtContent), "utf8");

  const createdAt = new Date().toISOString();
  await setArtifact(projectId, {
    kind: "youtube-captions",
    sourceHash: sha256(`${sourceRelative}:${cues.length}:${createdAt}`),
    relativePath: SRT_RELATIVE,
    createdAt,
    metadata: { cueCount: sanitized.length, vttRelativePath: VTT_RELATIVE },
  });

  return { projectId, srtRelativePath: SRT_RELATIVE, vttRelativePath: VTT_RELATIVE, cueCount: sanitized.length };
}
