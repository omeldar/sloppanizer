import { Link } from "@tanstack/react-router";
import { timeZone, today } from "../../lib/format.ts";
import { useBlocks } from "../../lib/queries.ts";
import { useNow } from "../../lib/useNow.ts";
import styles from "./Planner.module.css";
import { blockTitle, spanText } from "./planner.ts";

/**
 * Today's planned time above Next up: what is on now and what comes later, each opening its todo. Blocks
 * that are over drop out; nothing shows when the day has no plan left.
 */
export function TodayPlan() {
  const nowMs = useNow();
  const day = today(new Date(nowMs));
  const blocks = useBlocks(day, day);
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
              <span className={styles.todayTitle}>{blockTitle(block)}</span>
            </>
          );
          return (
            <li key={block.id} className={styles.todayItem} data-now={now || undefined}>
              {block.todo ? (
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
