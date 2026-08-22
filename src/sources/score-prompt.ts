import type { ChatMessage } from "../llm/chat.ts";
import type { SourceCandidate } from "./store.ts";

const SYSTEM = [
  "You judge whether a source video is worth making an ORIGINAL review, recap, or analysis video about.",
  "You are not asked how to republish it, re-upload it, or reproduce it. Never propose those.",
  "You see metadata only: the video has not been downloaded and you have not watched it. Judge on what you are given and say so in the risks when the metadata is thin.",
  "",
  "Answer with a single JSON object and nothing else:",
  '{"value": <0-100>, "angle": "<the review angle you would take>", "hooks": ["<opening beats>"], "risks": ["<what could make this a bad choice>"], "reason": "<why this score>"}',
  "",
  "value is your judgement of how worth reviewing this is, where 0 is not worth it and 100 is exceptional.",
  "angle must describe original commentary, not a summary of the source.",
  "risks must be honest: thin metadata, an unclear topic, a saturated subject, or heavy spoiler exposure all belong there.",
].join("\n");

/**
 * Metadata only. Nothing has been downloaded when a candidate is scored, and the
 * prompt must not imply otherwise — a model told it has seen the video will
 * invent detail it cannot have.
 */
export function buildScorePrompt(candidate: SourceCandidate): ChatMessage[] {
  const user = [
    `Platform: ${candidate.platform}`,
    `Title: ${candidate.title}`,
    `Channel: ${candidate.uploader || "(not reported)"}`,
    `Duration: ${formatDuration(candidate.durationSeconds)}`,
    "Description:",
    candidate.description || "(none)",
  ].join("\n");

  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

function formatDuration(seconds: number): string {
  if (!seconds) return "(not reported)";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}
