import { NEXT_MODES, type NextMode } from "@organizer/shared";
import { getRouteApi } from "@tanstack/react-router";
import { StripList } from "../../components/strip/StripList.tsx";
import stripStyles from "../../components/strip/Strip.module.css";
import { EmptyState, ErrorState, Loading, PageHeader } from "../../components/ui.tsx";
import { useLabels, useNext, useProjects } from "../../lib/queries.ts";
import { formatDate } from "../../lib/format.ts";
import styles from "../lists/Lists.module.css";
import { hint } from "../../lib/device.ts";
import { TodayPlan } from "../planner/TodayPlan.tsx";
import { ActionNeededList } from "./ActionNeededList.tsx";
import { AssignedToYou } from "./AssignedToYou.tsx";

const route = getRouteApi("/");

const MODE_NAMES: Record<NextMode, string> = {
  smart: "Smart",
  oldest: "Oldest",
  priority: "Priority",
  due: "Due",
};

export function NextUpPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const projects = useProjects();
  const labels = useLabels();
  const mode = search.mode ?? "smart";
  const project =
    search.project === "inbox" ? undefined : projects.data?.find((p) => p.slug === search.project);
  const projectId = search.project === "inbox" ? ("inbox" as const) : project?.id;
  const waitingForProject = search.project !== undefined && search.project !== "inbox" && !projects.data;
  const next = useNext({ mode, projectId, label: search.label ? [search.label] : undefined });
  const data = waitingForProject ? undefined : next.data;

  const set = (patch: Partial<typeof search>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  return (
    <>
      <PageHeader
        title="Next up"
        meta={data ? `${data.items.length} ranked, today ${formatDate(data.today)}` : undefined}
        actions={
          <div className={styles.filters}>
            <div className={styles.modes} role="group" aria-label="Ranking">
              {NEXT_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={styles.mode}
                  aria-pressed={m === mode}
                  onClick={() => set({ mode: m === "smart" ? undefined : m })}
                >
                  {MODE_NAMES[m]}
                </button>
              ))}
            </div>
            <select
              className={styles.select}
              aria-label="Project filter"
              value={search.project ?? ""}
              onChange={(event) => set({ project: event.target.value || undefined })}
            >
              <option value="">All projects</option>
              <option value="inbox">Inbox only</option>
              {(projects.data ?? [])
                .filter((p) => p.archivedAt === null)
                .map((p) => (
                  <option key={p.id} value={p.slug}>
                    {p.name}
                  </option>
                ))}
            </select>
            <select
              className={styles.select}
              aria-label="Label filter"
              value={search.label ?? ""}
              onChange={(event) => set({ label: event.target.value || undefined })}
            >
              <option value="">Any label</option>
              {(labels.data ?? []).map((l) => (
                <option key={l.id} value={l.name}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        }
      />
      <TodayPlan />
      {/* Filters pick among your own projects and labels; the shared todos stay out of a filtered view. */}
      {!search.project && !search.label && <ActionNeededList />}
      {!search.project && !search.label && <AssignedToYou />}
      {!data && !next.isError && <Loading />}
      {next.isError && <ErrorState error={next.error} onRetry={() => void next.refetch()} />}
      {data &&
        (data.items.length === 0 ? (
          <EmptyState>
            {search.project || search.label
              ? "Nothing open matches these filters. Clear them to see everything."
              : hint(
                  "Nothing to do next. Press c to add a todo.",
                  "Nothing to do next. Tap + to add a todo.",
                )}
          </EmptyState>
        ) : (
          <StripList
            ranked
            label="Ranked todos"
            items={data.items.map((item, i) => ({
              todo: item.todo,
              rank: i + 1,
              reasons: item.reasons,
              score: item.score,
            }))}
          />
        ))}
      {data && data.blocked.length > 0 && (
        <section className={stripStyles.group} aria-label="Blocked">
          <h2 className={stripStyles.groupTitle}>
            Blocked <span className={stripStyles.groupCount}>{data.blocked.length}</span>
          </h2>
          <StripList items={data.blocked.map((todo) => ({ todo }))} label="Blocked todos" keys={false} />
        </section>
      )}
    </>
  );
}
