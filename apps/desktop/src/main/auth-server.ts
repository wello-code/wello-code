import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * One-shot loopback listener for the browser sign-in flow ("Войти через браузер").
 *
 * The app starts this listener on 127.0.0.1:<random port> with a 256-bit random
 * `state`, then opens https://wello.dev/code-auth?port=…&state=… in the system
 * browser. Under the site session that page mints a `wlo_live_…` key and POSTs
 * {state, key} here (a request BODY, never a URL — nothing lands in browser
 * history). We accept exactly one delivery with the matching state, resolve the
 * promise and shut down.
 *
 * Security posture: binds to 127.0.0.1 only; the state is the sole gate (a local
 * process that doesn't know it gets 403 — and one that could read our memory has
 * won already); CORS echoes ONLY the wello.dev origins, plus the
 * Private-Network-Access preflight header Chrome requires for public→loopback
 * fetches. After the first success/cancel/timeout the socket is closed for good.
 */

const AUTH_PATH = "/wello-code-auth";
/** Origins allowed to deliver the key (the /code-auth page lives on the apex). */
const ALLOWED_ORIGINS = new Set(["https://wello.dev", "https://www.wello.dev"]);
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** A {state, key} JSON is well under 4 KB; anything bigger is not our client. */
const MAX_BODY_BYTES = 16_384;

export class AuthCancelledError extends Error {
  constructor() {
    super("auth cancelled");
    this.name = "AuthCancelledError";
  }
}
export class AuthTimeoutError extends Error {
  constructor() {
    super("auth timed out");
    this.name = "AuthTimeoutError";
  }
}

export interface AuthListener {
  port: number;
  state: string;
  /** Resolves with the delivered key; rejects with AuthCancelled/AuthTimeoutError. */
  key: Promise<string>;
  cancel: () => void;
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...corsHeaders(req) });
  res.end(JSON.stringify(body));
}

/** Constant-time state comparison (equal length is part of the check). */
function stateMatches(expected: string, presented: unknown): boolean {
  if (typeof presented !== "string" || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}

/** Starts the listener; resolves once the OS assigned a port. */
export function startAuthListener(opts?: { timeoutMs?: number }): Promise<AuthListener> {
  const state = randomBytes(32).toString("hex");
  let settled = false;
  let resolveKey!: (key: string) => void;
  let rejectKey!: (err: Error) => void;
  const key = new Promise<string>((resolve, reject) => {
    resolveKey = resolve;
    rejectKey = reject;
  });
  // The renderer surfaces rejections as UI states; this bare handler just keeps
  // a cancel that races ahead of an await from becoming an unhandled rejection.
  key.catch(() => {});

  // `finish` closes over `server`/`timer` declared below — it can only run after
  // listen(), by which point both exist.
  const finish = (err: Error | null, deliveredKey?: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (err) rejectKey(err);
    else resolveKey(deliveredKey!);
    // Let the in-flight response flush, then close for good.
    setImmediate(() => server.close());
  };
  const timer = setTimeout(() => finish(new AuthTimeoutError()), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const server: Server = createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    if (url !== AUTH_PATH) {
      sendJson(req, res, 404, { error: "not_found" });
      return;
    }
    if (req.method === "OPTIONS") {
      // Chrome's Private Network Access preflight for a public→loopback fetch.
      res.writeHead(204, {
        ...corsHeaders(req),
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "300",
      });
      res.end();
      return;
    }
    if (req.method !== "POST") {
      sendJson(req, res, 405, { error: "method_not_allowed" });
      return;
    }

    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        sendJson(req, res, 413, { error: "too_large" });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      let body: { state?: unknown; key?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
      } catch {
        sendJson(req, res, 400, { error: "bad_json" });
        return;
      }
      if (!stateMatches(state, body.state)) {
        sendJson(req, res, 403, { error: "bad_state" });
        return;
      }
      const k = typeof body.key === "string" ? body.key.trim() : "";
      if (!k.startsWith("wlo_")) {
        sendJson(req, res, 400, { error: "bad_key" });
        return;
      }
      if (settled) {
        sendJson(req, res, 409, { error: "already_done" });
        return;
      }
      sendJson(req, res, 200, { ok: true });
      finish(null, k);
    });
  });

  return new Promise<AuthListener>((resolve, reject) => {
    server.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        clearTimeout(timer);
        server.close();
        reject(new Error("no port assigned"));
        return;
      }
      resolve({
        port: addr.port,
        state,
        key,
        cancel: () => finish(new AuthCancelledError()),
      });
    });
  });
}
