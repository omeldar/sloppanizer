import { useState } from "react";
import { StripList } from "../../components/strip/StripList.tsx";
import stripStyles from "../../components/strip/Strip.module.css";
import { Button, EmptyState, ErrorState, Loading } from "../../components/ui.tsx";
import { type TodoListParams, useTodos } from "../../lib/queries.ts";
import styles from "./Lists.module.css";

const SORTS = {
  newest: { sort: "created", order: "desc", label: "Newest" },
  oldest: { sort: "created", order: "asc", label: "Oldest" },
  priority: { sort: "priority", order: "asc", label: "Priority" },
  due: { sort: "due", order: "asc", label: "Due date" },
} as const satisfies Record<
  string,
  { sort: TodoListParams["sort"]; order: TodoListParams["order"]; label: string }
>;
type SortKey = keyof typeof SORTS;

/** Open todos of one place (Inbox or a project), plus the recently done ones on demand. */
export function TodoListView({
  projectId,
  label,
  empty,
}: {
  projectId: number | "inbox";
  label: string;
  empty: string;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [showDone, setShowDone] = useState(false);
  const { sort, order } = SORTS[sortKey];
  const open = useTodos({ projectId, sort, order, limit: 500 });
  const done = useTodos({ projectId, status: "done", sort: "updated", order: "desc", limit: 20 }, showDone);

  return (
    <>
      <div className={styles.toolbar}>
        <span className={styles.total}>{open.data ? `${open.data.total} open` : ""}</span>
        <label className={styles.sort}>
          <span>Sort</span>
          <select
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value as SortKey)}
            className={styles.select}
          >
            {Object.entries(SORTS).map(([key, value]) => (
              <option key={key} value={key}>
                {value.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {open.isPending && <Loading />}
      {open.isError && <ErrorState error={open.error} onRetry={() => void open.refetch()} />}
      {open.data &&
        (open.data.items.length === 0 ? (
          <EmptyState>{empty}</EmptyState>
        ) : (
          <StripList items={open.data.items.map((todo) => ({ todo }))} label={label} />
        ))}
      <section className={stripStyles.group}>
        <div className={styles.doneHead}>
          <Button variant="ghost" size="sm" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
            {showDone ? "Hide done" : "Show recently done"}
          </Button>
        </div>
        {showDone && done.isPending && <Loading />}
        {showDone && done.isError && <ErrorState error={done.error} onRetry={() => void done.refetch()} />}
        {showDone &&
          done.data &&
          (done.data.items.length === 0 ? (
            <p className={styles.quiet}>Nothing done here yet.</p>
          ) : (
            <StripList
              items={done.data.items.map((todo) => ({ todo }))}
              label="Recently done"
              keys={false}
              collapseOnDone={false}
            />
          ))}
      </section>
    </>
  );
}
