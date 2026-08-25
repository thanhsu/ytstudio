import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAuthUrl, exchangeCode, refreshAccessToken } from "../src/youtube/oauth.ts";
import { clearTokens, getFreshAccessToken, loadTokens, saveTokens } from "../src/youtube/token-store.ts";
import { createStudioServer, startStudioServer } from "../src/server.ts";

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("buildAuthUrl carries offline consent and encoded OAuth parameters", () => {
  const url = new URL(buildAuthUrl({
    clientId: "client id",
    redirectUri: "http://127.0.0.1:3000/api/youtube/oauth/callback",
    scopes: ["scope-a", "scope-b"],
    state: "channel.one",
  }));
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.pathname, "/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), "client id");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:3000/api/youtube/oauth/callback");
  assert.equal(url.searchParams.get("scope"), "scope-a scope-b");
  assert.equal(url.searchParams.get("state"), "channel.one");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
});

test("exchangeCode and refreshAccessToken post form bodies and compute expiry", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), body: String(init?.body) });
    return response({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "scope-a" });
  };
  const exchanged = await exchangeCode({ clientId: "client", clientSecret: "secret", redirectUri: "redirect", code: "code", fetch: fetchImpl });
  const refreshed = await refreshAccessToken({ clientId: "client", clientSecret: "secret", refreshToken: "refresh", fetch: fetchImpl });
  assert.equal(exchanged.accessToken, "access");
  assert.equal(exchanged.refreshToken, "refresh");
  assert.equal(refreshed.accessToken, "access");
  assert.ok(Date.parse(exchanged.expiresAt) > Date.now());
  assert.match(calls[0].body, /grant_type=authorization_code/);
  assert.match(calls[0].body, /code=code/);
  assert.match(calls[1].body, /grant_type=refresh_token/);
  assert.match(calls[1].body, /refresh_token=refresh/);
});

test("Google OAuth errors are surfaced without credential-shaped body content", async () => {
  await assert.rejects(
    () => exchangeCode({
      clientId: "client",
      clientSecret: "secret",
      redirectUri: "redirect",
      code: "code",
      fetch: async () => response({ error: "invalid_grant", api_key: "sk-secret-value" }, 400),
    }),
    (error: unknown) => error instanceof Error && /400/.test(error.message) && !error.message.includes("sk-secret-value"),
  );
});

test("token store round-trips, clears, and refreshes expired access tokens", async () => {
  const previous = process.env.YT_STUDIO_PROJECTS_DIR;
  const root = await mkdtemp(join(tmpdir(), "yt-youtube-token-"));
  process.env.YT_STUDIO_PROJECTS_DIR = root;
  try {
    const tokens = {
      version: 1 as const,
      refreshToken: "refresh",
      accessToken: "old-access",
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
      scope: "scope-a",
      connectedAt: "2026-08-24T00:00:00.000Z",
    };
    await saveTokens("es-horror", tokens);
    assert.deepEqual(await loadTokens("es-horror"), tokens);
    const fresh = await getFreshAccessToken("es-horror", {
      clientId: "client",
      clientSecret: "secret",
      fetch: async () => response({ access_token: "new-access", expires_in: 3600, scope: "scope-a" }),
    });
    assert.equal(fresh, "new-access");
    assert.equal((await loadTokens("es-horror"))?.accessToken, "new-access");
    await clearTokens("es-horror");
    assert.equal(await loadTokens("es-horror"), null);
    await assert.rejects(() => readFile(join(root, "es-horror", "workspace", "youtube", "tokens.json")));
  } finally {
    if (previous === undefined) delete process.env.YT_STUDIO_PROJECTS_DIR;
    else process.env.YT_STUDIO_PROJECTS_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("YouTube status/connect/disconnect routes expose local OAuth state", async () => {
  const previousCwd = process.cwd();
  const previousClient = process.env.YOUTUBE_CLIENT_ID;
  const previousSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const root = await mkdtemp(join(tmpdir(), "yt-youtube-route-"));
  process.chdir(root);
  process.env.YOUTUBE_CLIENT_ID = "client-id";
  process.env.YOUTUBE_CLIENT_SECRET = "client-secret";
  try {
    await mkdir("projects", { recursive: true });
    await writeFile("studio.config.json", JSON.stringify({ storyFactory: { enabled: true } }), "utf8");
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const status = await fetch(`${running.url}/api/series/es-horror/youtube/status`);
      assert.equal(status.status, 200);
      assert.deepEqual(await status.json(), { ok: true, connected: false, configured: true });

      const connect = await fetch(`${running.url}/api/series/es-horror/youtube/connect`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: JSON.stringify({}),
      });
      assert.equal(connect.status, 200);
      const authUrl = new URL((await connect.json()).authUrl);
      assert.equal(authUrl.searchParams.get("client_id"), "client-id");
      assert.match(authUrl.searchParams.get("state") ?? "", /^es-horror\./);

      const disconnected = await fetch(`${running.url}/api/series/es-horror/youtube/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: running.url },
        body: "{}",
      });
      assert.equal(disconnected.status, 200);
    } finally {
      await running.close();
    }
  } finally {
    process.chdir(previousCwd);
    if (previousClient === undefined) delete process.env.YOUTUBE_CLIENT_ID;
    else process.env.YOUTUBE_CLIENT_ID = previousClient;
    if (previousSecret === undefined) delete process.env.YOUTUBE_CLIENT_SECRET;
    else process.env.YOUTUBE_CLIENT_SECRET = previousSecret;
    await rm(root, { recursive: true, force: true });
  }
});
