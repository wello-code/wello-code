/**
 * Gateway-backed web search for the agent's `web_search` MCP tool. The engine's
 * own WebSearch is a server-side Anthropic tool the Wello /code passthrough
 * cannot serve (upstream 400s on it), so searches go through the gateway's
 * Parallel-powered endpoint instead. Pure: the transport is injected for tests.
 */

export interface WebSearchHit {
  title: string;
  url: string;
  snippet?: string;
}

export type WebSearchOutcome =
  | { ok: true; hits: WebSearchHit[] }
  | { ok: false; error: string };

type FetchLike = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** POST {codeBase}/v1/web-search — codeBase is the same base the engine talks to. */
export async function gatewayWebSearch(
  codeBase: string,
  apiKey: string,
  query: string,
  doFetch: FetchLike = fetch,
): Promise<WebSearchOutcome> {
  let payload: unknown;
  try {
    const res = await doFetch(`${codeBase}/v1/web-search`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(25_000),
    });
    if (res.status === 404 || res.status === 501) {
      return { ok: false, error: "Веб-поиск временно недоступен (шлюз не поддерживает поиск)." };
    }
    payload = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error: unknown }).error)
          : `HTTP ${res.status}`;
      return { ok: false, error: `Поиск не удался: ${message}` };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Поиск не удался: ${reason}` };
  }
  const raw = (payload as { results?: unknown })?.results;
  if (!Array.isArray(raw)) return { ok: true, hits: [] };
  const hits: WebSearchHit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const url = typeof e.url === "string" ? e.url : null;
    if (!url) continue;
    hits.push({
      title: typeof e.title === "string" && e.title ? e.title : url,
      url,
      ...(typeof e.snippet === "string" && e.snippet ? { snippet: e.snippet } : {}),
    });
  }
  return { ok: true, hits };
}

/** The plain-text tool result the model reads back (compact, source-first). */
export function formatWebSearchHits(query: string, hits: WebSearchHit[]): string {
  if (hits.length === 0) {
    return `No results found for "${query}". Try a different query.`;
  }
  const lines = hits.map((h, i) => {
    const snippet = h.snippet ? `\n${h.snippet.trim()}` : "";
    return `${i + 1}. ${h.title}\n${h.url}${snippet}`;
  });
  return `Web search results for "${query}":\n\n${lines.join("\n\n")}`;
}
