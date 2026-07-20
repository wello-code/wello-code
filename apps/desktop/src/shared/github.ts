/**
 * Pure GitHub helpers shared by main and the renderer (and unit-testable
 * without Electron or network): the origin-URL parser, PR-title prefill and
 * the Device Flow polling loop with its error mapping — the HTTP transport is
 * INJECTED, so tests stub it at the module boundary.
 */

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/**
 * owner/repo out of an origin URL — https and ssh shapes, with or without
 * `.git`. Anything not github.com → null (the Create-PR button explains why).
 *   https://github.com/owner/repo(.git)
 *   git@github.com:owner/repo(.git)
 *   ssh://git@github.com/owner/repo(.git)
 */
export function parseGitHubRemote(url: string): GitHubRepoRef | null {
  const u = url.trim();
  const m =
    /^https:\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u) ??
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(u) ??
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) return null;
  const owner = m[1]!;
  const repo = m[2]!;
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** PR title prefill: the last commit subject, the branch name as the fallback. */
export function defaultPrTitle(lastSubject: string | null | undefined, branch: string): string {
  const s = (lastSubject ?? "").trim();
  return s || branch;
}

/* ── Git credential bridge ─────────────────────────────────────────────────── */

/**
 * Env vars that make `git push/pull/fetch` against github.com authenticate with
 * the app's stored OAuth token instead of whatever credential helper the machine
 * has (GCM's browser sign-in window is exactly the step novices get lost on).
 *
 * Mechanism: GIT_CONFIG_{COUNT,KEY_n,VALUE_n} inject command-line-level config
 * into every git the env reaches. Entry 0 (empty value) CLEARS the helper list
 * accumulated from system/global config — scoped to github.com only, so GCM
 * still serves GitLab/Bitbucket/etc. Entry 1 adds an inline shell helper that
 * answers `get` with the token from $WELLO_GH_TOKEN — the token itself never
 * appears in the command line or config value, only in the process env.
 * SSH remotes ignore credential helpers entirely — those keep the user's keys.
 */
export function buildGitCredentialEnv(token: string): Record<string, string> {
  const scope = "credential.https://github.com.helper";
  return {
    WELLO_GH_TOKEN: token,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: scope,
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: scope,
    GIT_CONFIG_VALUE_1:
      '!f() { if [ "$1" = get ]; then printf \'username=x-access-token\\npassword=%s\\n\' "$WELLO_GH_TOKEN"; fi; }; f',
  };
}

/**
 * A GitHub-valid repository name derived from a folder name: the allowed
 * alphabet is [A-Za-z0-9._-], every run of anything else becomes one "-".
 * Cyrillic (most of this app's users) has no GitHub-legal form — it drops out,
 * so «Лендинг кофейни Mafin» → "Mafin" and a fully-Cyrillic name falls back to
 * "" (the caller shows an empty field and asks). Trimmed to GitHub's 100 chars.
 */
export function repoNameFromFolder(folder: string): string {
  return folder
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
}

/* ── Device Flow ───────────────────────────────────────────────────────────── */

/** The app's public OAuth Client ID (Device Flow needs no secret). */
export const GITHUB_CLIENT_ID = "Ov23ctK7d7H4vX32dmtl";

export type DeviceFlowErrorCode = "access_denied" | "expired_token" | "network" | "cancelled";

/** Human words for the connect modal, by error code. */
export function deviceFlowErrorText(code: DeviceFlowErrorCode): string {
  switch (code) {
    case "access_denied":
      return "Доступ отклонён на github.com.";
    case "expired_token":
      return "Код истёк — запросите новый.";
    case "cancelled":
      return "Подключение отменено.";
    default:
      return "Не удалось связаться с GitHub. Проверьте интернет-соединение.";
  }
}

export type DeviceFlowResult =
  | { ok: true; accessToken: string }
  | { ok: false; code: DeviceFlowErrorCode };

interface TokenPollResponse {
  access_token?: string;
  error?: string;
  interval?: number;
}

/**
 * Poll the token endpoint strictly on the given interval (+5s after a
 * slow_down), until access_token / a terminal error / an abort. `post` and
 * `sleep` are injected: tests drive the loop without network or real timers.
 */
export async function pollDeviceFlow(
  deviceCode: string,
  intervalSec: number,
  opts: {
    post: (body: Record<string, string>) => Promise<TokenPollResponse>;
    sleep: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  },
): Promise<DeviceFlowResult> {
  let interval = Math.max(1, intervalSec);
  for (;;) {
    await opts.sleep(interval * 1000);
    if (opts.signal?.aborted) return { ok: false, code: "cancelled" };
    let res: TokenPollResponse;
    try {
      res = await opts.post({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
    } catch {
      if (opts.signal?.aborted) return { ok: false, code: "cancelled" };
      return { ok: false, code: "network" };
    }
    if (opts.signal?.aborted) return { ok: false, code: "cancelled" };
    if (res.access_token) return { ok: true, accessToken: res.access_token };
    switch (res.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      case "access_denied":
        return { ok: false, code: "access_denied" };
      case "expired_token":
        return { ok: false, code: "expired_token" };
      default:
        return { ok: false, code: "network" };
    }
  }
}
