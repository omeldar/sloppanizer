import { STATUS_LABELS, type Todo, type TodoRef } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { useToast } from "../../../components/toast/ToastProvider.tsx";
import { Button } from "../../../components/ui.tsx";
import { errorMessage } from "../../../lib/api.ts";
import { useRemoveLink } from "../../../lib/queries.ts";
import type { LinkKindValue } from "./AddLinkDialog.tsx";
import styles from "./Relations.module.css";

const GROUPS: { kind: LinkKindValue; title: string; pick: (todo: Todo) => TodoRef[] }[] = [
  { kind: "blocks", title: "Blocks", pick: (t) => t.links.blocks },
  { kind: "blocked_by", title: "Blocked by", pick: (t) => t.links.blockedBy },
  { kind: "relates", title: "Related", pick: (t) => t.links.relatesTo },
];

/** Every todo this one is linked to, for the add dialog to leave out. */
export function linkedIds(todo: Todo): number[] {
  return [...todo.links.blocks, ...todo.links.blockedBy, ...todo.links.relatesTo].map((t) => t.id);
}

/** "Waiting on #12" at the top of a todo that has open blockers. */
export function WaitingLine({ todo }: { todo: Todo }) {
  // Same rule as the shared activeBlockers, with titles.
  const blockers = todo.links.blockedBy.filter((b) => b.status !== "done");
  if (blockers.length === 0 || todo.status === "done") return null;
  return (
    <p className={styles.waiting} role="note">
      Waiting on{" "}
      {blockers.map((b, i) => (
        <span key={b.id}>
          {i > 0 && ", "}
          <Link to="/todos/$id" params={{ id: String(b.id) }} className={styles.waitingRef}>
            #{b.id}
          </Link>{" "}
          {b.title}
        </span>
      ))}
    </p>
  );
}

/** Links grouped as Blocks, Blocked by and Related, each with remove; "Add link" opens the dialog. */
export function Links({ todo, onAdd }: { todo: Todo; onAdd: () => void }) {
  const remove = useRemoveLink(todo.id);
  const toast = useToast();
  const groups = GROUPS.filter((g) => g.pick(todo).length > 0);
  return (
    <section className={styles.section} aria-label="Links">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Links</h2>
        <Button size="sm" variant="ghost" hint="b" onClick={onAdd}>
          Add link
        </Button>
      </div>
      {groups.length === 0 && (
        <p className={styles.none}>No links. Press b to say what this todo blocks or waits for.</p>
      )}
      {groups.map((group) => (
        <div key={group.kind} className={styles.linkGroup}>
          <h3 className={styles.groupTitle}>{group.title}</h3>
          <ul className={styles.rows} aria-label={group.title}>
            {group.pick(todo).map((other) => (
              <li
                key={other.id}
                className={`${styles.row} ${styles.linkRow}`}
                data-done={other.status === "done" || undefined}
              >
                <span className={styles.rowId}>#{other.id}</span>
                <Link to="/todos/$id" params={{ id: String(other.id) }} className={styles.rowTitle}>
                  {other.title}
                </Link>
                <span className={styles.rowStatus}>{STATUS_LABELS[other.status]}</span>
                <button
                  type="button"
                  className={styles.rowMenu}
                  aria-label={`Remove the link to #${other.id}`}
                  onClick={() =>
                    remove.mutate(
                      { otherId: other.id, kind: group.kind },
                      {
                        onError: (error) =>
                          toast.show({
                            tone: "error",
                            message: `Could not remove the link. ${errorMessage(error)}`,
                          }),
                      },
                    )
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
