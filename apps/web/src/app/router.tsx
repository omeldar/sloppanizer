import { CalendarDate, NextMode, PEOPLE_STATS_SORTS, SearchKind } from "@organizer/shared";
import { createRootRoute, createRoute, createRouter, Link, lazyRouteComponent } from "@tanstack/react-router";
import { z } from "zod";
import { EmptyState, PageHeader } from "../components/ui.tsx";
import { AccountPage } from "../features/account/AccountPage.tsx";
import { AdminPage } from "../features/account/AdminPage.tsx";
import { BoardPage } from "../features/board/BoardPage.tsx";
import { LabelsPage } from "../features/labels/LabelsPage.tsx";
import { InboxPage } from "../features/lists/InboxPage.tsx";
import { NextUpPage } from "../features/next/NextUpPage.tsx";
import { PeoplePage } from "../features/people/PeoplePage.tsx";
import { PeopleStatsPage } from "../features/people/PeopleStatsPage.tsx";
import { PERIODS } from "../features/people/stats.ts";
import { SearchPage } from "../features/search/SearchPage.tsx";
import { ProjectPage } from "../features/projects/ProjectPage.tsx";
import { SettingsPage } from "../features/settings/SettingsPage.tsx";
import { TokensPage } from "../features/settings/TokensPage.tsx";
import { WeekPage } from "../features/week/WeekPage.tsx";
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

const BoardSearch = z.object({
  /** Project slug or "inbox". */
  project: z.string().optional().catch(undefined),
  label: z.string().optional().catch(undefined),
  person: z.coerce.number().int().positive().optional().catch(undefined),
});

const ProjectSearch = z.object({
  view: z.enum(["list", "board"]).optional().catch(undefined),
  label: z.string().optional().catch(undefined),
  person: z.coerce.number().int().positive().optional().catch(undefined),
});

const WeekSearch = z.object({ start: z.string().optional().catch(undefined) });
const PlannerSearch = z.object({
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
});
const plannerPage = lazyRouteComponent(() => import("../features/planner/PlannerPage.tsx"), "PlannerPage");

const NotesSearch = z.object({
  /** Project slug or "none". */
  project: z.string().optional().catch(undefined),
  q: z.string().optional().catch(undefined),
});

const NoteSearch = NotesSearch.extend({
  /** Just created: open in write mode. */
  write: z.boolean().optional().catch(undefined),
});

// Notes, the person page and the todo page hold the editor and the Markdown renderer: loaded on first use.
const notesPage = lazyRouteComponent(() => import("../features/notes/NotesPage.tsx"), "NotesPage");
const notePage = lazyRouteComponent(() => import("../features/notes/NotesPage.tsx"), "NotePage");
const personPage = lazyRouteComponent(() => import("../features/people/PersonPage.tsx"), "PersonPage");

const PeopleSearch = z.object({
  q: z.string().optional().catch(undefined),
  /** Comma lists of names: every one must match. */
  topic: z.string().optional().catch(undefined),
  team: z.string().optional().catch(undefined),
  tag: z.string().optional().catch(undefined),
  kind: z.enum(["requester", "contact"]).optional().catch(undefined),
  sort: z.enum(["name", "requested", "contact", "recent"]).optional().catch(undefined),
});

const PeopleStatsSearch = z.object({
  period: z
    .enum(Object.keys(PERIODS) as [keyof typeof PERIODS])
    .optional()
    .catch(undefined),
  from: CalendarDate.optional().catch(undefined),
  to: CalendarDate.optional().catch(undefined),
  role: z.enum(["requester", "contact"]).optional().catch(undefined),
  /** Comma lists of names: every one must match. */
  topic: z.string().optional().catch(undefined),
  tag: z.string().optional().catch(undefined),
  team: z.string().optional().catch(undefined),
  label: z.string().optional().catch(undefined),
  /** Project slug or "inbox". */
  project: z.string().optional().catch(undefined),
  sort: z.enum(PEOPLE_STATS_SORTS).optional().catch(undefined),
});

const SearchPageSearch = z.object({
  q: z.string().optional().catch(undefined),
  kind: SearchKind.optional().catch(undefined),
});

const routes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: NextUpPage,
    validateSearch: NextSearch,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/inbox", component: InboxPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$slug",
    component: ProjectPage,
    validateSearch: ProjectSearch,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/board",
    component: BoardPage,
    validateSearch: BoardSearch,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/week",
    component: WeekPage,
    validateSearch: WeekSearch,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/planner",
    component: plannerPage,
    validateSearch: PlannerSearch,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/notes",
    component: notesPage,
    validateSearch: NotesSearch,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/notes/$id",
    component: notePage,
    validateSearch: NoteSearch,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/todos/$id",
    validateSearch: z.object({ comment: z.coerce.number().int().positive().optional().catch(undefined) }),
    // The editor and Markdown renderer are most of the bundle; load them with the first todo opened.
    component: lazyRouteComponent(() => import("../features/todos/TodoPage.tsx"), "TodoPage"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/search",
    component: SearchPage,
    validateSearch: SearchPageSearch,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/labels", component: LabelsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/people",
    component: PeoplePage,
    validateSearch: PeopleSearch,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/people/stats",
    component: PeopleStatsPage,
    validateSearch: PeopleStatsSearch,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/people/$id", component: personPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings/tokens", component: TokensPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/account", component: AccountPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/admin", component: AdminPage }),
] as const;

export const routeTree = rootRoute.addChildren(routes);

/** `basepath` is the account's "/u/<username>": every route and Link stays inside that account. */
export function makeRouter(basepath = "/") {
  return createRouter({ routeTree, basepath, defaultPreload: false, scrollRestoration: true });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
