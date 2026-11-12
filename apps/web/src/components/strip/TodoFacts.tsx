import { describeRecurrence, type Todo, waitingReason } from "@organizer/shared";
import styles from "./TodoFacts.module.css";

/** Subtasks and checklist items together, e.g. "2/5"; null when the todo has neither. */
export function progressText(todo: Pick<Todo, "progress">): { text: string; title: string } | null {
  const { subtasks, checklist } = todo.progress;
  const total = subtasks.total + checklist.total;
  if (total === 0) return null;
  const parts = [
    subtasks.total > 0 ? `${subtasks.done} of ${subtasks.total} subtasks` : null,
    checklist.total > 0 ? `${checklist.done} of ${checklist.total} checklist items` : null,
  ].filter(Boolean);
  return { text: `${subtasks.done + checklist.done}/${total}`, title: `${parts.join(", ")} done` };
}

/** True when TodoFacts would show anything. */
export function hasFacts(todo: Todo): boolean {
  return (
    progressText(todo) !== null ||
    todo.recurrence !== null ||
    (todo.status !== "done" && waitingReason(todo) !== null)
  );
}

/** Small step 3 facts on a strip: progress, a repeat glyph and "waiting on #12". */
export function TodoFacts({ todo, compact = false }: { todo: Todo; compact?: boolean }) {
  if (!hasFacts(todo)) return null;
  const progress = progressText(todo);
  const waiting = todo.status === "done" ? null : waitingReason(todo);
  return (
    <span className={styles.facts}>
      {progress && (
        <span className={styles.progress} title={progress.title}>
          {progress.text}
        </span>
      )}
      {todo.recurrence && <RepeatGlyph title={`Repeats ${describeRecurrence(todo.recurrence)}`} />}
      {waiting && !compact && <span className={styles.waiting}>{waiting.label}</span>}
      {waiting && compact && (
        <span className={styles.waiting} title={waiting.label}>
          waiting
        </span>
      )}
    </span>
  );
}

function RepeatGlyph({ title }: { title: string }) {
  return (
    <span className={styles.repeat} title={title}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path
          d="M2 5.5a4 4 0 0 1 7-2.6M10 6.5a4 4 0 0 1-7 2.6M9.2 1v2.2H7M2.8 11V8.8H5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="visually-hidden">{title}</span>
    </span>
  );
}
