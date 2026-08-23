export type TtsFormat = "wav" | "mp3";

export type TtsRequest = {
  projectId: string;
  provider: "piper" | "openai" | "vietnamese-local" | "google";
  text: string;
  voice: string;
  format: TtsFormat;
  speed: number;
  instructions: string;
  confirmedPaidRequest: boolean;
  // Optional so requests written before these fields existed keep the exact
  // cache keys they were stored under (JSON.stringify drops undefined).
  languageCode?: string;
  pitch?: number;
  model?: string;
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
