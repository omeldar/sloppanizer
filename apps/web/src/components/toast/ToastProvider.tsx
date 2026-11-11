import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./Toast.module.css";

export interface ToastInput {
  message: string;
  tone?: "info" | "error";
  /** One action, e.g. Undo. Running it closes the toast. */
  action?: { label: string; run: () => void };
  durationMs?: number;
}

interface Toast extends ToastInput {
  id: number;
}

interface ToastApi {
  show: (toast: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export const TOAST_MS = 5000;
const MAX_TOASTS = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback((toast: ToastInput) => {
    const id = nextId.current++;
    setToasts((all) => [...all, { ...toast, id }].slice(-MAX_TOASTS));
    return id;
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <section className={styles.region} aria-label="Notifications" aria-live="polite">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} dismiss={dismiss} />
        ))}
      </section>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const onDismiss = useCallback(() => dismiss(toast.id), [dismiss, toast.id]);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(onDismiss, toast.durationMs ?? TOAST_MS);
    return () => clearTimeout(timer);
  }, [paused, onDismiss, toast.durationMs]);

  return (
    <div
      className={styles.toast}
      data-tone={toast.tone ?? "info"}
      role={toast.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span className={styles.message}>{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            toast.action?.run();
            onDismiss();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className={styles.close} aria-label="Close notification" onClick={onDismiss}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast needs a ToastProvider above it.");
  return api;
}
