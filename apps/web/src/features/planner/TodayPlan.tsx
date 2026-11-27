import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useCurrentAccount } from "../../app/account.tsx";
import { timeZone, today } from "../../lib/format.ts";
import { useBlocks } from "../../lib/queries.ts";
import { sharedTodoHref } from "../../lib/spaces.ts";
import { useNow } from "../../lib/useNow.ts";
import styles from "./Planner.module.css";
import { blockKey, blockTitle, spanText } from "./planner.ts";

/**
 * Today's planned time above Next up: what is on now and what comes later, each opening its todo. Blocks
 * that are over drop out; nothing shows when the day has no plan left.
 */
export function TodayPlan() {
  const nowMs = useNow();
  const day = today(new Date(nowMs));
  const blocks = useBlocks(day, day);
  const account = useCurrentAccount();
  const left = (blocks.data ?? []).filter((b) => Date.parse(b.endAt) > nowMs);
  if (left.length === 0) return null;
  return (
    <section className={styles.today} aria-label="Planned today">
      <Link to="/planner" className={styles.todayHead}>
        Today&apos;s plan
      </Link>
      <ul className={styles.todayList}>
        {left.map((block) => {
          const now = Date.parse(block.startAt) <= nowMs;
          const body = (
            <>
              <span className={styles.todayTime}>
                {now ? "now" : spanText(block, timeZone).split("–")[0]}
              </span>
              <span className={styles.todayTitle}>
                {blockTitle(block)}
                {block.space && (
                  <span
                    className={styles.fromSpace}
                    style={{ "--swatch": block.space.color } as CSSProperties}
                  >
                    {block.space.name}
                  </span>
                )}
              </span>
            </>
          );
          return (
            <li key={blockKey(block)} className={styles.todayItem} data-now={now || undefined}>
              {block.todo && block.space && account ? (
                // Your time in a shared project opens the todo in that project's tab (a full page load).
                <a
                  href={sharedTodoHref(account.username, block.space.id, block.todo.id)}
                  className={styles.todayLink}
                >
                  {body}
                </a>
              ) : block.todo ? (
                <Link to="/todos/$id" params={{ id: String(block.todo.id) }} className={styles.todayLink}>
                  {body}
                </Link>
              ) : (
                <Link to="/planner" className={styles.todayLink}>
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
