import { useEffect, useRef, useState } from "react";
import type { GitHubAuthStatus, GitHubDeviceStart } from "../../shared/ipc-api";
import { deviceFlowErrorText, type DeviceFlowErrorCode } from "../../shared/github";
import { Icon } from "./Icon";
import { Modal, ModalCancel } from "./Modal";
import { toast } from "./Toaster";

/**
 * The GitHub connection card (Settings → Коннекторы) + the Device Flow modal:
 * a large one-time code, «Копировать код», a button that opens
 * github.com/login/device in the system browser, and the waiting spinner. The
 * token never reaches the renderer — main keeps it in the OS keychain.
 */
export function GitHubCard() {
  const [status, setStatus] = useState<GitHubAuthStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  const refresh = async (): Promise<void> => {
    setStatus(await window.wello.githubStatus().catch(() => ({ connected: false })));
  };
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="scard">
      <div className="srow" id="srow-github">
        <div className="srow__text">
          <span className="srow__title">GitHub</span>
          <span className="srow__desc">
            {status?.connected
              ? `Подключено как ${status.login ?? "…"}`
              : "Репозитории, отправка кода и pull request из приложения. Авторизация по одноразовому коду."}
          </span>
        </div>
        <div className="srow__ctl">
          {status?.connected ? (
            <button className="button secondary sm" onClick={() => setConfirmOff(true)}>
              Отключить
            </button>
          ) : (
            <button className="button primary sm" onClick={() => setConnecting(true)}>
              Подключить GitHub
            </button>
          )}
        </div>
      </div>
      {connecting ? (
        <DeviceFlowModal
          onClose={() => setConnecting(false)}
          onConnected={(login) => {
            setConnecting(false);
            toast({ message: `GitHub подключён как ${login}`, tone: "success" });
            void refresh();
          }}
        />
      ) : null}
      {confirmOff ? (
        <Modal title="Отключить GitHub?" onClose={() => setConfirmOff(false)}>
          <p className="modal__body">
            Токен доступа будет удалён с этого компьютера. Создание репозиториев, отправка кода и
            pull request станут недоступны, пока вы не подключитесь снова.
          </p>
          <div className="modal__actions">
            <ModalCancel fallback={() => setConfirmOff(false)} autoFocus>
              Отмена
            </ModalCancel>
            <button
              className="button primary sm"
              onClick={() => {
                void window.wello.githubDisconnect().then(() => {
                  setConfirmOff(false);
                  toast({ message: "GitHub отключён", tone: "success" });
                  void refresh();
                });
              }}
            >
              Отключить
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * The agent asked for GitHub (github_connect): a one-click card in the chat, in
 * the permission-card visual language. «Подключить» opens the same Device Flow
 * modal as Settings; the outcome answers the blocked tool call.
 */
export function GithubConnectCard({ onRespond }: { onRespond: (connected: boolean) => void }) {
  const [connecting, setConnecting] = useState(false);
  return (
    <section className="perm wello-rise" aria-labelledby="ghconnect-title" role="alertdialog">
      <div className="perm__head">
        <span className="perm__risk perm__risk--medium" aria-hidden />
        <strong id="ghconnect-title">Агенту нужен доступ к GitHub</strong>
      </div>
      <p className="perm__reason">
        Подключите ваш аккаунт GitHub — агент сможет создавать репозитории и отправлять код от
        вашего имени. Понадобится один раз: вход по коду, без пароля в приложении.
      </p>
      <div className="perm__actions">
        <button className="button primary sm" onClick={() => setConnecting(true)}>
          Подключить GitHub
        </button>
        <button className="button ghost sm" onClick={() => onRespond(false)}>
          Отклонить
        </button>
      </div>
      {connecting ? (
        <DeviceFlowModal
          onClose={() => setConnecting(false)}
          onConnected={(login) => {
            setConnecting(false);
            toast({ message: `GitHub подключён как ${login}`, tone: "success" });
            onRespond(true);
          }}
        />
      ) : null}
    </section>
  );
}

export function DeviceFlowModal({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (login: string) => void;
}) {
  const [start, setStart] = useState<GitHubDeviceStart | null>(null);
  const [error, setError] = useState<DeviceFlowErrorCode | "start" | null>(null);
  const [copied, setCopied] = useState(false);
  // The modal may close mid-wait (cancel) — late results must not toast.
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
      void window.wello.githubDeviceCancel();
    },
    [],
  );

  const begin = async (): Promise<void> => {
    setError(null);
    setStart(null);
    try {
      const s = await window.wello.githubDeviceStart();
      if (!aliveRef.current) return;
      setStart(s);
      const result = await window.wello.githubDeviceWait();
      if (!aliveRef.current) return;
      if (result.ok) onConnected(result.login ?? "…");
      else if (result.error !== "cancelled") setError(result.error ?? "network");
    } catch {
      if (aliveRef.current) setError("start");
    }
  };
  // Kick the flow off once on mount (begin is stable for the modal's lifetime).
  const beginRef = useRef(begin);
  beginRef.current = begin;
  useEffect(() => {
    void beginRef.current();
  }, []);

  const copy = (): void => {
    if (!start) return;
    void window.wello.copyText(start.userCode).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Modal title="Подключение GitHub" onClose={onClose}>
      {error ? (
        <>
          <p className="modal__body">
            {error === "start"
              ? "Не удалось связаться с GitHub. Проверьте интернет-соединение."
              : deviceFlowErrorText(error)}
          </p>
          <div className="modal__actions">
            <ModalCancel fallback={onClose}>Закрыть</ModalCancel>
            <button className="button primary sm" onClick={() => void begin()}>
              Попробовать снова
            </button>
          </div>
        </>
      ) : !start ? (
        <p className="ghconnect__wait">
          <span className="spinner" aria-hidden /> Запрашиваю код…
        </p>
      ) : (
        <>
          <div className="ghconnect__code" aria-label="Код подтверждения">
            {start.userCode}
          </div>
          <div className="ghconnect__row">
            <button className="button ghost sm" onClick={copy}>
              <Icon name="copy" size={13} />
              {copied ? "Скопировано" : "Копировать код"}
            </button>
            <button
              className="button primary sm"
              onClick={() => void window.wello.openExternal(start.verificationUri)}
            >
              <Icon name="external" size={13} />
              Открыть github.com/login/device
            </button>
          </div>
          <p className="ghconnect__note">Введите код на открывшейся странице.</p>
          <p className="ghconnect__wait">
            <span className="spinner" aria-hidden /> Ожидание подтверждения…
          </p>
          <div className="modal__actions">
            <ModalCancel fallback={onClose}>Отмена</ModalCancel>
          </div>
        </>
      )}
    </Modal>
  );
}
