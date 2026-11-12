import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { PageHeader } from "../../components/ui.tsx";
import { useProjects } from "../../lib/queries.ts";
import { BoardFilterBar } from "./BoardFilterBar.tsx";
import { type BoardFilters, BoardView } from "./BoardView.tsx";

const route = getRouteApi("/board");

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
