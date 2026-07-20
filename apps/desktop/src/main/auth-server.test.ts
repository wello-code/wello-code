import { describe, expect, it } from "vitest";
import {
  AuthCancelledError,
  AuthTimeoutError,
  startAuthListener,
  type AuthListener,
} from "./auth-server";

const deliver = (l: AuthListener, body: unknown, origin?: string) =>
  fetch(`http://127.0.0.1:${l.port}/wello-code-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });

describe("startAuthListener (browser sign-in loopback)", () => {
  it("delivers a key with the right state exactly once, then shuts down", async () => {
    const l = await startAuthListener();
    expect(l.state).toMatch(/^[a-f0-9]{64}$/);

    const res = await deliver(l, { state: l.state, key: "wlo_live_abc" }, "https://wello.dev");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://wello.dev");
    await expect(l.key).resolves.toBe("wlo_live_abc");

    // One-shot: the socket is gone after the first success.
    await new Promise((r) => setTimeout(r, 50));
    await expect(deliver(l, { state: l.state, key: "wlo_live_second" })).rejects.toThrow();
  });

  it("rejects a wrong/missing state with 403 and keeps waiting", async () => {
    const l = await startAuthListener();
    expect((await deliver(l, { state: "f".repeat(64), key: "wlo_live_x" })).status).toBe(403);
    expect((await deliver(l, { key: "wlo_live_x" })).status).toBe(403);
    // Still alive: the real state goes through afterwards.
    expect((await deliver(l, { state: l.state, key: "wlo_live_ok" })).status).toBe(200);
    await expect(l.key).resolves.toBe("wlo_live_ok");
  });

  it("rejects malformed keys and bodies without settling", async () => {
    const l = await startAuthListener();
    expect((await deliver(l, { state: l.state, key: "not-a-key" })).status).toBe(400);
    const raw = await fetch(`http://127.0.0.1:${l.port}/wello-code-auth`, {
      method: "POST",
      body: "{oops",
    });
    expect(raw.status).toBe(400);
    l.cancel();
    await expect(l.key).rejects.toBeInstanceOf(AuthCancelledError);
  });

  it("answers the PNA/CORS preflight for wello.dev and ignores foreign origins", async () => {
    const l = await startAuthListener();
    const pre = await fetch(`http://127.0.0.1:${l.port}/wello-code-auth`, {
      method: "OPTIONS",
      headers: { Origin: "https://wello.dev" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://wello.dev");
    expect(pre.headers.get("access-control-allow-private-network")).toBe("true");

    const foreign = await fetch(`http://127.0.0.1:${l.port}/wello-code-auth`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    l.cancel();
    await l.key.catch(() => {});
  });

  it("times out when nothing arrives", async () => {
    const l = await startAuthListener({ timeoutMs: 60 });
    await expect(l.key).rejects.toBeInstanceOf(AuthTimeoutError);
  });

  it("cancel() rejects the wait and closes the port", async () => {
    const l = await startAuthListener();
    l.cancel();
    await expect(l.key).rejects.toBeInstanceOf(AuthCancelledError);
    await new Promise((r) => setTimeout(r, 50));
    await expect(deliver(l, { state: l.state, key: "wlo_live_x" })).rejects.toThrow();
  });
});
