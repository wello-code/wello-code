import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GitBranchInfo, GitHubAuthStatus, GitSyncInfo, PullStatus } from "../../shared/ipc-api";
import { parseGitHubRemote, repoNameFromFolder } from "../../shared/github";
import { CreatePrModal, prLinkKey, sessionPrLinks } from "./CreatePr";
import { DeviceFlowModal } from "./GitHubConnect";
import { Icon } from "./Icon";
import { toast } from "./Toaster";

/** The popover's fixed width (also used by the clamping math). */
const POP_W = 316;
/** Show the branch filter only when the list stops being glanceable. */
const FILTER_FROM = 8;

type Busy =
  | "fetch"
  | "push"
  | "pull"
  | "switch"
  | "create"
  | "remote"
  | "publish"
  | "checkout"
  | "rename"
  | "delete"
  | "stash"
  | "stashpop"
  | null;

interface PopError {
  kind: "net" | "dirty";
  text: string;
  /** ff-only refusal → add the "diverged" advice line. */
  diverged?: boolean;
}

/**
 * The branch popover (git stage 2): sync with origin (fetch / push / pull,
 * first push publishes the branch), the local branch list with switch/create,
 * and — when the repo has no remote — the one-click «Опубликовать на GitHub»
 * flow (create repo → origin → push through the app's stored token), with the
 * raw attach-by-URL form behind a link. Anchored above the branch chip through
 * a PORTAL (the chip sits at the very bottom of the chat column); Esc/outside-
 * click close it — except while a network operation or a portal modal is up.
 * Auth: with GitHub connected the app injects its credential bridge; otherwise
 * the machine's own helper (GCM may pop a browser sign-in — the hint says so).
 */
export function BranchPopover({
  anchorRef,
  workspacePath,
  info,
  sync,
  running,
  model,
  onClose,
  onOpenReview,
  onChanged,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  workspacePath: string;
  info: GitBranchInfo;
  sync: GitSyncInfo | null;
  /** The agent is mid-turn in this task: mutations are parked, fetch stays. */
  running: boolean;
  /** The composer's current model — the PR-description generator uses it. */
  model: string;
  onClose: () => void;
  onOpenReview: () => void;
  /** Repo state changed (push/pull/fetch/switch/create/remote) — refresh the chip. */
  onChanged: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<PopError | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [remoteOnly, setRemoteOnly] = useState<string[]>([]);
  const [stashN, setStashN] = useState(0);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  // Inline branch management (no separate modal): rename the current branch,
  // arm-then-confirm a delete (destructive), offer force after an unmerged refusal.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [forceDel, setForceDel] = useState<string | null>(null);
  // Stage 3: Create PR — GitHub auth status + the modal + the session PR link.
  const [github, setGithub] = useState<GitHubAuthStatus | null>(null);
  const [prOpen, setPrOpen] = useState(false);
  // No-remote flow: one-click publish (create repo → origin → push) with the
  // folder name prefilled; the raw attach-by-URL form hides behind a link.
  const [publishName, setPublishName] = useState(() =>
    repoNameFromFolder(workspacePath.split(/[\\/]/).pop() ?? ""),
  );
  const [publishPrivate, setPublishPrivate] = useState(true);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  // The open PR for the current branch (checks + review count), when connected.
  const [pull, setPull] = useState<PullStatus | null>(null);
  const busyRef = useRef<Busy>(null);
  busyRef.current = busy;

  const unborn = info.unborn;
  const detached = Boolean(sync?.detached);

  // Anchor math (before paint): left edges aligned, opening UPWARD off the chip,
  // clamped ≥8px from the window edges.
  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8)),
      bottom: window.innerHeight - r.top + 8,
    });
  }, [anchorRef]);

  // Esc / outside click close — but never abandon a live network operation, and
  // never while a MODAL rendered through a portal (Create-PR / GitHub connect —
  // its clicks are "outside" the popover) is up.
  const prOpenRef = useRef(false);
  prOpenRef.current = prOpen || connectOpen;
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (busyRef.current || prOpenRef.current) return;
      if (!rootRef.current?.contains(e.target as Node) && !anchorRef.current?.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || busyRef.current || prOpenRef.current) return;
      // Esc INSIDE one of the popover's fields belongs to that field (the
      // new-branch input cancels itself) — this runs in the CAPTURE phase and
      // would otherwise close the whole popover before the field ever sees it.
      const t = e.target;
      if (t instanceof Element && rootRef.current?.contains(t) && t.closest("input, textarea")) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("mousedown", onDown);
    // Capture phase: win over the app-level Escape handlers.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, anchorRef]);

  // The local + remote branch lists, stash count and GitHub auth. `reloadBranches`
  // re-reads after a mutation (checkout/rename/delete/stash) so the lists stay honest.
  const [reloadKey, setReloadKey] = useState(0);
  const reloadBranches = (): void => setReloadKey((k) => k + 1);
  useEffect(() => {
    let alive = true;
    void Promise.all([
      window.wello.gitListBranches(workspacePath),
      window.wello.gitRemoteBranches(workspacePath).catch(() => [] as string[]),
      window.wello.gitStashCount(workspacePath).catch(() => 0),
    ]).then(([list, remote, stash]) => {
      if (!alive) return;
      setBranches(list.branches);
      setCurrent(list.current);
      setStashN(stash);
      const local = new Set(list.branches);
      setRemoteOnly(remote.filter((b) => !local.has(b)));
    });
    return () => {
      alive = false;
    };
  }, [workspacePath, reloadKey]);
  useEffect(() => {
    let alive = true;
    void window.wello.githubStatus().then((s) => alive && setGithub(s));
    return () => {
      alive = false;
    };
  }, [workspacePath]);

  // The open PR for this branch (checks/reviews) — only when GitHub is connected
  // and origin is on GitHub; re-checked when the branch or push state changes.
  const headBranch = current ?? info.branch ?? null;
  const onGitHub = Boolean(sync?.remote && parseGitHubRemote(sync.remote));
  useEffect(() => {
    if (!github?.connected || !onGitHub || !headBranch || !sync?.upstream) {
      setPull(null);
      return;
    }
    let alive = true;
    void window.wello
      .githubPullForBranch(workspacePath, headBranch)
      .then((p) => alive && setPull(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [workspacePath, headBranch, github?.connected, onGitHub, sync?.upstream, sync?.ahead]);

  const runOp = async (
    kind: Exclude<Busy, null>,
    op: () => Promise<{ ok: boolean; stderr?: string; code?: "dirty" }>,
    onOk?: () => void,
  ): Promise<void> => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const res = await op();
      if (res.ok) {
        onOk?.();
        onChanged();
      } else if (res.code === "dirty") {
        setError({ kind: "dirty", text: "Сначала закоммитьте или отмените изменения." });
      } else {
        const text = res.stderr || "Операция не удалась.";
        setError({
          kind: "net",
          text,
          diverged: /fast-forward|divergent|diverging|расходя/i.test(text),
        });
      }
    } finally {
      setBusy(null);
    }
  };

  const doFetch = (): Promise<void> =>
    runOp("fetch", () => window.wello.gitFetch(workspacePath));
  const doPush = (): Promise<void> => runOp("push", () => window.wello.gitPush(workspacePath));
  const doPull = (): Promise<void> => runOp("pull", () => window.wello.gitPull(workspacePath));
  const doSwitch = (name: string): Promise<void> =>
    runOp("switch", () => window.wello.gitSwitchBranch(workspacePath, name), () => {
      setCurrent(name);
    });
  const doCreate = (): Promise<void> => {
    const name = newName.trim();
    if (!name) return Promise.resolve();
    return runOp("create", () => window.wello.gitCreateBranch(workspacePath, name), () => {
      setCreating(false);
      setNewName("");
      setBranches((prev) => (prev && !prev.includes(name) ? [...prev, name] : prev));
      setCurrent(name);
    });
  };
  const doAddRemote = (): Promise<void> => {
    const url = remoteUrl.trim();
    if (!url) return Promise.resolve();
    return runOp("remote", () => window.wello.gitAddRemote(workspacePath, url), () => {
      setRemoteUrl("");
    });
  };
  // One-click publish: create the repo → attach origin → push. Success flips
  // this popover into the ordinary sync view (onChanged refreshes the props).
  const doPublish = async (): Promise<void> => {
    const name = publishName.trim();
    if (!name || busy) return;
    setBusy("publish");
    setPublishError(null);
    setError(null);
    try {
      const res = await window.wello.githubPublishRepo(workspacePath, {
        name,
        private: publishPrivate,
      });
      if (res.ok) {
        onChanged();
        reloadBranches();
        if (res.pushed) {
          toast({ message: `Код опубликован: ${res.fullName ?? name}`, tone: "success" });
        } else {
          // The repo exists — the sync view takes over; explain what's left.
          setPublishError(res.error ?? "Репозиторий создан, но код пока не отправлен.");
        }
      } else if (res.auth) {
        setGithub({ connected: false });
        setPublishError(res.error ?? "GitHub не подключён.");
      } else {
        setPublishError(res.error ?? "Не удалось создать репозиторий.");
      }
    } finally {
      setBusy(null);
    }
  };
  const doCheckoutRemote = (name: string): Promise<void> =>
    runOp("checkout", () => window.wello.gitCheckoutRemote(workspacePath, name), () => {
      setCurrent(name);
      reloadBranches();
    });
  const doRename = (): Promise<void> => {
    const to = renameTo.trim();
    const from = renaming ?? "";
    if (!to || !from) return Promise.resolve();
    return runOp("rename", () => window.wello.gitRenameBranch(workspacePath, from, to), () => {
      setRenaming(null);
      setRenameTo("");
      if (from === current) setCurrent(to);
      reloadBranches();
    });
  };
  const doDelete = (name: string, force: boolean): Promise<void> =>
    runOp(
      "delete",
      async () => {
        const res = await window.wello.gitDeleteBranch(workspacePath, name, force);
        // An unmerged branch refuses `-d` — offer a force delete instead of failing.
        if (!res.ok && !force && /not fully merged|не слит/i.test(res.stderr ?? "")) {
          setForceDel(name);
        }
        return res;
      },
      () => {
        setConfirmDel(null);
        setForceDel(null);
        reloadBranches();
      },
    );
  const doStash = (): Promise<void> =>
    runOp("stash", () => window.wello.gitStashPush(workspacePath), () => {
      setStashN((n) => n + 1);
      onChanged();
    });
  const doStashPop = (): Promise<void> =>
    runOp("stashpop", () => window.wello.gitStashPop(workspacePath), () => {
      setStashN((n) => Math.max(0, n - 1));
      onChanged();
    });

  const mutationsLocked = running || Boolean(busy);
  const lockTitle = running ? "Дождитесь завершения хода агента" : undefined;
  const currentLabel = detached
    ? `HEAD @ ${sync?.head ?? "?"}`
    : unborn
      ? `${info.branch ?? "main"} (нет коммитов)`
      : (current ?? info.branch ?? "—");

  const shown = (branches ?? []).filter(
    (b) => !filter.trim() || b.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return createPortal(
    <div
      className="branchpop"
      ref={rootRef}
      role="dialog"
      aria-label="Ветка и синхронизация"
      style={pos ? { left: pos.left, bottom: pos.bottom, visibility: "visible" } : { visibility: "hidden" }}
    >
      <div className="branchpop__head">
        <Icon name="gitbranch" size={13} />
        <span className="branchpop__name" title={currentLabel}>
          {currentLabel}
        </span>
        {sync?.remote && !unborn ? (
          <button
            className="icon-button"
            title="Обновить (git fetch)"
            aria-label="Обновить состояние удалённого репозитория"
            disabled={Boolean(busy)}
            onClick={() => void doFetch()}
          >
            {busy === "fetch" ? <span className="spinner" aria-hidden /> : <Icon name="undo" size={13} />}
          </button>
        ) : null}
      </div>

      {unborn ? (
        <p className="branchpop__note">
          Сделайте первый коммит — синхронизация и ветки станут доступны.
        </p>
      ) : sync?.remote ? (
        <>
          {sync.upstream ? (
            // Published branch: divergence counts + equal-width push/pull.
            <div className="branchpop__sync">
              <span className="branchpop__counts" title="Локальные коммиты ↑ / удалённые ↓">
                <em className={sync.ahead > 0 ? "is-live" : ""}>↑{sync.ahead}</em>
                <em className={sync.behind > 0 ? "is-live" : ""}>↓{sync.behind}</em>
              </span>
              <button
                className="button ghost sm"
                disabled={mutationsLocked || detached}
                title={detached ? "Отсоединённый HEAD — переключитесь на ветку" : lockTitle}
                onClick={() => void doPush()}
              >
                {busy === "push" ? <span className="spinner" aria-hidden /> : null}
                Отправить
              </button>
              <button
                className="button ghost sm"
                disabled={mutationsLocked}
                title={lockTitle}
                onClick={() => void doPull()}
              >
                {busy === "pull" ? <span className="spinner" aria-hidden /> : null}
                Получить
              </button>
            </div>
          ) : (
            // Unpublished branch: one clear full-width action instead of a
            // cramped counts row (pull is meaningless without an upstream).
            <div className="branchpop__sync branchpop__sync--publish">
              <button
                className="button ghost sm branchpop__wide"
                disabled={mutationsLocked || detached}
                title={
                  detached
                    ? "Отсоединённый HEAD — переключитесь на ветку"
                    : (lockTitle ?? "Отправить ветку в удалённый репозиторий")
                }
                onClick={() => void doPush()}
              >
                {busy === "push" ? <span className="spinner" aria-hidden /> : null}
                Опубликовать ветку
              </button>
            </div>
          )}
          {(busy === "push" || busy === "pull") && !github?.connected && onGitHub ? (
            // Without the app's GitHub connection the push rides the machine's
            // own credential helper — which may pop a browser sign-in.
            <p className="branchpop__hint">
              Если появится окно входа GitHub — подтвердите доступ в браузере.
            </p>
          ) : null}
          {(() => {
            // A live PR exists → show its status card (checks + reviews); the
            // session link is the fallback for a just-created PR before the API
            // reflects it. Otherwise offer the Create-PR button.
            const link = headBranch ? sessionPrLinks.get(prLinkKey(workspacePath, headBranch)) : undefined;
            if (pull) {
              const c = pull.checks;
              const checkTone =
                c?.state === "failure" ? "is-fail" : c?.state === "pending" ? "is-pending" : "is-ok";
              return (
                <button
                  className="branchpop__pr-card"
                  onClick={() => void window.wello.openExternal(pull.url)}
                  title={`Открыть PR #${pull.number} на GitHub`}
                >
                  <span className="branchpop__pr-top">
                    <Icon name="rocket" size={12} />
                    <span className="branchpop__pr-num">
                      PR #{pull.number}
                      {pull.draft ? " · черновик" : ""}
                    </span>
                    <Icon name="external" size={11} />
                  </span>
                  <span className="branchpop__pr-title">{pull.title}</span>
                  <span className="branchpop__pr-meta">
                    {c ? (
                      <span className={`branchpop__pr-checks ${checkTone}`}>
                        {c.state === "failure"
                          ? `✗ ${c.failed}/${c.total} проверок упало`
                          : c.state === "pending"
                            ? `● ${c.running} проверок идёт`
                            : `✓ ${c.passed}/${c.total} проверок`}
                      </span>
                    ) : (
                      <span className="branchpop__pr-checks">без CI-проверок</span>
                    )}
                    {pull.reviewComments > 0 ? (
                      <span className="branchpop__pr-reviews">💬 {pull.reviewComments}</span>
                    ) : null}
                  </span>
                </button>
              );
            }
            if (link) {
              return (
                <button
                  className="branchpop__item branchpop__pr"
                  onClick={() => void window.wello.openExternal(link.url)}
                  title={link.url}
                >
                  <span className="branchpop__check" aria-hidden>
                    <Icon name="external" size={12} />
                  </span>
                  PR #{link.number}
                </button>
              );
            }
            const reason = !github?.connected
              ? "Подключите GitHub в настройках"
              : !onGitHub
                ? "origin не на GitHub"
                : !sync.upstream
                  ? "Сначала отправьте ветку"
                  : running
                    ? "Дождитесь завершения хода агента"
                    : detached || !headBranch
                      ? "Отсоединённый HEAD — переключитесь на ветку"
                      : null;
            return (
              <button
                className="branchpop__item branchpop__pr"
                disabled={Boolean(reason) || Boolean(busy)}
                title={reason ?? "Создать pull request на GitHub"}
                onClick={() => setPrOpen(true)}
              >
                <span className="branchpop__check" aria-hidden>
                  <Icon name="rocket" size={12} />
                </span>
                Создать pull request
              </button>
            );
          })()}
        </>
      ) : manualUrl ? (
        <div className="branchpop__remote">
          <input
            className="branchpop__field"
            placeholder="URL удалённого репозитория"
            value={remoteUrl}
            spellCheck={false}
            onChange={(e) => setRemoteUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doAddRemote();
            }}
          />
          <button
            className="button ghost sm"
            disabled={!remoteUrl.trim() || Boolean(busy)}
            onClick={() => void doAddRemote()}
          >
            {busy === "remote" ? <span className="spinner" aria-hidden /> : null}
            Привязать
          </button>
          <button className="branchpop__link" onClick={() => setManualUrl(false)}>
            ← Создать новый репозиторий
          </button>
        </div>
      ) : github?.connected ? (
        <div className="branchpop__publish">
          <p className="branchpop__caption">Опубликовать на GitHub</p>
          <input
            className="branchpop__field"
            placeholder="имя-репозитория"
            value={publishName}
            spellCheck={false}
            disabled={busy === "publish"}
            onChange={(e) => {
              setPublishName(e.target.value);
              setPublishError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doPublish();
            }}
          />
          <label className="branchpop__checkline">
            <input
              type="checkbox"
              checked={publishPrivate}
              disabled={busy === "publish"}
              onChange={(e) => setPublishPrivate(e.target.checked)}
            />
            Приватный репозиторий
          </label>
          <button
            className="button primary sm branchpop__publishbtn"
            disabled={!publishName.trim() || mutationsLocked}
            title={lockTitle ?? "Создать репозиторий на GitHub и отправить код"}
            onClick={() => void doPublish()}
          >
            {busy === "publish" ? <span className="spinner" aria-hidden /> : null}
            {busy === "publish" ? "Публикую…" : "Опубликовать"}
          </button>
          {publishError ? (
            <div className="branchpop__error" role="alert">
              <pre className="branchpop__stderr">{publishError}</pre>
            </div>
          ) : null}
          <button className="branchpop__link" onClick={() => setManualUrl(true)}>
            Привязать существующий репозиторий по URL
          </button>
        </div>
      ) : (
        <div className="branchpop__publish">
          <p className="branchpop__hint">
            Подключите GitHub — приложение создаст репозиторий и отправит код в один клик.
            Вход по одноразовому коду, пароль не нужен.
          </p>
          <button
            className="button primary sm branchpop__publishbtn"
            disabled={!github}
            onClick={() => setConnectOpen(true)}
          >
            Подключить GitHub
          </button>
          <button className="branchpop__link" onClick={() => setManualUrl(true)}>
            Привязать репозиторий по URL
          </button>
        </div>
      )}

      {error ? (
        <div className={`branchpop__error ${error.kind === "dirty" ? "is-warn" : ""}`} role="alert">
          <pre className="branchpop__stderr">{error.text}</pre>
          {error.diverged ? (
            <p className="branchpop__advice">
              Ветки разошлись — заберите изменения вручную из терминала.
            </p>
          ) : null}
          {error.kind === "dirty" ? (
            <button className="button ghost sm" onClick={onOpenReview}>
              Открыть проверку
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="branchpop__sep" role="separator" />

      <p className="branchpop__caption">Ветки</p>
      {(branches?.length ?? 0) > FILTER_FROM ? (
        <input
          className="branchpop__field branchpop__filter"
          placeholder="Фильтр веток…"
          value={filter}
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
        />
      ) : null}
      <ul className="branchpop__list">
        {branches === null ? (
          <li className="branchpop__note">Загрузка…</li>
        ) : shown.length === 0 ? (
          <li className="branchpop__note">{filter.trim() ? "Ничего не найдено" : "Веток нет"}</li>
        ) : (
          shown.map((b) =>
            renaming === b ? (
              <li key={b} className="branchpop__new">
                <input
                  className="branchpop__field"
                  value={renameTo}
                  autoFocus
                  spellCheck={false}
                  onChange={(e) => setRenameTo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void doRename();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setRenaming(null);
                      setRenameTo("");
                    }
                  }}
                />
                <button
                  className="button ghost sm"
                  disabled={!renameTo.trim() || mutationsLocked}
                  onClick={() => void doRename()}
                >
                  {busy === "rename" ? <span className="spinner" aria-hidden /> : null}
                  ОК
                </button>
              </li>
            ) : confirmDel === b ? (
              <li key={b} className="branchpop__confirm">
                <span className="branchpop__confirm-text">
                  {forceDel === b ? `Ветка не слита. Удалить «${b}» принудительно?` : `Удалить «${b}»?`}
                </span>
                <button
                  className="button ghost sm"
                  onClick={() => {
                    setConfirmDel(null);
                    setForceDel(null);
                  }}
                >
                  Нет
                </button>
                <button
                  className="button sm danger-solid"
                  disabled={mutationsLocked}
                  onClick={() => void doDelete(b, forceDel === b)}
                >
                  {busy === "delete" ? <span className="spinner" aria-hidden /> : null}
                  Удалить
                </button>
              </li>
            ) : (
              <li key={b} className="branchpop__row">
                <button
                  className={`branchpop__item ${b === current ? "is-current" : ""}`}
                  disabled={unborn || mutationsLocked || b === current}
                  title={b === current ? "Текущая ветка" : (lockTitle ?? `Переключиться на ${b}`)}
                  onClick={() => void doSwitch(b)}
                >
                  <span className="branchpop__check" aria-hidden>
                    {b === current ? <Icon name="check" size={12} /> : null}
                  </span>
                  <span className="branchpop__branch">{b}</span>
                </button>
                <span className="branchpop__rowactions">
                  <button
                    className="icon-button"
                    title="Переименовать ветку"
                    aria-label={`Переименовать ветку ${b}`}
                    disabled={mutationsLocked}
                    onClick={() => {
                      setRenaming(b);
                      setRenameTo(b);
                      setConfirmDel(null);
                    }}
                  >
                    <Icon name="edit" size={12} />
                  </button>
                  {b !== current ? (
                    <button
                      className="icon-button"
                      title="Удалить ветку"
                      aria-label={`Удалить ветку ${b}`}
                      disabled={mutationsLocked}
                      onClick={() => {
                        setConfirmDel(b);
                        setForceDel(null);
                        setRenaming(null);
                      }}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  ) : null}
                </span>
              </li>
            ),
          )
        )}
      </ul>

      {creating ? (
        <div className="branchpop__new">
          <input
            className="branchpop__field"
            placeholder="имя-новой-ветки"
            value={newName}
            autoFocus
            spellCheck={false}
            onFocus={(e) => {
              // The prefix is a starting point — the caret lands after it and
              // the whole thing stays editable (deletable) like any text.
              const end = e.target.value.length;
              e.target.setSelectionRange(end, end);
            }}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doCreate();
              if (e.key === "Escape") {
                e.stopPropagation();
                setCreating(false);
                setNewName("");
              }
            }}
          />
          <button
            className="button ghost sm"
            disabled={!newName.trim() || mutationsLocked || unborn}
            onClick={() => void doCreate()}
          >
            {busy === "create" ? <span className="spinner" aria-hidden /> : null}
            Создать
          </button>
        </div>
      ) : (
        <button
          className="branchpop__item branchpop__add"
          disabled={unborn || mutationsLocked}
          title={unborn ? "Сделайте первый коммит" : lockTitle}
          onClick={() => {
            // The branch-prefix SETTING is read at use — no restart needed.
            void window.wello
              .getSettings()
              .then((s) => setNewName((prev) => prev || (s.gitBranchPrefix ?? "")))
              .catch(() => undefined)
              .finally(() => setCreating(true));
          }}
        >
          <span className="branchpop__check" aria-hidden>
            <Icon name="plus" size={12} />
          </span>
          Новая ветка
        </button>
      )}

      {remoteOnly.length > 0 ? (
        <>
          <p className="branchpop__caption">Удалённые ветки</p>
          <ul className="branchpop__list">
            {remoteOnly.slice(0, 12).map((b) => (
              <li key={b}>
                <button
                  className="branchpop__item"
                  disabled={unborn || mutationsLocked}
                  title={lockTitle ?? `Получить ветку origin/${b}`}
                  onClick={() => void doCheckoutRemote(b)}
                >
                  <span className="branchpop__check" aria-hidden>
                    {busy === "checkout" ? <span className="spinner" aria-hidden /> : <Icon name="forward" size={12} />}
                  </span>
                  <span className="branchpop__branch">{b}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {!unborn ? (
        <>
          <div className="branchpop__sep" role="separator" />
          <button
            className="branchpop__item"
            disabled={mutationsLocked}
            title={lockTitle ?? "Спрятать текущие изменения (git stash)"}
            onClick={() => void doStash()}
          >
            <span className="branchpop__check" aria-hidden>
              {busy === "stash" ? <span className="spinner" aria-hidden /> : <Icon name="collapse" size={12} />}
            </span>
            Спрятать изменения
          </button>
          {stashN > 0 ? (
            <button
              className="branchpop__item"
              disabled={mutationsLocked}
              title={lockTitle ?? "Вернуть спрятанные изменения (git stash pop)"}
              onClick={() => void doStashPop()}
            >
              <span className="branchpop__check" aria-hidden>
                {busy === "stashpop" ? <span className="spinner" aria-hidden /> : <Icon name="expand" size={12} />}
              </span>
              Вернуть спрятанное ({stashN})
            </button>
          ) : null}
        </>
      ) : null}
      {prOpen ? (
        <CreatePrModal
          workspacePath={workspacePath}
          head={(current ?? info.branch)!}
          model={model}
          onClose={() => setPrOpen(false)}
          onCreated={() => {
            setPrOpen(false);
            onChanged();
          }}
        />
      ) : null}
      {connectOpen ? (
        <DeviceFlowModal
          onClose={() => setConnectOpen(false)}
          onConnected={(login) => {
            setConnectOpen(false);
            setGithub({ connected: true, login });
            toast({ message: `GitHub подключён как ${login}`, tone: "success" });
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
