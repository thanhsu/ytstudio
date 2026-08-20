import { access, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { runProcess } from "./process.ts";

export type ToolStatus = {
  command: string;
  available: boolean;
  version: string;
  error?: string;
};

export async function probeDuration(filePath: string, ffprobePath = process.env.FFPROBE_PATH || "ffprobe"): Promise<number> {
  try {
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
  } catch (error: unknown) {
    if (extname(filePath).toLowerCase() === ".wav") {
      return probeWavDuration(filePath);
    }
    throw error;
  }
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

async function probeWavDuration(filePath: string): Promise<number> {
  const buffer = await readFile(filePath);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Unable to probe WAV duration for ${filePath}.`);
  }

  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "fmt ") {
      byteRate = buffer.readUInt32LE(chunkStart + 8);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
      break;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  const duration = dataSize / byteRate;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Unable to probe WAV duration for ${filePath}.`);
  }
  return duration;
}
