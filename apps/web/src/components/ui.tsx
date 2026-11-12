import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useState,
} from "react";
import { keyCaps } from "../keyboard/keys.ts";
import { errorMessage } from "../lib/api.ts";
import styles from "./ui.module.css";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "sm";
  /** Shortcut shown inside the button, e.g. "c". */
  hint?: string;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", hint, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={[styles.button, className].filter(Boolean).join(" ")}
      data-variant={variant}
      data-size={size}
      {...rest}
    >
      {children}
      {hint && <Kbd keys={hint} subtle />}
    </button>
  );
});

export function Kbd({ keys, subtle = false }: { keys: string; subtle?: boolean }) {
  return (
    <span className={styles.kbdGroup} data-subtle={subtle || undefined} aria-label={`Shortcut ${keys}`}>
      {numbered(keyCaps(keys)).map(({ id, cap }) => (
        <kbd key={id} className={styles.kbd}>
          {cap}
        </kbd>
      ))}
    </span>
  );
}

/** Caps can repeat ("g g"), so each gets its position as a stable id. */
function numbered(caps: string[]): { id: string; cap: string }[] {
  return caps.map((cap, position) => ({ id: `${position}:${cap}`, cap }));
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return <input ref={ref} className={[styles.input, className].filter(Boolean).join(" ")} {...rest} />;
  },
);

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {hint && <span className={styles.fieldHint}>{hint}</span>}
    </label>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className={styles.error} role="alert">
      <span>{errorMessage(error)}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className={styles.loading} role="status">
      <span className={styles.loadingBar} />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}

export function PageHeader({
  title,
  meta,
  actions,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={styles.pageHeader}>
      <div className={styles.pageTitleRow}>
        <h1 className={styles.pageTitle}>{title}</h1>
        {meta && <span className={styles.pageMeta}>{meta}</span>}
      </div>
      {actions && <div className={styles.pageActions}>{actions}</div>}
    </header>
  );
}

/** A button that shows a field's value and opens its picker (project, labels, people). */
export const FieldButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { empty?: boolean }
>(function FieldButton({ className, empty, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={[styles.fieldButton, className].filter(Boolean).join(" ")}
      data-empty={empty || undefined}
      {...rest}
    />
  );
});

/** Title editor opened on purpose (key e or a click): Enter or blur saves, Esc cancels (null). */
export function TitleInput({
  initial,
  onDone,
  maxLength,
  className,
}: {
  initial: string;
  onDone: (title: string | null) => void;
  maxLength: number;
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") onDone(value.trim());
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDone(null);
    }
  };
  return (
    <input
      className={className}
      value={value}
      maxLength={maxLength}
      aria-label="Title"
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened on purpose to type
      autoFocus
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => onDone(value.trim())}
    />
  );
}
