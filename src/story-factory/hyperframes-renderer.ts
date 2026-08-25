import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../process.ts";
import type { HyperframesComposition } from "./hyperframes-composition.ts";

export type RenderHyperframesOptions = {
  workspacePath: string;
  command: string;
  args: string[];
  timeoutMinutes: number;
  composition: HyperframesComposition;
  outputFileName: string;
  signal?: AbortSignal;
};

export type HyperframesRenderResult = {
  engine: "hyperframes";
  videoPath: string;
  compositionPath: string;
  manifestPath: string;
};

export async function renderHyperframesStoryVideo(options: RenderHyperframesOptions): Promise<HyperframesRenderResult> {
  await mkdir(options.workspacePath, { recursive: true });
  const compositionPath = join(options.workspacePath, "index.html");
  const framePath = join(options.workspacePath, "frame.md");
  const manifestPath = join(options.workspacePath, "manifest.json");
  const outputPath = join(options.workspacePath, options.outputFileName);
  await writeFile(compositionPath, options.composition.html, "utf8");
  await writeFile(framePath, options.composition.frame, "utf8");
  await writeFile(manifestPath, JSON.stringify(options.composition.manifest, null, 2), "utf8");

  const timeoutController = new AbortController();
  const timeoutMs = Math.max(1, options.timeoutMinutes * 60_000);
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combinedSignal = combineSignals([options.signal, timeoutController.signal]);
  try {
    await runProcess(
      options.command,
      [...options.args, "render", "--output", outputPath, "."],
      { cwd: options.workspacePath, signal: combinedSignal },
    );
  } catch (error) {
    if (timeoutController.signal.aborted) {
      throw new Error(`Hyperframes render timed out after ${options.timeoutMinutes} minute(s).`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  await stat(outputPath);
  return { engine: "hyperframes", videoPath: outputPath, compositionPath, manifestPath };
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of active) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}
