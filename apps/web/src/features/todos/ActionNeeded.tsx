import type { Todo } from "@organizer/shared";
import { Button } from "../../components/ui.tsx";
import { relativeTime } from "../../lib/format.ts";
import styles from "./TodoPage.module.css";
import { useTodoActions } from "./useTodoActions.ts";

/**
 * "Action needed" at the top of a todo: what someone (usually an assistant's scheduled run) needs the
 * user to do themselves. It stays until someone removes it here (or through the API).
 */
export function ActionNeededBanner({ todo }: { todo: Todo }) {
  const { patch } = useTodoActions();
  const marker = todo.actionNeeded;
  if (!marker) return null;
  return (
    <div className={styles.actionNeeded} role="note" aria-label="Action needed">
      <div className={styles.actionNeededText}>
        <strong>Action needed</strong>
        {marker.reason && <span className={styles.actionNeededReason}>{marker.reason}</span>}
        <span className={styles.actionNeededBy}>
          Set by {marker.by} {relativeTime(marker.at)}
        </span>
      </div>
      <Button size="sm" onClick={() => void patch(todo.id, { actionNeeded: null })}>
        Done, remove
      </Button>
    </div>
  );
}
