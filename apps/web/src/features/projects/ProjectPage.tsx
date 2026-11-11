import { getRouteApi, Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { EmptyState, ErrorState, Loading, PageHeader } from "../../components/ui.tsx";
import { useProjects } from "../../lib/queries.ts";
import styles from "../lists/Lists.module.css";
import { TodoListView } from "../lists/TodoListView.tsx";

const route = getRouteApi("/projects/$slug");

export function ProjectPage() {
  const { slug } = route.useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.slug === slug);

  if (projects.isPending) return <Loading />;
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
      />
      {project.description && <p className={styles.description}>{project.description}</p>}
      <TodoListView
        key={project.id}
        projectId={project.id}
        label={project.name}
        empty={`No open todos in ${project.name}. Press c to add one.`}
      />
    </>
  );
}
