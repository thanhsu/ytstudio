export type ImageAspectRatio = "16:9" | "1:1";

export type ImageRequest = {
  prompt: string;
  aspectRatio: ImageAspectRatio;
  /** Absolute path the provider writes the image bytes to. */
  outputPath: string;
  confirmedPaidRequest: boolean;
};

export type ImageArtifact = {
  provider: string;
  model: string;
  mimeType: string;
  createdAt: string;
};

export type ImageProvider = {
  readonly name: string;
  generate(request: ImageRequest, signal?: AbortSignal): Promise<ImageArtifact>;
};
