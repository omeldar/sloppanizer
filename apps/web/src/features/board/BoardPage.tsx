import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { Kbd, PageHeader } from "../../components/ui.tsx";
import { useLabels, usePeople, useProjects } from "../../lib/queries.ts";
import styles from "./Board.module.css";
import { type BoardFilters, BoardView } from "./BoardView.tsx";

const route = getRouteApi("/board");

export interface BoardSearch {
  /** Project slug or "inbox". */
  project?: string;
  label?: string;
  person?: number;
}

export function BoardPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.slug === search.project);
  const filters: BoardFilters = {
    projectId: search.project === "inbox" ? "inbox" : project?.id,
    label: search.label,
    personId: search.person,
  };
  // Wait for the project list before filtering by slug, so the board does not flash all projects.
  const ready = !search.project || search.project === "inbox" || projects.isSuccess;

  return (
    <>
      <PageHeader title="Board" />
      <BoardFilterBar
        search={search}
        onChange={(next) => void navigate({ to: "/board", search: next, replace: true })}
      />
      {ready && <BoardView key={JSON.stringify(filters)} filters={filters} />}
    </>
  );
}

/** Project (unless the page is a project), label and person filters; values live in the URL. */
export function BoardFilterBar({
  search,
  onChange,
  showProject = true,
}: {
  search: BoardSearch;
  onChange: (next: BoardSearch) => void;
  showProject?: boolean;
}) {
  const projects = useProjects();
  const labels = useLabels();
  const people = usePeople();
  const set = (patch: Partial<BoardSearch>) => onChange({ ...search, ...patch });
  return (
    <div className={styles.filters}>
      {showProject && (
        <label className={styles.filter}>
          <span>Project</span>
          <select
            className={styles.select}
            value={search.project ?? ""}
            onChange={(e) => set({ project: e.target.value || undefined })}
          >
            <option value="">All projects</option>
            <option value="inbox">Inbox</option>
            {(projects.data ?? [])
              .filter((p) => p.archivedAt === null)
              .map((p) => (
                <option key={p.id} value={p.slug}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
      )}
      <label className={styles.filter}>
        <span>Label</span>
        <select
          className={styles.select}
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
      </label>
      <label className={styles.filter}>
        <span>Person</span>
        <select
          className={styles.select}
          value={search.person ?? ""}
          onChange={(e) => set({ person: e.target.value ? Number(e.target.value) : undefined })}
        >
          <option value="">Anyone</option>
          {(people.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </label>
      <span className={styles.keysHint}>
        <Kbd keys="h" />
        <Kbd keys="l" /> columns <Kbd keys="shift+l" /> move right <Kbd keys="shift+h" /> left
      </span>
    </div>
  );
}
