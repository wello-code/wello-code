import { describe, expect, it } from "vitest";
import { formatWebSearchHits, gatewayWebSearch } from "./web-search";

type FetchArgs = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, capture?: FetchArgs[]) {
  return async (url: string, init: RequestInit) => {
    capture?.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
}

describe("gatewayWebSearch", () => {
  it("posts the query with the bearer key to /v1/web-search", async () => {
    const calls: FetchArgs[] = [];
    const out = await gatewayWebSearch(
      "https://api.wello.dev/code",
      "wlo_live_x",
      "node lts",
      fakeFetch(200, { results: [] }, calls),
    );
    expect(out).toEqual({ ok: true, hits: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.wello.dev/code/v1/web-search");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer wlo_live_x",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ query: "node lts" });
  });

  it("keeps only entries with a url and defaults title to the url", async () => {
    const out = await gatewayWebSearch(
      "b",
      "k",
      "q",
      fakeFetch(200, {
        results: [
          { title: "Node.js", url: "https://nodejs.org", snippet: "LTS releases" },
          { title: "no url" },
          { url: "https://plain.example" },
          "garbage",
        ],
      }),
    );
    expect(out).toEqual({
      ok: true,
      hits: [
        { title: "Node.js", url: "https://nodejs.org", snippet: "LTS releases" },
        { title: "https://plain.example", url: "https://plain.example" },
      ],
    });
  });

  it("maps 404/501 to the 'gateway has no search' error", async () => {
    for (const status of [404, 501]) {
      const out = await gatewayWebSearch("b", "k", "q", fakeFetch(status, null));
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toContain("недоступен");
    }
  });

  it("surfaces the gateway's error text on other failures", async () => {
    const out = await gatewayWebSearch("b", "k", "q", fakeFetch(503, { error: "pool empty" }));
    expect(out).toEqual({ ok: false, error: "Поиск не удался: pool empty" });
  });

  it("survives a transport exception", async () => {
    const out = await gatewayWebSearch("b", "k", "q", async () => {
      throw new Error("offline");
    });
    expect(out).toEqual({ ok: false, error: "Поиск не удался: offline" });
  });
});

describe("formatWebSearchHits", () => {
  it("numbers hits and carries snippets", () => {
    const text = formatWebSearchHits("q", [
      { title: "A", url: "https://a", snippet: "alpha" },
      { title: "B", url: "https://b" },
    ]);
    expect(text).toContain('Web search results for "q"');
    expect(text).toContain("1. A\nhttps://a\nalpha");
    expect(text).toContain("2. B\nhttps://b");
  });

  it("says so when nothing was found", () => {
    expect(formatWebSearchHits("qq", [])).toContain("No results found");
  });
});
