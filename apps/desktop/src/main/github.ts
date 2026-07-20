import { app, safeStorage } from "electron";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CreatePrInput,
  CreatePrResult,
  CreateRepoInput,
  CreateRepoResult,
  GitHubAuthStatus,
  GitHubDeviceStart,
  PullStatus,
} from "../shared/ipc-api";
import {
  GITHUB_CLIENT_ID,
  buildGitCredentialEnv,
  parseGitHubRemote,
  pollDeviceFlow,
  type DeviceFlowErrorCode,
} from "../shared/github";

/**
 * GitHub integration (git stage 3), main-process only: OAuth Device Flow (no
 * client secret by design) and the couple of REST calls Create-PR needs. The
 * token lives next to the Wello key with the SAME safeStorage pattern — its
 * own file, so neither credential can ever clobber the other.
 */
const FILE = "github-credentials.bin";
const API = "https://api.github.com";

function tokenPath(): string {
  return join(app.getPath("userData"), FILE);
}

async function setToken(token: string): Promise<void> {
  const bytes = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from(token, "utf8");
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(tokenPath(), bytes);
}

async function getToken(): Promise<string | null> {
  try {
    const bytes = await readFile(tokenPath());
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(bytes);
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

async function clearToken(): Promise<void> {
  await rm(tokenPath(), { force: true });
  cachedLogin = null;
}

/** The signed-in login, cached for the session (GET /user is not free). */
let cachedLogin: string | null = null;

/** 401 anywhere → the token was revoked on github.com: drop it quietly. */
class GitHubAuthError extends Error {}

async function api<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const token = await getToken();
  if (!token) throw new GitHubAuthError("GitHub не подключён.");
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) {
    await clearToken();
    throw new GitHubAuthError("Токен отозван — подключите GitHub заново.");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown> & T;
  if (!res.ok) {
    const message = typeof body.message === "string" ? body.message : `GitHub API: ${res.status}`;
    const err = new Error(message) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* ── Device Flow ───────────────────────────────────────────────────────────── */

interface ActiveFlow {
  controller: AbortController;
  wait: Promise<{ ok: boolean; login?: string; error?: DeviceFlowErrorCode }>;
}
let activeFlow: ActiveFlow | null = null;

async function postForm(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Start the Device Flow: returns the user code for the modal and begins
 * polling in the background (deviceWait resolves it; deviceCancel aborts).
 */
export async function deviceStart(): Promise<GitHubDeviceStart> {
  activeFlow?.controller.abort();
  const body = await postForm("https://github.com/login/device/code", {
    client_id: GITHUB_CLIENT_ID,
    scope: "repo",
  });
  const deviceCode = String(body.device_code ?? "");
  const start: GitHubDeviceStart = {
    userCode: String(body.user_code ?? ""),
    verificationUri: String(body.verification_uri ?? "https://github.com/login/device"),
    expiresIn: Number(body.expires_in ?? 900),
    interval: Number(body.interval ?? 5),
  };
  if (!deviceCode || !start.userCode) throw new Error("GitHub не выдал код устройства.");

  const controller = new AbortController();
  const wait = (async (): Promise<{ ok: boolean; login?: string; error?: DeviceFlowErrorCode }> => {
    const result = await pollDeviceFlow(deviceCode, start.interval, {
      post: (form) =>
        postForm("https://github.com/login/oauth/access_token", form) as Promise<{
          access_token?: string;
          error?: string;
        }>,
      sleep: (ms) =>
        new Promise((resolve) => {
          const t = setTimeout(resolve, ms);
          controller.signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          });
        }),
      signal: controller.signal,
    });
    if (!result.ok) return { ok: false, error: result.code };
    await setToken(result.accessToken);
    cachedLogin = null;
    const status = await authStatus();
    return { ok: true, login: status.login ?? undefined };
  })();
  activeFlow = { controller, wait };
  return start;
}

/** Resolves when the running flow finishes (token stored / error / cancel). */
export async function deviceWait(): Promise<{ ok: boolean; login?: string; error?: DeviceFlowErrorCode }> {
  if (!activeFlow) return { ok: false, error: "cancelled" };
  try {
    return await activeFlow.wait;
  } finally {
    activeFlow = null;
  }
}

export function deviceCancel(): void {
  activeFlow?.controller.abort();
}

/* ── Status / disconnect ──────────────────────────────────────────────────── */

export async function authStatus(): Promise<GitHubAuthStatus> {
  if (!(await getToken())) return { connected: false };
  if (cachedLogin) return { connected: true, login: cachedLogin };
  try {
    const user = await api<{ login?: string }>("/user");
    cachedLogin = user.login ?? null;
    return { connected: true, login: cachedLogin ?? undefined };
  } catch (err) {
    if (err instanceof GitHubAuthError) return { connected: false };
    // Network hiccup: the token is still there — stay "connected", just nameless.
    return { connected: true };
  }
}

export async function disconnect(): Promise<void> {
  await clearToken();
}

/**
 * Env that authenticates git network calls against github.com with the stored
 * token (see buildGitCredentialEnv). Null when GitHub is not connected — the
 * caller then runs git with the machine's own credential setup, unchanged.
 */
export async function gitAuthEnv(): Promise<Record<string, string> | null> {
  const token = await getToken();
  return token ? buildGitCredentialEnv(token) : null;
}

/* ── Repo / pull requests ─────────────────────────────────────────────────── */

export async function defaultBranch(owner: string, repo: string): Promise<string> {
  const info = await api<{ default_branch?: string }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
  return info.default_branch ?? "main";
}

/**
 * The open PR for a branch, with its CI-checks rollup and review-comment count —
 * everything the branch popover shows so the user doesn't round-trip to the
 * browser to see where a PR stands. Null when no open PR exists for the branch.
 */
export async function pullForBranch(
  originUrl: string,
  branch: string,
): Promise<PullStatus | null> {
  const ref = parseGitHubRemote(originUrl);
  if (!ref) return null;
  const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const prs = await api<
    Array<{
      number: number;
      html_url: string;
      title: string;
      draft?: boolean;
      review_comments?: number;
      head?: { sha?: string };
    }>
  >(`${base}/pulls?state=open&head=${encodeURIComponent(`${ref.owner}:${branch}`)}`);
  const pr = prs[0];
  if (!pr) return null;
  let checks: PullStatus["checks"] = null;
  const sha = pr.head?.sha;
  if (sha) {
    try {
      const runs = await api<{ total_count?: number; check_runs?: Array<{ status?: string; conclusion?: string }> }>(
        `${base}/commits/${encodeURIComponent(sha)}/check-runs`,
      );
      const list = runs.check_runs ?? [];
      if (list.length > 0) {
        let passed = 0;
        let failed = 0;
        let running = 0;
        for (const r of list) {
          if (r.status !== "completed") running++;
          else if (r.conclusion === "success" || r.conclusion === "neutral" || r.conclusion === "skipped") passed++;
          else failed++;
        }
        checks = {
          total: list.length,
          passed,
          failed,
          running,
          state: failed > 0 ? "failure" : running > 0 ? "pending" : "success",
        };
      }
    } catch {
      /* checks are best-effort — the PR link still shows */
    }
  }
  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    draft: pr.draft ?? false,
    reviewComments: pr.review_comments ?? 0,
    checks,
  };
}

/**
 * Create a repository under the signed-in user's account. `auto_init` is never
 * sent: an empty repo accepts the first push of an existing local history
 * as-is (an auto-created README would make that push non-fast-forward). The
 * name/URLs in the result come from GitHub's RESPONSE — the API normalizes
 * names itself (spaces → dashes etc.), so we never guess the final URL.
 */
export async function createRepo(input: CreateRepoInput): Promise<CreateRepoResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Укажите имя репозитория." };
  try {
    const repo = await api<{
      name?: string;
      full_name?: string;
      html_url?: string;
      clone_url?: string;
      owner?: { login?: string };
      private?: boolean;
    }>("/user/repos", {
      method: "POST",
      body: {
        name,
        private: input.private,
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      },
    });
    if (!repo.clone_url || !repo.html_url || !repo.name) {
      return { ok: false, error: "GitHub вернул неожиданный ответ." };
    }
    return {
      ok: true,
      name: repo.name,
      fullName: repo.full_name ?? `${repo.owner?.login ?? "?"}/${repo.name}`,
      url: repo.html_url,
      cloneUrl: repo.clone_url,
      private: repo.private ?? input.private,
    };
  } catch (err) {
    if (err instanceof GitHubAuthError) return { ok: false, error: err.message, auth: true };
    const e = err as Error & { status?: number; body?: unknown };
    if (e.status === 422 && /already exists/i.test(nestedErrorText(e.body) || e.message)) {
      return {
        ok: false,
        nameTaken: true,
        error: `Репозиторий с именем «${name}» уже есть в вашем аккаунте.`,
      };
    }
    if (e.status === 403) {
      return { ok: false, error: "GitHub отклонил запрос (недостаточно прав токена)." };
    }
    return { ok: false, error: e.message || "Не удалось создать репозиторий." };
  }
}

/** 422 bodies bury the reason in `errors[].message` — surface it for matching. */
function nestedErrorText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return "";
  return errors
    .map((e) => (e && typeof e === "object" ? String((e as { message?: unknown }).message ?? "") : ""))
    .join(" ");
}

/**
 * Create the PR (draft by default upstream of this call). A 422 "already
 * exists" comes back as `exists` with the live PR looked up for its link.
 */
export async function createPull(
  originUrl: string,
  input: CreatePrInput,
): Promise<CreatePrResult> {
  const ref = parseGitHubRemote(originUrl);
  if (!ref) return { ok: false, error: "origin не указывает на GitHub." };
  const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  try {
    const pr = await api<{ number: number; html_url: string }>(`${base}/pulls`, {
      method: "POST",
      body: {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        draft: input.draft,
      },
    });
    return { ok: true, number: pr.number, url: pr.html_url };
  } catch (err) {
    if (err instanceof GitHubAuthError) return { ok: false, error: err.message, auth: true };
    const e = err as Error & { status?: number };
    if (e.status === 422 && /already exists/i.test(e.message)) {
      try {
        const existing = await api<{ number: number; html_url: string }[]>(
          `${base}/pulls?state=open&head=${encodeURIComponent(`${ref.owner}:${input.head}`)}`,
        );
        const pr = existing[0];
        if (pr) {
          return {
            ok: false,
            error: "Pull request для этой ветки уже существует.",
            exists: { number: pr.number, url: pr.html_url },
          };
        }
      } catch {
        /* the wording below still explains it */
      }
      return { ok: false, error: "Pull request для этой ветки уже существует." };
    }
    return { ok: false, error: e.message || "Не удалось создать pull request." };
  }
}
