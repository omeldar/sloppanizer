import { addDays, formatDuration, type WorkStats } from "@organizer/shared";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { ErrorState, Loading, PageHeader } from "../../components/ui.tsx";
import { dayLabel, formatDate, formatDayMonth, formatTime, today } from "../../lib/format.ts";
import {
  type BarRow,
  BarList,
  ChartCard,
  Columns,
  GroupedColumns,
  type HeatCell,
  Heatmap,
  Lines,
} from "./charts.tsx";
import { BUCKET_LABELS, hoursText, periodOf, PRESETS, useWorkStats, WEEKDAY_SHORT } from "./stats.ts";
import styles from "./Stats.module.css";
import { DateInput } from "../../components/DateTimeInputs.tsx";

const route = getRouteApi("/stats");

const VIZ_1 = "var(--viz-1)";
const VIZ_2 = "var(--viz-2)";

/** Hours with one decimal, for axes and tables. */
const hours = (minutes: number): number => Math.round(minutes / 6) / 10;

/**
 * Statistics of a period: worked time (planned time that has happened) per project, requester, week
 * and hour, meetings, todos created and done, how long todos took. One period control scopes it all.
 */
export function StatsPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const period = periodOf(search, today());
  const stats = useWorkStats(period.from, period.to);
  const go = (next: { period?: string; from?: string; to?: string }) =>
    void navigate({ to: "/stats", search: next, replace: true });

  return (
    <div className={styles.page}>
      <PageHeader title="Statistics" meta={`${formatDate(period.from)} – ${formatDate(period.to)}`} />
      <div className={styles.filters} role="group" aria-label="Period">
        <div className={styles.presets}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={styles.preset}
              aria-pressed={period.preset === p.id}
              onClick={() => go({ period: p.id })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className={styles.range}>
          From
          <DateInput
            aria-label="From"
            value={period.from}
            max={period.to}
            onChange={(value) => value && go({ from: value, to: period.to })}
          />
        </span>
        <span className={styles.range}>
          to
          <DateInput
            aria-label="To"
            value={period.to}
            min={period.from}
            onChange={(value) => value && go({ from: period.from, to: value })}
          />
        </span>
      </div>
      <p className={styles.note}>
        Worked time is planned time that has already happened: time blocks and planned dates of repeating
        todos in the Planner. There is no timer, so plan what you do to see it here.
      </p>
      {stats.isPending && <Loading />}
      {stats.isError && <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />}
      {stats.data && (
        <div className={stats.isPlaceholderData ? styles.loading : undefined}>
          <Overview stats={stats.data} />
        </div>
      )}
    </div>
  );
}

function Overview({ stats }: { stats: WorkStats }) {
  const { totals } = stats;
  return (
    <>
      <div className={styles.tiles}>
        <Tile label="Worked" value={hoursText(totals.workedMinutes)} sub="planned time that happened" />
        <Tile label="Todos done" value={String(totals.done)} sub={`${totals.created} created`} />
        <Tile
          label="Median time to done"
          value={totals.medianDoneMs === null ? "–" : formatDuration(totals.medianDoneMs)}
          sub="from created to done"
        />
        <Tile
          label="In meetings"
          value={hoursText(totals.meetingMinutes)}
          sub="meeting dates that happened"
        />
      </div>
      <div className={styles.grid}>
        <ProjectsCard stats={stats} />
        <RequestersCard stats={stats} />
        <WeeksCard stats={stats} />
        <TrendCard stats={stats} />
        <HoursCard stats={stats} />
        <DaysCard stats={stats} />
        <DurationsCard stats={stats} />
      </div>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      <span className={styles.tileSub}>{sub}</span>
    </div>
  );
}

const groupLabel = (g: WorkStats["projects"][number]): string =>
  g.kind === "inbox"
    ? "Inbox"
    : g.kind === "untitled"
      ? "Own title (no todo)"
      : (g.project?.name ?? "Project");

const workText = (minutes: number, done: number): string => `${hoursText(minutes)} · ${done} done`;

function ProjectsCard({ stats }: { stats: WorkStats }) {
  const rows: BarRow[] = stats.projects.map((g) => ({
    key: g.project ? `p${g.project.id}` : g.kind,
    label: groupLabel(g),
    ...(g.project
      ? { swatch: g.project.color, to: { to: "/projects/$slug", params: { slug: g.project.slug } } }
      : {}),
    value: g.minutes,
    text: workText(g.minutes, g.done),
    tip: {
      title: groupLabel(g),
      rows: [
        { label: "worked", value: hoursText(g.minutes) },
        { label: "done", value: String(g.done) },
      ],
    },
  })) as BarRow[];
  return (
    <ChartCard
      title="Worked per project"
      subtitle="Hours and todos done; open a project from its name"
      table={{
        head: ["Project", "Hours", "Done"],
        rows: stats.projects.map((g) => [groupLabel(g), hours(g.minutes), g.done]),
      }}
    >
      <BarList rows={rows} empty="Nothing planned or done in this period." />
    </ChartCard>
  );
}

function RequestersCard({ stats }: { stats: WorkStats }) {
  const rows: BarRow[] = stats.requesters.map((r) => ({
    key: `r${r.person.id}`,
    label: r.person.name,
    to: { to: "/people/$id", params: { id: String(r.person.id) } },
    value: r.minutes,
    text: workText(r.minutes, r.done),
    tip: {
      title: r.person.name,
      rows: [
        { label: "worked", value: hoursText(r.minutes) },
        { label: "done", value: String(r.done) },
      ],
    },
  }));
  const others = stats.otherRequesters;
  if (others)
    rows.push({
      key: "others",
      label: `${others.people} others`,
      value: others.minutes,
      text: workText(others.minutes, others.done),
      tip: {
        title: `${others.people} others`,
        rows: [{ label: "worked", value: hoursText(others.minutes) }],
      },
    });
  return (
    <ChartCard
      title="Worked for whom"
      subtitle="By who asked for the todo; a todo with two requesters counts for both"
      table={{
        head: ["Requester", "Hours", "Done"],
        rows: [
          ...stats.requesters.map((r) => [r.person.name, hours(r.minutes), r.done]),
          ...(others ? [[`${others.people} others`, hours(others.minutes), others.done]] : []),
        ],
      }}
    >
      <BarList rows={rows} empty="No time for todos with a requester in this period." />
    </ChartCard>
  );
}

function WeeksCard({ stats }: { stats: WorkStats }) {
  return (
    <ChartCard
      title="Focus and meetings per week"
      subtitle="Hours worked next to hours in meetings; hover a week for its projects"
      legend={[
        { label: "Worked", color: VIZ_1, kind: "bar" },
        { label: "Meetings", color: VIZ_2, kind: "bar" },
      ]}
      wide
      table={{
        head: ["Week of", "Worked h", "Meetings h", "Top projects"],
        rows: stats.weeks.map((w) => [
          formatDate(w.start),
          hours(w.workedMinutes),
          hours(w.meetingMinutes),
          w.projects
            .slice(0, 3)
            .map((p) => `${p.name} ${hoursText(p.minutes)}`)
            .join(", "),
        ]),
      }}
    >
      <GroupedColumns
        colors={[VIZ_1, VIZ_2]}
        format={(v) => `${v} h`}
        groups={stats.weeks.map((w) => ({
          key: w.start,
          label: formatDayMonth(w.start),
          values: [w.workedMinutes / 60, w.meetingMinutes / 60],
          tip: {
            title: `Week of ${dayLabel(w.start)}`,
            rows: [
              { label: "worked", value: hoursText(w.workedMinutes), key: { kind: "bar", color: VIZ_1 } },
              { label: "meetings", value: hoursText(w.meetingMinutes), key: { kind: "bar", color: VIZ_2 } },
              ...w.projects.slice(0, 4).map((p) => ({ label: p.name, value: hoursText(p.minutes) })),
            ],
          },
        }))}
      />
    </ChartCard>
  );
}

function TrendCard({ stats }: { stats: WorkStats }) {
  const created = stats.weeks.map((w) => w.created);
  const done = stats.weeks.map((w) => w.done);
  const balance = done.reduce((n, v) => n + v, 0) - created.reduce((n, v) => n + v, 0);
  return (
    <ChartCard
      title="Created and done per week"
      subtitle={
        balance === 0
          ? "As many done as created: the backlog holds steady"
          : balance > 0
            ? `${balance} more done than created: the backlog shrinks`
            : `${-balance} more created than done: the backlog grows`
      }
      legend={[
        { label: "Created", color: VIZ_1, kind: "line" },
        { label: "Done", color: VIZ_2, kind: "line" },
      ]}
      table={{
        head: ["Week of", "Created", "Done"],
        rows: stats.weeks.map((w) => [formatDate(w.start), w.created, w.done]),
      }}
    >
      <Lines
        labels={stats.weeks.map((w) => formatDayMonth(w.start))}
        series={[
          { name: "created", color: VIZ_1, values: created },
          { name: "done", color: VIZ_2, values: done },
        ]}
        tipTitle={(i) => `Week of ${dayLabel(stats.weeks[i]?.start ?? stats.from)}`}
      />
    </ChartCard>
  );
}

const hourText = (hour: number): string => formatTime(`${String(hour).padStart(2, "0")}:00`);

function HoursCard({ stats }: { stats: WorkStats }) {
  const cells: HeatCell[] = stats.hours.flatMap((row, day) =>
    row.map((minutes, hour) => ({
      key: `${day}-${hour}`,
      row: day,
      col: hour,
      value: minutes,
      tip: {
        title: `${WEEKDAY_SHORT[day]} ${hourText(hour)}–${hourText((hour + 1) % 24)}`,
        rows: [{ label: "worked in this period", value: hoursText(minutes) }],
      },
    })),
  );
  const busiest = stats.hours
    .flatMap((row, day) => row.map((m, hour) => ({ day, hour, m })))
    .toSorted((a, b) => b.m - a.m)[0];
  return (
    <ChartCard
      title="When you work"
      subtitle={
        busiest && busiest.m > 0
          ? `Busiest: ${WEEKDAY_SHORT[busiest.day]} around ${hourText(busiest.hour)}`
          : "Worked time by weekday and hour"
      }
      table={{
        head: ["Day", ...Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"))],
        rows: stats.hours.map((row, day) => [WEEKDAY_SHORT[day] as string, ...row.map(hours)]),
      }}
    >
      <Heatmap
        label="Worked hours by weekday and hour"
        cells={cells}
        rows={7}
        cols={24}
        cell={16}
        rowLabels={[...WEEKDAY_SHORT]}
        colLabels={[0, 6, 12, 18].map((h) => ({ col: h, text: String(h).padStart(2, "0") }))}
      />
    </ChartCard>
  );
}

/** 0 = Monday ... 6 = Sunday. */
const weekday = (date: string): number => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;

function DaysCard({ stats }: { stats: WorkStats }) {
  const first = stats.days[0]?.date ?? stats.from;
  const monday = addDays(first, -weekday(first));
  const col = (date: string) =>
    Math.floor((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${monday}T12:00:00Z`)) / (7 * 86_400_000));
  const cells: HeatCell[] = stats.days.map((d) => ({
    key: d.date,
    row: weekday(d.date),
    col: col(d.date),
    value: d.done,
    tip: {
      title: dayLabel(d.date),
      rows: [
        { label: "done", value: String(d.done) },
        { label: "worked", value: hoursText(d.workedMinutes) },
      ],
    },
  }));
  const cols = col(stats.days.at(-1)?.date ?? first) + 1;
  const total = stats.days.reduce((n, d) => n + d.done, 0);
  const active = stats.days.filter((d) => d.done > 0).length;
  return (
    <ChartCard
      title="Done per day"
      subtitle={`${total} done on ${active} of ${stats.days.length} days`}
      table={{
        head: ["Day", "Done", "Worked h"],
        rows: stats.days
          .filter((d) => d.done > 0 || d.workedMinutes > 0)
          .map((d) => [formatDate(d.date), d.done, hours(d.workedMinutes)]),
      }}
    >
      <Heatmap
        label="Todos done per day"
        cells={cells}
        rows={7}
        cols={cols}
        cell={16}
        rowLabels={[...WEEKDAY_SHORT]}
        colLabels={Array.from({ length: cols }, (_, c) => ({
          col: c,
          text: formatDayMonth(addDays(monday, c * 7)),
        }))}
      />
    </ChartCard>
  );
}

function DurationsCard({ stats }: { stats: WorkStats }) {
  return (
    <ChartCard
      title="Time to done"
      subtitle="How long the todos done in this period took, from created to done"
      table={{
        head: ["Took", "Todos"],
        rows: stats.doneDurations.map((b) => [BUCKET_LABELS[b.bucket], b.count]),
      }}
    >
      <Columns
        color={VIZ_1}
        items={stats.doneDurations.map((b) => ({
          key: b.bucket,
          label: BUCKET_LABELS[b.bucket],
          value: b.count,
          tip: {
            title: `Took ${BUCKET_LABELS[b.bucket]}`,
            rows: [{ label: "todos", value: String(b.count) }],
          },
        }))}
      />
    </ChartCard>
  );
}
