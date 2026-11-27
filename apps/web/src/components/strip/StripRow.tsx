import { formatDuration, priorityOf, type Reason, type Todo } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { dueState, dueText, formatDate, shortAge, shortDate } from "../../lib/format.ts";
import { useOnChange } from "../../lib/useOnChange.ts";
import { LabelPill } from "../LabelPill.tsx";
import styles from "./Strip.module.css";
import { hasFacts, TodoFacts } from "./TodoFacts.tsx";

/** Matches --t-collapse: the row folds away, then the change is sent. */
export const COLLAPSE_MS = 180;

/**
 * Where a todo from a shared project came from, when a list of your own shows it ("Assigned to you"):
 * the badge names the project, and the title opens the todo in that project's tab.
 */
export interface StripSource {
  name: string;
  color: string;
  href: string;
}

export interface StripRowProps {
  todo: Todo;
  source?: StripSource;
  selected?: boolean;
  /** Next up: position in the ranking (1 is framed as "next"). */
  rank?: number;
  reasons?: readonly Reason[];
  score?: number;
  /** Collapse the row before marking it done (lists that hide done todos). */
  collapseOnDone?: boolean;
  editingTitle?: boolean;
  /** Picked for a bulk change (the checkbox). Lists without bulk changes leave the box out. */
  checked?: boolean;
  /** The checkbox was clicked; range is true with shift held (everything since the last click). */
  onCheck?: (range: boolean) => void;
  onSelect?: () => void;
  onToggleDone: (todo: Todo) => void;
  onTitleSave?: (title: string) => void;
  onTitleCancel?: () => void;
}

export function StripRow({
  todo,
  source,
  selected = false,
  rank,
  reasons,
  score,
  collapseOnDone = false,
  editingTitle = false,
  checked = false,
  onCheck,
  onSelect,
  onToggleDone,
  onTitleSave,
  onTitleCancel,
}: StripRowProps) {
  const done = todo.status === "done";
  const [collapsing, setCollapsing] = useState(false);
  const priority = priorityOf(todo.labels);
  // The priority pill and band already say it; the chips show the other reasons.
  // "waiting" shows as a fact chip on every strip, so the reason would repeat it.
  const visibleReasons = (reasons ?? []).filter(
    (reason) => reason.kind !== "priority" && reason.kind !== "waiting",
  );
  const rowRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (selected) rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  // A row that comes back (undo) shows again.
  useOnChange(todo.status, () => setCollapsing(false));

  // Fires once per collapse, even when the parent re-renders with a new callback meanwhile.
  const latest = useRef({ todo, onToggleDone });
  useEffect(() => {
    latest.current = { todo, onToggleDone };
  });
  useEffect(() => {
    if (!collapsing) return;
    const timer = setTimeout(() => latest.current.onToggleDone(latest.current.todo), COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [collapsing]);

  const toggle = () => {
    if (!done && collapseOnDone && !prefersReducedMotion()) setCollapsing(true);
    else onToggleDone(todo);
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a click moves the list cursor (j/k do the same by keyboard)
    <li
      ref={rowRef}
      className={styles.row}
      data-priority={priority ?? "none"}
      data-selected={selected || undefined}
      data-done={done || undefined}
      data-next={rank === 1 || undefined}
      data-ranked={rank !== undefined || undefined}
      data-collapsing={collapsing || undefined}
      data-checked={checked || undefined}
      aria-current={selected || undefined}
      onMouseDown={onSelect}
    >
      <span className={styles.band} aria-hidden="true" />
      {rank !== undefined && (
        <span className={styles.rank} title={score === undefined ? undefined : `Score ${score}`}>
          {rank}
        </span>
      )}
      <span className={styles.check}>
        {onCheck && (
          <input
            type="checkbox"
            checked={checked}
            // The click carries shift (range selection); change events do not.
            readOnly
            onClick={(event) => onCheck(event.shiftKey)}
            aria-label={source ? `Select "${todo.title}"` : `Select #${todo.id}`}
          />
        )}
      </span>
      <span className={styles.id}>{source ? "" : `#${todo.id}`}</span>
      <span className={styles.main}>
        <span className={styles.line}>
          {editingTitle ? (
            <TitleEditor initial={todo.title} onSave={onTitleSave} onCancel={onTitleCancel} />
          ) : source ? (
            // Another tab (the shared project's own), so a full page load.
            <a href={source.href} className={styles.title}>
              {todo.title}
            </a>
          ) : (
            <Link to="/todos/$id" params={{ id: String(todo.id) }} className={styles.title}>
              {todo.title}
            </Link>
          )}
          {todo.actionNeeded && (
            <span
              className={styles.actionNeeded}
              title={
                todo.actionNeeded.reason ? `Action needed: ${todo.actionNeeded.reason}` : "Action needed"
              }
            >
              Action needed
            </span>
          )}
          {(source || todo.labels.length > 0 || todo.requestedBy.length > 0 || todo.assignee) && (
            <span className={styles.tags}>
              {source && (
                <span className={styles.source} title={`From the shared project ${source.name}`}>
                  <span className={styles.swatch} style={{ "--swatch": source.color } as CSSProperties} />
                  from {source.name}
                </span>
              )}
              {todo.labels.map((label) => (
                <LabelPill key={label.id} name={label.name} color={label.color} />
              ))}
              {todo.requestedBy.length > 0 && (
                <span className={styles.people}>
                  from {todo.requestedBy.map((p) => p.displayName).join(", ")}
                </span>
              )}
              {/* In your own list a shared todo is always yours; the project's own lists say whose. */}
              {todo.assignee && !source && (
                <span className={styles.assignee} title={`Assigned to ${todo.assignee.name}`}>
                  @{todo.assignee.username}
                </span>
              )}
            </span>
          )}
          <DoneButton done={done || collapsing} label={doneLabel(todo, done, source)} onClick={toggle} />
        </span>
        {(visibleReasons.length > 0 || hasFacts(todo)) && (
          <span className={styles.reasons}>
            <TodoFacts todo={todo} />
            {visibleReasons.map((reason) => (
              <span
                key={reason.kind}
                className={styles.reason}
                data-kind={reason.kind}
                title={`${reason.points} points`}
              >
                {reason.label}
              </span>
            ))}
          </span>
        )}
      </span>
      <span
        className={styles.comments}
        title={
          todo.commentCount > 0
            ? `${todo.commentCount} ${todo.commentCount === 1 ? "comment" : "comments"}`
            : undefined
        }
      >
        {todo.commentCount > 0 && (
          <>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M1.5 2h9v6h-5l-2.5 2v-2h-1.5z" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            <span className="visually-hidden">Comments:</span>
            {todo.commentCount}
          </>
        )}
      </span>
      <DueCell todo={todo} />
      <span className={styles.age}>
        {done && todo.durationMs !== null
          ? `took ${formatDuration(todo.durationMs)}`
          : `open ${shortAge(todo.createdAt)}`}
      </span>
      <span className={styles.project}>
        {source ? (
          <>
            <span className={styles.swatch} style={{ "--swatch": source.color } as CSSProperties} />
            <span className={styles.projectName}>{source.name}</span>
          </>
        ) : todo.project ? (
          <>
            <span className={styles.swatch} style={{ "--swatch": todo.project.color } as CSSProperties} />
            <span className={styles.projectName}>{todo.project.name}</span>
          </>
        ) : (
          <span className={styles.inbox}>Inbox</span>
        )}
      </span>
    </li>
  );
}

function doneLabel(todo: Todo, done: boolean, source: StripSource | undefined): string {
  // A shared project numbers its todos on its own: #3 there is not your #3.
  if (source) return `${done ? "Reopen" : "Mark"} "${todo.title}"${done ? "" : " done"}`;
  return done ? `Reopen #${todo.id}` : `Mark #${todo.id} done`;
}

/**
 * Done or reopen in one click (the checkbox selects since S5#14). Shown on hover, focus and the row
 * under the cursor, always on touch screens and on done rows; x does the same by keyboard.
 */
function DoneButton({ done, label, onClick }: { done: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={styles.done}
      data-on={done || undefined}
      aria-label={label}
      title={`${done ? "Reopen" : "Mark done"} (x)`}
      onClick={onClick}
    >
      <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M3 7.2l2.6 2.6L11 4.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    </button>
  );
}

function DueCell({ todo }: { todo: Todo }) {
  if (!todo.dueOn) return <span className={styles.due} />;
  const state = todo.status === "done" ? "later" : dueState(todo.dueOn);
  return (
    <span
      className={styles.due}
      data-state={state}
      title={`${formatDate(todo.dueOn)}, ${dueText(todo.dueOn)}`}
    >
      {shortDate(todo.dueOn)}
    </span>
  );
}

function TitleEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave?: (title: string) => void;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const finish = () => {
    const title = value.trim();
    if (title && title !== initial) onSave?.(title);
    else onCancel?.();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel?.();
    }
  };
  return (
    <input
      className={styles.titleInput}
      value={value}
      aria-label="Title"
      maxLength={300}
      // The editor opens on purpose (key e), so it takes the focus.
      // oxlint-disable-next-line jsx-a11y/no-autofocus
      autoFocus
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={finish}
    />
  );
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
