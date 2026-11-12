import { normalizeTopic } from "@organizer/shared";
import { type KeyboardEvent, type ReactNode, type Ref, useDeferredValue, useId, useState } from "react";
import { useTopics } from "../../lib/queries.ts";
import styles from "./People.module.css";

interface Props {
  topics: readonly string[];
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  /** Renders one chip; defaults to the plain name with a remove button. */
  renderChip?: (name: string) => ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  placeholder?: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What Enter adds: the highlighted suggestion, else the typed text (trimmed, spaces collapsed). */
export function topicToAdd(typed: string, suggestion: string | undefined): string | null {
  if (suggestion) return suggestion;
  const name = normalizeTopic(typed.replaceAll(",", " "));
  return name ? name.slice(0, 60) : null;
}

/**
 * Topic chips with an input: Enter (or a comma) adds the highlighted suggestion or the typed topic,
 * Backspace in the empty input removes the last chip, arrow keys move through suggestions from /topics.
 */
export function TopicInput({ topics, onAdd, onRemove, renderChip, inputRef, placeholder }: Props) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const query = useDeferredValue(text.trim());
  const suggestions = useTopics(query, focused);
  const listId = useId();
  const options = (suggestions.data ?? [])
    .map((t) => t.name)
    .filter((name) => !topics.some((t) => same(t, name)))
    .slice(0, 8);
  const open = focused && text.trim().length > 0 && options.length > 0;
  const highlighted = open && active >= 0 ? options[active] : undefined;

  const add = (name: string | null) => {
    setText("");
    setActive(-1);
    if (name && !topics.some((t) => same(t, name))) onAdd(name);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (text.trim() || highlighted) add(topicToAdd(text, highlighted));
    } else if (event.key === "Backspace" && text === "" && topics.length > 0) {
      event.preventDefault();
      onRemove(topics.at(-1) as string);
    } else if (event.key === "ArrowDown" && open) {
      event.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
    }
  };

  return (
    <div className={styles.topicBox}>
      <ul className={styles.chips} aria-label="Topics">
        {topics.map((name) => (
          <li key={name}>
            {renderChip ? (
              renderChip(name)
            ) : (
              <span className={styles.chip}>
                {name}
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={`Remove topic ${name}`}
                  onClick={() => onRemove(name)}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                    <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className={styles.topicField}>
        <input
          ref={inputRef}
          className={styles.topicInput}
          value={text}
          maxLength={60}
          placeholder={
            placeholder ?? (topics.length > 0 ? "Add a topic" : "What they help with, e.g. firewall rules")
          }
          aria-label="Add a topic"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={highlighted ? `${listId}-${active}` : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {open && (
          <ul id={listId} role="listbox" className={styles.suggestions} aria-label="Matching topics">
            {options.map((name, i) => (
              <li
                key={name}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={styles.suggestion}
                // Keep the focus in the input; a click picks the topic.
                onMouseDown={(event) => {
                  event.preventDefault();
                  add(name);
                }}
              >
                {name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
