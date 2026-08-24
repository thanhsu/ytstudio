import { createWriteStream } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { parseSrt, stringifySrt } from "./srt.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { loadProjectState, setArtifact, sha256 } from "./project-state.ts";
import { runProcess } from "./process.ts";

export type VoiceoverSegment = {
  cueIndex: number;
  file: string;
  startMs: number;
  endMs: number;
};

export type VoiceoverManifest = {
  version: 1;
  timingRelativePath: string;
  segments: VoiceoverSegment[];
  missingCues: number[];
  createdAt: string;
};

export type VoiceoverImportResult = {
  projectId: string;
  cueCount: number;
  segmentCount: number;
  missingCues: number[];
  extraFiles: string[];
  timingRelativePath: string;
  manifestRelativePath: string;
};

const SEGMENT_FILE_PATTERN = /^(\d+)\.wav$/i;

export function srtTimestampToMs(value: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(value);
  if (!match) {
    throw new Error(`Invalid SRT timestamp: ${value}`);
  }
  return Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1000 + Number(match[4]);
}

export async function importVoiceoverSegments(input: {
  projectId: string;
  folderPath: string;
  srtPath?: string;
}): Promise<VoiceoverImportResult> {
  let srtPath = input.srtPath;
  if (!srtPath) {
    const state = await loadProjectState(input.projectId);
    const sourceSubtitles = state.artifacts["source-subtitles"];
    if (!sourceSubtitles) {
      throw new Error(
        "No SRT path was given and the project has no source subtitles. Import an SRT first or pass srtPath.",
      );
    }
    srtPath = resolveProjectPath(input.projectId, sourceSubtitles.relativePath);
  }
  const cues = parseSrt(await readFile(srtPath, "utf8"));
  if (cues.length === 0) {
    throw new Error("The timing SRT has no cues.");
  }

  const voiceoverDir = resolveProjectPath(input.projectId, join("workspace", "voiceover"));
  const segmentsDir = join(voiceoverDir, "segments");
  await mkdir(segmentsDir, { recursive: true });

  const timingRelativePath = "workspace/voiceover/timing.srt";
  await writeFile(join(voiceoverDir, "timing.srt"), stringifySrt(cues), "utf8");

  const fileByIndex = new Map<number, string>();
  for (const entry of await readdir(input.folderPath, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = SEGMENT_FILE_PATTERN.exec(entry.name);
    if (!match) continue;
    fileByIndex.set(Number(match[1]), entry.name);
  }

  const segments: VoiceoverSegment[] = [];
  const missingCues: number[] = [];
  const matchedFiles = new Set<string>();
  for (const cue of cues) {
    const file = fileByIndex.get(cue.index);
    if (!file) {
      missingCues.push(cue.index);
      continue;
    }
    matchedFiles.add(file);
    await copyFile(join(input.folderPath, file), join(segmentsDir, file));
    segments.push({
      cueIndex: cue.index,
      file,
      startMs: srtTimestampToMs(cue.start),
      endMs: srtTimestampToMs(cue.end),
    });
  }

  const extraFiles = [...fileByIndex.values()].filter((file) => !matchedFiles.has(file)).sort();

  const manifest: VoiceoverManifest = {
    version: 1,
    timingRelativePath,
    segments,
    missingCues,
    createdAt: new Date().toISOString(),
  };
  const manifestRelativePath = "workspace/voiceover/segments.json";
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(voiceoverDir, "segments.json"), manifestJson, "utf8");

  await setArtifact(input.projectId, {
    kind: "voiceover-segments",
    sourceHash: sha256(manifestJson),
    relativePath: manifestRelativePath,
    createdAt: manifest.createdAt,
    metadata: {
      cueCount: cues.length,
      segmentCount: segments.length,
      missingCueCount: missingCues.length,
    },
  });

  return {
    projectId: input.projectId,
    cueCount: cues.length,
    segmentCount: segments.length,
    missingCues,
    extraFiles,
    timingRelativePath,
    manifestRelativePath,
  };
}

export type VoiceoverRenderResult = {
  projectId: string;
  wavRelativePath: string;
  m4aRelativePath?: string;
  segmentCount: number;
  durationMs: number;
  warnings: string[];
};

type WavFormat = {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
};

type WavInfo = WavFormat & {
  dataOffset: number;
  dataBytes: number;
};

async function readWavInfo(path: string): Promise<WavInfo> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const head = Buffer.alloc(12);
    await handle.read(head, 0, 12, 0);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error(`Not a RIFF/WAVE file: ${path}`);
    }

    let format: WavFormat | undefined;
    let dataOffset = -1;
    let dataBytes = -1;
    let position = 12;
    const chunkHeader = Buffer.alloc(8);
    while (position + 8 <= size) {
      await handle.read(chunkHeader, 0, 8, position);
      const chunkId = chunkHeader.toString("ascii", 0, 4);
      const chunkSize = chunkHeader.readUInt32LE(4);
      if (chunkId === "fmt ") {
        const body = Buffer.alloc(16);
        await handle.read(body, 0, 16, position + 8);
        const audioFormat = body.readUInt16LE(0);
        if (audioFormat !== 1) {
          throw new Error(`Unsupported WAV encoding ${audioFormat} (expected PCM) in ${path}`);
        }
        format = {
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          bitsPerSample: body.readUInt16LE(14),
        };
      } else if (chunkId === "data") {
        dataOffset = position + 8;
        dataBytes = Math.min(chunkSize, size - dataOffset);
      }
      position += 8 + chunkSize + (chunkSize % 2);
    }

    if (!format || dataOffset < 0) {
      throw new Error(`Missing fmt or data chunk in ${path}`);
    }
    if (format.bitsPerSample !== 16) {
      throw new Error(`Unsupported bit depth ${format.bitsPerSample} (expected 16) in ${path}`);
    }
    return { ...format, dataOffset, dataBytes };
  } finally {
    await handle.close();
  }
}

function writeChunk(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

async function writeSilence(stream: Writable, bytes: number): Promise<void> {
  const blank = Buffer.alloc(Math.min(bytes, 65536));
  let remaining = bytes;
  while (remaining > 0) {
    const step = Math.min(remaining, blank.length);
    await writeChunk(stream, blank.subarray(0, step));
    remaining -= step;
  }
}

function wavHeader(format: WavFormat, dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE((format.sampleRate * format.channels * format.bitsPerSample) / 8, 28);
  header.writeUInt16LE((format.channels * format.bitsPerSample) / 8, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export async function renderVoiceoverTrack(input: {
  projectId: string;
  ffmpegPath?: string;
  ffmpegPrefixArgs?: string[];
  onProgress?: (progress: number, message: string) => Promise<void>;
}): Promise<VoiceoverRenderResult> {
  const voiceoverDir = resolveProjectPath(input.projectId, join("workspace", "voiceover"));
  const manifest = JSON.parse(
    await readFile(join(voiceoverDir, "segments.json"), "utf8"),
  ) as VoiceoverManifest;
  if (manifest.segments.length === 0) {
    throw new Error("No voiceover segments imported. Import segments before rendering.");
  }

  const warnings: string[] = manifest.missingCues.map(
    (cueIndex) => `Cue ${cueIndex} has no audio segment; the gap stays silent.`,
  );

  const segments = [...manifest.segments].sort((a, b) => a.startMs - b.startMs);
  const segmentsDir = join(voiceoverDir, "segments");
  const infos: WavInfo[] = [];
  for (const segment of segments) {
    infos.push(await readWavInfo(join(segmentsDir, segment.file)));
  }

  const format: WavFormat = {
    channels: infos[0].channels,
    sampleRate: infos[0].sampleRate,
    bitsPerSample: infos[0].bitsPerSample,
  };
  for (let i = 1; i < infos.length; i += 1) {
    if (
      infos[i].channels !== format.channels ||
      infos[i].sampleRate !== format.sampleRate ||
      infos[i].bitsPerSample !== format.bitsPerSample
    ) {
      throw new Error(
        `Segment ${segments[i].file} format (${infos[i].sampleRate}Hz/${infos[i].channels}ch/${infos[i].bitsPerSample}bit) ` +
          `differs from ${segments[0].file} (${format.sampleRate}Hz/${format.channels}ch/${format.bitsPerSample}bit).`,
      );
    }
  }

  const frameBytes = (format.channels * format.bitsPerSample) / 8;
  const placements = segments.map((segment, index) => {
    const startFrame = Math.round((segment.startMs / 1000) * format.sampleRate);
    return { segment, info: infos[index], startFrame, frames: Math.floor(infos[index].dataBytes / frameBytes) };
  });
  for (let i = 0; i < placements.length - 1; i += 1) {
    const current = placements[i];
    const nextStart = placements[i + 1].startFrame;
    if (current.startFrame + current.frames > nextStart) {
      const trimmedFrames = current.startFrame + current.frames - nextStart;
      current.frames = Math.max(0, nextStart - current.startFrame);
      warnings.push(
        `Segment ${current.segment.file} overlaps cue ${placements[i + 1].segment.cueIndex}; ` +
          `trimmed ${Math.round((trimmedFrames / format.sampleRate) * 1000)}ms from its tail.`,
      );
    }
  }

  const totalFrames = placements.reduce((max, p) => Math.max(max, p.startFrame + p.frames), 0);
  const wavRelativePath = "workspace/voiceover/voiceover.wav";
  const outputPath = join(voiceoverDir, "voiceover.wav");
  const stream = createWriteStream(outputPath);
  try {
    await writeChunk(stream, wavHeader(format, totalFrames * frameBytes));
    let cursorFrame = 0;
    for (let i = 0; i < placements.length; i += 1) {
      const placement = placements[i];
      if (placement.startFrame > cursorFrame) {
        await writeSilence(stream, (placement.startFrame - cursorFrame) * frameBytes);
      }
      if (placement.frames > 0) {
        const file = await readFile(join(segmentsDir, placement.segment.file));
        await writeChunk(
          stream,
          file.subarray(placement.info.dataOffset, placement.info.dataOffset + placement.frames * frameBytes),
        );
      }
      cursorFrame = placement.startFrame + placement.frames;
      if (input.onProgress && (i % 50 === 0 || i === placements.length - 1)) {
        await input.onProgress(
          Math.round(((i + 1) / placements.length) * 90),
          `Placed segment ${i + 1}/${placements.length}`,
        );
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }

  let m4aRelativePath: string | undefined;
  if (input.ffmpegPath) {
    if (input.onProgress) {
      await input.onProgress(92, "Encoding m4a copy");
    }
    try {
      await runProcess(input.ffmpegPath, [
        ...(input.ffmpegPrefixArgs ?? []),
        "-y",
        "-i",
        outputPath,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        join(voiceoverDir, "voiceover.m4a"),
      ]);
      m4aRelativePath = "workspace/voiceover/voiceover.m4a";
    } catch (error: unknown) {
      warnings.push(
        `m4a encode failed; the wav track is still available. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const durationMs = Math.round((totalFrames / format.sampleRate) * 1000);
  const createdAt = new Date().toISOString();
  await setArtifact(input.projectId, {
    kind: "voiceover-track",
    sourceHash: sha256(`${wavRelativePath}:${totalFrames}:${createdAt}`),
    relativePath: wavRelativePath,
    createdAt,
    metadata: {
      durationMs,
      segmentCount: segments.length,
      warningCount: warnings.length,
    },
  });

  return {
    projectId: input.projectId,
    wavRelativePath,
    m4aRelativePath,
    segmentCount: segments.length,
    durationMs,
    warnings,
  };
}
