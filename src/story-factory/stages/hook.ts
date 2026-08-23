import { optionalStringArray, parseJsonObject, requirePositiveNumber, requireText } from "../../llm/parse.ts";
import { buildHookMessages, HOOK_PROMPT_NAME, HOOK_PROMPT_VERSION } from "../prompts/hook.ts";
import { readStageArtifact, writeStageArtifact } from "../story-project.ts";
import type { HookArtifact, IdeaArtifact } from "../types.ts";
import { llmStage, promptContext, type StageContext } from "./context.ts";

export type ParsedHook = {
  hookText: string;
  altHooks: string[];
  estimatedSeconds: number;
};

export function parseHook(raw: string): ParsedHook {
  const payload = parseJsonObject(raw);
  return {
    hookText: requireText(payload.hookText, "hookText"),
    altHooks: optionalStringArray(payload.altHooks, "altHooks"),
    estimatedSeconds: requirePositiveNumber(payload.estimatedSeconds, "estimatedSeconds"),
  };
}

export async function runHookStage(ctx: StageContext): Promise<HookArtifact> {
  const idea = await readStageArtifact<IdeaArtifact>(ctx.channelId, ctx.storyId, "idea");
  if (!idea) {
    throw new Error("The hook stage needs a completed idea (idea.json is missing).");
  }
  const result = await llmStage(
    ctx,
    "hook",
    HOOK_PROMPT_NAME,
    HOOK_PROMPT_VERSION,
    buildHookMessages(promptContext(ctx), { logline: idea.logline, premise: idea.premise }),
    parseHook,
  );
  const artifact: HookArtifact = { version: 1, ...result.value, provenance: result.provenance };
  await writeStageArtifact(ctx.channelId, ctx.storyId, "hook", artifact);
  return artifact;
}
