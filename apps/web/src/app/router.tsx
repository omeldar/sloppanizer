import { NextMode } from "@organizer/shared";
import { createRootRoute, createRoute, createRouter, Link, lazyRouteComponent } from "@tanstack/react-router";
import { z } from "zod";
import { EmptyState, PageHeader } from "../components/ui.tsx";
import { LabelsPage } from "../features/labels/LabelsPage.tsx";
import { InboxPage } from "../features/lists/InboxPage.tsx";
import { NextUpPage } from "../features/next/NextUpPage.tsx";
import { PeoplePage } from "../features/people/PeoplePage.tsx";
import { ProjectPage } from "../features/projects/ProjectPage.tsx";
import { SettingsPage } from "../features/settings/SettingsPage.tsx";
import { Layout } from "./Layout.tsx";

function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState>
        This address does not exist. <Link to="/">Go to Next up</Link> or press ctrl+k to search.
      </EmptyState>
    </>
  );
}

const rootRoute = createRootRoute({ component: Layout, notFoundComponent: NotFound });

const NextSearch = z.object({
  mode: NextMode.optional().catch(undefined),
  /** Project slug or "inbox". */
  project: z.string().optional().catch(undefined),
  label: z.string().optional().catch(undefined),
});

const routes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: NextUpPage,
    validateSearch: NextSearch,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/inbox", component: InboxPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/projects/$slug", component: ProjectPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/todos/$id",
    // The editor and Markdown renderer are most of the bundle; load them with the first todo opened.
    component: lazyRouteComponent(() => import("../features/todos/TodoPage.tsx"), "TodoPage"),
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/labels", component: LabelsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/people", component: PeoplePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
] as const;

export const routeTree = rootRoute.addChildren(routes);

export function makeRouter() {
  return createRouter({ routeTree, defaultPreload: false, scrollRestoration: true });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
