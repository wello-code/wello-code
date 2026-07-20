import type { PublishRepoResult } from "../shared/ipc-api";
import { parseGitHubRemote } from "../shared/github";
import { addRemote, branchInfo, originUrl, push } from "./git";
import { authStatus, createRepo, gitAuthEnv } from "./github";

/**
 * The one-click "publish to GitHub" composition used by BOTH the branch-popover
 * button and the agent's github_create_repo tool: create the repository under
 * the signed-in account, attach it as `origin`, optionally push the current
 * history. Every partial outcome stays honest — a repo created but not pushed
 * returns ok:true + pushed:false + the push error, so «Отправить» can retry.
 */
export async function publishToGitHub(
  cwd: string,
  input: { name: string; private: boolean; description?: string; push: boolean },
): Promise<PublishRepoResult> {
  const existing = await originUrl(cwd);

  if (existing) {
    // A remote is already attached but (per the caller) the repo may not exist
    // on GitHub yet — the classic "git remote add first, created nothing" hole.
    const ref = parseGitHubRemote(existing);
    if (!ref) {
      return { ok: false, error: `origin уже привязан и указывает не на GitHub: ${existing}` };
    }
    const me = await authStatus();
    if (!me.connected) return { ok: false, auth: true, error: "GitHub не подключён." };
    // Fail CLOSED when the login is unknown (transient /user hiccup): with a
    // foreign origin already attached, a blind continue would push there.
    if (!me.login) {
      return { ok: false, error: "Не удалось проверить аккаунт GitHub — повторите попытку." };
    }
    if (ref.owner.toLowerCase() !== me.login.toLowerCase()) {
      return {
        ok: false,
        error:
          `origin указывает на аккаунт «${ref.owner}», а подключён «${me.login}» — ` +
          "создать репозиторий за другого владельца нельзя.",
      };
    }
    const created = await createRepo({ name: ref.repo, private: input.private });
    if (!created.ok && !created.nameTaken) return { ok: false, error: created.error, auth: created.auth };
    // nameTaken here means the repo ALREADY exists — publishing degrades to a push.
    const url = created.ok ? created.url : `https://github.com/${ref.owner}/${ref.repo}`;
    const fullName = created.ok ? created.fullName : `${ref.owner}/${ref.repo}`;
    return finishPush(cwd, { url, fullName }, input.push);
  }

  const created = await createRepo({
    name: input.name,
    private: input.private,
    ...(input.description ? { description: input.description } : {}),
  });
  if (!created.ok || !created.cloneUrl) {
    return { ok: false, error: created.error, nameTaken: created.nameTaken, auth: created.auth };
  }
  const attached = await addRemote(cwd, created.cloneUrl);
  if (!attached.ok) {
    return {
      ok: true,
      url: created.url,
      fullName: created.fullName,
      pushed: false,
      error: `Репозиторий создан, но привязать origin не удалось: ${attached.stderr ?? ""}`.trim(),
    };
  }
  return finishPush(cwd, { url: created.url, fullName: created.fullName }, input.push);
}

/** Push step of a publish: skipped for unborn repos (nothing to push yet). */
async function finishPush(
  cwd: string,
  repo: { url?: string; fullName?: string },
  wantPush: boolean,
): Promise<PublishRepoResult> {
  const base: PublishRepoResult = { ok: true, url: repo.url, fullName: repo.fullName, pushed: false };
  if (!wantPush) return base;
  const info = await branchInfo(cwd);
  if (info.unborn) {
    return { ...base, error: "В репозитории ещё нет коммитов — сделайте первый коммит и отправьте." };
  }
  const auth = (await gitAuthEnv()) ?? undefined;
  const pushed = await push(cwd, auth);
  if (!pushed.ok) {
    return { ...base, error: `Репозиторий создан, но отправить не удалось: ${pushed.stderr ?? ""}`.trim() };
  }
  return { ...base, pushed: true };
}
