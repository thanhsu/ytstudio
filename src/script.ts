import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadStudioConfig, type StudioConfig } from "./config.ts";
import { ensureProjectDir, projectDir, readJson, writeJson } from "./fs.ts";
import { buildDryRunScript, createDryRunProvider, type ScriptGeneration } from "./llm/dry-run.ts";
import { createOpenAiCompatibleProvider } from "./llm/openai-compatible.ts";
import type { LlmProvider } from "./llm/types.ts";
import type { VideoBrief } from "./types.ts";

export { buildDryRunScript };
export type { ScriptGeneration };

export type GenerateScriptOptions = {
  provider?: LlmProvider;
  confirmedPaidRequest?: boolean;
  signal?: AbortSignal;
};

export async function generateScript(
  projectId: string,
  options: GenerateScriptOptions = {},
): Promise<ScriptGeneration> {
  const brief = await readJson<VideoBrief>(join(projectDir(projectId), "brief.json"));
  const provider = options.provider ?? createConfiguredProvider(await loadStudioConfig());

  // Files are written only after the provider returns a validated result, so a
  // failed call leaves the previous script in place rather than a partial one.
  const result = await provider.generate(
    { projectId, brief, confirmedPaidRequest: options.confirmedPaidRequest === true },
    options.signal,
  );

  const dir = await ensureProjectDir(projectId);
  await writeFile(join(dir, "script.md"), result.script, "utf8");
  await writeJson(join(dir, "metadata.json"), result.metadata);
  await writeJson(join(dir, "scene-plan.json"), result.scenePlan);

  return { script: result.script, metadata: result.metadata, scenePlan: result.scenePlan };
}

export async function generateDryRunScript(projectId: string): Promise<ScriptGeneration> {
  return generateScript(projectId, { provider: createDryRunProvider() });
}

function createConfiguredProvider(config: StudioConfig): LlmProvider {
  if (config.script.provider === "openai-compatible") {
    return createOpenAiCompatibleProvider({
      baseUrl: config.script.baseUrl,
      model: config.script.model,
      apiKey: config.script.apiKeyEnv ? process.env[config.script.apiKeyEnv] ?? "" : "",
      paid: config.script.paid,
      temperature: config.script.temperature,
      maxOutputTokens: config.script.maxOutputTokens,
    });
  }
  return createDryRunProvider();
}
