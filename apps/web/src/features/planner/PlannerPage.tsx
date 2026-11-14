import { addDays, toLocalTime, weekDays } from "@organizer/shared";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type MouseEvent, useEffect, useMemo, useState } from "react";
import { Button, PageHeader } from "../../components/ui.tsx";
import { timeZone, today } from "../../lib/format.ts";
import { useBlocks, useNext } from "../../lib/queries.ts";
import { BlockDialog, type BlockDraft, draftOf } from "./BlockDialog.tsx";
import styles from "./Planner.module.css";
import {
  blockTitle,
  minutesToTime,
  nextQuarter,
  type PlacedBlock,
  placeBlocks,
  snap,
  spanText,
  visibleHours,
} from "./planner.ts";

const route = getRouteApi("/planner");
const HOUR_PX = 52;
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
const DAY_NUMBER = new Intl.DateTimeFormat(undefined, { day: "numeric", timeZone: "UTC" });
const MONTH = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

const asDate = (day: string) => new Date(`${day}T12:00:00Z`);

/** Today and the minutes after local midnight now. */
function readNow(): { day: string; minutes: number } {
  const now = new Date();
  const [h = 0, m = 0] = toLocalTime(now, timeZone).split(":").map(Number);
  return { day: today(now), minutes: h * 60 + m };
}

/** readNow, refreshed every minute (for the now line). */
function useNowMinutes(): { day: string; minutes: number } {
  const [state, setState] = useState(readNow);
  useEffect(() => {
    const timer = setInterval(() => setState(readNow()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return state;
}

/**
 * The planner: a week of days with time blocks for todos (or with their own title). Click or tap a
 * free slot to plan time there, a block to change it. Phones show one day at a time.
 */
export function PlannerPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const now = useNowMinutes();
  const selected = search.day ?? now.day;
  const days = useMemo(() => weekDays(selected, timeZone), [selected]);
  const first = days[0] as string;
  const last = days[6] as string;
  const blocks = useBlocks(first, last);
  const next = useNext({ mode: "smart" });
  const [draft, setDraft] = useState<BlockDraft | null>(null);

  const go = (day: string) => void navigate({ to: "/planner", search: day === now.day ? {} : { day } });

  const placedByDay = useMemo(
    () => new Map(days.map((day) => [day, placeBlocks(blocks.data ?? [], day, timeZone)])),
    [blocks.data, days],
  );
  const hours = visibleHours([...placedByDay.values()].flat());
  const hourList = Array.from({ length: hours.last - hours.first }, (_, i) => hours.first + i);
  const gridStyle = { "--hour": `${HOUR_PX}px`, "--hours": hourList.length } as CSSProperties;

  const planAt = (day: string, event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const minutes = snap(hours.first * 60 + ((event.clientY - rect.top) / HOUR_PX) * 60 - 15);
    const start = Math.max(0, Math.min(23 * 60, minutes));
    setDraft({ day, start: minutesToTime(start), end: minutesToTime(Math.min(24 * 60, start + 60)) });
  };

  const planTodo = (todo: { id: number; title: string }) => {
    const start = selected === now.day ? nextQuarter(new Date(), timeZone) : "09:00";
    const [h = 9, m = 0] = start.split(":").map(Number);
    setDraft({ day: selected, start, end: minutesToTime(Math.min(24 * 60, h * 60 + m + 60)), todo });
  };

  const planned = new Set((blocks.data ?? []).flatMap((b) => (b.todoId === null ? [] : [b.todoId])));
  const toPlan = (next.data?.items ?? [])
    .map((item) => item.todo)
    .filter((todo) => !planned.has(todo.id))
    .slice(0, 8);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Planner"
        meta={`${MONTH.format(asDate(first))} – ${MONTH.format(asDate(last))}`}
        actions={
          <>
            <Button size="sm" onClick={() => go(addDays(selected, -7))} aria-label="Previous week">
              ‹
            </Button>
            <Button size="sm" onClick={() => go(now.day)}>
              Today
            </Button>
            <Button size="sm" onClick={() => go(addDays(selected, 7))} aria-label="Next week">
              ›
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const start = selected === now.day ? nextQuarter(new Date(), timeZone) : "09:00";
                const [h = 9, m = 0] = start.split(":").map(Number);
                setDraft({ day: selected, start, end: minutesToTime(Math.min(24 * 60, h * 60 + m + 60)) });
              }}
            >
              Plan time
            </Button>
          </>
        }
      />

      <div className={styles.layout}>
        <div className={styles.calendar} style={gridStyle}>
          <div className={styles.dayHeads} role="tablist" aria-label="Days">
            <span className={styles.corner} />
            {days.map((day) => (
              <button
                key={day}
                type="button"
                role="tab"
                aria-selected={day === selected}
                className={styles.dayHead}
                data-today={day === now.day || undefined}
                data-selected={day === selected || undefined}
                onClick={() => go(day)}
              >
                <span className={styles.weekday}>{WEEKDAY.format(asDate(day))}</span>
                <span className={styles.dayNumber}>{DAY_NUMBER.format(asDate(day))}</span>
                {(placedByDay.get(day)?.length ?? 0) > 0 && (
                  <span className={styles.dot} aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
          <div className={styles.body}>
            <div className={styles.axis} aria-hidden="true">
              {hourList.map((hour) => (
                <span key={hour} className={styles.hourLabel}>
                  {minutesToTime(hour * 60)}
                </span>
              ))}
            </div>
            {days.map((day) => (
              <div
                key={day}
                className={styles.day}
                data-selected={day === selected || undefined}
                data-past={day < now.day || undefined}
                onClick={(event) => planAt(day, event)}
                role="presentation"
              >
                {day === now.day && now.minutes >= hours.first * 60 && now.minutes <= hours.last * 60 && (
                  <span
                    className={styles.nowLine}
                    style={{ top: ((now.minutes - hours.first * 60) / 60) * HOUR_PX }}
                    aria-hidden="true"
                  />
                )}
                {(placedByDay.get(day) ?? []).map((placed) => (
                  <BlockCard
                    key={`${placed.block.id}-${day}`}
                    placed={placed}
                    firstHour={hours.first}
                    onOpen={() => setDraft(draftOf(placed.block))}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        <aside className={styles.side} aria-label="To plan">
          <h2 className={styles.sideTitle}>To plan</h2>
          <p className={styles.sideNote}>Next up without time this week.</p>
          {toPlan.length === 0 && (
            <p className={styles.sideNote}>Everything near the top has time planned.</p>
          )}
          <ul className={styles.toPlan}>
            {toPlan.map((todo) => (
              <li key={todo.id}>
                <button type="button" className={styles.toPlanItem} onClick={() => planTodo(todo)}>
                  <span className={styles.toPlanTitle}>{todo.title}</span>
                  <span className={styles.toPlanAction}>Plan</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <BlockDialog draft={draft} onClose={() => setDraft(null)} />
    </div>
  );
}

function BlockCard({
  placed,
  firstHour,
  onOpen,
}: {
  placed: PlacedBlock;
  firstHour: number;
  onOpen: () => void;
}) {
  const { block } = placed;
  const top = ((placed.startMin - firstHour * 60) / 60) * HOUR_PX;
  const height = Math.max(22, ((placed.endMin - placed.startMin) / 60) * HOUR_PX - 2);
  const style = {
    top,
    height,
    // Overlaps cascade like a calendar: each later lane is indented and drawn on top, so every block
    // keeps most of the column's width.
    left: `calc(${placed.lane * Math.min(28, 60 / placed.lanes)}% + 2px)`,
    right: "2px",
    zIndex: 1 + placed.lane,
    "--block": block.project?.color ?? "var(--amber)",
  } as CSSProperties;
  return (
    <button
      type="button"
      className={styles.block}
      style={style}
      data-done={block.todo?.status === "done" || undefined}
      data-short={height < 40 || undefined}
      onClick={onOpen}
      title={`${blockTitle(block)}, ${spanText(block, timeZone)}`}
    >
      <span className={styles.blockTitle}>{blockTitle(block)}</span>
      <span className={styles.blockTime}>{spanText(block, timeZone)}</span>
    </button>
  );
}
