import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import Busboy from "busboy";
import { loadProjectState } from "./project-state.ts";
import { validateProjectId } from "./project-paths.ts";
import { TRANSLATION_PRESETS } from "./translation.ts";

export type StudioServerOptions = {
  projectsRoot?: string;
  staticRoot?: string;
};

export type RunningStudioServer = {
  server: http.Server;
  address: { address: string; port: number };
  url: string;
  close(): Promise<void>;
};

type ApiError = {
  code: string;
  message: string;
  action?: string;
  details?: unknown;
};

export function createStudioServer(options: StudioServerOptions = {}): http.Server {
  const projectsRoot = options.projectsRoot ?? "projects";
  const staticRoot = options.staticRoot ?? process.cwd();

  return http.createServer(async (request, response) => {
    try {
      await routeRequest(request, response, projectsRoot, staticRoot);
    } catch (error: unknown) {
      sendError(response, 500, {
        code: "internal-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export async function startStudioServer(
  server = createStudioServer(),
  options: { port?: number; host?: string } = {},
): Promise<RunningStudioServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to read server address.");
  }

  return {
    server,
    address: { address: address.address, port: address.port },
    url: `http://${address.address}:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  projectsRoot: string,
  staticRoot: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  if (method === "GET" && (url.pathname === "/" || url.pathname === "/styles.css" || url.pathname === "/app.js")) {
    await sendStatic(response, staticRoot, url.pathname);
    return;
  }

  if (method !== "GET" && !isSameOrigin(request)) {
    sendError(response, 403, { code: "same-origin-required", message: "Mutating requests require same-origin." });
    return;
  }

  if (method === "GET" && url.pathname === "/api/projects") {
    await sendProjects(response, projectsRoot);
    return;
  }

  if (method === "GET" && url.pathname === "/api/translation-presets") {
    sendJson(response, 200, {
      presets: Object.values(TRANSLATION_PRESETS),
      genres: ["cultivation", "fantasy-system", "modern-drama"],
    });
    return;
  }

  const projectMatch = /^\/api\/projects\/([a-z0-9-]+)(?:\/(.+))?$/.exec(url.pathname);
  if (!projectMatch) {
    sendError(response, 404, { code: "not-found", message: "Route not found." });
    return;
  }

  const projectId = validateProjectId(projectMatch[1]);
  const rest = projectMatch[2] ?? "";

  if (method === "GET" && rest === "") {
    await sendProject(response, projectsRoot, projectId);
    return;
  }

  if (method === "GET" && rest === "events") {
    await sendProjectEvents(response, projectId);
    return;
  }

  if (method === "POST" && rest === "voice") {
    const body = await readJsonBody(request);
    if (body.provider === "openai" && body.confirmedPaidRequest !== true) {
      sendError(response, 409, {
        code: "paid-confirmation-required",
        message: "OpenAI voice generation requires explicit paid confirmation.",
        action: "confirm-paid-request",
      });
      return;
    }
    sendJson(response, 202, { ok: true, queued: true });
    return;
  }

  if (method === "POST" && rest === "render") {
    const state = await loadProjectState(projectId);
    const reasons: string[] = [];
    if (!state.approvals.script) reasons.push("script-approval-missing");
    if (!state.approvals.copyright) reasons.push("copyright-approval-missing");
    if (state.approvals.script && !state.artifacts.voice) reasons.push("voice-missing");
    if (state.approvals.script && !state.artifacts.captions) reasons.push("captions-missing");

    if (reasons.length > 0) {
      sendError(response, 409, {
        code: "render-gates-unmet",
        message: "Render cannot start until required approvals and artifacts are ready.",
        details: { reasons },
      });
      return;
    }
    sendJson(response, 202, { ok: true, queued: true });
    return;
  }

  if (method === "POST" && rest === "assets") {
    await consumeUpload(request);
    sendJson(response, 202, { ok: true, queued: true });
    return;
  }

  sendError(response, 404, { code: "not-found", message: "Route not found." });
}

async function sendProjects(response: ServerResponse, projectsRoot: string): Promise<void> {
  let ids: string[] = [];
  try {
    ids = (await readdir(projectsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          validateProjectId(name);
          return true;
        } catch {
          return false;
        }
      });
  } catch {
    ids = [];
  }
  sendJson(response, 200, { projects: ids });
}

async function sendProject(response: ServerResponse, projectsRoot: string, projectId: string): Promise<void> {
  const briefPath = join(projectsRoot, projectId, "brief.json");
  const brief = JSON.parse(await readFile(briefPath, "utf8")) as unknown;
  const state = await loadProjectState(projectId);
  sendJson(response, 200, { brief, state });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    return {};
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 1024 * 1024) {
      throw new Error("JSON request body is too large.");
    }
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function consumeUpload(request: IncomingMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const busboy = Busboy({ headers: request.headers, limits: { fileSize: 250 * 1024 * 1024 } });
    busboy.on("file", (_name, file) => file.resume());
    busboy.on("error", reject);
    busboy.on("finish", resolve);
    request.pipe(busboy);
  });
}

function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  const host = request.headers.host;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendError(response: ServerResponse, status: number, error: ApiError): void {
  sendJson(response, status, error);
}

async function sendStatic(response: ServerResponse, staticRoot: string, pathname: string): Promise<void> {
  const relativePath = pathname === "/" ? "src/web/index.html" : `src/web${pathname}`;
  const root = resolve(staticRoot);
  const filePath = resolve(root, relativePath);

  if (!filePath.startsWith(root)) {
    sendError(response, 404, { code: "not-found", message: "Route not found." });
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    sendError(response, 404, { code: "not-found", message: "Route not found." });
  }
}

function contentTypeFor(filePath: string): string {
  const extension = extname(filePath);
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function sendProjectEvents(response: ServerResponse, projectId: string): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.write(`event: snapshot\ndata: ${JSON.stringify({ projectId, jobs: [] })}\n\n`);

  const heartbeat = setInterval(() => {
    response.write(": heartbeat\n\n");
  }, 15_000);

  response.on("close", () => clearInterval(heartbeat));
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  const port = Number(process.env.PORT ?? 3000);
  const running = await startStudioServer(createStudioServer(), { port });
  console.log(`YT Review Studio listening on ${running.url}`);
}
