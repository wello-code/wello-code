import { randomBytes } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * A single loopback static file server for the preview pane. Binds 127.0.0.1 on an
 * ephemeral port ONLY (never 0.0.0.0), serves strictly under one resolved output
 * root, and gates every request behind an unguessable per-session path token so no
 * other local process can read the workspace through it. Real-server fidelity (ES
 * modules, relative assets) is why the preview uses an iframe over this rather than
 * file://. Reused/retargeted across workspaces — at most one server at a time.
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

interface State {
  server: Server;
  port: number;
  token: string;
  root: string;
  entry: string;
}
let state: State | null = null;

export interface PreviewHandle {
  url: string;
  entry: string;
}

/** Resolve a request path under `root`, rejecting any `..`/absolute escape. */
export function safeResolve(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const abs = resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

function urlFor(s: State): string {
  return `http://127.0.0.1:${s.port}/${s.token}/${s.entry}`;
}

export async function start(root: string, entry: string): Promise<PreviewHandle> {
  await stop();
  const token = randomBytes(16).toString("hex");
  const prefix = `/${token}`;
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const rest = pathname.slice(prefix.length) || "/";
    let target = safeResolve(root, rest);
    if (!target) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    let info;
    try {
      info = statSync(target);
    } catch {
      res.writeHead(404).end("Not found");
      return;
    }
    if (info.isDirectory()) {
      target = join(target, "index.html");
      try {
        statSync(target);
      } catch {
        res.writeHead(404).end("Not found");
        return;
      }
    }
    res.setHeader("Content-Type", MIME[extname(target).toLowerCase()] ?? "application/octet-stream");
    createReadStream(target)
      .on("error", () => {
        if (!res.headersSent) res.writeHead(404);
        res.end();
      })
      .pipe(res);
  });
  await new Promise<void>((ok, err) => {
    server.once("error", err);
    server.listen(0, "127.0.0.1", () => ok());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  state = { server, port, token, root, entry };
  return { url: urlFor(state), entry };
}

export async function stop(): Promise<void> {
  const s = state;
  state = null;
  if (s) await new Promise<void>((ok) => s.server.close(() => ok()));
}

export function current(): PreviewHandle | null {
  return state ? { url: urlFor(state), entry: state.entry } : null;
}
