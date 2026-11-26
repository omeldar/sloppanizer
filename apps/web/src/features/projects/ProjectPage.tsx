import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { Button, EmptyState, ErrorState, Loading, PageHeader } from "../../components/ui.tsx";
import { useProjectView } from "../../lib/accountQueries.ts";
import { useProjects } from "../../lib/queries.ts";
import { BoardFilterBar } from "../board/BoardFilterBar.tsx";
import { BoardView } from "../board/BoardView.tsx";
import styles from "../lists/Lists.module.css";
import { TodoListView } from "../lists/TodoListView.tsx";
import { hint } from "../../lib/device.ts";
import { EditProjectDialog } from "./EditProjectDialog.tsx";

const route = getRouteApi("/projects/$slug");

export function ProjectPage() {
  const { slug } = route.useParams();
  const search = route.useSearch();
  const navigate = useNavigate();
  const projects = useProjects();
  // Without ?view= the page opens as the account chose in Settings (S5#3).
  const preferred = useProjectView();
  const board = (search.view ?? preferred.view) === "board";
  const project = projects.data?.find((p) => p.slug === slug);
  const [editing, setEditing] = useState(false);

  if (projects.isPending || (search.view === undefined && preferred.pending)) return <Loading />;
  if (projects.isError) return <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />;
  if (!project) {
    return (
      <>
        <PageHeader title="Project not found" />
        <EmptyState>
          There is no project called {slug}. Pick one in the sidebar or <Link to="/">go to Next up</Link>.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={
          <span className={styles.projectHead}>
            <span className={styles.projectSwatch} style={{ "--swatch": project.color } as CSSProperties} />
            {project.name}
          </span>
        }
        actions={
          <>
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit project
            </Button>
            <div className={styles.modes} role="group" aria-label="View">
              {(["list", "board"] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  className={styles.mode}
                  aria-pressed={(view === "board") === board}
                  onClick={() =>
                    void navigate({
                      to: "/projects/$slug",
                      params: { slug },
                      search: view === preferred.view ? {} : { view },
                      replace: true,
                    })
                  }
                >
                  {view === "list" ? "List" : "Board"}
                </button>
              ))}
            </div>
          </>
        }
      />
      <EditProjectDialog project={editing ? project : null} onOpenChange={setEditing} />
      {project.description && <p className={styles.description}>{project.description}</p>}
      {board ? (
        <>
          <BoardFilterBar
            search={{ label: search.label, person: search.person }}
            showProject={false}
            onChange={(next) =>
              void navigate({
                to: "/projects/$slug",
                params: { slug },
                search: { view: "board", label: next.label, person: next.person },
                replace: true,
              })
            }
          />
          <BoardView
            key={`${project.id}-${search.label ?? ""}-${search.person ?? ""}`}
            filters={{ projectId: project.id, label: search.label, personId: search.person }}
          />
        </>
      ) : (
        <TodoListView
          key={project.id}
          projectId={project.id}
          label={project.name}
          empty={hint(
            `No open todos in ${project.name}. Press c to add one.`,
            `No open todos in ${project.name}. Tap + to add one.`,
          )}
        />
      )}
    </>
  );
}
