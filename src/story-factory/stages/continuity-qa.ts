import { parseJsonObject, requireObject, requireText } from "../../llm/parse.ts";
import { StoryContentError } from "../errors.ts";
import { buildContinuityMessages, CONTINUITY_PROMPT_NAME, CONTINUITY_PROMPT_VERSION } from "../prompts/continuity-qa.ts";
import { readStageArtifact, writeStageArtifact } from "../story-project.ts";
import type { BibleArtifact, ContinuityIssue, ContinuityReport, ScriptArtifact } from "../types.ts";
import { readSectionFile } from "./sections.ts";
import { llmStage, promptContext, renderBibleContext, renderNumberedScript, type StageContext } from "./context.ts";

export function parseContinuity(raw: string): { issues: ContinuityIssue[]; pass: boolean } {
  const payload = parseJsonObject(raw);
  const issuesValue = payload.issues;
  const issues: ContinuityIssue[] = Array.isArray(issuesValue)
    ? issuesValue.map((entry, index) => {
        const value = requireObject(entry, `issues[${index}]`);
        const sectionIndex = Math.round(Number(value.sectionIndex));
        return {
          severity: value.severity === "major" ? "major" : "minor",
          sectionIndex: Number.isFinite(sectionIndex) && sectionIndex > 0 ? sectionIndex : 0,
          description: requireText(value.description, `issues[${index}].description`),
          suggestion: requireText(value.suggestion, `issues[${index}].suggestion`),
        };
      })
    : [];
  const pass = payload.pass === true && !issues.some((issue) => issue.severity === "major");
  return { issues, pass };
}

export async function runContinuityStage(ctx: StageContext): Promise<ContinuityReport> {
  const script = await readStageArtifact<ScriptArtifact>(ctx.channelId, ctx.storyId, "sections");
  const bible = await readStageArtifact<BibleArtifact>(ctx.channelId, ctx.storyId, "bible");
  if (!script || !bible) {
    throw new Error("Continuity QA needs a completed script and bible.");
  }
  const sections = [];
  for (const entry of script.sections) {
    const section = await readSectionFile(ctx.channelId, ctx.storyId, entry.index);
    if (section) sections.push({ index: section.index, text: section.text });
  }
  const result = await llmStage(
    ctx,
    "continuity-qa",
    CONTINUITY_PROMPT_NAME,
    CONTINUITY_PROMPT_VERSION,
    buildContinuityMessages(promptContext(ctx), {
      bibleContext: renderBibleContext(bible),
      numberedScript: renderNumberedScript(sections),
    }),
    parseContinuity,
  );
  const report: ContinuityReport = { version: 1, ...result.value, provenance: result.provenance };
  // The report is written even when it fails, so the operator can read it.
  await writeStageArtifact(ctx.channelId, ctx.storyId, "continuity-qa", report);
  if (!report.pass) {
    const majors = report.issues.filter((issue) => issue.severity === "major");
    throw new StoryContentError(
      `Continuity QA found ${majors.length} major issue(s), e.g. section ${majors[0]?.sectionIndex}: ` +
        `${majors[0]?.description ?? "see continuity-report.json"} — regenerate the flagged section(s) or edit the script.`,
    );
  }
  return report;
}
