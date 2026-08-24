import { normalizeYouTubeError } from "./errors.ts";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const pendingStates = new Map<string, { channelId: string; expiresAt: number }>();

export type TokenResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scope: string;
};

type OAuthFetch = typeof fetch;

export function buildAuthUrl(options: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: options.scopes.join(" "),
    state: options.state,
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return url.toString();
}

export function rememberOAuthState(state: string, channelId: string, now = Date.now()): void {
  pendingStates.set(state, { channelId, expiresAt: now + 10 * 60 * 1000 });
}

export function consumeOAuthState(state: string, now = Date.now()): string | null {
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  if (!entry || entry.expiresAt < now) return null;
  return entry.channelId;
}

export async function exchangeCode(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetch?: OAuthFetch;
}): Promise<TokenResponse> {
  return requestToken(new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
    code: options.code,
    grant_type: "authorization_code",
  }), options.fetch);
}

export async function refreshAccessToken(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: OAuthFetch;
}): Promise<TokenResponse> {
  return requestToken(new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    refresh_token: options.refreshToken,
    grant_type: "refresh_token",
  }), options.fetch);
}

async function requestToken(body: URLSearchParams, fetchImpl: OAuthFetch = fetch): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (error: unknown) {
    const mapped = normalizeYouTubeError(error);
    throw new Error(`${mapped.code}: YouTube OAuth token request failed.`);
  }
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // The redacted text below remains useful when Google returns non-JSON.
  }
  if (!response.ok) {
    const mapped = normalizeYouTubeError({ response: { status: response.status, body: raw } });
    throw new Error(`${mapped.code}: ${mapped.message}`);
  }
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!accessToken) throw new Error("YouTube OAuth token response did not contain access_token.");
  const expiresIn = Number(payload.expires_in);
  const expiresAt = new Date(Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000).toISOString();
  return {
    accessToken,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
    expiresAt,
    scope: typeof payload.scope === "string" ? payload.scope : "",
  };
}
