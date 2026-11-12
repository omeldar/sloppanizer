import type { PersonStatMonth } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { usePersonStats } from "../../lib/queries.ts";
import styles from "./PeopleStats.module.css";
import { daysText, tookText } from "./stats.ts";

/** The person's numbers over all time plus mini bars of the last 12 months. */
export function PersonStats({ personId }: { personId: number }) {
  const stats = usePersonStats(personId);
  if (!stats.data) return null;
  const { requested, contact } = stats.data.stat;
  const months = stats.data.months;
  const max = Math.max(1, ...months.map((m) => Math.max(m.requested, m.contact)));
  return (
    <section className={styles.personStats} aria-label="Statistics">
      <h2 className={styles.personStatsTitle}>
        Statistics
        <Link to="/people/stats" className={styles.personStatsLink}>
          All people
        </Link>
      </h2>
      <dl className={styles.personNumbers}>
        <div>
          <dt>Requested</dt>
          <dd>
            {requested.total}{" "}
            <span>
              ({requested.open} open, {requested.done} done)
            </span>
          </dd>
        </div>
        <div>
          <dt>Median took</dt>
          <dd>{tookText(requested.medianDoneMs)}</dd>
        </div>
        <div>
          <dt>p90 took</dt>
          <dd>{tookText(requested.p90DoneMs)}</dd>
        </div>
        <div>
          <dt>Oldest open</dt>
          <dd>{daysText(requested.oldestOpenDays)}</dd>
        </div>
        <div>
          <dt>Contact for</dt>
          <dd>
            {contact.total} <span>({contact.open} open)</span>
          </dd>
        </div>
      </dl>
      <ol className={styles.months} aria-label="Last 12 months">
        {months.map((month) => (
          <MonthBar key={month.month} month={month} max={max} />
        ))}
      </ol>
      <p className={styles.monthsLegend}>
        Requested <span className={styles.keyOpen} /> open <span className={styles.keyDone} /> done, and{" "}
        <span className={styles.keyContact} /> as contact
      </p>
    </section>
  );
}

function MonthBar({ month, max }: { month: PersonStatMonth; max: number }) {
  const label = `${month.month}: ${month.requested} requested, ${month.done} done, ${month.contact} as contact`;
  return (
    <li
      className={styles.month}
      title={label}
      aria-label={label}
      style={
        {
          "--open": `${(Math.max(0, month.requested - month.done) / max) * 100}%`,
          "--done": `${(Math.min(month.done, month.requested) / max) * 100}%`,
          "--contact": `${(month.contact / max) * 100}%`,
        } as CSSProperties
      }
    >
      <span className={styles.monthRequested}>
        <span className={styles.monthOpen} />
        <span className={styles.monthDone} />
      </span>
      <span className={styles.monthContact} />
      <span className={styles.monthName}>{month.month.slice(5)}</span>
    </li>
  );
}
