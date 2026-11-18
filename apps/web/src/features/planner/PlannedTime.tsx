import { addDays, type Todo, toLocalDate } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../components/ui.tsx";
import { dayLabel, timeZone, today } from "../../lib/format.ts";
import { useBlocks } from "../../lib/queries.ts";
import { useNow } from "../../lib/useNow.ts";
import relations from "../todos/relations/Relations.module.css";
import { BlockDialog, type BlockDraft, draftOf } from "./BlockDialog.tsx";
import styles from "./Planner.module.css";
import { minutesToTime, nextQuarter, spanText, timeToMinutes } from "./planner.ts";

/** The time planned for a todo (two weeks back, seven weeks ahead) and a button to plan more. */
export function PlannedTime({ todo }: { todo: Todo }) {
  const nowMs = useNow();
  const now = today(new Date(nowMs));
  const blocks = useBlocks(addDays(now, -14), addDays(now, 47), todo.id);
  const [draft, setDraft] = useState<BlockDraft | null>(null);

  const planNew = () => {
    const day = todo.plannedOn && todo.plannedOn >= now ? todo.plannedOn : now;
    const start = day === now ? nextQuarter(new Date(), timeZone) : "09:00";
    setDraft({
      day,
      start,
      end: minutesToTime(Math.min(24 * 60, timeToMinutes(start) + 60)),
      todo: { id: todo.id, title: todo.title },
    });
  };

  const list = blocks.data ?? [];
  return (
    <section className={relations.section} aria-label="Planned time">
      <div className={relations.sectionHead}>
        <h2 className={relations.sectionTitle}>Planned time</h2>
        <Button size="sm" variant="ghost" onClick={planNew}>
          Plan time
        </Button>
      </div>
      {list.length === 0 ? (
        <p className={relations.none}>
          No time planned. Plan a slot here or in the <Link to="/planner">planner</Link>.
        </p>
      ) : (
        <ul className={styles.plannedList}>
          {list.map((block) => {
            return (
              <li key={block.id}>
                <button
                  type="button"
                  className={styles.plannedItem}
                  data-past={Date.parse(block.endAt) < nowMs || undefined}
                  onClick={() => setDraft(draftOf(block))}
                >
                  <span>{dayLabel(toLocalDate(block.startAt, timeZone))}</span>
                  <span className={styles.plannedTime}>{spanText(block, timeZone)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <BlockDialog draft={draft} onClose={() => setDraft(null)} />
    </section>
  );
}
