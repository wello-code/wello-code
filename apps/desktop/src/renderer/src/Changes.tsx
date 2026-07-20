import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangedFile, ChangeSummary } from "../../shared/ipc-api";
import { highlight, languageForPath } from "./highlight";
import { Icon } from "./Icon";
import { toast } from "./Toaster";

/** Copy via the main-process clipboard (navigator.clipboard is permission-gated) + toast. */
function copyToClipboard(text: string, okMessage: string): void {
  if (!text) return;
  void window.wello.copyText(text).then(
    () => toast({ message: okMessage, tone: "success" }),
    () => toast({ message: "Не удалось скопировать", tone: "danger" }),
  );
}

function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return { dir: "", name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

/** The Review tab: uncommitted files with per-file counts, a numbered diff and
 *  (in a git repo) the commit-as-accept bar; a plain folder offers git init. */
export function ReviewPane({
  workspacePath,
  taskId,
  refreshKey,
  model,
  onOpenFile,
  onRepoChanged,
}: {
  workspacePath: string;
  taskId: string;
  refreshKey: number;
  /** The composer's current model — the commit-message generator uses it. */
  model: string;
  onOpenFile: (path: string) => void;
  /** Init/commit changed the repo state — the app refreshes the chip and the card. */
  onRepoChanged: () => void;
}) {
  const [summary, setSummary] = useState<ChangeSummary | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // Reverting is destructive (new files are permanently deleted, edits discarded),
  // so it takes two clicks — matching the inline change-set card. The armed row
  // resets on its own after a few seconds.
  const [armed, setArmed] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (armTimer.current && clearTimeout(armTimer.current)), []);

  const openFile = useCallback(
    async (path: string): Promise<void> => {
      setSelected(path);
      const result = await window.wello.reviewDiff(workspacePath, taskId, path);
      setDiff(result.diff);
    },
    [workspacePath, taskId],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.wello.reviewSummary(workspacePath, taskId);
    setSummary(next);
    setSelected((prev) => {
      if (prev && next.files.some((f) => f.path === prev)) return prev;
      const first = next.files[0]?.path ?? null;
      if (first) void openFile(first);
      else setDiff("");
      return first;
    });
  }, [workspacePath, taskId, openFile]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const reject = async (file: ChangedFile): Promise<void> => {
    // First click arms; second click (within the window) actually reverts.
    if (armed !== file.path) {
      setArmed(file.path);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(null), 3500);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(null);
    setBusy(true);
    try {
      await window.wello.reviewRevertFile(workspacePath, taskId, file.path);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  // A snapshot-added file (like an untracked git file) has no base to restore to —
  // reverting it means deleting it, so it gets the destructive trash affordance.
  const isNewFile = (f: ChangedFile): boolean => f.status === "untracked" || f.status === "added";

  // ── Local git, stage 1: init a plain folder / commit-as-accept ─────────────
  const [initBusy, setInitBusy] = useState(false);
  const doInit = async (): Promise<void> => {
    if (initBusy) return;
    setInitBusy(true);
    try {
      const res = await window.wello.gitInit(workspacePath, taskId);
      if (res.ok) {
        toast({ message: "Git-репозиторий инициализирован", tone: "success" });
        onRepoChanged();
        await refresh();
      } else {
        toast({ message: res.stderr || "Не удалось инициализировать git", tone: "danger" });
      }
    } finally {
      setInitBusy(false);
    }
  };

  const files = summary?.files ?? [];
  const selectedFile = files.find((f) => f.path === selected) ?? null;

  // Arrow-key navigation of the file list (bubbles from the focused row button).
  const onListKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const idx = files.findIndex((f) => f.path === selected);
    const to = e.key === "ArrowDown" ? Math.min(files.length - 1, idx + 1) : Math.max(0, idx - 1);
    const f = files[to];
    if (f && f.path !== selected) void openFile(f.path);
  };

  if (!summary) {
    return (
      <div className="inspector__body">
        <div className="review-loading" aria-busy="true">
          <span className="spinner" aria-hidden />
          <span>Загрузка изменений…</span>
        </div>
      </div>
    );
  }
  // «Инициализировать git» — offered everywhere the snapshot backend is doing
  // git's job (and in the no-backing stub), but never when git itself is missing.
  const initButton =
    !summary.gitMissing && summary.backing !== "git" ? (
      <button className="button ghost sm" disabled={initBusy} onClick={() => void doInit()}>
        <Icon name="gitbranch" size={13} />
        Инициализировать git
      </button>
    ) : null;

  if (summary.backing === "none") {
    return (
      <div className="inspector__note review__stub">
        <p className="muted">
          Проверка недоступна: это не git-репозиторий, а снимок ещё не создан (или проект слишком
          большой).
        </p>
        {summary.gitMissing ? (
          <p className="muted">Установите Git, чтобы включить ветки и коммиты.</p>
        ) : (
          initButton
        )}
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div className="inspector__note review__stub">
        <p className="muted">Изменений пока нет.</p>
        {initButton}
      </div>
    );
  }
  return (
    <div className="inspector__body">
      <div className="review__totals">
        <span className="review__caption">Последние изменения</span>
        {initButton}
        <span className="pm">
          <em className="pm__add">+{summary.additions}</em> <em className="pm__del">-{summary.deletions}</em>
        </span>
      </div>
      <ul className="filelist" onKeyDown={onListKeyDown}>
        {files.map((f) => (
          <li key={f.path} className={`filelist__item ${selected === f.path ? "is-active" : ""}`}>
            <button className="filelist__name" onClick={() => void openFile(f.path)} title={f.path}>
              <span className={`badge badge--${f.status}`}>{f.status.charAt(0).toUpperCase()}</span>
              <span className="filelist__path">{f.path}</span>
            </button>
            <span className="pm">
              <em className="pm__add">+{f.additions}</em> <em className="pm__del">-{f.deletions}</em>
            </span>
            <button
              className={`icon-button filelist__revert ${armed === f.path ? "is-armed" : ""}`}
              disabled={busy}
              title={
                armed === f.path
                  ? "Нажмите ещё раз, чтобы подтвердить"
                  : isNewFile(f)
                    ? `Удалить новый файл «${f.path}» — без возможности восстановления`
                    : `Откатить изменения в «${f.path}» к исходному состоянию`
              }
              aria-label={
                armed === f.path
                  ? `Подтвердить: ${isNewFile(f) ? "удалить" : "откатить"} ${f.path}`
                  : isNewFile(f)
                    ? `Удалить новый файл ${f.path}`
                    : `Откатить ${f.path}`
              }
              onClick={() => void reject(f)}
            >
              <Icon name={isNewFile(f) ? "trash" : "undo"} size={13} />
            </button>
          </li>
        ))}
      </ul>
      {selectedFile ? (
        <div className="diffpane">
          <div className="diffpane__file">
            <button
              className="diffpane__path"
              title={`${selectedFile.path} — нажмите, чтобы скопировать путь`}
              onClick={() => copyToClipboard(selectedFile.path, "Путь скопирован")}
            >
              <span className="changeset__dir">{splitPath(selectedFile.path).dir}</span>
              <span>{splitPath(selectedFile.path).name}</span>
            </button>
            <span className="pm">
              <em className="pm__add">+{selectedFile.additions}</em>{" "}
              <em className="pm__del">-{selectedFile.deletions}</em>
            </span>
            <span className="inspector__spacer" />
            <button
              className="icon-button"
              title="Копировать дифф"
              aria-label="Копировать дифф файла"
              disabled={!diff}
              onClick={() => copyToClipboard(diff, "Дифф скопирован")}
            >
              <Icon name="copy" size={13} />
            </button>
            <button
              className="icon-button"
              title="Открыть файл во вкладке"
              aria-label="Открыть файл во вкладке"
              onClick={() => onOpenFile(selectedFile.path)}
            >
              <Icon name="file" size={13} />
            </button>
          </div>
          <DiffView text={diff} path={selectedFile.path} />
        </div>
      ) : (
        <p className="muted inspector__note">Выберите файл, чтобы посмотреть дифф.</p>
      )}
      {summary.backing === "git" ? (
        <CommitBar
          workspacePath={workspacePath}
          taskId={taskId}
          files={files}
          model={model}
          disabled={busy}
          onCommitted={async () => {
            onRepoChanged();
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Commit-as-accept (git backend only): a one-line message field (grows to ~3
 * rows), «Закоммитить всё» and the generator that asks the CURRENT model for
 * a one-liner from the change diff. Failures (unset user.name/email being the
 * classic) surface as a compact red block with git's own words.
 */
function CommitBar({
  workspacePath,
  taskId,
  files,
  model,
  disabled,
  onCommitted,
}: {
  workspacePath: string;
  taskId: string;
  files: ChangedFile[];
  model: string;
  disabled: boolean;
  onCommitted: () => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // The field grows with its content, one line up to ~three.
  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 84)}px`;
  }, [message]);

  const commit = async (): Promise<void> => {
    const msg = message.trim();
    if (!msg || committing) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await window.wello.gitCommitAll(workspacePath, msg);
      if (res.ok) {
        setMessage("");
        toast({
          message: res.shortHash ? `Закоммичено · ${res.shortHash}` : "Закоммичено",
          tone: "success",
        });
        await onCommitted();
      } else {
        setError(res.stderr || "Не удалось создать коммит.");
      }
    } finally {
      setCommitting(false);
    }
  };

  /** Collect the change diff (bounded) and ask the model for a one-liner. */
  const generate = async (): Promise<void> => {
    if (generating || committing || files.length === 0) return;
    setGenerating(true);
    try {
      const parts: string[] = [];
      let total = 0;
      for (const f of files) {
        if (total > 48_000) {
          parts.push(`… и ещё ${files.length - parts.length} файлов без диффа`);
          break;
        }
        const d = await window.wello.reviewDiff(workspacePath, taskId, f.path);
        const chunk = `--- ${f.path}\n${d.diff.slice(0, 12_000)}`;
        parts.push(chunk);
        total += chunk.length;
      }
      const suggestion = await window.wello.gitCommitMessage(parts.join("\n\n"), model);
      if (suggestion) {
        setMessage(suggestion);
        fieldRef.current?.focus();
      } else {
        toast({ message: "Не удалось сгенерировать сообщение", tone: "danger" });
      }
    } finally {
      setGenerating(false);
    }
  };

  const configHint = error && /user\.(name|email)|tell me who you are/i.test(error);
  return (
    <div className="commitbar">
      {error ? (
        <div className="commitbar__error" role="alert">
          <pre className="commitbar__stderr">{error}</pre>
          {configHint ? (
            <p className="commitbar__hint">
              Представьтесь git-у: <code>git config --global user.name "Имя"</code> и{" "}
              <code>git config --global user.email "you@example.com"</code>, затем повторите.
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="commitbar__row">
        <textarea
          ref={fieldRef}
          className="commitbar__field"
          rows={1}
          placeholder="Сообщение коммита"
          value={message}
          disabled={committing}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <button
          className="button ghost sm commitbar__gen"
          title="Сгенерировать сообщение по диффу текущей моделью"
          disabled={generating || committing || disabled}
          onClick={() => void generate()}
        >
          {generating ? <span className="spinner" aria-hidden /> : <Icon name="compose" size={13} />}
          {generating ? "Генерирую…" : "Сгенерировать"}
        </button>
        <button
          className="button primary sm"
          disabled={!message.trim() || committing || disabled}
          onClick={() => void commit()}
        >
          {committing ? "Коммичу…" : "Закоммитить всё"}
        </button>
      </div>
    </div>
  );
}

interface DiffRow {
  kind: "add" | "del" | "ctx" | "hunk";
  num: number | null;
  text: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Turn a unified diff into gutter-numbered rows (new-side numbers, old for deletions). */
function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldN = 1;
  let newN = 1;
  for (const line of text.split("\n")) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldN = Number(hunk[1]);
      newN = Number(hunk[2]);
      rows.push({ kind: "hunk", num: null, text: line });
      continue;
    }
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to") ||
      line.startsWith("Binary files") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", num: newN, text: line.slice(1) });
      newN += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", num: oldN, text: line.slice(1) });
      oldN += 1;
    } else if (line.length > 0 || rows.length > 0) {
      rows.push({ kind: "ctx", num: newN, text: line.startsWith(" ") ? line.slice(1) : line });
      oldN += 1;
      newN += 1;
    }
  }
  // Drop a trailing blank context row produced by the final newline.
  while (rows.length > 0 && rows[rows.length - 1]!.kind === "ctx" && rows[rows.length - 1]!.text === "") {
    rows.pop();
  }
  return rows;
}

function DiffView({ text, path }: { text: string; path: string }) {
  // Per-line syntax highlighting in the file's language; recomputed only when the
  // diff or file changes. Line-by-line coloring is an accepted diff-viewer tradeoff
  // (multi-line constructs may tint imperfectly).
  const rows = useMemo(() => {
    const lang = languageForPath(path);
    return parseDiff(text).map((row) => ({
      ...row,
      html: row.kind === "hunk" ? null : highlight(row.text, lang),
    }));
  }, [text, path]);
  return (
    <pre className="diff" aria-label="Дифф файла">
      {rows.map((row, i) => (
        <div key={i} className={`dl dl--${row.kind}`}>
          <span className="dl__num">{row.num ?? "⋯"}</span>
          {row.html != null ? (
            <span className="dl__text is-code" dangerouslySetInnerHTML={{ __html: row.html || " " }} />
          ) : (
            <span className="dl__text">{row.kind === "hunk" ? row.text : row.text || " "}</span>
          )}
        </div>
      ))}
    </pre>
  );
}
