import { Component, type ErrorInfo, type ReactNode } from "react";
import { Icon } from "./Icon";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * A last-resort boundary: without it, any render-time throw blanks the whole
 * desktop window (there is no browser chrome to reload from). Instead we show a
 * calm, recoverable card — reload the view or copy the details for a bug report.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it in the dev console / logs too; the card is the user-facing half.
    console.error("Renderer crashed:", error, info.componentStack);
  }

  private copy = (): void => {
    const { error } = this.state;
    if (!error) return;
    void window.wello.copyText(`${error.message}\n\n${error.stack ?? ""}`).catch(() => undefined);
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="center">
        <section className="card wello-rise" aria-labelledby="crash-title" role="alert">
          <div className="card__mark" aria-hidden>
            <Icon name="bug" size={22} />
          </div>
          <h1 id="crash-title" className="card__title">
            Что-то пошло не так
          </h1>
          <p className="card__subtitle">
            Интерфейс неожиданно сбойнул. Ваши задачи и история сохранены — перезагрузите окно, чтобы
            продолжить.
          </p>
          <pre className="crash__detail">{error.message}</pre>
          <div className="crash__actions">
            <button className="button ghost sm" onClick={this.copy}>
              <Icon name="copy" size={13} />
              Скопировать детали
            </button>
            <button className="button primary sm" onClick={() => window.location.reload()}>
              <Icon name="undo" size={13} />
              Перезагрузить
            </button>
          </div>
        </section>
      </main>
    );
  }
}
