import { useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlight, resolveLanguage } from "./highlight";
import { Icon } from "./Icon";
import { parseFileRef, isRelativeFileHref } from "./file-ref";

/** Flattens a React inline-code child to its plain text (usually already a string). */
function nodeText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(nodeText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return nodeText((children as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

/** A clickable file mention (inline code or link) that opens the file in the inspector. */
function FileRefChip({
  label,
  path,
  onOpenFile,
}: {
  label: ReactNode;
  path: string;
  onOpenFile: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="md-fileref"
      title={`Открыть ${path}`}
      onClick={() => onOpenFile(path)}
    >
      <Icon name="file" size={11} />
      <span className="md-fileref__label">{label}</span>
    </button>
  );
}

/** A fenced code block with a header bar (language + copy), matching the reference. */
function CodeBlock({ children, lang }: { children: ReactNode; lang: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    const text = ref.current?.textContent ?? "";
    // Main-process clipboard: the renderer's navigator.clipboard is permission-gated.
    void window.wello.copyText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined,
    );
  };
  return (
    <div className="codeblock">
      <div className="codeblock__bar">
        <span className="codeblock__lang">{lang}</span>
        <div className="codeblock__actions">
          <button
            className="icon-button"
            title={copied ? "Скопировано" : "Скопировать код"}
            aria-label="Скопировать код"
            onClick={copy}
          >
            <Icon name={copied ? "check" : "copy"} size={13} />
          </button>
        </div>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

function buildComponents(onOpenFile?: (path: string) => void): Components {
  return {
    a({ href, children }) {
      // A relative href that names a workspace file opens in the inspector; a real
      // URL (http/mailto) still goes to the external browser.
      const fileRef = onOpenFile ? isRelativeFileHref(href) : null;
      if (fileRef && onOpenFile) {
        return <FileRefChip label={children} path={fileRef.path} onOpenFile={onOpenFile} />;
      }
      return (
        <a
          className="md-a"
          href={href}
          onClick={(e) => {
            e.preventDefault();
            if (href) void window.wello.openExternal(href);
          }}
        >
          {children}
        </a>
      );
    },
    pre({ children }) {
      // The <code> child carries the language in its className (language-xxx).
      let lang = "code";
      if (children && typeof children === "object" && "props" in children) {
        const cls = (children.props as { className?: string }).className ?? "";
        const m = /language-(\w+)/.exec(cls);
        if (m) lang = m[1]!;
      }
      return <CodeBlock lang={lang}>{children}</CodeBlock>;
    },
    code({ className, children }) {
      const isBlock = /language-/.test(className ?? "");
      if (!isBlock) {
        // An inline-code span that clearly names a workspace file becomes a click
        // that opens it in the inspector (Codex "answer → code" navigation).
        const fileRef = onOpenFile ? parseFileRef(nodeText(children)) : null;
        if (fileRef && onOpenFile) {
          return <FileRefChip label={children} path={fileRef.path} onOpenFile={onOpenFile} />;
        }
        return <code className="md-code">{children}</code>;
      }
      // Token colors come from design-system variables (app.css maps .hljs-*).
      // hljs escapes the source itself, so its output HTML is safe to inject.
      const lang = resolveLanguage(/language-([\w+-]+)/.exec(className ?? "")?.[1]);
      const html = highlight(String(children).replace(/\n$/, ""), lang);
      return html != null ? (
        <code className={className} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code className={className}>{children}</code>
      );
    },
  };
}

/** Renders agent output as GitHub-flavored markdown (prose, code, lists, links).
 *  When `onOpenFile` is given, file mentions become clickable inspector links. */
export function Markdown({ text, onOpenFile }: { text: string; onOpenFile?: (path: string) => void }) {
  const components = useMemo(() => buildComponents(onOpenFile), [onOpenFile]);
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
