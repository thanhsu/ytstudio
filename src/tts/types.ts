export type TtsFormat = "wav" | "mp3";

export type TtsRequest = {
  projectId: string;
  provider: "piper" | "openai";
  text: string;
  voice: string;
  format: TtsFormat;
  speed: number;
  instructions: string;
  confirmedPaidRequest: boolean;
};

export type TtsArtifact = {
  provider: string;
  cacheKey: string;
  relativePath: string;
  durationSeconds: number;
  createdAt: string;
  metadata: Record<string, string | number | boolean>;
};

export type TtsProvider = {
  readonly name: string;
  generate(request: TtsRequest, signal?: AbortSignal): Promise<TtsArtifact>;
};
