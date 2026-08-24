import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolveProjectPath } from "../project-paths.ts";
import { refreshAccessToken, type TokenResponse } from "./oauth.ts";

const TOKEN_FILE = "workspace/youtube/tokens.json";

export type StoredTokens = {
  version: 1;
  refreshToken: string;
  accessToken: string;
  expiresAt: string;
  scope: string;
  connectedAt: string;
};

export async function loadTokens(channelId: string): Promise<StoredTokens | null> {
  try {
    const parsed = JSON.parse(await readFile(resolveProjectPath(channelId, ...TOKEN_FILE.split("/")), "utf8")) as Partial<StoredTokens>;
    if (parsed.version !== 1 || !parsed.refreshToken || !parsed.accessToken || !parsed.expiresAt) return null;
    return {
      version: 1,
      refreshToken: parsed.refreshToken,
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt,
      scope: typeof parsed.scope === "string" ? parsed.scope : "",
      connectedAt: typeof parsed.connectedAt === "string" ? parsed.connectedAt : new Date(0).toISOString(),
    };
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function saveTokens(channelId: string, tokens: StoredTokens): Promise<void> {
  const path = resolveProjectPath(channelId, ...TOKEN_FILE.split("/"));
  await mkdir(resolveProjectPath(channelId, "workspace", "youtube"), { recursive: true });
  await writeFile(path, `${JSON.stringify(tokens, null, 2)}\n`, "utf8");
}

export async function clearTokens(channelId: string): Promise<void> {
  await rm(resolveProjectPath(channelId, ...TOKEN_FILE.split("/")), { force: true });
}

export async function getFreshAccessToken(channelId: string, config: {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}): Promise<string> {
  const stored = await loadTokens(channelId);
  if (!stored) throw new Error("YouTube is not connected for this channel.");
  if (Date.parse(stored.expiresAt) - Date.now() >= 60_000) return stored.accessToken;
  const refreshed = await refreshAccessToken({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: stored.refreshToken,
    fetch: config.fetch,
  });
  await saveTokens(channelId, {
    ...stored,
    accessToken: refreshed.accessToken,
    expiresAt: refreshed.expiresAt,
    scope: refreshed.scope || stored.scope,
  });
  return refreshed.accessToken;
}

export function storedTokensFromResponse(response: TokenResponse, connectedAt = new Date().toISOString()): StoredTokens {
  if (!response.refreshToken) throw new Error("YouTube OAuth did not return a refresh token.");
  return {
    version: 1,
    refreshToken: response.refreshToken,
    accessToken: response.accessToken,
    expiresAt: response.expiresAt,
    scope: response.scope,
    connectedAt,
  };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
