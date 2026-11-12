import { type KeyboardEvent, type Ref, useState } from "react";
import styles from "./People.module.css";

interface Props {
  label: string;
  value: string;
  onSave: (value: string) => void;
  placeholder: string;
  maxLength: number;
  type?: "text" | "email";
  /** id of a datalist with suggestions (team names). */
  list?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}

/** A value shown as text; click or Enter edits it in place. Enter or leaving saves, Esc cancels. */
export function InlineText({
  label,
  value,
  onSave,
  placeholder,
  maxLength,
  type = "text",
  list,
  buttonRef,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const finish = (save: boolean) => {
    setEditing(false);
    const next = draft.trim();
    if (save && next !== value) onSave(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  };

  if (editing) {
    return (
      <input
        className={styles.inlineInput}
        type={type}
        value={draft}
        maxLength={maxLength}
        list={list}
        aria-label={label}
        placeholder={placeholder}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened on purpose to type
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => finish(true)}
      />
    );
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.inlineValue}
      data-empty={value === "" || undefined}
      aria-label={`${label}: ${value || "not set"}. Edit`}
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
    >
      {value || placeholder}
    </button>
  );
}
