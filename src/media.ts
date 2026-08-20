import { access } from "node:fs/promises";
import { runProcess } from "./process.ts";

export type ToolStatus = {
  command: string;
  available: boolean;
  version: string;
  error?: string;
};

export async function probeDuration(filePath: string, ffprobePath = process.env.FFPROBE_PATH || "ffprobe"): Promise<number> {
  const result = await runProcess(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Unable to probe media duration for ${filePath}.`);
  }
  return duration;
}

export async function checkExecutable(command: string, versionArgs: string[] = ["--version"]): Promise<ToolStatus> {
  try {
    if (command.includes("/") || command.includes("\\")) {
      await access(command);
    }
    const result = await runProcess(command, versionArgs, { maxOutputBytes: 4096 });
    return {
      command,
      available: true,
      version: firstLine(result.stdout || result.stderr),
    };
  } catch (error: unknown) {
    return {
      command,
      available: false,
      version: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find(Boolean) ?? "";
}
