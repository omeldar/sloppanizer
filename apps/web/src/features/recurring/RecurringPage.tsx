import { canRepeatPlan, type RecurringTodo, toLocalDate, toLocalTime } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { Button, EmptyState, ErrorState, Loading, PageHeader } from "../../components/ui.tsx";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { errorMessage } from "../../lib/api.ts";
import { dayLabel, timeZone } from "../../lib/format.ts";
import { useRecurring } from "../../lib/plans.ts";
import { useUpdateTodo } from "../../lib/queries.ts";
import styles from "./Recurring.module.css";

/** "Thu 20.11., 09:00" in local time. */
const startText = (startAt: string): string =>
  `${dayLabel(toLocalDate(startAt, timeZone))}, ${toLocalTime(startAt, timeZone)}`;

/**
 * Every repeating todo once, with its repeat and when it comes next. Marking one done here (or anywhere)
 * never hides it: the next todo of the repeat takes its place, with the planned time that repeats with it.
 */
export function RecurringPage() {
  const recurring = useRecurring();
  const list = recurring.data ?? [];
  const open = list.filter((r) => !r.ended);
  const ended = list.filter((r) => r.ended);

  return (
    <div className={styles.page}>
      <PageHeader title="Recurring" meta={recurring.isSuccess ? `${open.length} repeating` : undefined} />
      {recurring.isPending && <Loading />}
      {recurring.isError && <ErrorState error={recurring.error} onRetry={() => void recurring.refetch()} />}
      {recurring.isSuccess && list.length === 0 && (
        <EmptyState>
          No repeating todos yet. Give a todo a repeat (shift+r on a todo): it shows here with when it comes
          next, and time planned for it in the Planner repeats with it.
        </EmptyState>
      )}
      <ul className={styles.cards} aria-label="Repeating todos">
        {open.map((r) => (
          <RecurringCard key={r.todo.id} item={r} />
        ))}
      </ul>
      {ended.length > 0 && (
        <>
          <h2 className={styles.sectionTitle}>Ended</h2>
          <ul className={styles.cards} aria-label="Ended repeats">
            {ended.map((r) => (
              <RecurringCard key={r.todo.id} item={r} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function RecurringCard({ item }: { item: RecurringTodo }) {
  const { todo, plan } = item;
  const update = useUpdateTodo();
  const toast = useToast();
  const markDone = () =>
    update.mutate(
      { id: todo.id, patch: { status: "done" } },
      {
        onSuccess: (saved) =>
          toast.show({
            message: saved.nextOccurrence
              ? `Done. ${todo.title} comes back as #${saved.nextOccurrence.id}.`
              : `Done. ${todo.title} has no next date.`,
            action: {
              label: "Undo",
              run: () => update.mutate({ id: todo.id, patch: { status: "open" } }),
            },
          }),
        onError: (failure) => toast.show({ tone: "error", message: errorMessage(failure) }),
      },
    );

  return (
    <li className={styles.card} data-ended={item.ended || undefined}>
      <div className={styles.cardHead}>
        {todo.project && (
          <span
            className={styles.swatch}
            style={{ "--swatch": todo.project.color } as CSSProperties}
            title={todo.project.name}
          />
        )}
        <Link to="/todos/$id" params={{ id: String(todo.id) }} className={styles.title}>
          {todo.title}
        </Link>
        <span className={styles.id}>#{todo.id}</span>
        <span className={styles.spacer} />
        {!item.ended && todo.status !== "done" && (
          <Button size="sm" onClick={markDone} disabled={update.isPending}>
            Done
          </Button>
        )}
      </div>
      <p className={styles.rule}>{item.text}</p>
      <dl className={styles.facts}>
        <div>
          <dt>Next</dt>
          <dd className={styles.mono}>{item.nextOn ? dayLabel(item.nextOn) : "Ended"}</dd>
        </div>
        <div>
          <dt>Done</dt>
          <dd className={styles.mono}>
            {item.doneCount === 0
              ? "Not yet"
              : `${item.doneCount}×${item.lastDoneAt ? `, last ${dayLabel(toLocalDate(item.lastDoneAt, timeZone))}` : ""}`}
          </dd>
        </div>
        <div>
          <dt>Planned</dt>
          <dd>
            {plan ? (
              <>
                <span>{plan.schedule.text}</span>
                {plan.next && (
                  <Link
                    to="/planner"
                    search={{ day: toLocalDate(plan.next.startAt, timeZone) }}
                    className={styles.planLink}
                  >
                    next {startText(plan.next.startAt)}
                  </Link>
                )}
              </>
            ) : (
              <span className={styles.quiet}>
                {canRepeatPlan(todo.recurrence)
                  ? "No time planned. Drag it into the Planner: the time repeats with it."
                  : "It repeats counted from the day it is done, so time is planned one date at a time."}
              </span>
            )}
          </dd>
        </div>
      </dl>
    </li>
  );
}
