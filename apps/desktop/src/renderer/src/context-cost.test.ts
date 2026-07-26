import { describe, it, expect } from "vitest";
import {
  contextAdvice,
  turnCostMultiplier,
  tokensK,
  CONTEXT_URGE_TOKENS,
  CONTEXT_WARN_TOKENS,
} from "./context-cost";

describe("contextAdvice", () => {
  it("stays quiet while the conversation is small", () => {
    expect(contextAdvice(null)).toBeNull();
    expect(contextAdvice(0)).toBeNull();
    expect(contextAdvice(CONTEXT_WARN_TOKENS - 1)).toBeNull();
  });

  it("warns once the context is the main thing being paid for", () => {
    const a = contextAdvice(CONTEXT_WARN_TOKENS);
    expect(a?.level).toBe("warn");
    expect(a?.action).toBe("Сжать контекст");
  });

  it("escalates when the context dominates the turn", () => {
    const a = contextAdvice(CONTEXT_URGE_TOKENS);
    expect(a?.level).toBe("urge");
    // The costly fact is stated, not implied.
    expect(a?.message).toContain("дороже");
  });

  it("fires long before a 1M window looks full (the bug this replaces)", () => {
    // The old nudge was 90% of the window: 900K on a 1M model. By then the user
    // had already been paying for a huge context for hours.
    expect(contextAdvice(200_000)).not.toBeNull();
    expect(200_000).toBeLessThan(0.9 * 1_000_000);
  });
});

describe("turnCostMultiplier", () => {
  it("is a plain ratio against a small exchange, never below 1", () => {
    expect(turnCostMultiplier(10_000)).toBe(1);
    expect(turnCostMultiplier(300_000)).toBe(30);
    expect(turnCostMultiplier(0)).toBe(1);
  });
});

describe("tokensK", () => {
  it("formats compactly", () => {
    expect(tokensK(999)).toBe("999");
    expect(tokensK(120_000)).toBe("120K");
  });
});
