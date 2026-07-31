import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { buildWorkspaceDiagnostics } from "./diagnostics";
import { loadWorkspaceDefinition } from "./discovery";
import { getWorkspaceProvider } from "./localProvider";
import { isRegisteredWorkspace, listWorkspaces } from "./registry";
import { sanitizeUserText } from "./userErrors";
import { embeddedUiAssets } from "./uiEmbedded";
import { resolveWorkspace } from "./workspace";

/**
 * Local-only HTTP server behind `boot ui`. Serves the built launchpad app
 * plus a small JSON API over the same core functions the CLI uses. It binds
 * to 127.0.0.1 and only operates on workspaces present in the registry.
 * Core module: returns data and throws; it never prints.
 */

export const DEFAULT_UI_PORT = 4400;

export interface UiServerOptions {
  /** TCP port; 0 asks the OS for a free port. */
  port?: number;
  /** Directory with built UI assets. Falls back to embedded assets. */
  distDir?: string | null;
}

export interface RunningUiServer {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

const upRequestSchema = z.object({
  root: z.string().min(1),
  profile: z.string().min(1).optional(),
  runSetup: z.boolean().optional(),
  start: z.boolean().optional(),
});

const openRequestSchema = z.object({
  root: z.string().min(1),
});

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function contentTypeFor(requestPath: string): string {
  return CONTENT_TYPES[path.extname(requestPath).toLowerCase()] ?? "application/octet-stream";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_048_576) throw new Error("Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

/** Reject requests whose Host header is not local (DNS-rebinding guard). */
function isLocalHost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "";
}

async function requireRegisteredRoot(res: ServerResponse, root: string): Promise<string | null> {
  const absolute = path.resolve(root);
  if (!(await isRegisteredWorkspace(absolute))) {
    sendError(res, 403, "This workspace is not registered. Run `boot up <path>` once, then retry.");
    return null;
  }
  return absolute;
}

/* -------------------------------- API -------------------------------- */

async function handleListWorkspaces(res: ServerResponse): Promise<void> {
  const entries = await listWorkspaces();
  const workspaces = await Promise.all(
    entries.map(async (entry) => {
      const base = {
        root: entry.root,
        name: entry.name,
        lastUsedAt: entry.lastUsedAt,
        exists: entry.exists,
      };
      if (!entry.exists) return { ...base, profiles: [], defaultProfile: null, error: "folder is missing" };
      try {
        const definition = await loadWorkspaceDefinition(entry.root);
        return {
          ...base,
          name: definition.workspace.name,
          description: definition.workspace.description ?? null,
          profiles: Object.keys(definition.profiles ?? {}),
          defaultProfile:
            definition.defaults?.profile ?? (definition.profiles?.local ? "local" : null),
        };
      } catch (error) {
        return {
          ...base,
          profiles: [],
          defaultProfile: null,
          error: sanitizeUserText((error as Error).message),
        };
      }
    }),
  );
  sendJson(res, 200, { workspaces });
}

async function handleInspect(res: ServerResponse, url: URL): Promise<void> {
  const rootParam = url.searchParams.get("root");
  if (!rootParam) return sendError(res, 400, "Missing `root` query parameter.");
  const root = await requireRegisteredRoot(res, rootParam);
  if (!root) return;

  const profile = url.searchParams.get("profile") ?? undefined;
  const definition = await loadWorkspaceDefinition(root);
  const workspace = resolveWorkspace(definition, profile);
  const provider = getWorkspaceProvider("local");
  const plan = await provider.inspect(root, workspace);
  sendJson(res, 200, buildWorkspaceDiagnostics(plan));
}

/**
 * Prepare a workspace, streaming progress as NDJSON lines:
 *   {"type":"service", ...ServiceStartEvent}
 *   {"type":"result","ready":…,"applied":…,"failures":…,"diagnostics":…}
 */
async function handleUp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = upRequestSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return sendError(res, 400, "Invalid request body.");
  const root = await requireRegisteredRoot(res, parsed.data.root);
  if (!root) return;

  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  const writeLine = (line: unknown): void => {
    res.write(`${JSON.stringify(line)}\n`);
  };

  try {
    const definition = await loadWorkspaceDefinition(root);
    const workspace = resolveWorkspace(definition, parsed.data.profile);
    const provider = getWorkspaceProvider("local");
    const plan = await provider.plan(root, workspace);
    writeLine({ type: "plan", ready: plan.ready, blockers: plan.blockers });

    const result = await provider.apply(root, workspace, plan, {
      runSetup: parsed.data.runSetup,
      startServices: parsed.data.start,
      onServiceEvent: (event) => writeLine({ type: "service", ...event }),
    });
    writeLine({
      type: "result",
      ready: result.ready,
      applied: result.applied,
      failures: result.failures,
      diagnostics: buildWorkspaceDiagnostics(result.plan),
    });
  } catch (error) {
    writeLine({ type: "error", message: sanitizeUserText((error as Error).message) });
  }
  res.end();
}

interface IdeCandidate {
  label: string;
  command: string;
  args: (root: string) => string[];
}

/**
 * Editor launchers, most preferred first. The CLI shell commands are tried
 * first; on macOS `open -a` covers installs whose shell command was never
 * added to PATH.
 */
const IDE_CANDIDATES: IdeCandidate[] =
  process.platform === "win32"
    ? [
        { label: "Cursor", command: "cursor.cmd", args: (root) => [root] },
        { label: "VS Code", command: "code.cmd", args: (root) => [root] },
      ]
    : [
        { label: "Cursor", command: "cursor", args: (root) => [root] },
        { label: "VS Code", command: "code", args: (root) => [root] },
        ...(process.platform === "darwin"
          ? [
              { label: "Cursor", command: "open", args: (root: string) => ["-a", "Cursor", root] },
              {
                label: "VS Code",
                command: "open",
                args: (root: string) => ["-a", "Visual Studio Code", root],
              },
            ]
          : []),
      ];

/** Run a quick launcher command; true when it exits 0 (or detaches cleanly). */
function runLauncher(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // Editor CLIs fork the app and exit immediately. If one lingers, assume
    // it launched and let it keep running.
    const guard = setTimeout(() => {
      child.unref();
      resolve(true);
    }, 3000);
    child.once("error", () => {
      clearTimeout(guard);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(guard);
      resolve(code === 0);
    });
  });
}

async function handleOpenIde(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = openRequestSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) return sendError(res, 400, "Invalid request body.");
  const root = await requireRegisteredRoot(res, parsed.data.root);
  if (!root) return;

  for (const candidate of IDE_CANDIDATES) {
    if (await runLauncher(candidate.command, candidate.args(root))) {
      return sendJson(res, 200, { opened: candidate.label });
    }
  }
  sendError(res, 500, "No editor found (tried the `cursor` and `code` commands and installed apps).");
}

/* ------------------------------- static ------------------------------ */

async function serveStatic(
  res: ServerResponse,
  requestPath: string,
  distDir: string | null,
): Promise<void> {
  const cleaned = path.posix.normalize(requestPath).replace(/^(\.\.\/?)+/, "");
  // SPA fallback: extension-less routes render the app shell; asset paths 404.
  const candidates =
    cleaned === "/" || cleaned === "."
      ? ["/index.html"]
      : path.posix.extname(cleaned)
        ? [cleaned]
        : [cleaned, `${cleaned.replace(/\/$/, "")}/index.html`, "/index.html"];

  for (const candidate of candidates) {
    if (distDir) {
      const filePath = path.join(distDir, ...candidate.split("/").filter(Boolean));
      if (!filePath.startsWith(distDir)) continue;
      try {
        const contents = await fs.readFile(filePath);
        res.writeHead(200, { "content-type": contentTypeFor(candidate) });
        res.end(contents);
        return;
      } catch {
        // Try the next candidate.
      }
    }
    const embedded = embeddedUiAssets[candidate];
    if (embedded !== undefined) {
      res.writeHead(200, { "content-type": contentTypeFor(candidate) });
      res.end(Buffer.from(embedded, "base64"));
      return;
    }
  }

  sendError(
    res,
    404,
    "The boot ui assets were not found. Build them with `pnpm ui:build`, or use a release binary.",
  );
}

/* ------------------------------- server ------------------------------ */

export async function startUiServer(options: UiServerOptions = {}): Promise<RunningUiServer> {
  const distDir = options.distDir ? path.resolve(options.distDir) : null;

  const server = createServer((req, res) => {
    void (async () => {
      if (!isLocalHost(req)) return sendError(res, 403, "boot ui only accepts local requests.");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const route = `${req.method} ${url.pathname}`;
      try {
        if (route === "GET /api/workspaces") return await handleListWorkspaces(res);
        if (route === "GET /api/inspect") return await handleInspect(res, url);
        if (route === "POST /api/up") return await handleUp(req, res);
        if (route === "POST /api/open-ide") return await handleOpenIde(req, res);
        if (req.method === "GET") return await serveStatic(res, url.pathname, distDir);
        sendError(res, 404, "Not found.");
      } catch (error) {
        if (!res.headersSent) {
          sendError(res, 500, sanitizeUserText((error as Error).message));
        } else {
          res.end();
        }
      }
    })();
  });

  const port = options.port ?? DEFAULT_UI_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    server,
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
