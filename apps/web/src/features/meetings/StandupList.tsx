import { STANDUP_KINDS, type Standup, type StandupItem, type StandupKind } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, EmptyState, ErrorState, Loading } from "../../components/ui.tsx";
import { useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { errorMessage } from "../../lib/api.ts";
import { formatDayMonth, relativeTime, toDate } from "../../lib/format.ts";
import { stepCursor, useScrollIntoView } from "../../lib/listCursor.ts";
import { type MarkVars, useMark, useStandup, useUnmark } from "../../lib/meetings.ts";
import styles from "./Meetings.module.css";

export const KIND_LABELS: Record<StandupKind, string> = {
  done: "Done",
  started: "Started",
  updated: "Updates",
  blocked: "Blocked",
};

/** The items of each kind, in the list's group order; kinds without items are left out. */
export function groupItems(items: readonly StandupItem[]): { kind: StandupKind; items: StandupItem[] }[] {
  return STANDUP_KINDS.map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) })).filter(
    (group) => group.items.length > 0,
  );
}

/** The line under the title: the newest change, else the last comment. */
export function firstLine(item: StandupItem): string | null {
  if (item.changes[0]) return item.changes[0];
  if (item.lastComment) return `${item.lastComment.actor}: ${item.lastComment.excerpt}`;
  return null;
}

/**
 * What the user still has to say at a standup date, grouped by kind, newest first. Phone first: big
 * rows, a thumb-sized tick on the right, kind chips that stay on top while the list scrolls. A tick
 * moves the item to "Said at", a dismiss leaves the list with an Undo in a toast.
 */
export function StandupList({
  meetingId,
  on,
  kind,
  onKind,
}: {
  meetingId: number;
  on: string;
  kind: StandupKind | null;
  onKind: (kind: StandupKind | null) => void;
}) {
  const standup = useStandup(meetingId, on, kind);
  if (standup.isPending) return <Loading label="Loading the standup list" />;
  if (standup.isError) return <ErrorState error={standup.error} onRetry={() => void standup.refetch()} />;
  return (
    <ListBody
      list={standup.data}
      meetingId={meetingId}
      kind={kind}
      onKind={onKind}
      loading={standup.isPlaceholderData}
    />
  );
}

function ListBody({
  list,
  meetingId,
  kind,
  onKind,
  loading,
}: {
  list: Standup;
  meetingId: number;
  kind: StandupKind | null;
  onKind: (kind: StandupKind | null) => void;
  loading: boolean;
}) {
  const mark = useMark();
  const unmark = useUnmark();
  const toast = useToast();
  const [openId, setOpenId] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [saidOpen, setSaidOpen] = useState(false);
  const groups = groupItems(list.items);
  const ids = groups.flatMap((g) => g.items.map((i) => i.todo.id));
  const total = STANDUP_KINDS.reduce((sum, k) => sum + list.counts[k], 0);
  const since = formatDayMonth(toDate(list.since));
  const on = list.on;

  const failed = (failure: unknown) => toast.show({ tone: "error", message: errorMessage(failure) });
  const undo = (todoId: number) => unmark.mutate({ meetingId, on, todoId }, { onError: failed });
  const markItem = (item: StandupItem, markKind: MarkVars["kind"]) => {
    // The cursor goes on to the next row, so x x x ticks down the list.
    if (cursor === item.todo.id) {
      const next = stepCursor(ids, item.todo.id, 1);
      setCursor(next === item.todo.id ? stepCursor(ids, item.todo.id, -1) : next);
    }
    if (openId === item.todo.id) setOpenId(null);
    mark.mutate(
      { meetingId, on, todoId: item.todo.id, kind: markKind, coveredUntil: item.at },
      { onError: failed },
    );
    if (markKind === "dismissed") {
      toast.show({
        message: `Dismissed "${item.todo.title}"`,
        action: { label: "Undo", run: () => undo(item.todo.id) },
      });
    }
  };
  const atCursor = () => list.items.find((i) => i.todo.id === cursor);

  useKeys([
    { keys: "j", run: () => setCursor(stepCursor(ids, cursor, 1)), label: "Next item", group: "Standup" },
    {
      keys: "k",
      run: () => setCursor(stepCursor(ids, cursor, -1)),
      label: "Previous item",
      group: "Standup",
    },
    {
      keys: "x",
      run: () => {
        const item = atCursor();
        if (item) markItem(item, "said");
      },
      label: "Tick: said",
      group: "Standup",
    },
    {
      keys: "d",
      run: () => {
        const item = atCursor();
        if (item) markItem(item, "dismissed");
      },
      label: "Dismiss",
      group: "Standup",
    },
    {
      keys: "Enter",
      run: () => cursor !== null && setOpenId(openId === cursor ? null : cursor),
      label: "Show details",
      group: "Standup",
    },
  ]);

  return (
    <section className={styles.standup} aria-label="To say" aria-busy={loading || undefined}>
      <div className={styles.chips} role="group" aria-label="Show">
        <button
          type="button"
          className={styles.chip}
          aria-pressed={kind === null}
          onClick={() => onKind(null)}
        >
          All <span className={styles.chipCount}>{total}</span>
        </button>
        {STANDUP_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={styles.chip}
            data-kind={k}
            aria-pressed={kind === k}
            data-empty={list.counts[k] === 0 || undefined}
            onClick={() => onKind(kind === k ? null : k)}
          >
            {KIND_LABELS[k]} <span className={styles.chipCount}>{list.counts[k]}</span>
          </button>
        ))}
      </div>
      <p className={styles.since}>
        Since {since}
        {list.dismissedCount > 0 && `, ${list.dismissedCount} dismissed`}
      </p>

      {groups.length === 0 && (
        <EmptyState>
          {kind === null ? (
            `Nothing new to say since ${since}`
          ) : (
            <>
              No {KIND_LABELS[kind].toLowerCase()} to say.{" "}
              <button type="button" className={styles.linkButton} onClick={() => onKind(null)}>
                Show all
              </button>
            </>
          )}
        </EmptyState>
      )}
      {groups.map((group) => (
        <section key={group.kind} className={styles.group} aria-label={KIND_LABELS[group.kind]}>
          <h3 className={styles.groupHead} data-kind={group.kind}>
            {KIND_LABELS[group.kind]} <span className={styles.groupCount}>{group.items.length}</span>
          </h3>
          <ul className={styles.items}>
            {group.items.map((item) => (
              <Row
                key={item.todo.id}
                item={item}
                open={openId === item.todo.id}
                cursor={cursor === item.todo.id}
                onToggle={() => {
                  setCursor(item.todo.id);
                  setOpenId(openId === item.todo.id ? null : item.todo.id);
                }}
                onSaid={() => markItem(item, "said")}
                onDismiss={() => markItem(item, "dismissed")}
              />
            ))}
          </ul>
        </section>
      ))}

      {list.said.length > 0 && (
        <section className={styles.said} aria-label={`Said at ${formatDayMonth(on)}`}>
          <button
            type="button"
            className={styles.saidHead}
            aria-expanded={saidOpen}
            onClick={() => setSaidOpen(!saidOpen)}
          >
            <span className={styles.chevron} aria-hidden="true" data-open={saidOpen || undefined} />
            Said at {formatDayMonth(on)} <span className={styles.groupCount}>{list.said.length}</span>
          </button>
          {saidOpen && (
            <ul className={styles.saidList}>
              {list.said.map((said) => (
                <li key={said.todo.id} className={styles.saidRow}>
                  <span className={styles.saidTitle}>{said.todo.title}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className={styles.undo}
                    onClick={() => undo(said.todo.id)}
                  >
                    Undo
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}

function Row({
  item,
  open,
  cursor,
  onToggle,
  onSaid,
  onDismiss,
}: {
  item: StandupItem;
  open: boolean;
  cursor: boolean;
  onToggle: () => void;
  onSaid: () => void;
  onDismiss: () => void;
}) {
  const ref = useScrollIntoView<HTMLLIElement>(cursor);
  const line = firstLine(item);
  const detailsId = `standup-${item.todo.id}`;
  return (
    <li ref={ref} className={styles.item} data-open={open || undefined} data-cursor={cursor || undefined}>
      <div className={styles.itemMain}>
        <button
          type="button"
          className={styles.itemButton}
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={onToggle}
        >
          <span className={styles.itemTitle}>{item.todo.title}</span>
          <span className={styles.itemMeta}>
            {item.project && (
              <span className={styles.project}>
                <span
                  className={styles.projectDot}
                  style={{ "--swatch": item.project.color } as CSSProperties}
                  aria-hidden="true"
                />
                {item.project.name}
              </span>
            )}
            {item.parent && <span className={styles.parent}>in {item.parent.title}</span>}
            <span className={styles.at}>{relativeTime(item.at)}</span>
            {item.again && <span className={styles.again}>new since you said it</span>}
          </span>
          {line && !open && <span className={styles.itemLine}>{line}</span>}
        </button>
        <button
          type="button"
          className={styles.tick}
          aria-label={`Said: ${item.todo.title}`}
          title="Said it (x)"
          onClick={onSaid}
        >
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <path
              d="M5 11.5l4 4 8-9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {open && (
        <div id={detailsId} className={styles.details}>
          {item.changes.length > 0 && (
            <ul className={styles.changes}>
              {item.changes.map((change, i) => (
                // Sentences can repeat ("checked a box" twice); their order is fixed.
                // oxlint-disable-next-line react/no-array-index-key
                <li key={`${i}-${change}`}>{change}</li>
              ))}
            </ul>
          )}
          {item.lastComment && (
            <blockquote className={styles.comment}>
              <span className={styles.commentHead}>
                {item.lastComment.actor}, {relativeTime(item.lastComment.createdAt)}
                {item.newCommentCount > 1 && ` (${item.newCommentCount} new comments)`}
              </span>
              {item.lastComment.excerpt}
            </blockquote>
          )}
          <div className={styles.detailActions}>
            <Link to="/todos/$id" params={{ id: String(item.todo.id) }} className={styles.openTodo}>
              Open todo #{item.todo.id}
            </Link>
            <Button variant="ghost" className={styles.dismiss} onClick={onDismiss} title="Dismiss (d)">
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
