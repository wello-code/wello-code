/**
 * Thin client for the public Wello gateway (api.wello.dev). Runs in main (native
 * fetch, no Origin header → no CORS). Phase 2: model traffic and utility calls go
 * through the /code API, which bills the user's SUBSCRIPTION first and spills to
 * the PAYG balance — /code/v1/access is the billing status for the titlebar chip.
 */
const BASE_URL = "https://api.wello.dev";
/** The /code API base — subscription-first billing for the coding agent. */
const CODE_BASE = `${BASE_URL}/code`;

/** Best-effort self-revoke on sign-out, so the machine keeps no live credential. */
export async function revokeCurrentKey(apiKey: string): Promise<void> {
  try {
    await fetch(`${CODE_BASE}/v1/key`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Offline sign-out still clears the local keychain; the key just stays
    // revocable from the web cabinet.
  }
}

/** Account-wide "PAYG beyond the plan limit" switch (same flag as web settings). */
export async function setPaygOverflow(apiKey: string, enabled: boolean): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${CODE_BASE}/v1/overflow`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Не удалось связаться с Wello. Проверьте интернет-соединение.");
  }
  if (!res.ok) throw new Error(`Не удалось изменить настройку (код ${res.status}).`);
}

export interface BalanceInfo {
  balanceCents: number;
  totalTokensUsed: number;
}

/** Billing status for the next /code turn, from GET /code/v1/access. */
export interface AccessInfo {
  /** How the next turn will be funded. */
  billing: "subscription" | "payg" | "blocked";
  /** Why it's blocked (subscription_cap / need_topup / payg_balance_low), when blocked. */
  reason: string | null;
  /** Account e-mail (null on gateways that predate the identity fields). */
  email: string | null;
  /** Display name the user set in web Settings (auth user_metadata), when any. */
  displayName: string | null;
  planId: string | null;
  /** Whether the account has an active paid plan (Wello Code is a Pro+ perk). */
  planActive: boolean;
  /** Account-wide "PAYG beyond the plan limit" switch (null = unknown/old gateway). */
  overflowEnabled: boolean | null;
  /**
   * Fraction of the monthly subscription cap already used, 0..1 (null = no plan).
   * Since 2026-07 the plan has a single per-period limit that resets on renewal —
   * the old 5-hour/weekly windows are gone.
   */
  usedFraction: number | null;
  paygBalanceCents: number;
}

export async function fetchBalance(apiKey: string): Promise<BalanceInfo> {
  // A 15s timeout keeps a black-holed connection (captive portal, dropped socket)
  // from hanging the startup connection check forever.
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/balance`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Не удалось связаться с Wello. Проверьте интернет-соединение.");
  }
  if (!res.ok) {
    throw new Error(
      res.status === 401 ? "Неверный ключ Wello." : `Не удалось проверить баланс (код ${res.status}).`,
    );
  }
  const body = (await res.json()) as { balance_cents?: number; total_tokens_used?: number };
  return {
    balanceCents: Math.round(body.balance_cents ?? 0),
    totalTokensUsed: body.total_tokens_used ?? 0,
  };
}

/**
 * Billing status for the coding agent (subscription window / PAYG balance).
 * Falls back to the plain balance shape against an older gateway (404 on the
 * /code routes) so the client keeps working through a deploy gap.
 */
export async function fetchAccess(apiKey: string): Promise<AccessInfo> {
  let res: Response;
  try {
    res = await fetch(`${CODE_BASE}/v1/access`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Не удалось связаться с Wello. Проверьте интернет-соединение.");
  }
  if (res.status === 404) {
    // Pre-/code gateway: degrade to the dev-API balance view (PAYG-only).
    const { balanceCents } = await fetchBalance(apiKey);
    return {
      billing: balanceCents > 0 ? "payg" : "blocked",
      reason: balanceCents > 0 ? null : "need_topup",
      email: null,
      displayName: null,
      planId: null,
      planActive: false,
      overflowEnabled: null,
      usedFraction: null,
      paygBalanceCents: balanceCents,
    };
  }
  if (!res.ok) {
    throw new Error(
      res.status === 401 ? "Неверный ключ Wello." : `Не удалось проверить доступ (код ${res.status}).`,
    );
  }
  const body = (await res.json()) as {
    billing?: string;
    reason?: string | null;
    email?: string | null;
    display_name?: string | null;
    plan_id?: string | null;
    plan_active?: boolean;
    payg_overflow_enabled?: boolean;
    subscription?: {
      used_fraction?: number;
      overflow_enabled?: boolean;
    } | null;
    payg_balance_cents?: number;
  };
  const billing =
    body.billing === "subscription" || body.billing === "payg" || body.billing === "blocked"
      ? body.billing
      : "blocked";
  return {
    billing,
    reason: body.reason ?? null,
    email: typeof body.email === "string" && body.email ? body.email : null,
    displayName:
      typeof body.display_name === "string" && body.display_name.trim()
        ? body.display_name.trim()
        : null,
    planId: body.plan_id ?? null,
    // Older gateway builds lack the top-level fields — fall back to the
    // subscription block (present exactly when the plan is active).
    planActive: body.plan_active ?? body.subscription != null,
    overflowEnabled: body.payg_overflow_enabled ?? body.subscription?.overflow_enabled ?? null,
    usedFraction: body.subscription?.used_fraction ?? null,
    paygBalanceCents: Math.round(body.payg_balance_cents ?? 0),
  };
}

/**
 * Short task title from the first prompt (a ~1K-token utility turn). Runs through
 * /code so a subscriber's titles draw on the plan like every other agent call —
 * a subscription-only account isn't left with silently failing titles. Best-effort:
 * any failure returns null and the UI keeps the prompt-derived placeholder.
 */
/**
 * One-line commit message from the change diff, in the user's CURRENT chat model
 * (the diff is already truncated by the caller). Same /code endpoint as titles —
 * the turn bills the subscription first like any other call. Null on any failure:
 * the field simply stays empty, the user types their own message.
 */
export async function generateCommitMessage(
  apiKey: string,
  diff: string,
  model: string,
  instructions?: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${CODE_BASE}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 60,
        system:
          "Ты пишешь сообщение git-коммита по диффу. Ответь ОДНОЙ строкой до 72 символов, " +
          "в повелительном наклонении, без кавычек, точки в конце, префиксов вроде «commit:». " +
          "Пиши на языке кода/проекта (комментарии на русском → по-русски)." +
          userInstructionsBlock(instructions),
        messages: [{ role: "user", content: diff }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const raw = body.content?.find((b) => b.type === "text")?.text ?? "";
    const line = raw
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean);
    const msg = (line ?? "").replace(/^["'«»`\s]+|["'«»`\s.]+$/g, "").trim();
    if (!msg || msg.length > 120) return null;
    return msg;
  } catch {
    return null;
  }
}

/** The user's own generation instructions, appended AFTER the base task
 *  (settings → Git); empty/blank → nothing is appended at all. */
function userInstructionsBlock(instructions?: string): string {
  const t = instructions?.trim();
  return t ? `\n\nПользовательские инструкции: ${t}` : "";
}

/**
 * PR title + markdown body from the branch's commit subjects and diff, in the
 * user's current chat model. Contract with the model: first line = title,
 * blank line, then the body. Null on any failure — the form stays editable.
 */
export async function generatePrText(
  apiKey: string,
  context: string,
  model: string,
  instructions?: string,
): Promise<{ title: string; body: string } | null> {
  try {
    const res = await fetch(`${CODE_BASE}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 700,
        system:
          "Ты пишешь pull request по списку коммитов и диффу. Первая строка ответа — заголовок " +
          "PR (до 72 символов, без кавычек и точки). Затем пустая строка и описание в markdown: " +
          "короткий абзац «что и зачем» и маркированный список ключевых изменений. Без преамбул. " +
          "Пиши на языке кода/проекта (комментарии на русском → по-русски)." +
          userInstructionsBlock(instructions),
        messages: [{ role: "user", content: context }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const raw = (data.content?.find((b) => b.type === "text")?.text ?? "").trim();
    if (!raw) return null;
    const nl = raw.indexOf("\n");
    const title = (nl === -1 ? raw : raw.slice(0, nl)).replace(/^["'«»`#\s]+|["'«»`\s.]+$/g, "").trim();
    const body = nl === -1 ? "" : raw.slice(nl + 1).trim();
    if (!title || title.length > 160) return null;
    return { title, body };
  } catch {
    return null;
  }
}

/**
 * A handoff note that carries a chat's context into a fresh one ("continue in a
 * new chat"): the goal, what's been done, decisions made, and the immediate next
 * step. In the user's current chat model. Null on any failure — the caller then
 * opens the new chat without a preamble.
 */
export async function generateHandoff(
  apiKey: string,
  transcript: string,
  model: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${CODE_BASE}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 700,
        system:
          "Сожми диалог в передаточную записку для НОВОГО чата с тем же агентом, чтобы он " +
          "продолжил работу без потери контекста. Пиши в markdown, кратко и по делу, на языке " +
          "диалога, разделами: **Цель** (что делаем), **Сделано** (ключевые шаги/решения), " +
          "**Состояние** (где остановились, важные файлы/факты), **Дальше** (следующий шаг). " +
          "Без преамбул и без обращений — только записка.",
        messages: [{ role: "user", content: transcript }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const note = (body.content?.find((b) => b.type === "text")?.text ?? "").trim();
    return note || null;
  } catch {
    return null;
  }
}

export async function generateTitle(apiKey: string, prompt: string): Promise<string | null> {
  try {
    const res = await fetch(`${CODE_BASE}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // Sonnet 5 since 2026-07-15 (haiku and sonnet-4.6 are dead upstream); a title
        // turn is ~1K tokens, so the price difference is noise.
        model: "claude-sonnet-5",
        max_tokens: 30,
        system:
          "Придумай очень короткое название задачи (2-4 слова, без кавычек и точки в конце) " +
          "по сообщению пользователя. Отвечай ТОЛЬКО названием, на языке сообщения.",
        messages: [{ role: "user", content: prompt.slice(0, 600) }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const raw = body.content?.find((b) => b.type === "text")?.text ?? "";
    const title = raw
      .split("\n")[0]!
      .replace(/^["'«»\s]+|["'«»\s.]+$/g, "")
      .trim();
    if (!title || title.length > 60) return null;
    return title;
  } catch {
    return null;
  }
}
