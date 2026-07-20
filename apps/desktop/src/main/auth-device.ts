/**
 * Browser sign-in via a device-authorization flow.
 *
 * Replaces the 127.0.0.1 loopback listener this app used to run. That design had
 * the wello.dev page POST the freshly minted key straight into our process, and
 * it simply cannot work on macOS: Safari refuses to let an https page fetch
 * http://127.0.0.1 (mixed content, no override), and Chrome now hides the same
 * call behind a Private Network Access permission. Mac users always saw
 * "Не удалось передать доступ приложению".
 *
 * Now the browser is out of the delivery path. We ask the gateway to open a
 * session, keep the `device_code` here (it never reaches the browser), open the
 * page with only the session's public half, and poll over HTTPS until the user
 * approves. Works in every browser, and even if the user approves on a different
 * device.
 *
 * The shape mirrors the listener it replaces — `{ key, cancel }` plus the same
 * cancel/timeout error types — so the sign-in call site did not have to change.
 */

const BASE_URL = "https://api.wello.dev";
/** Fallback pacing if the server does not advertise an interval. */
const DEFAULT_INTERVAL_MS = 2000;
/** Give up well before a human would; the server session expires around 10 min. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

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
/** The session died server-side (expired, or already collected). */
export class AuthExpiredError extends Error {
  constructor() {
    super("auth session expired");
    this.name = "AuthExpiredError";
  }
}

export interface BrowserSignIn {
  /** Where to send the user; already carries the session's public code. */
  verifyUrl: string;
  /** Resolves with the `wlo_live_…` key, or rejects with one of the errors above. */
  key: Promise<string>;
  cancel: () => void;
}

interface StartResponse {
  device_code?: unknown;
  user_code?: unknown;
  verify_url?: unknown;
  interval?: unknown;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AuthCancelledError());
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new AuthCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Opens a sign-in session. Rejects if the gateway will not start one; otherwise
 * the caller opens {@link BrowserSignIn.verifyUrl} and awaits `key`.
 */
export async function startBrowserSignIn(opts?: {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<BrowserSignIn> {
  const doFetch = opts?.fetchImpl ?? fetch;

  const res = await doFetch(`${BASE_URL}/code/v1/auth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`start failed (${res.status})`);
  const body = (await res.json()) as StartResponse;

  const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
  const userCode = typeof body.user_code === "string" ? body.user_code : "";
  if (!deviceCode || !userCode) throw new Error("start returned no session");

  const verifyUrl =
    typeof body.verify_url === "string" && body.verify_url.startsWith("https://")
      ? body.verify_url
      : `https://wello.dev/code-auth?code=${encodeURIComponent(userCode)}`;
  const intervalMs =
    typeof body.interval === "number" && body.interval > 0
      ? Math.min(Math.max(body.interval, 1), 30) * 1000
      : DEFAULT_INTERVAL_MS;

  const controller = new AbortController();
  const deadline = Date.now() + (opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const key = (async (): Promise<string> => {
    for (;;) {
      if (controller.signal.aborted) throw new AuthCancelledError();
      if (Date.now() >= deadline) throw new AuthTimeoutError();

      await sleep(intervalMs, controller.signal);

      let poll: Response;
      try {
        poll = await doFetch(`${BASE_URL}/code/v1/auth/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: deviceCode }),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new AuthCancelledError();
        // A blip in connectivity should not end a sign-in the user is midway
        // through; keep polling until the deadline.
        void err;
        continue;
      }

      if (poll.status === 410) throw new AuthExpiredError();
      if (!poll.ok) continue; // transient server-side trouble: keep waiting

      const data = (await poll.json()) as { status?: unknown; key?: unknown };
      if (data.status === "approved" && typeof data.key === "string" && data.key) {
        return data.key;
      }
      // "pending" — go round again.
    }
  })();

  // Nothing else awaits this promise until the caller does; without a no-op
  // catch, a cancel before `await` surfaces as an unhandled rejection.
  key.catch(() => {});

  return { verifyUrl, key, cancel: () => controller.abort() };
}
