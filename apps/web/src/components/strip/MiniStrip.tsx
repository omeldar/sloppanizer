import { PRIORITY_SCOPE, parseLabelName, priorityOf, type Todo } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, forwardRef, type HTMLAttributes } from "react";
import { dueState, dueText, formatDate, shortDate } from "../../lib/format.ts";
import { LabelPill } from "../LabelPill.tsx";
import styles from "./MiniStrip.module.css";
import type { StripSource } from "./StripRow.tsx";
import stripStyles from "./Strip.module.css";
import { hasFacts, TodoFacts } from "./TodoFacts.tsx";

type Props = HTMLAttributes<HTMLDivElement> & {
  todo: Todo;
  selected?: boolean;
  /** Being dragged: the original stays as a faint slot. */
  ghost?: boolean;
  /** Under the pointer while dragging (the overlay copy). */
  lifted?: boolean;
  dimmed?: boolean;
  /** Extra mono text at the end, e.g. "took 2d". */
  aside?: string;
  /** Narrow columns (week days): the title wraps to two lines and labels stay out. */
  narrow?: boolean;
  /** A todo of a shared project in your own tab: its project, and the title opens it in that tab. */
  source?: StripSource;
};

/** Compact flight strip for board columns and week days: band, #id, title, labels, due. */
export const MiniStrip = forwardRef<HTMLDivElement, Props>(function MiniStrip(
  { todo, selected, ghost, lifted, dimmed, aside, narrow, source, className, ...rest },
  ref,
) {
  const priority = priorityOf(todo.labels);
  const done = todo.status === "done";
  // The band already shows the priority; narrow cards keep the room for the other labels.
  const labels = narrow
    ? []
    : todo.labels.filter((l) => parseLabelName(l.name).scope?.toLowerCase() !== PRIORITY_SCOPE);
  return (
    <div
      ref={ref}
      className={[styles.card, className].filter(Boolean).join(" ")}
      data-priority={priority ?? "none"}
      data-selected={selected || undefined}
      data-ghost={ghost || undefined}
      data-lifted={lifted || undefined}
      data-dimmed={dimmed || done || undefined}
      data-narrow={narrow || undefined}
      aria-current={selected || undefined}
      {...rest}
    >
      <span className={styles.band} aria-hidden="true" />
      <span className={styles.body}>
        <span className={styles.top}>
          {/* A shared project numbers its todos on its own: #3 there is not your #3. */}
          {!source && <span className={styles.id}>#{todo.id}</span>}
          {source ? (
            // Another tab (the shared project's own), so a full page load.
            <a href={source.href || undefined} className={styles.title} draggable={false}>
              {todo.title}
            </a>
          ) : (
            <Link
              to="/todos/$id"
              params={{ id: String(todo.id) }}
              className={styles.title}
              // The whole card drags (also by its title); the board stops the click that ends a drag.
              draggable={false}
            >
              {todo.title}
            </Link>
          )}
        </span>
        {(source || labels.length > 0 || todo.dueOn || aside || hasFacts(todo)) && (
          <span className={styles.meta}>
            {source && (
              <span className={stripStyles.source} title={`From the shared project ${source.name}`}>
                <span className={stripStyles.swatch} style={{ "--swatch": source.color } as CSSProperties} />
                {source.name}
              </span>
            )}
            <span className={styles.labels}>
              {labels.map((label) => (
                <LabelPill key={label.id} name={label.name} color={label.color} />
              ))}
            </span>
            <TodoFacts todo={todo} compact />
            {todo.dueOn && (
              <span
                className={styles.due}
                data-state={done ? "later" : dueState(todo.dueOn)}
                title={`${formatDate(todo.dueOn)}, ${dueText(todo.dueOn)}`}
              >
                {shortDate(todo.dueOn)}
              </span>
            )}
            {aside && <span className={styles.aside}>{aside}</span>}
          </span>
        )}
      </span>
    </div>
  );
});
