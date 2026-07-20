import { useEffect, useRef, useState } from "react";
import type { PrContext } from "../../shared/ipc-api";
import { defaultPrTitle } from "../../shared/github";
import { Icon } from "./Icon";
import { Modal, ModalCancel } from "./Modal";
import { toast } from "./Toaster";

/** PRs created this session, by "workspace|branch" — the popover shows the
 *  link instead of the button after a successful create. */
export const sessionPrLinks = new Map<string, { number: number; url: string }>();

export function prLinkKey(workspacePath: string, branch: string): string {
  return `${workspacePath}|${branch}`;
}

/**
 * The «Новый pull request» modal (git stage 3): base from the repo's default
 * branch, head = the current branch (read-only), title prefilled from the last
 * commit, generation from the branch's commits/diff in the current model,
 * draft on by default. Pushes first when the branch is ahead.
 */
export function CreatePrModal({
  workspacePath,
  head,
  model,
  onClose,
  onCreated,
}: {
  workspacePath: string;
  head: string;
  model: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [ctx, setCtx] = useState<PrContext | null>(null);
  const [base, setBase] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<{ number: number; url: string } | null>(null);
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  useEffect(() => {
    void window.wello.githubPrContext(workspacePath).then((c) => {
      if (!aliveRef.current) return;
      setCtx(c);
      setBase(c.defaultBranch ?? c.remoteBranches[0] ?? "main");
      setTitle(defaultPrTitle(c.lastSubject, head));
    });
    // The draft DEFAULT comes from settings (read at open); the checkbox in the
    // modal still flips it for this one PR.
    void window.wello
      .getSettings()
      .then((s) => {
        if (aliveRef.current) setDraft(s.gitPrDraftDefault !== false);
      })
      .catch(() => undefined);
  }, [workspacePath, head]);

  const generate = async (): Promise<void> => {
    if (generating || creating || !base) return;
    setGenerating(true);
    try {
      const text = await window.wello.githubPrText(workspacePath, base, model);
      if (!aliveRef.current) return;
      if (text) {
        setTitle(text.title);
        setBody(text.body);
      } else {
        toast({ message: "Не удалось сгенерировать описание", tone: "danger" });
      }
    } finally {
      if (aliveRef.current) setGenerating(false);
    }
  };

  const create = async (): Promise<void> => {
    if (creating || !title.trim() || !base) return;
    setCreating(true);
    setError(null);
    setExisting(null);
    try {
      const res = await window.wello.githubCreatePr(workspacePath, {
        title: title.trim(),
        body,
        head,
        base,
        draft,
      });
      if (!aliveRef.current) return;
      if (res.ok && res.url && res.number != null) {
        sessionPrLinks.set(prLinkKey(workspacePath, head), { number: res.number, url: res.url });
        const url = res.url;
        toast({
          message: `PR #${res.number} создан`,
          tone: "success",
          action: { label: "Открыть", onClick: () => void window.wello.openExternal(url) },
        });
        onCreated();
      } else {
        if (res.exists) {
          sessionPrLinks.set(prLinkKey(workspacePath, head), res.exists);
          setExisting(res.exists);
        }
        setError(res.error ?? "Не удалось создать pull request.");
      }
    } finally {
      if (aliveRef.current) setCreating(false);
    }
  };

  const bases = ctx?.remoteBranches.filter((b) => b !== head) ?? [];
  return (
    <Modal title="Новый pull request" onClose={onClose}>
      {!ctx ? (
        <p className="ghconnect__wait">
          <span className="spinner" aria-hidden /> Загрузка…
        </p>
      ) : (
        <div className="prform">
          <div className="prform__row">
            <label className="prform__label" htmlFor="pr-base">
              base
            </label>
            <select
              id="pr-base"
              className="prform__select"
              value={base}
              disabled={creating}
              onChange={(e) => setBase(e.target.value)}
            >
              {bases.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <span className="prform__arrow" aria-hidden>
              ←
            </span>
            <span className="prform__head" title={head}>
              {head}
            </span>
          </div>
          <input
            className="prform__field"
            placeholder="Заголовок"
            value={title}
            disabled={creating}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="prform__body"
            placeholder="Описание (markdown)"
            rows={6}
            value={body}
            disabled={creating}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="prform__row prform__row--foot">
            <label className="prform__draft">
              <input
                type="checkbox"
                checked={draft}
                disabled={creating}
                onChange={(e) => setDraft(e.target.checked)}
              />
              Черновик
            </label>
            <span className="prform__spacer" />
            <button
              className="button ghost sm"
              disabled={generating || creating}
              onClick={() => void generate()}
            >
              {generating ? <span className="spinner" aria-hidden /> : <Icon name="compose" size={13} />}
              {generating ? "Генерирую…" : "Сгенерировать описание"}
            </button>
          </div>
          {ctx.ahead > 0 ? (
            <p className="prform__note">
              Перед созданием будет отправлено {ctx.ahead}{" "}
              {ctx.ahead === 1 ? "коммит" : ctx.ahead < 5 ? "коммита" : "коммитов"} (git push).
            </p>
          ) : null}
          {error ? (
            <div className="prform__error" role="alert">
              <p className="prform__errtext">{error}</p>
              {existing ? (
                <button
                  className="button ghost sm"
                  onClick={() => void window.wello.openExternal(existing.url)}
                >
                  <Icon name="external" size={13} />
                  Открыть PR #{existing.number}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="modal__actions">
            <ModalCancel fallback={onClose}>Отмена</ModalCancel>
            <button
              className="button primary sm"
              disabled={creating || !title.trim() || !base}
              onClick={() => void create()}
            >
              {creating ? <span className="spinner" aria-hidden /> : null}
              {creating ? "Создаю…" : "Создать pull request"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
