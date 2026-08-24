import { spawn } from "node:child_process";

export type ProcessOptions = {
  cwd?: string;
  input?: string | Buffer;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** Called with each complete stdout line while the process is still running. */
  onStdoutLine?: (line: string) => void;
};

export type ProcessResult = {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

export class ProcessError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;

  constructor(message: string, result: ProcessResult) {
    super(message);
    this.name = "ProcessError";
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.durationMs = result.durationMs;
  }
}

export async function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  const startedAt = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      signal: options.signal,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    let pendingLine = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < maxOutputBytes) {
        stdoutChunks.push(chunk.subarray(0, Math.max(0, maxOutputBytes - stdoutBytes)));
      }
      stdoutBytes += chunk.length;
      if (options.onStdoutLine) {
        pendingLine += chunk.toString("utf8");
        const lines = pendingLine.split(/\r?\n/);
        pendingLine = lines.pop() ?? "";
        for (const line of lines) options.onStdoutLine(line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < maxOutputBytes) {
        stderrChunks.push(chunk.subarray(0, Math.max(0, maxOutputBytes - stderrBytes)));
      }
      stderrBytes += chunk.length;
    });

    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (options.onStdoutLine && pendingLine) options.onStdoutLine(pendingLine);

      const result: ProcessResult = {
        command,
        args,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: sanitizeOutput(Buffer.concat(stderrChunks).toString("utf8")),
        exitCode: code ?? -1,
        durationMs: Date.now() - startedAt,
      };

      if (result.exitCode !== 0) {
        reject(new ProcessError(`Process failed with exit code ${result.exitCode}: ${result.stderr}`, result));
        return;
      }

      resolve(result);
    });

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function sanitizeOutput(output: string): string {
  return output
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^\s"']+/gi, "$1[redacted]")
    .replace(/(token["']?\s*[:=]\s*["']?)[^\s"']+/gi, "$1[redacted]");
}
