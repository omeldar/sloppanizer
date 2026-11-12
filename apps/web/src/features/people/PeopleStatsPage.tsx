import type { PersonStat } from "@organizer/shared";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { EmptyState, ErrorState, Loading, PageHeader, TextInput } from "../../components/ui.tsx";
import { type KeyBinding, useKeys } from "../../keyboard/KeyboardProvider.tsx";
import { today as localToday, toDate } from "../../lib/format.ts";
import { useLabels, usePeopleStats, useProjects } from "../../lib/queries.ts";
import { stepCursor, useScrollIntoView } from "../../lib/listCursor.ts";
import { joinList, splitList, TagFilter, TeamFilter } from "./filters.tsx";
import { PeopleTabs } from "./PeopleTabs.tsx";
import styles from "./PeopleStats.module.css";
import {
  barParts,
  DEFAULT_PERIOD,
  daysText,
  type Period,
  PERIODS,
  peopleStatsParams,
  roleNumbers,
  type StatsSearch,
  type StatsSort,
  tookText,
} from "./stats.ts";
import { TopicInput } from "./TopicInput.tsx";

const route = getRouteApi("/people/stats");

const ROLES = [
  { role: "requester", label: "Requesters" },
  { role: "contact", label: "Contacts" },
] as const;

export function PeopleStatsPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const projects = useProjects();
  const labels = useLabels();
  const role = search.role ?? "requester";
  const period = search.period ?? DEFAULT_PERIOD;
  const params = peopleStatsParams(
    search,
    localToday(),
    (slug) => projects.data?.find((p) => p.slug === slug)?.id,
  );
  const stats = usePeopleStats(params);
  const items = stats.data?.items ?? [];
  // A project slug in the URL that no project has (renamed, deleted, mistyped): the query cannot run.
  const unknownProject =
    search.project !== undefined &&
    search.project !== "inbox" &&
    projects.data !== undefined &&
    !projects.data.some((p) => p.slug === search.project);
  const set = (patch: Partial<StatsSearch>) =>
    void navigate({ to: "/people/stats", search: { ...search, ...patch }, replace: true });
  const filtered = Boolean(
    search.topic || search.tag || search.team || search.label || search.project || period !== "all",
  );

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const move = (delta: number) =>
    setSelectedId(
      stepCursor(
        items.map((s) => s.person.id),
        selectedId,
        delta,
      ),
    );
  const bindings: KeyBinding[] = [
    { keys: "j", run: () => move(1), label: "Next person", group: "People statistics" },
    { keys: "k", run: () => move(-1), label: "Previous person", group: "People statistics" },
    { keys: "ArrowDown", run: () => move(1) },
    { keys: "ArrowUp", run: () => move(-1) },
    {
      keys: "Enter",
      run: () =>
        selectedId !== null && void navigate({ to: "/people/$id", params: { id: String(selectedId) } }),
      label: "Open person",
      group: "People statistics",
    },
  ];
  useKeys(bindings);

  const maxTotal = Math.max(0, ...items.map((s) => roleNumbers(s, role).total));
  const totals = stats.data?.totals;

  return (
    <div className={styles.page}>
      <PageHeader title="People and contacts" />
      <PeopleTabs current="stats" />

      <div className={styles.toolbar}>
        <div className={styles.segmented} role="group" aria-label="Who">
          {ROLES.map((r) => (
            <button
              key={r.role}
              type="button"
              className={styles.segButton}
              aria-pressed={role === r.role}
              onClick={() => set({ role: r.role === "requester" ? undefined : r.role, sort: undefined })}
            >
              {r.label}
            </button>
          ))}
        </div>
        <label className={styles.control}>
          <span>Period</span>
          <select
            className={styles.select}
            value={period}
            onChange={(e) => {
              const next = e.target.value as Period;
              set({
                period: next === DEFAULT_PERIOD ? undefined : next,
                ...(next !== "custom" && { from: undefined, to: undefined }),
              });
            }}
          >
            {Object.entries(PERIODS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {period === "custom" && (
          <span className={styles.control}>
            <TextInput
              type="date"
              aria-label="From"
              className={styles.date}
              value={search.from ?? ""}
              onChange={(e) => set({ from: e.target.value || undefined })}
            />
            <span>to</span>
            <TextInput
              type="date"
              aria-label="To"
              className={styles.date}
              value={search.to ?? ""}
              onChange={(e) => set({ to: e.target.value || undefined })}
            />
          </span>
        )}
        <select
          className={styles.select}
          aria-label="Project filter"
          value={search.project ?? ""}
          onChange={(e) => set({ project: e.target.value || undefined })}
        >
          <option value="">All projects</option>
          <option value="inbox">Inbox only</option>
          {(projects.data ?? [])
            .filter((p) => p.archivedAt === null || p.slug === search.project)
            .map((p) => (
              <option key={p.id} value={p.slug}>
                {p.archivedAt === null ? p.name : `${p.name} (archived)`}
              </option>
            ))}
        </select>
        <select
          className={styles.select}
          aria-label="Label filter"
          value={search.label ?? ""}
          onChange={(e) => set({ label: e.target.value || undefined })}
        >
          <option value="">Any label</option>
          {(labels.data ?? []).map((l) => (
            <option key={l.id} value={l.name}>
              {l.name}
            </option>
          ))}
        </select>
        <TeamFilter value={search.team} onChange={(team) => set({ team })} />
        <TagFilter value={splitList(search.tag)} onChange={(tags) => set({ tag: joinList(tags) })} />
      </div>
      <div className={styles.topicFilter}>
        <span className={styles.filterLabel}>Topics</span>
        <TopicInput
          topics={splitList(search.topic)}
          placeholder="Only people with these topics"
          onAdd={(name) => set({ topic: joinList([...splitList(search.topic), name]) })}
          onRemove={(name) => set({ topic: joinList(splitList(search.topic).filter((t) => t !== name)) })}
        />
      </div>

      {totals && (
        <ul className={styles.summary} aria-label="Summary">
          <li>
            <b>{totals.todos}</b> todos
          </li>
          <li>
            <b>{totals.open}</b> open
          </li>
          <li>
            <b>{totals.done}</b> done
          </li>
          <li>
            <b>{tookText(totals.medianDoneMs)}</b> median took
          </li>
          {stats.data?.from && (
            <li className={styles.range}>
              {stats.data.from} to {stats.data.to ?? "today"}
            </li>
          )}
        </ul>
      )}

      {unknownProject && (
        <EmptyState>
          There is no project "{search.project}".{" "}
          <Link to="/people/stats" search={{ ...search, project: undefined }}>
            Show all projects
          </Link>
          .
        </EmptyState>
      )}
      {projects.isError && !params && (
        <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
      )}
      {stats.isPending && !unknownProject && !(projects.isError && !params) && <Loading />}
      {stats.isError && <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />}
      {stats.data && items.length === 0 && (
        <EmptyState>
          {filtered ? (
            <>
              Nobody matches. Pick a longer period or All time, remove a topic, tag or label, or{" "}
              <Link to="/people/stats" search={{ period: "all", role: search.role }}>
                clear every filter
              </Link>
              .
            </>
          ) : role === "requester" ? (
            "Nobody has asked for anything yet. Add people in the Requested by field of a todo."
          ) : (
            "Nobody is a contact yet. Add people in the Contacts field of a todo."
          )}
        </EmptyState>
      )}
      {items.length > 0 && (
        <StatsTable
          items={items}
          role={role}
          sort={search.sort ?? "total"}
          onSort={(sort) => set({ sort: sort === "total" ? undefined : sort })}
          maxTotal={maxTotal}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}
    </div>
  );
}

interface Column {
  label: string;
  sort?: StatsSort;
  num?: boolean;
}

function columns(role: "requester" | "contact"): Column[] {
  return role === "requester"
    ? [
        { label: "#", num: true },
        { label: "Name", sort: "name" },
        { label: "Requested", sort: "total", num: true },
        { label: "Open", sort: "open", num: true },
        { label: "Done", sort: "done", num: true },
        { label: "Median took", sort: "speed", num: true },
        { label: "p90 took", num: true },
        { label: "Oldest open", num: true },
        { label: "Contact for", num: true },
        { label: "Last asked", sort: "recent" },
        { label: "Open and done" },
      ]
    : [
        { label: "#", num: true },
        { label: "Name", sort: "name" },
        { label: "Contact for", sort: "total", num: true },
        { label: "Open", sort: "open", num: true },
        { label: "Done", sort: "done", num: true },
        { label: "Requested", num: true },
        { label: "Open and done" },
      ];
}

export function StatsTable({
  items,
  role,
  sort,
  onSort,
  maxTotal,
  selectedId,
  onSelect,
}: {
  items: PersonStat[];
  role: "requester" | "contact";
  sort: StatsSort;
  onSort: (sort: StatsSort) => void;
  maxTotal: number;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <table className={styles.table} data-role={role}>
      <thead>
        <tr>
          {columns(role).map((column) => (
            <th
              key={column.label}
              scope="col"
              data-num={column.num || undefined}
              aria-sort={column.sort && column.sort === sort ? sortDirection(column.sort) : undefined}
            >
              {column.sort ? (
                <button
                  type="button"
                  className={styles.sortButton}
                  data-on={column.sort === sort || undefined}
                  onClick={() => column.sort && onSort(column.sort)}
                >
                  {column.label}
                </button>
              ) : (
                column.label
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((stat, i) => (
          <StatRow
            key={stat.person.id}
            stat={stat}
            rank={i + 1}
            role={role}
            maxTotal={maxTotal}
            selected={stat.person.id === selectedId}
            onSelect={() => onSelect(stat.person.id)}
          />
        ))}
      </tbody>
    </table>
  );
}

/** Name sorts A to Z, speed fastest first; the counts and "recent" sort biggest or newest first. */
function sortDirection(sort: StatsSort): "ascending" | "descending" {
  return sort === "name" || sort === "speed" ? "ascending" : "descending";
}

function StatRow({
  stat,
  rank,
  role,
  maxTotal,
  selected,
  onSelect,
}: {
  stat: PersonStat;
  rank: number;
  role: "requester" | "contact";
  maxTotal: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const ref = useScrollIntoView<HTMLTableRowElement>(selected);
  const numbers = roleNumbers(stat, role);
  const bar = barParts(numbers, maxTotal);
  const { person, requested, contact } = stat;
  return (
    <tr ref={ref} className={styles.row} data-selected={selected || undefined} onMouseDown={onSelect}>
      <td data-num className={styles.rank}>
        {rank}
      </td>
      <td className={styles.nameCell}>
        <Link to="/people/$id" params={{ id: String(person.id) }} className={styles.name}>
          {person.displayName}
        </Link>
        {person.team && <span className={styles.team}>{person.team}</span>}
      </td>
      <td data-num>{numbers.total}</td>
      <td data-num>{numbers.open}</td>
      <td data-num>{numbers.done}</td>
      {role === "requester" ? (
        <>
          <td data-num>{tookText(requested.medianDoneMs)}</td>
          <td data-num>{tookText(requested.p90DoneMs)}</td>
          <td data-num>{daysText(requested.oldestOpenDays)}</td>
          <td data-num>{contact.total}</td>
          <td className={styles.when}>{requested.lastAt ? toDate(requested.lastAt) : "-"}</td>
        </>
      ) : (
        <td data-num>{requested.total}</td>
      )}
      <td>
        <span
          className={styles.bar}
          role="img"
          aria-label={`${numbers.open} open, ${numbers.done} done`}
          title={`${numbers.open} open, ${numbers.done} done`}
          style={{ "--open": `${bar.open}%`, "--done": `${bar.done}%` } as CSSProperties}
        >
          <span className={styles.barOpen} />
          <span className={styles.barDone} />
        </span>
      </td>
    </tr>
  );
}
