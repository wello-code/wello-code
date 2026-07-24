import { describe, expect, it } from "vitest";
import {
  AuthCancelledError,
  AuthExpiredError,
  AuthTimeoutError,
  startBrowserSignIn,
} from "./auth-device";

/**
 * The sign-in client polls the gateway instead of running a loopback listener,
 * because Safari blocks an https page from reaching http://127.0.0.1 and Mac
 * users could therefore never finish signing in.
 */

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Replies to /start once, then walks the given /poll responses in order. */
function stubFetch(polls: Array<() => Response | Promise<Response>>, start?: unknown) {
  let i = 0;
  const calls: string[] = [];
  const impl = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/code/v1/auth/start")) {
      return json(
        201,
        start ?? {
          device_code: "d".repeat(64),
          user_code: "u".repeat(48),
          verify_url: "https://wello.dev/code-auth?code=" + "u".repeat(48),
          expires_in: 600,
          interval: 1,
        },
      );
    }
    const next = polls[Math.min(i, polls.length - 1)] ?? (() => json(200, { status: "pending" }));
    i += 1;
    return next();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("startBrowserSignIn", () => {
  it("returns the verify URL the user must open", async () => {
    const { impl } = stubFetch([() => json(200, { status: "pending" })]);
    const s = await startBrowserSignIn({ fetchImpl: impl, timeoutMs: 50 });
    expect(s.verifyUrl).toBe("https://wello.dev/code-auth?code=" + "u".repeat(48));
    s.cancel();
    await expect(s.key).rejects.toBeInstanceOf(AuthCancelledError);
  });

  it("waits as long as the server's expires_in, not a shorter fixed window", async () => {
    // Regression: the app used a hard 10-minute deadline while the gateway had
    // raised its session TTL to 30, so a first-time user still on the signup email
    // was told the request had expired while the session was very much alive.
    const { impl } = stubFetch([() => json(200, { status: "pending" })], {
      device_code: "d".repeat(64),
      user_code: "u".repeat(48),
      verify_url: "https://wello.dev/code-auth?code=" + "u".repeat(48),
      expires_in: 1800,
      interval: 1,
    });
    const started = Date.now();
    const s = await startBrowserSignIn({ fetchImpl: impl });
    // Not asserted by waiting 30 minutes: prove it did NOT reject early, then stop.
    const settled = await Promise.race([
      s.key.then(() => "resolved").catch((e) => `rejected:${(e as Error).name}`),
      new Promise((r) => setTimeout(() => r("still-waiting"), 150)),
    ]);
    expect(settled).toBe("still-waiting");
    expect(Date.now() - started).toBeLessThan(10 * 60_000);
    s.cancel();
    await expect(s.key).rejects.toBeInstanceOf(AuthCancelledError);
  });

  it("keeps the device_code out of the URL the browser opens", async () => {
    const { impl } = stubFetch([() => json(200, { status: "pending" })]);
    const s = await startBrowserSignIn({ fetchImpl: impl, timeoutMs: 50 });
    expect(s.verifyUrl).not.toContain("d".repeat(64));
    s.cancel();
    await expect(s.key).rejects.toBeInstanceOf(AuthCancelledError);
  });

  it("resolves with the key once the session is approved", async () => {
    const { impl } = stubFetch([
      () => json(200, { status: "pending" }),
      () => json(200, { status: "approved", key: "wlo_live_abc123" }),
    ]);
    const s = await startBrowserSignIn({ fetchImpl: impl, timeoutMs: 5000 });
    await expect(s.key).resolves.toBe("wlo_live_abc123");
  });

  it("rejects as expired when the gateway retires the session", async () => {
    const { impl } = stubFetch([() => json(410, { status: "expired" })]);
    const s = await startBrowserSignIn({ fetchImpl: impl, timeoutMs: 5000 });
    await expect(s.key).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it("keeps polling through a network blip rather than failing the sign-in", async () => {
    let n = 0;
    const impl = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/code/v1/auth/start")) {
        return json(201, {
          device_code: "d".repeat(64),
          user_code: "u".repeat(48),
          interval: 1,
        });
      }
      n += 1;
      if (n === 1) throw new TypeError("network down");
      if (n === 2) return json(503, {});
      return json(200, { status: "approved", key: "wlo_live_survived" });
    }) as unknown as typeof fetch;

    const s = await startBrowserSignIn({ fetchImpl: impl, timeoutMs: 5000 });
    await expect(s.key).resolves.toBe("wlo_live_survived");
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it("gives up with a timeout rather than polling forever", async () => {
    const { impl } = stubFetch([() => json(200, { status: "pending" })]);
    const s = await startBrowserSignIn({ fetchImpl: impl, timeoutMs: 1 });
    await expect(s.key).rejects.toBeInstanceOf(AuthTimeoutError);
  });

  it("fails fast when the gateway will not open a session", async () => {
    const impl = (async () => json(500, { error: "start_failed" })) as unknown as typeof fetch;
    await expect(startBrowserSignIn({ fetchImpl: impl })).rejects.toThrow(/start failed/);
  });

  it("falls back to the canonical page URL when the server omits verify_url", async () => {
    const { impl } = stubFetch([() => json(200, { status: "pending" })], {
      device_code: "d".repeat(64),
      user_code: "abc123",
      interval: 1,
    });
    const s = await startBrowserSignIn({ fetchImpl: impl, timeoutMs: 50 });
    expect(s.verifyUrl).toBe("https://wello.dev/code-auth?code=abc123");
    s.cancel();
    await expect(s.key).rejects.toBeInstanceOf(AuthCancelledError);
  });
});
