import { describe, expect, it } from "vitest";
import {
  clampCustomWidth,
  DEVICE_PRESETS,
  fitZoom,
  normalizeAddress,
  resolveAddressInput,
} from "./preview-device";

describe("fitZoom", () => {
  it("scales down to fit but never enlarges past 1:1", () => {
    expect(fitZoom(375, 300)).toBeCloseTo(0.8);
    expect(fitZoom(768, 384)).toBeCloseTo(0.5);
    expect(fitZoom(375, 800)).toBe(1); // wider pane → no upscale
    expect(fitZoom(375, 375)).toBe(1);
  });
  it("degrades to 1 on nonsense input", () => {
    expect(fitZoom(0, 300)).toBe(1);
    expect(fitZoom(375, 0)).toBe(1);
  });
});

describe("clampCustomWidth", () => {
  it("clamps to 320..3840 and rounds", () => {
    expect(clampCustomWidth(100)).toBe(320);
    expect(clampCustomWidth(5000)).toBe(3840);
    expect(clampCustomWidth(500.6)).toBe(501);
    expect(clampCustomWidth(Number.NaN)).toBe(375);
  });
});

describe("DEVICE_PRESETS", () => {
  it("has mobile/tablet/desktop with the desktop preset filling the pane", () => {
    expect(DEVICE_PRESETS.map((d) => d.id)).toEqual(["mobile", "tablet", "desktop"]);
    expect(DEVICE_PRESETS.find((d) => d.id === "desktop")?.width).toBe("fill");
    expect(DEVICE_PRESETS.find((d) => d.id === "mobile")?.width).toBe(375);
  });
});

describe("normalizeAddress (preview address bar)", () => {
  it("keeps explicit http/https as is", () => {
    expect(normalizeAddress("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(normalizeAddress("https://wello.dev")).toBe("https://wello.dev/");
  });

  it("scheme-less local hosts get http, public hosts get https", () => {
    expect(normalizeAddress("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeAddress("127.0.0.1:8080/app")).toBe("http://127.0.0.1:8080/app");
    expect(normalizeAddress("192.168.1.10:3005")).toBe("http://192.168.1.10:3005/");
    expect(normalizeAddress("wello.dev/docs")).toBe("https://wello.dev/docs");
  });

  it("rejects junk and non-web schemes", () => {
    expect(normalizeAddress("")).toBeNull();
    expect(normalizeAddress("   ")).toBeNull();
    expect(normalizeAddress("file:///C:/secrets.txt")).toBeNull();
    expect(normalizeAddress("javascript:alert(1)")).toBeNull();
  });
});

describe("resolveAddressInput (omnibox: URL or Google)", () => {
  it("loads things that look like URLs directly", () => {
    expect(resolveAddressInput("wello.dev/docs")).toBe("https://wello.dev/docs");
    expect(resolveAddressInput("https://vite.dev")).toBe("https://vite.dev/");
    expect(resolveAddressInput("localhost:5173")).toBe("http://localhost:5173/");
  });

  it("turns queries into a Google search", () => {
    expect(resolveAddressInput("погода в москве")).toBe(
      "https://www.google.com/search?q=" + encodeURIComponent("погода в москве"),
    );
    expect(resolveAddressInput("гугл")).toBe(
      "https://www.google.com/search?q=" + encodeURIComponent("гугл"),
    );
    expect(resolveAddressInput("how to center a div")).toContain("google.com/search?q=how");
  });

  it("spaces always mean a query, even with a dot in a token", () => {
    expect(resolveAddressInput("vite.dev что такое")).toContain("google.com/search");
  });

  it("explicit scheme or port on a dotless host is still a URL", () => {
    expect(resolveAddressInput("http://myhost")).toBe("http://myhost/");
    expect(resolveAddressInput("devbox:3000")).toBe("https://devbox:3000/");
  });

  it("non-web schemes become a search, empty stays null", () => {
    expect(resolveAddressInput("javascript:alert(1)")).toContain("google.com/search");
    expect(resolveAddressInput("  ")).toBeNull();
  });
});
