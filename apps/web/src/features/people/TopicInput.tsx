import { normalizeTopic } from "@organizer/shared";
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useDeferredValue,
  useEffect,
  useId,
  useState,
} from "react";
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
  /**
   * Only existing topics can be added (a filter): the first match is highlighted and Enter takes it,
   * and typed text that matches no topic says so instead of being added.
   */
  existingOnly?: boolean;
}

const fold = (text: string) => normalizeTopic(text).normalize("NFC").toLocaleLowerCase("en");
const same = (a: string, b: string) => fold(a) === fold(b);

/** What Enter adds: the highlighted suggestion, else the typed text (trimmed, spaces collapsed). */
export function topicToAdd(typed: string, suggestion: string | undefined): string | null {
  if (suggestion) return suggestion;
  const name = normalizeTopic(typed.replaceAll(",", " "));
  return name ? name.slice(0, 60) : null;
}

/** The suggestion an existing-only input takes on Enter: the same name, else the first one. */
export function bestMatch(typed: string, options: readonly string[]): string | undefined {
  return options.find((name) => same(name, typed)) ?? options[0];
}

/**
 * Topic chips with an input: Enter (or a comma) adds the highlighted suggestion or the typed topic,
 * Backspace in the empty input removes the last chip, arrow keys move through suggestions from /topics.
 */
export function TopicInput({
  topics,
  onAdd,
  onRemove,
  renderChip,
  inputRef,
  placeholder,
  existingOnly = false,
}: Props) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  // Enter came before the topics for the typed text: take the best one as soon as they arrive.
  const [enterWaiting, setEnterWaiting] = useState(false);
  const typed = text.trim();
  const query = useDeferredValue(typed);
  const suggestions = useTopics(query, focused);
  // The answer belongs to the typed text (not an older one kept on screen while the next one loads).
  const current = query === typed && suggestions.isSuccess && !suggestions.isPlaceholderData;
  const listId = useId();
  const found = (suggestions.data ?? [])
    .map((t) => t.name)
    // An older answer may still show: keep only names that hold the typed text.
    .filter((name) => !existingOnly || fold(name).includes(fold(typed)));
  const options = found.filter((name) => !topics.some((t) => same(t, name))).slice(0, 8);
  const open = focused && typed.length > 0 && options.length > 0;
  const noMatch = existingOnly && focused && typed.length > 0 && current && options.length === 0;
  const activeIndex = existingOnly && active < 0 ? options.indexOf(bestMatch(typed, options) ?? "") : active;
  const highlighted = open && activeIndex >= 0 ? options[activeIndex] : undefined;

  const add = (name: string | null) => {
    setText("");
    setActive(-1);
    setEnterWaiting(false);
    if (name && !topics.some((t) => same(t, name))) onAdd(name);
  };

  useEffect(() => {
    if (!enterWaiting || !current) return;
    if (options.length > 0) add(bestMatch(typed, options) ?? null);
    else setEnterWaiting(false);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs when the waited-for answer arrives
  }, [enterWaiting, current]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (!existingOnly) {
        if (typed || highlighted) add(topicToAdd(text, highlighted));
      } else if (highlighted) {
        add(highlighted);
      } else if (typed && !current) {
        setEnterWaiting(true);
      }
    } else if (event.key === "Backspace" && text === "" && topics.length > 0) {
      event.preventDefault();
      onRemove(topics.at(-1) as string);
    } else if (event.key === "ArrowDown" && open) {
      event.preventDefault();
      setActive((activeIndex + 1) % options.length);
    } else if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      setActive(activeIndex <= 0 ? options.length - 1 : activeIndex - 1);
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
          aria-activedescendant={highlighted ? `${listId}-${activeIndex}` : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setActive(-1);
            setEnterWaiting(false);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {open && (
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role -- the combobox popup list (ARIA combobox pattern)
          <ul id={listId} role="listbox" className={styles.suggestions} aria-label="Matching topics">
            {options.map((name, i) => (
              <li
                key={name}
                id={`${listId}-${i}`}
                // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role -- an option of the combobox list (ARIA combobox pattern)
                role="option"
                aria-selected={i === activeIndex}
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
        {noMatch && (
          <p className={`${styles.suggestions} ${styles.noMatch}`} role="status">
            {found.length > 0
              ? `Every topic with "${typed}" is in the filter already.`
              : `No topic matches "${typed}". Check the spelling, or search by name above.`}
          </p>
        )}
      </div>
    </div>
  );
}
