import { join } from "node:path";
import { ensureProjectDir, writeJson } from "./fs.ts";
import type { CopyrightCheckInput, CopyrightCheckResult, CopyrightRisk } from "./types.ts";

export function evaluateCopyrightRisk(input: CopyrightCheckInput): CopyrightCheckResult {
  const findings: string[] = [];
  let score = 0;

  if (input.footagePercent > 35) {
    score += 35;
    findings.push("Footage percentage is high; original commentary may not be the main value.");
  } else if (input.footagePercent > 20) {
    score += 20;
    findings.push("Footage percentage is moderate; keep clips short and tied to commentary.");
  }

  if (input.commentaryPercent < 50) {
    score += 30;
    findings.push("Commentary percentage is low for a review video.");
  } else if (input.commentaryPercent < 65) {
    score += 15;
    findings.push("Commentary percentage is acceptable but should be stronger.");
  }

  if (input.longestClipSeconds > 15) {
    score += 25;
    findings.push("Longest source clip is too long for a conservative review workflow.");
  } else if (input.longestClipSeconds > 8) {
    score += 10;
    findings.push("Longest source clip is getting long; trim it if possible.");
  }

  if (input.usesFullScene) {
    score += 40;
    findings.push("Full scene usage is a major copyright risk.");
  }

  if (input.thumbnailFromCopyrightFrame) {
    score += 15;
    findings.push("Thumbnail relies on a copyrighted frame; use original design or licensed material.");
  }

  if (!input.clipsHaveCommentaryPurpose) {
    score += 30;
    findings.push("Some clips do not have a clear commentary purpose.");
  }

  const blocked = input.usesFullScene || input.footagePercent > 50 || input.longestClipSeconds > 30;
  const risk: CopyrightRisk = blocked
    ? "blocked"
    : score >= 60
      ? "high"
      : score >= 30
        ? "medium"
        : "low";

  if (findings.length === 0) {
    findings.push("No obvious risk flags from the declared usage.");
  }

  return {
    ...input,
    risk,
    score,
    blocked,
    findings,
    checkedAt: new Date().toISOString(),
  };
}

export async function saveCopyrightCheck(input: CopyrightCheckInput): Promise<CopyrightCheckResult> {
  const result = evaluateCopyrightRisk(input);
  const dir = await ensureProjectDir(input.projectId);
  await writeJson(join(dir, "copyright-check.json"), result);
  return result;
}
